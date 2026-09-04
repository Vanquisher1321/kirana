import { db, nowIso } from '../lib/db.ts';
import { id } from '../lib/id.ts';
import { record } from '../audit/ledger.ts';
import { getAgent, agentWorkspace } from './agents.ts';
import { killSwitchActive } from './guard.ts';

/**
 * Standing authorisation — the human's answer, given in advance.
 *
 * The rest of this codebase rests on one rule: an agent may request consent and
 * may never grant it. Auto-approval is the obvious way to break that rule by
 * accident, so it is built to keep it. A standing rule is not the agent gaining
 * a right; it is a PERSON deciding earlier, from the console, with a ceiling and
 * an end date attached. When a request matches, the grant is issued on that
 * person's authority and their name is on it. There is still no argument an
 * agent can pass that approves itself, and no code path here that an agent can
 * reach.
 *
 * This is the mandate model consent.ts already cites: UPI Autopay is a human
 * pre-authorising a bounded, revocable, expiring instruction — not a merchant
 * being handed the account.
 *
 * Four bounds, none of them optional:
 *   - a per-order ceiling, so one basket cannot be arbitrarily large;
 *   - a rolling daily ceiling, so many small baskets cannot add up past it;
 *   - an expiry, so forgetting about a rule ends it rather than extending it;
 *   - instant revocation.
 * On top of those, the agent's identity must have been PROVEN with a key, for
 * the reason agentCaps() gives: a raised ceiling granted on a name anyone can
 * type is not a ceiling.
 */

export interface StandingRule {
  id: string;
  workspaceId: string | null;
  agentId: string | null;
  perOrderCapMinor: number;
  dailyCapMinor: number;
  createdBy: string;
  createdAt: string;
  expiresAt: string;
  revokedAt: string | null;
}

export const MAX_STANDING_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
export const DEFAULT_STANDING_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export class StandingError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'StandingError';
    this.code = code;
  }
}

function rowToRule(r: Record<string, unknown>): StandingRule {
  return {
    id: String(r.id),
    workspaceId: (r.workspace_id as string | null) ?? null,
    agentId: (r.agent_id as string | null) ?? null,
    perOrderCapMinor: Number(r.per_order_cap_minor),
    dailyCapMinor: Number(r.daily_cap_minor),
    createdBy: String(r.created_by),
    createdAt: String(r.created_at),
    expiresAt: String(r.expires_at),
    revokedAt: (r.revoked_at as string | null) ?? null,
  };
}

/** Console-only. Nothing on the agent-facing surface calls this. */
export function createStandingRule(input: {
  workspaceId: string | null;
  agentId: string | null;
  perOrderCapMinor: number;
  dailyCapMinor: number;
  createdBy: string;
  ttlMs?: number;
}): StandingRule {
  const { perOrderCapMinor, dailyCapMinor } = input;
  if (!Number.isSafeInteger(perOrderCapMinor) || perOrderCapMinor <= 0) {
    throw new StandingError('bad_cap', 'The per-order ceiling must be a positive whole number of paise.');
  }
  if (!Number.isSafeInteger(dailyCapMinor) || dailyCapMinor <= 0) {
    throw new StandingError('bad_cap', 'The daily ceiling must be a positive whole number of paise.');
  }
  // A daily ceiling below the per-order one is almost always a typo, and the
  // shape it produces -- a rule that can never fire -- is confusing rather than
  // safe. Refusing it here is kinder than silently never auto-approving.
  if (dailyCapMinor < perOrderCapMinor) {
    throw new StandingError('daily_below_order', 'The daily ceiling cannot be lower than the per-order ceiling.');
  }
  const ttl = Math.min(input.ttlMs ?? DEFAULT_STANDING_TTL_MS, MAX_STANDING_TTL_MS);
  if (ttl <= 0) throw new StandingError('bad_ttl', 'A standing rule must expire in the future.');

  // An unverified agent can never use a standing rule, so letting someone
  // create one against it would be a promise the guard will not keep.
  if (input.agentId) {
    const a = getAgent(input.agentId);
    if (!a) throw new StandingError('agent_not_found', `No agent ${input.agentId}.`);
    if (!a.verified) {
      throw new StandingError(
        'agent_unverified',
        'This assistant has not proven its identity with a key, so it cannot be given a standing approval. Issue it a key first.',
      );
    }
  }

  const rule: StandingRule = {
    id: id('rule'),
    workspaceId: input.workspaceId,
    agentId: input.agentId,
    perOrderCapMinor,
    dailyCapMinor,
    createdBy: input.createdBy,
    createdAt: nowIso(),
    expiresAt: new Date(Date.now() + ttl).toISOString(),
    revokedAt: null,
  };
  db.prepare(
    `INSERT INTO standing_rules
       (id, workspace_id, agent_id, per_order_cap_minor, daily_cap_minor, created_by, created_at, expires_at, revoked_at)
     VALUES (?,?,?,?,?,?,?,?,NULL)`,
  ).run(rule.id, rule.workspaceId, rule.agentId, rule.perOrderCapMinor, rule.dailyCapMinor, rule.createdBy, rule.createdAt, rule.expiresAt);

  record({
    actor: `human:${rule.createdBy}`,
    action: 'standing.created',
    subjectId: rule.id,
    outcome: 'ok',
    detail: {
      agentId: rule.agentId, perOrderCapMinor: rule.perOrderCapMinor,
      dailyCapMinor: rule.dailyCapMinor, expiresAt: rule.expiresAt,
    },
    workspaceId: rule.workspaceId,
  });
  return rule;
}

