import { db, nowIso } from '../lib/db.ts';
import { id } from '../lib/id.ts';
import { record } from '../audit/ledger.ts';
import { ensureAgent } from './agents.ts';
import { matchStandingRule } from './standing.ts';

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
  /**
   * Did THIS CALLER prove the identity it claims, with a key? Supplied by the
   * layer that checked the key, for the same reason GuardInput demands it:
   * looking the id up here would answer "is there a verified agent by this
   * name", which is the question an impostor wants asked.
   */
  identityProven?: boolean;
  /** The workspace of the person buying, when the connection knows one. */
  buyerWorkspaceId?: string | null;
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
  /**
   * Does a standing rule already cover this?
   *
   * Read this as the human having answered early, not as the agent approving
   * itself. matchStandingRule reaches nothing the caller controls: it needs a
   * key-proven identity, a live unexpired rule a person created from the
   * console, room under both of that rule's ceilings, and no engaged kill
   * switch. If any of those is missing it returns null and the request stays
   * pending, which is the ordinary path -- there is no failure mode here that
   * turns into a grant.
   */
  const match = matchStandingRule({
    agentId: input.agentId,
    identityProven: input.identityProven === true,
    capMinor: consent.capMinor,
  });

  if (match) {
    consent.status = 'granted';
    consent.grantedBy = match.rule.createdBy;
    consent.grantedAt = new Date(now).toISOString();
    db.prepare(
      `INSERT INTO consents (id, quote_id, agent_id, cap_minor, scope, granted_by, granted_at, expires_at, revoked_at, status, standing_rule_id, buyer_workspace_id)
       VALUES (?,?,?,?,?,?,?,?,NULL,'granted',?,?)`,
    ).run(
      consent.id, consent.quoteId, consent.agentId, consent.capMinor, consent.scope,
      consent.grantedBy, consent.grantedAt, consent.expiresAt, match.rule.id,
      input.buyerWorkspaceId ?? null,
    );

    // Its own action, never plain `consent.granted`. Someone reading The Record
    // must be able to tell an approval a person clicked from one a rule
    // answered, and to find the rule that answered it.
    record({
      actor: `human:${match.rule.createdBy}`,
      action: 'consent.auto_granted',
      subjectId: consent.id,
      outcome: 'ok',
      detail: {
        quoteId: consent.quoteId, capMinor: consent.capMinor, scope: consent.scope,
        expiresAt: consent.expiresAt, agentId: consent.agentId,
        standingRuleId: match.rule.id,
        perOrderCapMinor: match.rule.perOrderCapMinor,
        dailyHeadroomBeforeMinor: match.headroomMinor,
        ruleExpiresAt: match.rule.expiresAt,
      },
    });
    return consent;
  }

  db.prepare(
    `INSERT INTO consents (id, quote_id, agent_id, cap_minor, scope, granted_by, granted_at, expires_at, revoked_at, status, buyer_workspace_id)
     VALUES (?,?,?,?,?,'','',?,NULL,'pending',?)`,
  ).run(consent.id, consent.quoteId, consent.agentId, consent.capMinor, consent.scope, consent.expiresAt,
    input.buyerWorkspaceId ?? null);

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
export function approveConsent(consentId: string, by: string, buyerWorkspaceId: string | null = null): Consent {
  const c = getConsent(consentId);
  if (!c) throw new ConsentError('not_found', `No approval request ${consentId}.`);
  if (c.status !== 'pending') throw new ConsentError('not_pending', `Request is already ${c.status}.`);
  const at = nowIso();
  db.prepare("UPDATE consents SET status='granted', granted_by=?, granted_at=? WHERE id=?").run(by, at, consentId);
  // The person who approved the spend is the buyer, and on a per-shop link this
  // is the only moment anyone learns that. Without it their own purchase is
  // invisible to them the moment the shop belongs to somebody else -- or to
  // nobody, which is what the sandbox's seeded shop is.
  if (buyerWorkspaceId) {
    db.prepare('UPDATE consents SET buyer_workspace_id = ? WHERE id = ? AND buyer_workspace_id IS NULL')
      .run(buyerWorkspaceId, consentId);
  }
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

/**
 * Pending approvals, scoped to a tenant.
 *
 * The workspace is derived by joining through the quote to the merchant rather
 * than denormalised onto the consent row, so it cannot drift out of sync with
 * the shop the basket actually belongs to.
 */
/**
 * The approvals a visitor may act on: their own shops', plus the instance's
 * own seeded shop, which belongs to nobody and is shared by everyone on the
 * sandbox. Without the second half a visitor shopping the demo shop could be
 * asked for permission and have no way to give it.
 */
export function listPendingConsents(workspaceId?: string | null): Consent[] {
  const rows = workspaceId === undefined
    ? db.prepare("SELECT * FROM consents WHERE status='pending' ORDER BY expires_at ASC").all()
    : db.prepare(
        `SELECT c.* FROM consents c
         JOIN quotes q ON q.id = c.quote_id
         JOIN merchants m ON m.id = q.merchant_id
         WHERE c.status='pending'
           AND (m.workspace_id IS ? OR m.workspace_id IS NULL OR c.buyer_workspace_id IS ?)
         ORDER BY c.expires_at ASC`,
      ).all(workspaceId, workspaceId);
  return (rows as Record<string, unknown>[]).map(rowToConsent);
}

/** Which tenant an approval belongs to. Null when it cannot be resolved. */
export function consentWorkspace(consentId: string): string | null {
  const r = db.prepare(
    `SELECT m.workspace_id AS ws FROM consents c
     JOIN quotes q ON q.id = c.quote_id
     JOIN merchants m ON m.id = q.merchant_id
     WHERE c.id = ?`,
  ).get(consentId) as { ws?: string | null } | undefined;
  return (r?.ws as string | null) ?? null;
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

/** Atomic counterpart to claimQuote. One approval, one checkout, no race. */
export function claimConsent(consentId: string): boolean {
  const r = db.prepare("UPDATE consents SET status = 'consumed' WHERE id = ? AND status = 'granted'").run(consentId);
  return Number(r.changes) === 1;
}

export function releaseConsent(consentId: string): void {
  db.prepare("UPDATE consents SET status = 'granted' WHERE id = ? AND status = 'consumed'").run(consentId);
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
