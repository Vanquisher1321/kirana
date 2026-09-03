import { lookup } from 'node:dns/promises';
import { timingSafeEqual, createHash, createHmac, randomBytes } from 'node:crypto';
import { config } from './config.ts';
import { isIP } from 'node:net';

/**
 * Security primitives.
 *
 * The threat that matters most here is SSRF, and it is worth being explicit
 * about why. `POST /api/ingest {url}` asks this server to fetch a URL the
 * caller chose. That is, verbatim, the shape of a server-side request forgery:
 * an attacker who cannot reach a private network can ask US to reach it for
 * them. On a cloud host the classic target is the instance metadata endpoint at
 * 169.254.169.254, which hands out credentials to anyone who asks from inside.
 *
 * Blocking "localhost" by string is not a defence. `127.0.0.1`, `0.0.0.0`,
 * `[::1]`, `2130706433`, `127.1`, a hostname whose DNS record points at
 * 10.0.0.5, and a public URL that 302-redirects to any of those all reach the
 * same place. So we resolve the hostname and check the resolved ADDRESS, and we
 * re-check on every redirect hop.
 */

export class BlockedHostError extends Error {
  host: string;
  reason: string;
  constructor(host: string, reason: string) {
    super(`Refusing to fetch ${host}: ${reason}`);
    this.name = 'BlockedHostError';
    this.host = host;
    this.reason = reason;
  }
}

function ipv4ToInt(ip: string): number {
  const parts = ip.split('.').map(Number);
  return ((parts[0]! << 24) >>> 0) + (parts[1]! << 16) + (parts[2]! << 8) + parts[3]!;
}

/** Ranges that must never be reachable from a user-supplied URL. */
const BLOCKED_V4: Array<[string, number, string]> = [
  ['0.0.0.0', 8, 'this host'],
  ['10.0.0.0', 8, 'private network'],
  ['100.64.0.0', 10, 'carrier-grade NAT'],
  ['127.0.0.0', 8, 'loopback'],
  ['169.254.0.0', 16, 'link-local / cloud metadata'],
  ['172.16.0.0', 12, 'private network'],
  ['192.0.0.0', 24, 'IETF protocol assignments'],
  ['192.88.99.0', 24, '6to4 relay anycast'],
  ['192.168.0.0', 16, 'private network'],
  ['198.18.0.0', 15, 'benchmarking'],
  ['224.0.0.0', 4, 'multicast'],
  ['240.0.0.0', 4, 'reserved'],
];

/**
 * Expands any IPv6 literal to its 16 bytes, handling `::` compression and a
 * trailing dotted-quad. Returns null if it is not parseable as IPv6.
 *
 * This replaced a regex that only recognised the DOTTED form of an
 * IPv4-mapped address (`::ffff:127.0.0.1`). The WHATWG URL parser normalises
 * `[0:0:0:0:0:ffff:169.254.169.254]` to `[::ffff:a9fe:a9fe]` -- the same
 * address in hex -- which that regex did not match, so the cloud metadata
 * endpoint was reachable through a redirect. Parse the address; do not pattern
 * match its spelling.
 */
function ipv6Bytes(input: string): Uint8Array | null {
  let addr = input.trim().replace(/^\[|\]$/g, '').split('%')[0]!;
  if (!addr.includes(':')) return null;

  // A trailing dotted quad becomes two hex groups.
  const dotted = addr.match(/(.*:)(\d+\.\d+\.\d+\.\d+)$/);
  if (dotted) {
    const quad = dotted[2]!.split('.').map(Number);
    if (quad.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return null;
    const hi = ((quad[0]! << 8) | quad[1]!).toString(16);
    const lo = ((quad[2]! << 8) | quad[3]!).toString(16);
    addr = `${dotted[1]}${hi}:${lo}`;
  }

  const halves = addr.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0]!.split(':').filter((x) => x !== '') : [];
  const tail = halves.length === 2 ? (halves[1] ? halves[1]!.split(':').filter((x) => x !== '') : []) : [];
  const groups = halves.length === 2
    ? [...head, ...Array(8 - head.length - tail.length).fill('0'), ...tail]
    : head;
  if (groups.length !== 8) return null;

  const bytes = new Uint8Array(16);
  for (let i = 0; i < 8; i++) {
    const g = groups[i]!;
    if (!/^[0-9a-fA-F]{1,4}$/.test(g)) return null;
    const v = parseInt(g, 16);
    bytes[i * 2] = v >> 8;
    bytes[i * 2 + 1] = v & 0xff;
  }
  return bytes;
}