export function listStandingRules(workspaceId?: string | null): StandingRule[] {
  const rows = workspaceId === undefined
    ? db.prepare('SELECT * FROM standing_rules ORDER BY created_at DESC').all()
    : db.prepare('SELECT * FROM standing_rules WHERE workspace_id IS ? ORDER BY created_at DESC').all(workspaceId);
  return (rows as Record<string, unknown>[]).map(rowToRule);
}

export function getStandingRule(ruleId: string): StandingRule | null {
  const r = db.prepare('SELECT * FROM standing_rules WHERE id = ?').get(ruleId) as Record<string, unknown> | undefined;
  return r ? rowToRule(r) : null;
}

/** Instant and unilateral, like the kill switch and revokeConsent. */
export function revokeStandingRule(ruleId: string, by = 'human'): StandingRule {
  const rule = getStandingRule(ruleId);
  if (!rule) throw new StandingError('not_found', `No standing rule ${ruleId}.`);
  db.prepare('UPDATE standing_rules SET revoked_at = ? WHERE id = ?').run(nowIso(), ruleId);
  record({
    actor: `human:${by}`, action: 'standing.revoked', subjectId: ruleId, outcome: 'ok',
    detail: { agentId: rule.agentId }, workspaceId: rule.workspaceId,
  });
  return getStandingRule(ruleId)!;
}

export function isLive(rule: StandingRule, now = Date.now()): boolean {
  return rule.revokedAt === null && Date.parse(rule.expiresAt) > now;
}

/**
 * What this rule has already committed in the last 24 hours.
 *
 * Counted as the sum of the CAPS it auto-granted, not the amounts finally
 * charged. A cap is what the rule actually authorised, it is known the instant
 * the grant is issued, and it is never lower than the charge -- so the daily
 * ceiling binds on the promise rather than trailing behind the settlement. It
 * over-counts when a basket comes in under its cap, which is the direction a
 * ceiling should err in.
 *
 * Grants that were revoked or rejected afterwards do not count against it.
 */
export function committedTodayMinor(ruleId: string, now = Date.now()): number {
  const since = new Date(now - 24 * 60 * 60 * 1000).toISOString();
  const r = db.prepare(
    `SELECT COALESCE(SUM(cap_minor), 0) AS total FROM consents
     WHERE standing_rule_id = ? AND granted_at >= ? AND status NOT IN ('revoked','rejected')`,
  ).get(ruleId, since) as { total?: number } | undefined;
  return Number(r?.total ?? 0);
}

export interface StandingMatch {
  rule: StandingRule;
  headroomMinor: number;
}

/**
 * Does a live rule cover this request?
 *
 * Returns the rule, or null with nothing said — a request that finds no rule is
 * the ordinary case and simply stays pending for a human. Every reason to
 * refuse is a reason to fall back to asking, never to fail the request.
 */
export function matchStandingRule(input: {
  agentId: string | null;
  identityProven: boolean;
  capMinor: number;
  now?: number;
}): StandingMatch | null {
  const now = input.now ?? Date.now();

  // A stopped system approves nothing, including in advance.
  if (killSwitchActive()) return null;

  // The rule from agentCaps(), restated: a name anyone can type earns nothing.
  if (!input.agentId || !input.identityProven) return null;
  const agent = getAgent(input.agentId);
  if (!agent || !agent.verified) return null;

  const rows = db.prepare(
    `SELECT * FROM standing_rules
     WHERE revoked_at IS NULL AND expires_at > ?
       AND (agent_id = ? OR (agent_id IS NULL AND workspace_id IS ?))
     ORDER BY per_order_cap_minor ASC`,
  ).all(new Date(now).toISOString(), input.agentId, agentWorkspace(input.agentId)) as Record<string, unknown>[];

  for (const row of rows) {
    const rule = rowToRule(row);
    if (input.capMinor > rule.perOrderCapMinor) continue;
    const headroom = rule.dailyCapMinor - committedTodayMinor(rule.id, now);
    if (input.capMinor > headroom) continue;
    return { rule, headroomMinor: headroom };
  }
  return null;
}
