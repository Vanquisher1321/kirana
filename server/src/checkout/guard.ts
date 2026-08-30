import { db } from '../lib/db.ts';
import { formatInr } from '../lib/money.ts';
import { validateForPayment, type Quote } from './quote.ts';
import { getConsent, type Consent } from './consent.ts';
import { circuitState } from '../razorpay/client.ts';

/**
 * MoneyGuard: the single choke point every rupee passes through.
 *
 * Two properties matter more than the individual rules.
 *
 * First, it is a CHOKE POINT -- there is exactly one function that authorises a
 * charge, so "is this spend allowed" has one answer in one place rather than
 * being scattered across handlers. Second, it returns the FULL check list, pass
 * or fail. A guard that returns a bare boolean cannot explain itself, and the
 * track's bar is that every money action be explainable.
 */

export const KILL_SWITCH = { engaged: false, reason: '' };

export function engageKillSwitch(reason: string): void {
  KILL_SWITCH.engaged = true;
  KILL_SWITCH.reason = reason;
}
export function releaseKillSwitch(): void {
  KILL_SWITCH.engaged = false;
  KILL_SWITCH.reason = '';
}

/** Caps applied when a buyer agent is unregistered. Conservative on purpose. */
export const ANON_PER_ORDER_CAP_MINOR = 2_000_00;   // ₹2,000.00
export const ANON_DAILY_CAP_MINOR = 10_000_00;      // ₹10,000.00

export interface GuardCheck {
  name: string;
  /** Plain-English statement of what this gate enforces. Rendered in the UI. */
  says: string;
  passed: boolean;
  detail: string;
}

export interface GuardResult {
  allowed: boolean;
  checks: GuardCheck[];
  blockedBy?: string;
  reason?: string;
  quote?: Quote;
  consent?: Consent;
}

function agentCaps(agentId: string | null): { perOrder: number; daily: number; label: string } {
  if (!agentId) return { perOrder: ANON_PER_ORDER_CAP_MINOR, daily: ANON_DAILY_CAP_MINOR, label: 'unregistered agent' };
  const r = db.prepare('SELECT * FROM agents WHERE id = ? AND active = 1').get(agentId) as Record<string, unknown> | undefined;
  if (!r) return { perOrder: ANON_PER_ORDER_CAP_MINOR, daily: ANON_DAILY_CAP_MINOR, label: 'unknown agent' };
  return { perOrder: Number(r.per_order_cap_minor), daily: Number(r.daily_cap_minor), label: String(r.label) };
}

function spentTodayMinor(agentId: string | null): number {
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const r = db.prepare(
    `SELECT COALESCE(SUM(amount_minor), 0) AS total FROM orders
     WHERE created_at >= ? AND status IN ('paid','awaiting_payment')
       AND (agent_id IS ? OR agent_id = ?)`,
  ).get(since, agentId, agentId) as { total?: number } | undefined;
  return Number(r?.total ?? 0);
}

export interface GuardInput {
  quoteId: string;
  consentId: string;
  agentId: string | null;
  merchantId: string;
  idempotencyKey: string;
}