export function classifyAddress(addr: string): string | null {
  const family = isIP(addr.replace(/^\[|\]$/g, ''));

  if (family === 4) {
    const v = ipv4ToInt(addr);
    for (const [base, bits, why] of BLOCKED_V4) {
      const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
      if ((v & mask) === (ipv4ToInt(base) & mask)) return why;
    }
    return null;
  }

  if (family === 6) {
    const b = ipv6Bytes(addr);
    if (!b) return 'unparseable IPv6 address';

    const allZero = b.every((x) => x === 0);
    if (allZero) return 'unspecified';
    if (b.slice(0, 15).every((x) => x === 0) && b[15] === 1) return 'loopback';

    // Every form that embeds an IPv4 address must be judged on that address.
    // The comment here used to claim IPv4-compatible was handled; only the
    // MAPPED prefix was actually tested, so `::a9fe:a9fe` -- 169.254.169.254,
    // the cloud metadata service, in its IPv4-compatible spelling -- was
    // classified public and allowed.
    const first10Zero = b.slice(0, 10).every((x) => x === 0);
    // ::ffff:0:0/96 (IPv4-mapped)
    if (first10Zero && b[10] === 0xff && b[11] === 0xff) {
      return classifyAddress(`${b[12]}.${b[13]}.${b[14]}.${b[15]}`);
    }
    // ::/96 (IPv4-compatible, deprecated) and ::ffff:0:0:0/96 (SIIT).
    if (first10Zero && b[10] === 0x00 && b[11] === 0x00) {
      return classifyAddress(`${b[12]}.${b[13]}.${b[14]}.${b[15]}`) ?? 'IPv4-compatible address';
    }
    if (b.slice(0, 8).every((x) => x === 0) && b[8] === 0xff && b[9] === 0xff
        && b[10] === 0x00 && b[11] === 0x00) {
      return classifyAddress(`${b[12]}.${b[13]}.${b[14]}.${b[15]}`) ?? 'SIIT translation prefix';
    }
    // NAT64 well-known prefix 64:ff9b::/96 also embeds an IPv4 address.
    if (b[0] === 0x00 && b[1] === 0x64 && b[2] === 0xff && b[3] === 0x9b
        && b.slice(4, 12).every((x) => x === 0)) {
      return classifyAddress(`${b[12]}.${b[13]}.${b[14]}.${b[15]}`) ?? 'NAT64 translation prefix';
    }

    // 2002::/16 (6to4) carries the IPv4 address of the relay in bytes 2-5.
    if (b[0] === 0x20 && b[1] === 0x02) {
      return classifyAddress(`${b[2]}.${b[3]}.${b[4]}.${b[5]}`) ?? '6to4 tunnel prefix';
    }
    if ((b[0]! & 0xfe) === 0xfc) return 'unique local';
    if (b[0] === 0xfe && (b[1]! & 0xc0) === 0x80) return 'link-local';
    if (b[0] === 0xff) return 'multicast';
    return null;
  }

  return 'not an IP address';
}

/** Resolves a hostname and refuses it if ANY resolved address is internal. */
export async function assertPublicHost(hostname: string): Promise<void> {
  const bare = hostname.replace(/^\[|\]$/g, '');

  if (isIP(bare)) {
    const why = classifyAddress(bare);
    if (why) throw new BlockedHostError(hostname, why);
    return;
  }

  if (/^(localhost|.*\.localhost|.*\.local|.*\.internal|.*\.home\.arpa)$/i.test(bare)) {
    throw new BlockedHostError(hostname, 'internal hostname');
  }

  let addresses: Array<{ address: string }>;
  try {
    addresses = await lookup(bare, { all: true });
  } catch {
    throw new BlockedHostError(hostname, 'hostname does not resolve');
  }
  if (addresses.length === 0) throw new BlockedHostError(hostname, 'hostname does not resolve');

  // EVERY address must be public. One internal answer among several is enough
  // for an attacker, because which one gets used is not ours to choose.
  for (const { address } of addresses) {
    const why = classifyAddress(address);
    if (why) throw new BlockedHostError(hostname, `resolves to ${address} (${why})`);
  }
}

