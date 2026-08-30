import { createHash } from 'node:crypto';
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
  createdAt: string;
}

function rowToAgent(r: Record<string, unknown>): Agent {
  return {
    id: String(r.id), label: String(r.label),
    dailyCapMinor: Number(r.daily_cap_minor), perOrderCapMinor: Number(r.per_order_cap_minor),
    active: Number(r.active) === 1, createdAt: String(r.created_at),
  };
}

export function getAgent(agentId: string): Agent | null {
  const r = db.prepare('SELECT * FROM agents WHERE id = ?').get(agentId) as Record<string, unknown> | undefined;
  return r ? rowToAgent(r) : null;
}

/** Idempotent. Returns null for the anonymous caller so callers can pass through. */
export function ensureAgent(agentId: string | null, label?: string): Agent | null {
  if (!agentId) return null;
  const existing = getAgent(agentId);
  if (existing) return existing;

  const agent: Agent = {
    id: agentId,
    label: label ?? agentId,
    dailyCapMinor: ANON_DAILY_CAP_MINOR,
    perOrderCapMinor: ANON_PER_ORDER_CAP_MINOR,
    active: true,
    createdAt: nowIso(),
  };
  db.prepare(
    `INSERT INTO agents (id, label, api_key_hash, daily_cap_minor, per_order_cap_minor, active, created_at)
     VALUES (?,?,?,?,?,1,?)`,
  ).run(agent.id, agent.label, createHash('sha256').update(agent.id).digest('hex'),
    agent.dailyCapMinor, agent.perOrderCapMinor, agent.createdAt);

  record({
    actor: 'system',
    action: 'agent.registered',
    subjectId: agent.id,
    outcome: 'ok',
    detail: {
      label: agent.label, firstSeen: agent.createdAt,
      perOrderCapMinor: agent.perOrderCapMinor, dailyCapMinor: agent.dailyCapMinor,
      note: 'Auto-registered on first contact with default caps.',
    },
  });

  return agent;
}

export function listAgents(): Agent[] {
  return (db.prepare('SELECT * FROM agents ORDER BY created_at DESC').all() as Record<string, unknown>[]).map(rowToAgent);
}

export function setAgentCaps(agentId: string, perOrderMinor: number, dailyMinor: number, by = 'human'): Agent | null {
  const a = getAgent(agentId);
  if (!a) return null;
  db.prepare('UPDATE agents SET per_order_cap_minor = ?, daily_cap_minor = ? WHERE id = ?').run(perOrderMinor, dailyMinor, agentId);
  record({
    actor: `human:${by}`, action: 'agent.caps_changed', subjectId: agentId, outcome: 'ok',
    detail: { from: { perOrder: a.perOrderCapMinor, daily: a.dailyCapMinor }, to: { perOrder: perOrderMinor, daily: dailyMinor } },
  });
  return getAgent(agentId);
}
