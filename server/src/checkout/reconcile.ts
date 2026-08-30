import { db, nowIso } from '../lib/db.ts';
import { record } from '../audit/ledger.ts';
import { settleOrder } from './checkout.ts';
import { fetchOrderPayments, RazorpayError, CircuitOpenError, type CallOptions } from '../razorpay/client.ts';

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
    `SELECT id, razorpay_order_id FROM orders
     WHERE status = 'awaiting_payment' AND razorpay_order_id IS NOT NULL AND updated_at <= ?
     ORDER BY updated_at ASC LIMIT ?`,
  ).all(cutoff, opts.limit ?? 25) as Array<{ id: string; razorpay_order_id: string }>;

  for (const row of rows) {
    report.checked++;
    try {
      const { items } = await fetchOrderPayments(row.razorpay_order_id, opts.rzpOptions);
      const captured = items.find((p) => p.status === 'captured');
      const authorized = items.find((p) => p.status === 'authorized');
      const failed = items.find((p) => p.status === 'failed');

      if (captured) {
        settleOrder({ razorpayOrderId: row.razorpay_order_id, paymentId: captured.id, status: 'paid' });
        report.settled++;
      } else if (authorized) {
        // Authorised but not captured is a real state, not a success. Leave it
        // pending rather than reporting money we do not have.
        report.stillPending++;
      } else if (failed && items.length === 1) {
        settleOrder({
          razorpayOrderId: row.razorpay_order_id, paymentId: failed.id, status: 'failed',
          failureReason: `${failed.error_code ?? 'failed'}: ${failed.error_description ?? ''}`,
        });
        report.failed++;
      } else {
        report.stillPending++;
      }
    } catch (err) {
      if (err instanceof CircuitOpenError) {
        // The gateway is already known to be unhealthy. Stop the sweep rather
        // than spending the whole budget on calls that will not be sent.
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
