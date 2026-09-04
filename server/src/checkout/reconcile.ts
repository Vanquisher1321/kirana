import { db, nowIso } from '../lib/db.ts';
import { record } from '../audit/ledger.ts';
import { settleOrder } from './checkout.ts';
import { fetchOrderPayments, fetchPaymentLink, createTransfer, RazorpayError, CircuitOpenError, type CallOptions } from '../razorpay/client.ts';

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
  expired: number;
  stillPending: number;
  failed: number;
  skipped: number;
  /** Paid orders whose money was passed on to the merchant on this sweep. */
  transferred: number;
  errors: string[];
  ranAt: string;
}

/**
 * Pass a paid order's money on to the shop that sold it.
 *
 * Until this existed, every rupee an agent spent settled into the PLATFORM's
 * Razorpay account and stopped there -- which meant the system could prove an
 * agent had paid, and could not show the merchant being paid. "Make any
 * merchant transactable" was true up to the point where it mattered most.
 *
 * It runs as a sweep rather than inline with settlement for the same reason the
 * settlement itself is swept: the moment money moves is the moment you most
 * want a retry. `settleOrder` stays synchronous and cannot be made to fail by a
 * transfer that did not go through; the order simply carries a paid status, no
 * transfer id, and the reason it did not, until a later sweep succeeds.
 *
 * A shop with no linked account is not an error and is not retried in a loop --
 * it is a shop that has not told us where its money goes, and both the console
 * and the ledger say exactly that.
 */
