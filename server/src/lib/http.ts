import type { FetchLike } from '../types.ts';

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

/** Timeout plus an identifying user-agent. Politeness is not optional when reading someone's shop. */
export function makeFetch(timeoutMs = 15_000): FetchLike {
  return async (url, init) => {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeoutMs);
    try {
      return await fetch(url, {
        ...init,
        signal: ctl.signal,
        headers: { ...DEFAULT_HEADERS, ...(init?.headers as Record<string, string> | undefined) },
      });
    } finally {
      clearTimeout(timer);
    }
  };
}
