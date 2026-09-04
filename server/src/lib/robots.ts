import type { FetchLike } from '../types.ts';

/**
 * robots.txt, consulted before reading a stranger's catalogue.
 *
 * The feed Kirana reads is public and unauthenticated, and on a default Shopify
 * store nothing here refuses anything -- /products.json is not disallowed. So
 * this file changes almost no outcome, which is exactly why it is worth having:
 * "we read public data" and "we read public data and respect what the site asked
 * for" are different claims, and only one of them survives being asked about by
 * the merchant whose shop was read.
 *
 * Deliberately small. This is not a crawler; it fetches one path per shop and
 * needs to answer one question about it.
 */

export interface RobotsVerdict {
  allowed: boolean;
  /** The line that refused, so a refusal can explain itself to the merchant. */
  rule?: string;
}

interface Group {
  agents: string[];
  rules: Array<{ allow: boolean; path: string }>;
}

/** Parse only what is needed: user-agent groups and their allow/disallow paths. */
export function parseRobots(text: string): Group[] {
  const groups: Group[] = [];
  let current: Group | null = null;
  let lastWasAgent = false;

  for (const raw of text.split(/\r?\n/)) {
    const line = raw.split('#')[0]!.trim();
    if (!line) continue;
    const idx = line.indexOf(':');
    if (idx < 0) continue;
    const field = line.slice(0, idx).trim().toLowerCase();
    const value = line.slice(idx + 1).trim();

    if (field === 'user-agent') {
      // Consecutive User-agent lines share one group of rules.
      if (!current || !lastWasAgent) {
        current = { agents: [], rules: [] };
        groups.push(current);
      }
      current.agents.push(value.toLowerCase());
      lastWasAgent = true;
      continue;
    }
    lastWasAgent = false;
    if (!current) continue;
    if (field === 'allow' || field === 'disallow') {
      // "Disallow:" with nothing after it allows everything, and is not a rule
      // that can match a path -- dropping it is what makes the empty-value case
      // behave the way the standard says.
      if (field === 'disallow' && value === '') continue;
      current.rules.push({ allow: field === 'allow', path: value });
    }
  }
  return groups;
}

/** Does a robots path pattern match this path? Supports * and a trailing $. */
function matches(pattern: string, path: string): boolean {
  if (pattern === '') return false;
  const anchored = pattern.endsWith('$');
  const body = anchored ? pattern.slice(0, -1) : pattern;
  const parts = body.split('*').map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  const re = new RegExp('^' + parts.join('.*') + (anchored ? '$' : ''));
  return re.test(path);
}

/**
 * The verdict for one path.
 *
 * The most specific rule wins, which is the longest matching pattern; on a tie
 * Allow beats Disallow, because a site that wrote both meant the exception.
 */
export function verdictFor(groups: Group[], path: string, agent: string): RobotsVerdict {
  const lower = agent.toLowerCase();
  const mine = groups.filter((g) => g.agents.some((a) => a !== '*' && lower.includes(a)));
  const star = groups.filter((g) => g.agents.includes('*'));
  const chosen = mine.length ? mine : star;

  let best: { allow: boolean; len: number; path: string } | null = null;
  for (const g of chosen) {
    for (const r of g.rules) {
      if (!matches(r.path, path)) continue;
      if (!best || r.path.length > best.len || (r.path.length === best.len && r.allow)) {
        best = { allow: r.allow, len: r.path.length, path: r.path };
      }
    }
  }
  if (!best || best.allow) return { allowed: true };
  return { allowed: false, rule: `Disallow: ${best.path}` };
}

/**
 * Fetch and evaluate. Fails OPEN, deliberately: an unreachable or missing
 * robots.txt is the web's long-standing "no preference stated", and treating a
 * timeout as a refusal would make ingestion depend on a file most shops do not
 * think about.
 */
export async function robotsAllows(
  origin: string,
  path: string,
  fetchImpl: FetchLike,
  agent = 'KiranaBot',
): Promise<RobotsVerdict> {
  try {
    const res = await fetchImpl(`${origin}/robots.txt`, { method: 'GET' });
    if (!res.ok) return { allowed: true };
    const type = res.headers.get('content-type') ?? '';
    // A storefront that answers every unknown path with its HTML shell would
    // otherwise have its homepage parsed as rules.
    if (type && !type.includes('text/plain')) return { allowed: true };
    return verdictFor(parseRobots(await res.text()), path, agent);
  } catch {
    return { allowed: true };
  }
}