async function sweepTransfers(report: ReconcileReport, opts: { limit?: number; rzpOptions?: CallOptions }): Promise<void> {
  const due = db.prepare(
    `SELECT o.id, o.razorpay_payment_id AS payment_id, o.amount_minor, o.currency,
            m.razorpay_account_id AS account, m.slug
     FROM orders o JOIN merchants m ON m.id = o.merchant_id
     WHERE o.status = 'paid'
       AND o.razorpay_payment_id IS NOT NULL
       AND o.razorpay_transfer_id IS NULL
       AND m.razorpay_account_id IS NOT NULL
     ORDER BY o.updated_at ASC LIMIT ?`,
  ).all(opts.limit ?? 25) as Array<{
    id: string; payment_id: string; amount_minor: number; currency: string; account: string; slug: string;
  }>;

  for (const row of due) {
    try {
      const out = await createTransfer(row.payment_id, {
        account: row.account,
        amountMinor: Number(row.amount_minor),
        currency: String(row.currency),
        notes: { kirana_order: row.id, merchant: row.slug },
      }, opts.rzpOptions);

      const transfer = out.items?.[0];
      if (!transfer?.id) throw new Error('Razorpay accepted the transfer but named no transfer id.');

      db.prepare('UPDATE orders SET razorpay_transfer_id = ?, transfer_error = NULL, updated_at = ? WHERE id = ?')
        .run(transfer.id, nowIso(), row.id);
      report.transferred++;
      record({
        actor: 'system:reconciler', action: 'settlement.transferred', subjectId: row.id, outcome: 'ok',
        detail: {
          transferId: transfer.id, paymentId: row.payment_id, account: row.account,
          amountMinor: Number(row.amount_minor), currency: String(row.currency),
          note: 'The full amount was passed to the shop that sold it. Kirana takes no cut.',
        },
      });
    } catch (err) {
      if (err instanceof CircuitOpenError) {
        report.errors.push('gateway circuit open; transfers stopped early');
        return;
      }
      const reason = err instanceof RazorpayError ? `${err.code}: ${err.description}` : (err as Error).message;
      // Recorded on the row so it is visible, and left WITHOUT a transfer id so
      // the next sweep tries again. Money already captured is not lost by a
      // transfer that did not go through; it is money not yet passed on, and
      // saying so is the honest state.
      db.prepare('UPDATE orders SET transfer_error = ?, updated_at = ? WHERE id = ?')
        .run(reason, nowIso(), row.id);
      report.errors.push(`${row.id}: transfer failed: ${reason}`);
      record({
        actor: 'system:reconciler', action: 'settlement.transfer_failed', subjectId: row.id, outcome: 'failed',
        detail: { paymentId: row.payment_id, account: row.account, reason, willRetry: true },
      });
    }
  }
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

/** A checkout that never reached the gateway. Generous: two failed round-trips
 *  plus retries is well under a minute, so ten is only ever a dead row. */
const STUCK_AFTER_MS = 10 * 60 * 1000;

export async function reconcile(opts: { limit?: number; rzpOptions?: CallOptions; minAgeMs?: number } = {}): Promise<ReconcileReport> {
  const report: ReconcileReport = {
    checked: 0, settled: 0, expired: 0, stillPending: 0, failed: 0, skipped: 0, transferred: 0, errors: [], ranAt: nowIso(),
  };

  // A row stuck in `created` never reached the gateway: the process died
  // between claiming it and the first network call. Nothing swept it (the poll
  // selects `awaiting_payment`), nothing could query it (it has no gateway
  // ids), and it counted against the daily cap forever. It is safe to close
  // because no gateway object exists for it, and the human's approval was
  // consumed for nothing.
  const stuckBefore = new Date(Date.now() - STUCK_AFTER_MS).toISOString();
  const stuck = db.prepare(
    `UPDATE orders SET status = 'failed', failure_reason = ?, updated_at = ?
     WHERE status = 'created' AND created_at <= ?
       AND razorpay_order_id IS NULL AND razorpay_payment_link_id IS NULL`,
  ).run('abandoned before reaching the gateway; nothing was charged', nowIso(), stuckBefore);
  if (Number(stuck.changes) > 0) {
    record({
      actor: 'system:reconciler', action: 'orders.never_started', subjectId: null, outcome: 'ok',
      detail: { count: Number(stuck.changes), note: 'No gateway object was ever created for these.' },
    });
  }

  const cutoff = new Date(Date.now() - (opts.minAgeMs ?? MIN_AGE_MS)).toISOString();
  const rows = db.prepare(
    `SELECT id, razorpay_order_id, razorpay_payment_link_id, created_at FROM orders
     WHERE status = 'awaiting_payment' AND updated_at <= ?
       AND (razorpay_order_id IS NOT NULL OR razorpay_payment_link_id IS NOT NULL)
     ORDER BY updated_at ASC LIMIT ?`,
  ).all(cutoff, opts.limit ?? 25) as Array<{ id: string; razorpay_order_id: string | null; razorpay_payment_link_id: string | null; created_at: string }>;

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
        // Only NOW may an old order be retired -- after the gateway has been
        // asked and said no.
        //
        // This used to be a bare SQL sweep at the top of reconcile(), keyed on
        // created_at alone and run before any polling. So a customer who paid
        // while the reconciler was down -- a deploy, a crash, or the free tier
        // sleeping for six hours, which it does after fifteen idle minutes --
        // had their order marked `expired` on the very first sweep after it
        // woke, without one request to Razorpay, while the gateway was holding
        // the capture. `expired` is terminal, so the money was captured and
        // the ledger permanently said unpaid.
        //
        // An order is only abandoned if we asked and it was not paid.
        if (Date.parse(row.created_at) <= Date.now() - ABANDON_AFTER_MS) {
          db.prepare(
            "UPDATE orders SET status = 'expired', failure_reason = ?, updated_at = ? WHERE id = ? AND status = 'awaiting_payment'",
          ).run('not paid before the payment link expired; confirmed unpaid at the gateway', nowIso(), row.id);
          report.expired++;
          record({
            actor: 'system:reconciler', action: 'order.expired', subjectId: row.id, outcome: 'ok',
            detail: { olderThanHours: ABANDON_AFTER_MS / 3600_000, confirmedUnpaid: true },
          });
          continue;
        }
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

  // After settlement, not before: an order becomes transferable by being paid,
  // and the sweep above is what notices that.
  await sweepTransfers(report, opts);

  if (report.checked > 0 || report.transferred > 0) {
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
