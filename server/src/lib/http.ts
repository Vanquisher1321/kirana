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
  'user-agent': 'NexusBot/0.1 (+agent-commerce ingestion; contact: merchant console)',
  'accept-language': 'en-IN,en;q=0.9',
};

const MAX_REDIRECTS = 3;

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
export function makeFetch(timeoutMs = 15_000, opts: { guard?: boolean } = {}): FetchLike {
  const guard = opts.guard !== false;
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

        if (!guard || res.status < 300 || res.status >= 400) return res;

        const location = res.headers.get('location');
        if (!location) return res;

        const next = new URL(location, current);
        if (next.protocol !== 'https:' && next.protocol !== 'http:') {
          throw new Error(`Refusing to follow a redirect to ${next.protocol}`);
        }
        await assertPublicHost(next.hostname);
        current = next.toString();
      } finally {
        clearTimeout(timer);
      }
    }
    throw new Error(`Too many redirects (more than ${MAX_REDIRECTS}) starting from ${String(url)}`);
  };
}
