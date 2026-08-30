import { lookup } from 'node:dns/promises';
import { timingSafeEqual, createHash, randomBytes } from 'node:crypto';
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
  ['192.168.0.0', 16, 'private network'],
  ['198.18.0.0', 15, 'benchmarking'],
  ['224.0.0.0', 4, 'multicast'],
  ['240.0.0.0', 4, 'reserved'],
];

export function classifyAddress(addr: string): string | null {
  const family = isIP(addr);
  if (family === 4) {
    const v = ipv4ToInt(addr);
    for (const [base, bits, why] of BLOCKED_V4) {
      const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
      if ((v & mask) === (ipv4ToInt(base) & mask)) return why;
    }
    return null;
  }
  if (family === 6) {
    const a = addr.toLowerCase().replace(/^\[|\]$/g, '');
    if (a === '::1' || a === '::') return 'loopback';
    if (a.startsWith('fe80')) return 'link-local';
    if (a.startsWith('fc') || a.startsWith('fd')) return 'unique local';
    // IPv4-mapped (::ffff:127.0.0.1) is IPv4 wearing a hat.
    const mapped = a.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped) return classifyAddress(mapped[1]!);
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

export function hashKey(key: string): string {
  return createHash('sha256').update(key).digest('hex');
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