export async function assertFetchableUrl(raw: string): Promise<URL> {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new BlockedHostError(raw, 'not a valid URL');
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') {
    throw new BlockedHostError(raw, `scheme "${u.protocol}" is not allowed`);
  }
  if (u.port && !['80', '443', ''].includes(u.port)) {
    throw new BlockedHostError(u.hostname, `port ${u.port} is not allowed`);
  }
  await assertPublicHost(u.hostname);
  return u;
}

// ---------------------------------------------------------------------------

/** Compares two secrets without leaking their length or content through timing. */
export function secretEquals(a: string, b: string): boolean {
  const ha = createHash('sha256').update(a ?? '').digest();
  const hb = createHash('sha256').update(b ?? '').digest();
  return timingSafeEqual(ha, hb) && a.length > 0;
}

/**
 * How an agent API key is stored.
 *
 * CodeQL flags a fast hash here as "insufficient computational effort", and
 * that rule is right about PASSWORDS and wrong about this. bcrypt and scrypt
 * are slow on purpose to make guessing a human-chosen secret expensive. These
 * keys are `newApiKey`'s 24 random bytes -- 192 bits from a CSPRNG. There is
 * no dictionary to try and no cost factor that meaningfully changes the odds
 * of guessing one; all a slow KDF would buy is a deliberate delay on every
 * agent request, which is a denial-of-service lever rather than a defence.
 *
 * What IS worth having is a keyed hash. Plain SHA-256 of a token means anyone
 * who steals the database file can verify guesses offline against it forever.
 * HMAC under the signing secret means a stolen database is inert without also
 * stealing the secret, which lives in the environment and never in the file.
 * Same cost, strictly better posture -- so this is HMAC rather than a bare
 * digest, and deliberately still fast.
 *
 * One consequence, stated because it is a real operational edge: rotating
 * KIRANA_SIGNING_SECRET invalidates every issued agent key. That is the
 * correct behaviour -- rotating the secret SHOULD revoke credentials derived
 * from it -- but if the secret is left unset the server mints an ephemeral one
 * per boot, and then agent keys stop working on restart. config.ts already
 * warns loudly about that case for quotes; it now applies to keys too.
 */
export function hashKey(key: string): string {
  return createHmac('sha256', config.signingSecret).update(key).digest('hex');
}

export function newApiKey(prefix: string): string {
  return `${prefix}_${randomBytes(24).toString('base64url')}`;
}

// ---------------------------------------------------------------------------

interface Bucket { count: number; resetAt: number; }
const buckets = new Map<string, Bucket>();

/**
 * Fixed-window rate limit, in memory. Not distributed and not meant to be --
 * it exists so one buyer agent cannot spin the quote engine or the ingest
 * crawler at machine speed, which is a real risk when your users are programs.
 */
export function rateLimit(key: string, limit: number, windowMs: number): { ok: boolean; retryAfterMs: number } {
  const now = Date.now();
  const b = buckets.get(key);
  if (!b || now >= b.resetAt) {
    buckets.set(key, { count: 1, resetAt: now + windowMs });
    return { ok: true, retryAfterMs: 0 };
  }
  b.count++;
  if (b.count > limit) return { ok: false, retryAfterMs: b.resetAt - now };
  return { ok: true, retryAfterMs: 0 };
}

export function resetRateLimits(): void {
  buckets.clear();
}

/** Periodic sweep so the map cannot grow without bound. */
const sweeper = setInterval(() => {
  const now = Date.now();
  for (const [k, b] of buckets) if (now >= b.resetAt) buckets.delete(k);
}, 60_000);
sweeper.unref();
