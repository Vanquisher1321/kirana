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

export async function reconcile(opts: { limit?: number; rzpOptions?: CallOptions; minAgeMs?: number } = {}): Promise<ReconcileReport> {
  const report: ReconcileReport = {
    checked: 0, settled: 0, stillPending: 0, failed: 0, skipped: 0, errors: [], ranAt: nowIso(),
  };

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
      let captured: { id: string } | null = null;
      let failed: { id: string; code?: string; description?: string } | null = null;
      let authorizedOnly = false;

      // 1. The payment link is where a link-paid customer's money lands.
      if (row.razorpay_payment_link_id) {
        const link = await fetchPaymentLink(row.razorpay_payment_link_id, opts.rzpOptions);
        const attempts = link.payments ?? [];
        const good = attempts.find((p) => p.status === 'captured');
        if (good) {
          captured = { id: good.payment_id };
        } else if (link.status === 'paid') {
          // Paid but the payment array is not populated yet: trust the status
          // and record the link id so the entry is still traceable.
          captured = { id: attempts[0]?.payment_id ?? link.id };
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
          captured = { id: good.id };
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
