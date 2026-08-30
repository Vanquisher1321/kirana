import { db, nowIso } from '../lib/db.ts';
import { id } from '../lib/id.ts';
import { config } from '../lib/config.ts';
import { formatInr } from '../lib/money.ts';
import { record } from '../audit/ledger.ts';
import { authorise, type GuardCheck } from './guard.ts';
import { markQuote } from './quote.ts';
import { markConsent } from './consent.ts';
import { ensureAgent } from './agents.ts';
import { getMerchant } from '../catalog/store.ts';
import { createOrder, createPaymentLink, RazorpayError, CircuitOpenError, type CallOptions } from '../razorpay/client.ts';

export interface CheckoutInput {
  quoteId: string;
  consentId: string;
  merchantId: string;
  agentId: string | null;
  idempotencyKey: string;
  buyerNote?: string;
  rzpOptions?: CallOptions;
}

export interface CheckoutOutcome {
  ok: boolean;
  orderId?: string;
  razorpayOrderId?: string;
  payUrl?: string;
  amount?: string;
  amountMinor?: number;
  currency?: string;
  status?: string;
  checks: GuardCheck[];
  blockedBy?: string;
  reason?: string;
}

/**
 * The one function that can cause money to move.
 *
 * Ordering here is the whole game:
 *
 *   1. authorise everything BEFORE any network call, so a refusal costs nothing
 *      and can never be a half-charge;
 *   2. CLAIM the idempotency key in the database before talking to Razorpay,
 *      because the dangerous window is between "we decided to charge" and "we
 *      know whether we charged". If two identical requests race, the UNIQUE
 *      constraint decides the winner, not luck;
 *   3. only then call the gateway;
 *   4. record the outcome either way -- a failed charge is as auditable as a
 *      successful one.
 */
export async function checkout(input: CheckoutInput): Promise<CheckoutOutcome> {
  ensureAgent(input.agentId);
  const actor = input.agentId ? `agent:${input.agentId}` : 'agent:anonymous';

  const decision = authorise({
    quoteId: input.quoteId,
    consentId: input.consentId,
    agentId: input.agentId,
    merchantId: input.merchantId,
    idempotencyKey: input.idempotencyKey,
  });

  if (!decision.allowed) {
    record({
      actor,
      action: 'checkout.blocked',
      subjectId: input.quoteId,
      outcome: 'blocked',
      detail: {
        blockedBy: decision.blockedBy,
        reason: decision.reason,
        checks: decision.checks.map((c) => ({ name: c.name, passed: c.passed, detail: c.detail })),
      },
    });
    return { ok: false, checks: decision.checks, blockedBy: decision.blockedBy, reason: decision.reason };
  }

  const quote = decision.quote!;
  const merchant = getMerchant(input.merchantId)!;
  const orderId = id('ord');

  // Claim the idempotency key first. If a duplicate request is in flight, one
  // of them loses here -- before either has touched the gateway.
  try {
    db.prepare(
      `INSERT INTO orders (id, merchant_id, quote_id, consent_id, agent_id, idempotency_key,
                           amount_minor, currency, status, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?, 'created', ?, ?)`,
    ).run(orderId, input.merchantId, quote.id, input.consentId, input.agentId, input.idempotencyKey,
      quote.totalMinor, quote.currency, nowIso(), nowIso());
  } catch {
    const existing = db.prepare('SELECT id, status FROM orders WHERE idempotency_key = ?').get(input.idempotencyKey) as Record<string, unknown>;
    record({
      actor, action: 'checkout.deduplicated', subjectId: String(existing.id), outcome: 'blocked',
      detail: { idempotencyKey: input.idempotencyKey, existingStatus: String(existing.status) },
    });
    return {
      ok: false, checks: decision.checks, blockedBy: 'idempotency',
      reason: `This request was already processed as order ${String(existing.id)}. No second charge was made.`,
    };
  }

  const receipt = orderId.replace('ord_', 'kir');
  const notes = {
    kirana_order: orderId,
    kirana_quote: quote.id,
    kirana_consent: input.consentId,
    merchant: merchant.slug,
    agent: input.agentId ?? 'unregistered',
  };

  try {
    const rzpOrder = await createOrder({
      amountMinor: quote.totalMinor,
      currency: quote.currency,
      receipt,
      notes,
    }, input.rzpOptions);

    const description = quote.lines
      .map((l) => `${l.quantity} x ${l.productTitle} (${l.variantTitle})`)
      .join(', ')
      .slice(0, 200);

    const link = await createPaymentLink({
      amountMinor: quote.totalMinor,
      currency: quote.currency,
      description: `${merchant.name}: ${description}`,
      referenceId: receipt,
      expireBy: Math.floor(Date.parse(quote.expiresAt) / 1000) + 30 * 60,
      callbackUrl: config.publicOrigin ? `${config.publicOrigin}/paid` : undefined,
      notes,
    }, input.rzpOptions);

    db.prepare(
      `UPDATE orders SET razorpay_order_id = ?, status = 'awaiting_payment', updated_at = ?,
              failure_reason = NULL WHERE id = ?`,
    ).run(rzpOrder.id, nowIso(), orderId);

    // The quote and the consent are both single-use. Burning them here means a
    // replay cannot ride the same approval into a second order.
    markQuote(quote.id, 'consumed');
    markConsent(input.consentId, 'consumed');

    record({
      actor,
      action: 'checkout.authorised',
      subjectId: orderId,
      outcome: 'ok',
      detail: {
        merchant: merchant.slug,
        quoteId: quote.id,
        consentId: input.consentId,
        amountMinor: quote.totalMinor,
        amount: formatInr(quote.totalMinor),
        currency: quote.currency,
        razorpayOrderId: rzpOrder.id,
        paymentLinkId: link.id,
        checksPassed: decision.checks.length,
      },
    });

    return {
      ok: true,
      orderId,
      razorpayOrderId: rzpOrder.id,
      payUrl: link.short_url,
      amount: formatInr(quote.totalMinor),
      amountMinor: quote.totalMinor,
      currency: quote.currency,
      status: 'awaiting_payment',
      checks: decision.checks,
    };
  } catch (err) {
    const reason = err instanceof RazorpayError
      ? `${err.code}: ${err.description}`
      : err instanceof CircuitOpenError
        ? 'Razorpay circuit breaker open; no request was sent.'
        : (err as Error).message;

    db.prepare("UPDATE orders SET status = 'failed', failure_reason = ?, updated_at = ? WHERE id = ?")
      .run(reason, nowIso(), orderId);

    record({
      actor, action: 'checkout.failed', subjectId: orderId, outcome: 'failed',
      detail: { reason, quoteId: quote.id, amountMinor: quote.totalMinor, retryable: err instanceof RazorpayError ? err.retryable : false },
    });

    return {
      ok: false, checks: decision.checks, blockedBy: 'gateway',
      reason: `The payment could not be started: ${reason}. Nothing was charged.`,
      orderId,
    };
  }
}