export function authorise(input: GuardInput): GuardResult {
  const checks: GuardCheck[] = [];
  const fail = (name: string, reason: string): GuardResult => ({
    allowed: false, checks, blockedBy: name, reason,
  });

  const add = (name: string, says: string, passed: boolean, detail: string) => {
    checks.push({ name, says, passed, detail });
    return passed;
  };

  // 1. Global stop.
  if (!add('kill_switch', 'A human can stop all spending instantly.', !KILL_SWITCH.engaged,
    KILL_SWITCH.engaged ? `Engaged: ${KILL_SWITCH.reason}` : 'Not engaged')) {
    return fail('kill_switch', `All agent spending is paused: ${KILL_SWITCH.reason}`);
  }

  // 2. Gateway health. Never start a charge into a gateway we already know is failing.
  const circuit = circuitState();
  if (!add('gateway_circuit', 'We do not start a payment into a failing gateway.', !circuit.open,
    circuit.open ? `Open until ${circuit.openUntil}` : 'Closed (healthy)')) {
    return fail('gateway_circuit', 'Razorpay is returning errors, so no payment was attempted. Try again shortly.');
  }

  // 3. Idempotency. Checked BEFORE anything is sent, so a retried request can
  //    never become a second charge.
  const dupe = db.prepare('SELECT id, status, razorpay_order_id FROM orders WHERE idempotency_key = ?').get(input.idempotencyKey) as Record<string, unknown> | undefined;
  if (!add('idempotency', 'The same request can never charge twice.', !dupe,
    dupe ? `Already used by order ${String(dupe.id)} (${String(dupe.status)})` : 'Fresh key')) {
    return fail('idempotency', `This exact request was already processed as order ${String(dupe!.id)}. No second charge was made.`);
  }

  // 4. The quote: signature, expiry, reuse, and live price/stock drift.
  const qv = validateForPayment(input.quoteId);
  if (!add('quote_integrity', 'The price is signed by the shop and re-checked against live stock.', qv.ok,
    qv.ok ? 'Signature valid, unexpired, unused, prices unchanged' : `${qv.code}: ${qv.reason}`)) {
    return { allowed: false, checks, blockedBy: 'quote_integrity', reason: qv.reason, quote: qv.quote };
  }
  const quote = qv.quote!;

  if (!add('quote_merchant', 'A quote can only be paid to the shop that issued it.', quote.merchantId === input.merchantId,
    quote.merchantId === input.merchantId ? 'Matches' : `Quote belongs to ${quote.merchantId}`)) {
    return fail('quote_merchant', 'This quote was issued by a different merchant.');
  }

  // 5. Consent: exists, alive, in scope, and covers the amount.
  const consent = getConsent(input.consentId);
  if (!add('consent_exists', 'A human must have approved this spend.', Boolean(consent),
    !consent ? 'No such consent'
      : consent.grantedBy ? `Granted by ${consent.grantedBy}`
      : 'Requested, not yet approved')) {
    return fail('consent_exists', 'No human approval was found for this payment.');
  }
  const c = consent!;

  if (!add('consent_live', 'Approval can be revoked instantly and expires on its own.', c.status === 'granted',
    `Status ${c.status}${c.revokedAt ? ` (revoked ${c.revokedAt})` : ''}`)) {
    return fail('consent_live', c.status === 'revoked'
      ? 'The human revoked this approval. No payment was attempted.'
      : `Approval is ${c.status} and cannot authorise a payment.`);
  }

  if (!add('consent_unexpired', 'Approval is time-limited.', Date.parse(c.expiresAt) > Date.now(),
    `Expires ${c.expiresAt}`)) {
    return fail('consent_unexpired', 'The human approval expired before payment. Ask again.');
  }

  if (!add('consent_quote_match', 'Approval is tied to one specific basket.', c.quoteId === quote.id,
    c.quoteId === quote.id ? 'Matches' : `Approval covers ${c.quoteId}`)) {
    return fail('consent_quote_match', 'That approval was given for a different basket.');
  }

  if (!add('consent_agent_match', 'Approval names the agent allowed to use it.', (c.agentId ?? null) === (input.agentId ?? null),
    `Approved for ${c.agentId ?? 'unregistered agent'}`)) {
    return fail('consent_agent_match', 'A different agent tried to use this approval.');
  }

  // 6. THE cap check. The agent cannot spend more than the human allowed.
  if (!add('within_consent_cap', 'The charge cannot exceed the approved cap.', quote.totalMinor <= c.capMinor,
    `${formatInr(quote.totalMinor)} against a cap of ${formatInr(c.capMinor)}`)) {
    return fail('within_consent_cap',
      `The basket totals ${formatInr(quote.totalMinor)} but the approved cap is ${formatInr(c.capMinor)}. No payment was attempted.`);
  }

  // 7. Platform caps, independent of what any human approved.
  const caps = agentCaps(input.agentId);
  if (!add('within_per_order_cap', 'Every agent has a hard per-order ceiling.', quote.totalMinor <= caps.perOrder,
    `${formatInr(quote.totalMinor)} against ${formatInr(caps.perOrder)} for ${caps.label}`)) {
    return fail('within_per_order_cap',
      `${formatInr(quote.totalMinor)} exceeds the per-order ceiling of ${formatInr(caps.perOrder)} for this agent.`);
  }

  const spent = spentTodayMinor(input.agentId);
  if (!add('within_daily_cap', 'Every agent has a rolling 24-hour spend ceiling.', spent + quote.totalMinor <= caps.daily,
    `${formatInr(spent)} spent in 24h, ${formatInr(quote.totalMinor)} requested, ceiling ${formatInr(caps.daily)}`)) {
    return fail('within_daily_cap',
      `This would take 24-hour spending to ${formatInr(spent + quote.totalMinor)}, above the ${formatInr(caps.daily)} ceiling.`);
  }

  return { allowed: true, checks, quote, consent: c };
}
