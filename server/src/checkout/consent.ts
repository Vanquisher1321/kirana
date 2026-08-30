import { db, nowIso } from '../lib/db.ts';
import { id } from '../lib/id.ts';
import { record } from '../audit/ledger.ts';
import { ensureAgent } from './agents.ts';

/**
 * Consent, shaped after UPI Reserve Pay: a human pre-authorises a CAP for a
 * SCOPE for a LIMITED TIME, and can revoke it instantly. The agent never holds
 * an open-ended right to spend.
 *
 * The cap is the human's number, not the agent's. Nothing in this file lets an
 * agent raise its own cap, and there is no code path that mutates cap_minor
 * after the grant -- which is the property that actually matters.
 */

export const DEFAULT_CONSENT_TTL_MS = 15 * 60 * 1000;

export interface Consent {
  id: string;
  quoteId: string;
  agentId: string | null;
  capMinor: number;
  scope: string;
  grantedBy: string;
  grantedAt: string;
  expiresAt: string;
  revokedAt: string | null;
  status: 'pending' | 'granted' | 'consumed' | 'revoked' | 'expired' | 'rejected';
}

export class ConsentError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'ConsentError';
    this.code = code;
  }
}

/**
 * An agent may REQUEST approval. It cannot grant it.
 *
 * This split is the point of the whole module: the request path is reachable by
 * the agent, the approval path is only reachable from the human console. There
 * is no argument an agent can pass that turns a request into a grant.
 */
export function requestConsent(input: {
  quoteId: string;
  agentId: string | null;
  capMinor: number;
  scope: string;
  ttlMs?: number;
}): Consent {
  if (!Number.isSafeInteger(input.capMinor) || input.capMinor <= 0) {
    throw new ConsentError('bad_cap', 'A spending cap must be a positive whole number of paise.');
  }
  ensureAgent(input.agentId);
  const now = Date.now();
  const consent: Consent = {
    id: id('csnt'),
    quoteId: input.quoteId,
    agentId: input.agentId,
    capMinor: input.capMinor,
    scope: input.scope,
    grantedBy: '',
    grantedAt: '',
    expiresAt: new Date(now + (input.ttlMs ?? DEFAULT_CONSENT_TTL_MS)).toISOString(),
    revokedAt: null,
    status: 'pending',
  };
  db.prepare(
    `INSERT INTO consents (id, quote_id, agent_id, cap_minor, scope, granted_by, granted_at, expires_at, revoked_at, status)
     VALUES (?,?,?,?,?,'','',?,NULL,'pending')`,
  ).run(consent.id, consent.quoteId, consent.agentId, consent.capMinor, consent.scope, consent.expiresAt);

  record({
    actor: input.agentId ? `agent:${input.agentId}` : 'agent:anonymous',
    action: 'consent.requested',
    subjectId: consent.id,
    outcome: 'ok',
    detail: { quoteId: consent.quoteId, capMinor: consent.capMinor, scope: consent.scope, expiresAt: consent.expiresAt },
  });
  return consent;
}

/** Human-only. Turns a pending request into a live approval. */
export function approveConsent(consentId: string, by: string): Consent {
  const c = getConsent(consentId);
  if (!c) throw new ConsentError('not_found', `No approval request ${consentId}.`);
  if (c.status !== 'pending') throw new ConsentError('not_pending', `Request is already ${c.status}.`);
  const at = nowIso();
  db.prepare("UPDATE consents SET status='granted', granted_by=?, granted_at=? WHERE id=?").run(by, at, consentId);
  record({
    actor: `human:${by}`, action: 'consent.granted', subjectId: consentId, outcome: 'ok',
    detail: { quoteId: c.quoteId, capMinor: c.capMinor, scope: c.scope, expiresAt: c.expiresAt, agentId: c.agentId },
  });
  return getConsent(consentId)!;
}

