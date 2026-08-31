import { hashKey, newApiKey } from '../lib/security.ts';
import { db, nowIso } from '../lib/db.ts';
import { record } from '../audit/ledger.ts';
import { ANON_PER_ORDER_CAP_MINOR, ANON_DAILY_CAP_MINOR } from './guard.ts';

/**
 * Buyer agents are identified, not anonymous.
 *
 * An agent that has never been seen before is auto-registered on first contact
 * with the conservative default caps rather than being refused. The reasoning:
 * refusing unknown agents would make the system useless in an ecosystem whose
 * whole point is that any agent can walk up to any shop, while letting them in
 * uncapped would be reckless. So: let them in, cap them low, and record the
 * moment they first appeared. Raising a cap is a deliberate human act.
 */

export interface Agent {
  id: string;
  label: string;
  dailyCapMinor: number;
  perOrderCapMinor: number;
  active: boolean;
  /**
   * True only when the agent proved possession of an issued key. A name in a
   * header proves nothing -- any caller can claim to be any agent -- so
   * unverified agents are permanently pinned to the conservative default caps
   * and cannot have them raised.
   */
  verified: boolean;
  createdAt: string;
}

function rowToAgent(r: Record<string, unknown>): Agent {
  return {
    id: String(r.id), label: String(r.label),
    dailyCapMinor: Number(r.daily_cap_minor), perOrderCapMinor: Number(r.per_order_cap_minor),
    active: Number(r.active) === 1, verified: Number(r.verified ?? 0) === 1,
    createdAt: String(r.created_at),
  };
}

/** Which tenant an agent was first seen in. */
export function agentWorkspace(agentId: string): string | null {
  const r = db.prepare('SELECT workspace_id AS ws FROM agents WHERE id = ?').get(agentId) as { ws?: string | null } | undefined;
  return (r?.ws as string | null) ?? null;
}

export function getAgent(agentId: string): Agent | null {
  const r = db.prepare('SELECT * FROM agents WHERE id = ?').get(agentId) as Record<string, unknown> | undefined;
  return r ? rowToAgent(r) : null;
}

/** Idempotent. Returns null for the anonymous caller so callers can pass through. */
export function ensureAgent(agentId: string | null, label?: string, workspaceId: string | null = null): Agent | null {
  if (!agentId) return null;
  const existing = getAgent(agentId);
  if (existing) return existing;

  const agent: Agent = {
    id: agentId,
    label: label ?? agentId,
    dailyCapMinor: ANON_DAILY_CAP_MINOR,
    perOrderCapMinor: ANON_PER_ORDER_CAP_MINOR,
    active: true,
    verified: false,
    createdAt: nowIso(),
  };
  db.prepare(
    `INSERT INTO agents (id, label, api_key_hash, daily_cap_minor, per_order_cap_minor, active, verified, created_at)
     VALUES (?,?,?,?,?,1,0,?)`,
  ).run(agent.id, agent.label, hashKey(`unverified:${agent.id}`),
    agent.dailyCapMinor, agent.perOrderCapMinor, agent.createdAt);
  if (workspaceId) db.prepare('UPDATE agents SET workspace_id = ? WHERE id = ?').run(workspaceId, agent.id);

  record({
    actor: 'system',
    action: 'agent.registered',
    subjectId: agent.id,
    outcome: 'ok',
    detail: {
      label: agent.label, firstSeen: agent.createdAt,
      perOrderCapMinor: agent.perOrderCapMinor, dailyCapMinor: agent.dailyCapMinor,
      verified: false,
      note: 'Auto-registered on first contact. Identity is self-asserted, so caps stay at the default until a key is issued.',
    },
  });

  return agent;
}

export function listAgents(workspaceId?: string | null): Agent[] {
  const rows = workspaceId === undefined
    ? db.prepare('SELECT * FROM agents ORDER BY created_at DESC').all()
    : db.prepare('SELECT * FROM agents WHERE workspace_id IS ? ORDER BY created_at DESC').all(workspaceId);
  return (rows as Record<string, unknown>[]).map(rowToAgent);
}

/** Issues a real key. The plaintext is returned once and never stored. */
export function issueAgentKey(agentId: string, label: string, by = 'human', opts: { rotate?: boolean } = {}): { agent: Agent; apiKey: string } {
  const apiKey = newApiKey('kag');
  const existing = getAgent(agentId);
  if (existing?.verified && !opts.rotate) {
    // Re-issuing silently would let anyone who reaches this endpoint replace a
    // trusted agent's credential and inherit its ceilings.
    throw new Error(`Agent ${agentId} already has a key. Rotating it revokes the existing one; pass rotate to confirm.`);
  }
  if (existing) {
    db.prepare('UPDATE agents SET api_key_hash = ?, verified = 1, label = ? WHERE id = ?').run(hashKey(apiKey), label, agentId);
  } else {
    db.prepare(
      `INSERT INTO agents (id, label, api_key_hash, daily_cap_minor, per_order_cap_minor, active, verified, created_at)
       VALUES (?,?,?,?,?,1,1,?)`,
    ).run(agentId, label, hashKey(apiKey), ANON_DAILY_CAP_MINOR, ANON_PER_ORDER_CAP_MINOR, nowIso());
  }
  record({
    actor: `human:${by}`, action: 'agent.key_issued', subjectId: agentId, outcome: 'ok',
    detail: { label, note: 'Key hash stored; the key itself is shown once and never persisted.' },
  });
  return { agent: getAgent(agentId)!, apiKey };
}

/** Resolves a presented key to an agent. Returns null when the key is unknown. */
export function agentForKey(apiKey: string): Agent | null {
  if (!apiKey) return null;
  const r = db.prepare('SELECT * FROM agents WHERE api_key_hash = ? AND active = 1 AND verified = 1').get(hashKey(apiKey)) as Record<string, unknown> | undefined;
  return r ? rowToAgent(r) : null;
}

export function setAgentCaps(agentId: string, perOrderMinor: number, dailyMinor: number, by = 'human'): Agent | null {
  const a = getAgent(agentId);
  if (!a) return null;
  if (!Number.isSafeInteger(perOrderMinor) || perOrderMinor <= 0 || !Number.isSafeInteger(dailyMinor) || dailyMinor <= 0) {
    throw new Error('Caps must be positive whole numbers of paise.');
  }
  if (perOrderMinor > dailyMinor) {
    throw new Error('A per-order cap above the daily cap cannot be honoured.');
  }
  if (!a.verified) {
    // Raising the ceiling on an identity nobody proved would let any caller
    // inherit it just by sending the same header value.
    throw new Error(`Agent ${agentId} is unverified (identity is self-asserted). Issue it a key before changing its caps.`);
  }
  db.prepare('UPDATE agents SET per_order_cap_minor = ?, daily_cap_minor = ? WHERE id = ?').run(perOrderMinor, dailyMinor, agentId);
  record({
    actor: `human:${by}`, action: 'agent.caps_changed', subjectId: agentId, outcome: 'ok',
    detail: { from: { perOrder: a.perOrderCapMinor, daily: a.dailyCapMinor }, to: { perOrder: perOrderMinor, daily: dailyMinor } },
  });
  return getAgent(agentId);
}
