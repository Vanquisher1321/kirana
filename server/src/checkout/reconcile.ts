import { db, nowIso } from '../lib/db.ts';
import { record } from '../audit/ledger.ts';
import { settleOrder } from './checkout.ts';
import { fetchOrderPayments, fetchPaymentLink, RazorpayError, CircuitOpenError, type CallOptions } from '../razorpay/client.ts';

/**
 * Reconciliation: ask the gateway what actually happened.
 *
 * Webhooks are a notification, not a source of truth. They get lost to a
 * dropped tunnel, a restarted process, a firewall, an expired ngrok URL, or
 * simply arrive out of order. Any payment system that treats "we did not
 * receive a webhook" as "the customer did not pay" will eventually tell a
 * customer their money vanished.
 *
 * So the ledger is reconciled against Razorpay directly. The webhook makes
 * settlement fast; the reconciler makes it correct. Running both is not
 * redundancy for its own sake -- settleOrder is idempotent precisely so the two
 * paths can race without consequence.
 *
 * A useful side effect: the demo does not need a public tunnel at all.
 *
 * It also has to look in the right place. A Razorpay Order and a Payment Link
 * are separate objects; a customer paying the link produces a payment against
 * the LINK, and the order's payment list stays empty forever. Reconciling only
 * against the order is a bug that shows up as "the customer definitely paid but
 * the system says pending" -- so the link is checked first, and the order after.
 */

export interface ReconcileReport {
  checked: number;
  settled: number;
  stillPending: number;
  failed: number;
  skipped: number;
  errors: string[];
  ranAt: string;
}

/** Orders left in limbo long enough that a webhook probably is not coming. */
const MIN_AGE_MS = 5_000;

/**
 * After this long, an unpaid order is abandoned, not pending.
 *
 * Nothing used to leave `awaiting_payment`, ever. The sweep takes the 25 oldest
 * such rows and does not touch `updated_at` on the ones it leaves pending, so
 * those same 25 abandoned baskets were re-selected every 20 seconds forever --
 * about 4,500 gateway calls an hour spent re-polling links nobody will pay,
 * while the customer who DID pay sat at position 26 and was never looked at.
 * A queue that never drains is not a queue.
 *
 * The payment link itself expires 30 minutes after the quote, so an order this
 * old cannot still be paid.
 */
const ABANDON_AFTER_MS = 6 * 60 * 60 * 1000;

