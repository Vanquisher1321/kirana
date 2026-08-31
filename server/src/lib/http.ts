import type { FetchLike } from '../types.ts';
import { assertFetchableUrl, assertPublicHost } from './security.ts';

/**
 * Transport helpers, deliberately free of any database import so that tools
 * which only need to READ the web (the probe CLI, adapter tests) do not drag in
 * -- or lock -- the SQLite file.
 */

export function normaliseOrigin(input: string): string {
  const withScheme = /^https?:\/\//i.test(input) ? input : `https://${input}`;
  const u = new URL(withScheme);
  u.protocol = 'https:';
  return `${u.protocol}//${u.host}`;
}

const DEFAULT_HEADERS = {
  'user-agent': 'KiranaBot/0.1 (+agent-commerce ingestion; contact: merchant console)',
  'accept-language': 'en-IN,en;q=0.9',
};

const MAX_REDIRECTS = 3;

/**
 * How much decoded body we are willing to take from a shop we do not control.
 * A storefront page of 500 products is well under a megabyte; eight is
 * generous and still survivable on a 512 MB instance.
 */
const MAX_BODY_BYTES = 8 * 1024 * 1024;

/**
 * Read the body under BOTH a byte cap and the request deadline.
 *
 * The timeout used to be cleared as soon as the headers arrived, so neither
 * limit reached the body -- and `res.json()` was then called on it with no cap
 * at all. Two things walked straight through:
 *
 *   - a gzip bomb: 782 KB on the wire decompressed to 204 MB of JSON and took
 *     the process past 600 MB of RSS, which on a 512 MB free-tier instance is
 *     an OOM kill triggered by one request;
 *   - a storefront that sends headers immediately and then dribbles the body
 *     forever, pinning an ingestion worker and its buffer with no deadline.
 *
 * `content-length` is no defence against either: the bomb declares 782 KB
 * honestly, and the dribbler declares nothing. Only counting decoded bytes as
 * they arrive works.
 */
async function readCapped(res: Response, maxBytes: number): Promise<Response> {
  if (!res.body) return res;
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => {});
      throw new Error(`Response body exceeded ${Math.round(maxBytes / 1024 / 1024)}MB; refused.`);
    }
    chunks.push(value);
  }
  const body = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) { body.set(c, at); at += c.byteLength; }
  return new Response(body, { status: res.status, statusText: res.statusText, headers: res.headers });
}

/**
 * Fetch with a timeout, an identifying user-agent, and SSRF protection that
 * survives redirects.
 *
 * Following redirects automatically would undo the host check entirely: a
 * perfectly public URL can answer `302 Location: http://169.254.169.254/`, and
 * an auto-following client walks straight into the private network on the
 * attacker's behalf. So redirects are handled manually and every hop is
 * re-validated before it is followed.
 */
export function makeFetch(timeoutMs = 15_000, opts: { guard?: boolean; maxBytes?: number } = {}): FetchLike {
  const guard = opts.guard !== false;
  const maxBytes = opts.maxBytes ?? MAX_BODY_BYTES;
  return async (url, init) => {
    let current = String(url);
    if (guard) await assertFetchableUrl(current);

    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), timeoutMs);
      try {
        const res = await fetch(current, {
          ...init,
          signal: ctl.signal,
          redirect: guard ? 'manual' : 'follow',
          headers: { ...DEFAULT_HEADERS, ...(init?.headers as Record<string, string> | undefined) },
        });

        // The deadline and the cap have to cover the BODY, not just the
        // headers -- which is why the read happens here, inside the try, while
        // the abort timer is still armed.
        if (!guard || res.status < 300 || res.status >= 400) return await readCapped(res, maxBytes);

        const location = res.headers.get('location');
        if (!location) return await readCapped(res, maxBytes);

        // Re-run the FULL check on every hop, not just the host. The previous
        // version validated the hostname alone, so a redirect could still
        // downgrade the scheme or point at an arbitrary internal port.
        const next = new URL(location, current);
        await assertFetchableUrl(next.toString());
        current = next.toString();
      } finally {
        clearTimeout(timer);
      }
    }
    throw new Error(`Too many redirects (more than ${MAX_REDIRECTS}) starting from ${String(url)}`);
  };
}