export function getOrder(orderId: string): Record<string, unknown> | null {
  return (db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId) as Record<string, unknown>) ?? null;
}

export function listOrders(limit = 50): Record<string, unknown>[] {
  return db.prepare('SELECT * FROM orders ORDER BY created_at DESC LIMIT ?').all(limit) as Record<string, unknown>[];
}

/** Applied by the Razorpay webhook once a real payment lands. */
export function settleOrder(input: {
  razorpayOrderId?: string; referenceId?: string; paymentId: string; status: 'paid' | 'failed'; failureReason?: string;
}): string | null {
  // Match on the Razorpay order id when present, otherwise fall back to the
  // receipt/reference we generated -- payment-link events do not always carry
  // an order id.
  let row = input.razorpayOrderId
    ? db.prepare('SELECT id, status, razorpay_payment_id FROM orders WHERE razorpay_order_id = ?').get(input.razorpayOrderId) as Record<string, unknown> | undefined
    : undefined;
  if (!row && input.referenceId) {
    row = db.prepare("SELECT id, status, razorpay_payment_id FROM orders WHERE 'kir' || substr(id, 5) = ?").get(input.referenceId) as Record<string, unknown> | undefined;
  }
  if (!row) {
    record({
      actor: 'razorpay:webhook', action: 'webhook.unmatched', subjectId: null, outcome: 'blocked',
      detail: { razorpayOrderId: input.razorpayOrderId ?? null, referenceId: input.referenceId ?? null, paymentId: input.paymentId },
    });
    return null;
  }

  const orderId = String(row.id);

  // Razorpay retries a webhook until it gets a 2xx, so the same event arrives
  // more than once as a matter of course. Re-applying an identical settlement
  // must be a no-op: otherwise the audit trail grows a second "money received"
  // entry for one payment, which is exactly the kind of discrepancy the trail
  // exists to rule out.
  if (String(row.status) === input.status && String(row.razorpay_payment_id ?? '') === input.paymentId) {
    record({
      actor: 'razorpay:webhook', action: 'webhook.duplicate', subjectId: orderId, outcome: 'ok',
      detail: { paymentId: input.paymentId, status: input.status, note: 'Already settled; ignored.' },
    });
    return orderId;
  }

  db.prepare('UPDATE orders SET status = ?, razorpay_payment_id = ?, failure_reason = ?, updated_at = ? WHERE id = ?')
    .run(input.status, input.paymentId, input.failureReason ?? null, nowIso(), orderId);

  record({
    actor: 'razorpay:webhook',
    action: input.status === 'paid' ? 'payment.captured' : 'payment.failed',
    subjectId: orderId,
    outcome: input.status === 'paid' ? 'ok' : 'failed',
    detail: { paymentId: input.paymentId, razorpayOrderId: input.razorpayOrderId ?? null, failureReason: input.failureReason ?? null },
  });

  return orderId;
}