export async function reconcile(opts: { limit?: number; rzpOptions?: CallOptions; minAgeMs?: number } = {}): Promise<ReconcileReport> {
  const report: ReconcileReport = {
    checked: 0, settled: 0, stillPending: 0, failed: 0, skipped: 0, errors: [], ranAt: nowIso(),
  };

  // Retire what can no longer be paid, so the window moves.
  const abandonBefore = new Date(Date.now() - ABANDON_AFTER_MS).toISOString();
  const abandoned = db.prepare(
    "UPDATE orders SET status = 'expired', failure_reason = 'not paid before the payment link expired', updated_at = ? WHERE status = 'awaiting_payment' AND created_at <= ?",
  ).run(nowIso(), abandonBefore);
  if (Number(abandoned.changes) > 0) {
    record({
      actor: 'system:reconciler', action: 'orders.expired', subjectId: null, outcome: 'ok',
      detail: { count: Number(abandoned.changes), olderThanHours: ABANDON_AFTER_MS / 3600_000 },
    });
  }

  const cutoff = new Date(Date.now() - (opts.minAgeMs ?? MIN_AGE_MS)).toISOString();
  const rows = db.prepare(
    `SELECT id, razorpay_order_id, razorpay_payment_link_id FROM orders
     WHERE status = 'awaiting_payment' AND updated_at <= ?
       AND (razorpay_order_id IS NOT NULL OR razorpay_payment_link_id IS NOT NULL)
     ORDER BY updated_at ASC LIMIT ?`,
  ).all(cutoff, opts.limit ?? 25) as Array<{ id: string; razorpay_order_id: string | null; razorpay_payment_link_id: string | null }>;

  for (const row of rows) {
    report.checked++;
    try {
      let captured: { id: string; amountMinor?: number; currency?: string } | null = null;
      let failed: { id: string; code?: string; description?: string } | null = null;
      let authorizedOnly = false;

      // 1. The payment link is where a link-paid customer's money lands.
      if (row.razorpay_payment_link_id) {
        const link = await fetchPaymentLink(row.razorpay_payment_link_id, opts.rzpOptions);
        const attempts = link.payments ?? [];
        const good = attempts.find((p) => p.status === 'captured');
        if (good) {
          captured = { id: good.payment_id, amountMinor: good.amount };
        } else if (link.status === 'paid') {
          // Paid but the payment array is not populated yet. This branch used
          // to pass no amount at all, which skipped settleOrder's amount check
          // entirely -- the one path where the ledger asserted "money
          // received" without checking how much -- and stored a plink_ id in
          // the payment-id column, where every refund or support lookup would
          // later fail. The link object reports amount_paid; use it, and keep
          // the payment id null rather than lying about which id it is.
          captured = {
            id: attempts[0]?.payment_id ?? link.id,
            amountMinor: typeof link.amount_paid === 'number' ? link.amount_paid : undefined,
            currency: link.currency,
          };
        } else {
          const bad = attempts.find((p) => p.status === 'failed');
          if (bad) failed = { id: bad.payment_id, code: 'payment_failed', description: 'The payment attempt did not complete.' };
        }
      }

      // 2. Fall back to the order, for payments made against it directly.
      if (!captured && row.razorpay_order_id) {
        const { items } = await fetchOrderPayments(row.razorpay_order_id, opts.rzpOptions);
        const good = items.find((p) => p.status === 'captured');
        if (good) {
          captured = { id: good.id, amountMinor: good.amount, currency: good.currency };
        } else if (items.some((p) => p.status === 'authorized')) {
          authorizedOnly = true;
        } else {
          const bad = items.find((p) => p.status === 'failed');
          if (bad && items.length === 1 && !failed) {
            failed = { id: bad.id, code: bad.error_code ?? 'failed', description: bad.error_description ?? '' };
          }
        }
      }

      if (captured) {
        settleOrder({
          razorpayOrderId: row.razorpay_order_id ?? undefined,
          paymentId: captured.id,
          status: 'paid',
          amountMinor: captured.amountMinor,
          currency: captured.currency,
        });
        report.settled++;
      } else if (authorizedOnly) {
        // Authorised but not captured is a real state, not a success. Leave it
        // pending rather than reporting money we do not have.
        report.stillPending++;
      } else if (failed) {
        // A failed attempt does NOT close the order: the customer can simply
        // try again on the same link, which is exactly what a human does after
        // an OTP or 3-D Secure failure. Closing it here would strand a buyer
        // who was one retry away from paying.
        report.failed++;
        report.stillPending++;
      } else {
        report.stillPending++;
      }

      // Touch every row we looked at, settled or not. `ORDER BY updated_at ASC`
      // is only fair if looking at a row moves it to the back of the queue;
      // without this the same 25 rows are swept for ever and row 26 is never
      // reached.
      db.prepare("UPDATE orders SET updated_at = ? WHERE id = ? AND status = 'awaiting_payment'")
        .run(nowIso(), row.id);
    } catch (err) {
      if (err instanceof CircuitOpenError) {
        report.skipped = rows.length - report.checked + 1;
        report.errors.push('gateway circuit open; sweep stopped early');
        break;
      }
      const msg = err instanceof RazorpayError ? `${row.id}: ${err.code} ${err.description}` : `${row.id}: ${(err as Error).message}`;
      report.errors.push(msg);
    }
  }

  if (report.checked > 0) {
    record({
      actor: 'system:reconciler',
      action: 'reconcile.swept',
      subjectId: null,
      outcome: report.errors.length > 0 ? 'failed' : 'ok',
      detail: { ...report },
    });
  }

  return report;
}

let timer: NodeJS.Timeout | null = null;

/** Background sweep. Unref'd so it never keeps the process alive by itself. */
export function startReconciler(intervalMs = 20_000): void {
  if (timer) return;
  timer = setInterval(() => {
    void reconcile().catch(() => { /* reported inside */ });
  }, intervalMs);
  timer.unref();
}

export function stopReconciler(): void {
  if (timer) { clearInterval(timer); timer = null; }
}
