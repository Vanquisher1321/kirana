import { db, nowIso } from '../lib/db.ts';
import { id } from '../lib/id.ts';
import { config } from '../lib/config.ts';
import { formatInr } from '../lib/money.ts';
import { record } from '../audit/ledger.ts';
import { authorise, type GuardCheck } from './guard.ts';
import { markQuote, claimQuote, releaseQuote } from './quote.ts';
import { markConsent, claimConsent, releaseConsent } from './consent.ts';
import { ensureAgent } from './agents.ts';
import { getMerchant } from '../catalog/store.ts';
import { deliveryRef } from './delivery.ts';
import { createOrder, createPaymentLink, RazorpayError, CircuitOpenError, type CallOptions } from '../razorpay/client.ts';

/** Whoever approved the spend, when the connection itself did not say. */
function consentBuyer(consentId: string): string | null {
  const r = db.prepare('SELECT buyer_workspace_id AS w FROM consents WHERE id = ?').get(consentId) as { w?: string | null } | undefined;
  return (r?.w as string | null) ?? null;
}

export interface CheckoutInput {
  quoteId: string;
  consentId: string;
  merchantId: string;
  agentId: string | null;
  /** True only when the caller presented a matching agent key. */
  identityProven?: boolean;
  idempotencyKey: string;
  /**
   * The workspace of the PERSON buying, when the connection knows one. A buyer
   * link does; a per-shop link handed to a stranger's assistant does not, and
   * that order simply belongs to the merchant as it always did.
   */
  buyerWorkspaceId?: string | null;
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
    identityProven: input.identityProven === true,
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
                           amount_minor, currency, status, created_at, updated_at, buyer_workspace_id, delivery)
       VALUES (?,?,?,?,?,?,?,?, 'created', ?, ?, ?, ?)`,
    ).run(orderId, input.merchantId, quote.id, input.consentId, input.agentId, input.idempotencyKey,
      quote.totalMinor, quote.currency, nowIso(), nowIso(),
      // The connection may know the buyer (a buyer link does). If it does not,
      // the approval does: a human approved this from their own console.
      input.buyerWorkspaceId ?? consentBuyer(input.consentId),
      // SNAPSHOT, not a reference. The address is copied off the approval at the
      // moment of purchase, so that editing a saved address later cannot change
      // where an order already placed was sent -- and so the merchant's copy of
      // what they were told to ship to is fixed and auditable.
      JSON.stringify(decision.consent!.delivery));
  } catch (err) {
    const existing = db.prepare('SELECT id, status FROM orders WHERE idempotency_key = ?').get(input.idempotencyKey) as Record<string, unknown> | undefined;
    if (!existing) {
      // Not a duplicate — the insert failed for another reason (disk, lock).
      // Treating that as "already processed" would silently swallow a real
      // fault, so it is reported as a refusal with the actual cause.
      record({
        actor, action: 'checkout.failed', subjectId: orderId, outcome: 'failed',
        detail: { reason: `could not record the order: ${(err as Error).message}` },
      });
      return {
        ok: false, checks: decision.checks, blockedBy: 'storage',
        reason: 'The order could not be recorded, so no payment was attempted.',
      };
    }
    record({
      actor, action: 'checkout.deduplicated', subjectId: String(existing.id), outcome: 'blocked',
      detail: { idempotencyKey: input.idempotencyKey, existingStatus: String(existing.status) },
    });
    return {
      ok: false, checks: decision.checks, blockedBy: 'idempotency',
      reason: `This request was already processed as order ${String(existing.id)}. No second charge was made.`,
    };
  }

  // ---------------------------------------------------------------------
  // Burn the quote and the consent BEFORE touching the gateway.
  //
  // The guard read them a few lines ago and they were fine. That read is not a
  // reservation: the two awaits below hand the event loop to every other
  // in-flight checkout, all of which read the same `open` quote and the same
  // `granted` consent and all of which get their own order. One approval, N
  // payment links, every cap satisfied individually and none of them in
  // aggregate. The claim has to be the same statement as the check.
  // ---------------------------------------------------------------------
  if (!claimQuote(quote.id)) {
    db.prepare("UPDATE orders SET status = 'failed', failure_reason = ?, updated_at = ? WHERE id = ?")
      .run('quote already used by another request', nowIso(), orderId);
    record({
      actor, action: 'checkout.blocked', subjectId: orderId, outcome: 'blocked',
      detail: { blockedBy: 'quote_race', quoteId: quote.id },
    });
    return {
      ok: false, checks: decision.checks, blockedBy: 'quote_single_use',
      reason: 'That quote was already used by another request. Nothing was charged.',
    };
  }
  if (!claimConsent(input.consentId)) {
    releaseQuote(quote.id);
    db.prepare("UPDATE orders SET status = 'failed', failure_reason = ?, updated_at = ? WHERE id = ?")
      .run('approval already used by another request', nowIso(), orderId);
    record({
      actor, action: 'checkout.blocked', subjectId: orderId, outcome: 'blocked',
      detail: { blockedBy: 'consent_race', consentId: input.consentId },
    });
    return {
      ok: false, checks: decision.checks, blockedBy: 'consent_single_use',
      reason: 'That approval was already used by another request. Nothing was charged.',
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
      `UPDATE orders SET razorpay_order_id = ?, razorpay_payment_link_id = ?, pay_url = ?,
              status = 'awaiting_payment', updated_at = ?, failure_reason = NULL WHERE id = ?`,
    ).run(rzpOrder.id, link.id, link.short_url ?? null, nowIso(), orderId);

    // Both were already burned above, atomically, before the gateway call.

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
        deliverTo: decision.consent!.delivery ? deliveryRef(decision.consent!.delivery) : null,
        settlesTo: merchant.razorpayAccountId ? 'merchant' : 'platform',
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

    // Hand the quote and approval back ONLY when we know nothing was created:
    // the breaker refused to send, or Razorpay answered with a definite,
    // non-retryable error. A timeout or a 5xx is ambiguous -- the charge may
    // exist -- and there we keep them burned and make the human approve again.
    // Releasing on an ambiguous failure is how one approval becomes two links.
    // A 429 is rejected at Razorpay's door before any work is done -- the
    // client module says exactly that -- but `retryable` is true for it, so
    // the old test excluded it and a rate-limit blip permanently destroyed a
    // human approval that provably never created anything.
    const certainlyNotSent = err instanceof CircuitOpenError
      || (err instanceof RazorpayError && (err.retryable === false || err.status === 429));
    if (certainlyNotSent) {
      releaseConsent(input.consentId);
      releaseQuote(quote.id);
    }

    record({
      actor, action: 'checkout.failed', subjectId: orderId, outcome: 'failed',
      detail: {
        reason, quoteId: quote.id, amountMinor: quote.totalMinor,
        retryable: err instanceof RazorpayError ? err.retryable : false,
        approvalReusable: certainlyNotSent,
      },
    });

    return {
      ok: false, checks: decision.checks, blockedBy: 'gateway',
      reason: `The payment could not be started: ${reason}. Nothing was charged.`,
      orderId,
    };
  }
}

/** Which tenant an order belongs to, via the merchant that owns it. */
export function orderWorkspace(orderId: string): string | null {
  const r = db.prepare(
    'SELECT m.workspace_id AS ws FROM orders o JOIN merchants m ON m.id = o.merchant_id WHERE o.id = ?',
  ).get(orderId) as { ws?: string | null } | undefined;
  return (r?.ws as string | null) ?? null;
}

export function getOrder(orderId: string): Record<string, unknown> | null {
  return (db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId) as Record<string, unknown>) ?? null;
}

/** Scoped to a workspace by the merchant that owns the order. Undefined = all. */
export function listOrders(limit = 50, workspaceId?: string | null): Record<string, unknown>[] {
  if (workspaceId === undefined) {
    return db.prepare('SELECT * FROM orders ORDER BY created_at DESC LIMIT ?').all(limit) as Record<string, unknown>[];
  }
  // Two ways an order is yours: you sold it, or you bought it. The join alone
  // only ever answered the first, which made a shopper's own purchases
  // invisible to them the moment they shopped somebody else's shop.
  return db.prepare(
    `SELECT o.* FROM orders o JOIN merchants m ON m.id = o.merchant_id
     WHERE m.workspace_id IS ? OR o.buyer_workspace_id IS ?
     ORDER BY o.created_at DESC LIMIT ?`,
  ).all(workspaceId, workspaceId, limit) as Record<string, unknown>[];
}

/** Applied by the Razorpay webhook once a real payment lands. */
export function settleOrder(input: {
  razorpayOrderId?: string; referenceId?: string; paymentId: string; status: 'paid' | 'failed';
  failureReason?: string;
  /** Paise actually captured, when the source reports it. */
  amountMinor?: number;
  currency?: string;
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

  // A captured payment is never un-captured by a later event.
  //
  // Razorpay emits payment.failed for every abandoned attempt, and delivery is
  // concurrent, not ordered -- so a customer who fails 3-D Secure once and then
  // succeeds can have the failure land second. The UPDATE below is
  // unconditional on the current status, so that ordering flipped a paid order
  // to failed, and nothing recovers it: the reconciler only sweeps
  // `awaiting_payment`, which makes `failed` terminal. Money captured, ledger
  // says the customer did not pay. A replayed failure body does the same on
  // demand.
  // A failed attempt NEVER closes an open order.
  //
  // reconcile.ts states this invariant for itself -- "a failed attempt does
  // not close the order: the customer can simply try again on the same link,
  // which is exactly what a human does after an OTP or 3-D Secure failure" --
  // and then the webhook path did the opposite. `failed` is terminal because
  // the reconciler only sweeps `awaiting_payment`, so a customer who failed
  // once, retried and succeeded ended with money captured and a ledger saying
  // they never paid. The reconciler asserted the rule in a test; the webhook
  // broke it untested.
  //
  // `mismatch` belongs in that list too, and was missing from it. A short
  // capture parks the order there deliberately -- money arrived, the amount is
  // wrong, a human has to look -- and the failure notice for the customer's
  // EARLIER abandoned attempt then fell through to the unconditional UPDATE
  // and rewrote it as `failed`. Same loss, one state along: money captured, a
  // terminal row saying the customer never paid, and the diagnosis in
  // `failure_reason` overwritten with an OTP error. A state that exists to
  // summon a human must not be erasable by an event that arrived late.
  const settled = String(row.status) === 'paid' || String(row.status) === 'mismatch';
  if (input.status === 'failed' && (settled || String(row.status) === 'awaiting_payment')) {
    const was = String(row.status);
    if (settled) {
      // Status and failure_reason are both left alone: on a mismatch that
      // column holds the amount discrepancy, which is the whole reason the row
      // is waiting for someone.
      db.prepare('UPDATE orders SET updated_at = ? WHERE id = ?').run(nowIso(), orderId);
    } else {
      db.prepare('UPDATE orders SET failure_reason = ?, updated_at = ? WHERE id = ?')
        .run(`last attempt failed: ${input.failureReason ?? 'no reason given'}`, nowIso(), orderId);
    }
    record({
      actor: 'razorpay:webhook',
      action: settled ? 'settlement.late_failure_ignored' : 'payment.attempt_failed',
      subjectId: orderId, outcome: 'ok',
      detail: {
        paymentId: input.paymentId,
        failureReason: input.failureReason ?? null,
        orderStatus: was,
        note: settled
          ? `A failed attempt arrived for an order that is already ${was}. Ignored; what the gateway captured stands.`
          : 'An attempt failed. The order stays open so the customer can retry the same link.',
      },
    });
    return orderId;
  }


  // An order is only "paid" when the amount actually captured matches what we
  // charged. Without this, a webhook (or a link whose amount was edited) can
  // settle a large order with a small payment -- the ledger would say paid and
  // the money would not be there.
  if (input.status === 'paid' && typeof input.amountMinor === 'number') {
    const expected = Number((db.prepare('SELECT amount_minor, currency FROM orders WHERE id = ?').get(orderId) as { amount_minor: number; currency: string }).amount_minor);
    const expectedCurrency = String((db.prepare('SELECT currency FROM orders WHERE id = ?').get(orderId) as { currency: string }).currency);
    const currencyOk = !input.currency || input.currency === expectedCurrency;
    if (input.amountMinor !== expected || !currencyOk) {
      // Refusing to call a short payment "paid" is right. Leaving the row in
      // awaiting_payment was not: the reconciler re-selected it every 20s
      // forever, re-polling the gateway and writing an identical mismatch row
      // each time, while the webhook returned 200 so Razorpay stopped
      // retrying. Money captured, nobody told, log growing without bound.
      // `mismatch` is terminal and visible -- it needs a human, and now it can
      // get one.
      const already = String(row.status) === 'mismatch';
      db.prepare("UPDATE orders SET status = 'mismatch', razorpay_payment_id = ?, failure_reason = ?, updated_at = ? WHERE id = ?")
        .run(input.paymentId, `amount mismatch: captured ${input.amountMinor} ${input.currency ?? ''} against ${expected} ${expectedCurrency}`, nowIso(), orderId);
      if (!already) {
        record({
          actor: 'system', action: 'settlement.amount_mismatch', subjectId: orderId, outcome: 'blocked',
          detail: { paymentId: input.paymentId, captured: input.amountMinor, expected, capturedCurrency: input.currency ?? null, expectedCurrency },
        });
      }
      return orderId;
    }
  }

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