export function rejectConsent(consentId: string, by: string): Consent {
  const c = getConsent(consentId);
  if (!c) throw new ConsentError('not_found', `No approval request ${consentId}.`);
  db.prepare("UPDATE consents SET status='rejected' WHERE id=?").run(consentId);
  record({
    actor: `human:${by}`, action: 'consent.rejected', subjectId: consentId, outcome: 'blocked',
    detail: { quoteId: c.quoteId, capMinor: c.capMinor },
  });
  return getConsent(consentId)!;
}

export function listPendingConsents(): Consent[] {
  const rows = db.prepare("SELECT * FROM consents WHERE status='pending' ORDER BY expires_at ASC").all() as Record<string, unknown>[];
  return rows.map(rowToConsent);
}

export function grantConsent(input: {
  quoteId: string;
  agentId: string | null;
  capMinor: number;
  scope: string;
  grantedBy: string;
  ttlMs?: number;
}): Consent {
  if (!Number.isSafeInteger(input.capMinor) || input.capMinor <= 0) {
    throw new ConsentError('bad_cap', 'A spending cap must be a positive whole number of paise.');
  }
  ensureAgent(input.agentId);

  const now = Date.now();
  const consent: Consent = {
    id: id('csnt'),
    quoteId: input.quoteId,
    agentId: input.agentId,
    capMinor: input.capMinor,
    scope: input.scope,
    grantedBy: input.grantedBy,
    grantedAt: new Date(now).toISOString(),
    expiresAt: new Date(now + (input.ttlMs ?? DEFAULT_CONSENT_TTL_MS)).toISOString(),
    revokedAt: null,
    status: 'granted',
  };

  db.prepare(
    `INSERT INTO consents (id, quote_id, agent_id, cap_minor, scope, granted_by, granted_at, expires_at, revoked_at, status)
     VALUES (?,?,?,?,?,?,?,?,NULL,'granted')`,
  ).run(consent.id, consent.quoteId, consent.agentId, consent.capMinor, consent.scope, consent.grantedBy, consent.grantedAt, consent.expiresAt);

  record({
    actor: `human:${input.grantedBy}`,
    action: 'consent.granted',
    subjectId: consent.id,
    outcome: 'ok',
    detail: { quoteId: consent.quoteId, capMinor: consent.capMinor, scope: consent.scope, expiresAt: consent.expiresAt, agentId: consent.agentId },
  });

  return consent;
}

function rowToConsent(r: Record<string, unknown>): Consent {
  return {
    id: String(r.id), quoteId: String(r.quote_id),
    agentId: (r.agent_id as string | null) ?? null,
    capMinor: Number(r.cap_minor), scope: String(r.scope),
    grantedBy: String(r.granted_by), grantedAt: String(r.granted_at),
    expiresAt: String(r.expires_at), revokedAt: (r.revoked_at as string | null) ?? null,
    status: r.status as Consent['status'],
  };
}

export function getConsent(consentId: string): Consent | null {
  const r = db.prepare('SELECT * FROM consents WHERE id = ?').get(consentId) as Record<string, unknown> | undefined;
  return r ? rowToConsent(r) : null;
}

export function markConsent(consentId: string, status: Consent['status']): void {
  db.prepare('UPDATE consents SET status = ? WHERE id = ?').run(status, consentId);
}

/** The revoke button. Instant, unilateral, and logged. */
export function revokeConsent(consentId: string, by = 'human'): Consent {
  const c = getConsent(consentId);
  if (!c) throw new ConsentError('not_found', `No consent ${consentId}.`);
  db.prepare("UPDATE consents SET status='revoked', revoked_at=? WHERE id=?").run(nowIso(), consentId);
  record({
    actor: `human:${by}`, action: 'consent.revoked', subjectId: consentId,
    outcome: 'ok', detail: { quoteId: c.quoteId, capMinor: c.capMinor },
  });
  return getConsent(consentId)!;
}

export function listConsentsForQuote(quoteId: string): Consent[] {
  const rows = db.prepare('SELECT * FROM consents WHERE quote_id = ? ORDER BY granted_at DESC').all(quoteId) as Record<string, unknown>[];
  return rows.map(rowToConsent);
}
