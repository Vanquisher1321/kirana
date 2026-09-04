import { config } from '../lib/config.ts';

/**
 * Minimal Razorpay REST client built on fetch.
 *
 * Deliberately not the official SDK: this is ~150 lines, adds no dependency,
 * and -- more importantly -- lets the retry and circuit-breaker behaviour be
 * explicit and testable. In a payments path, "what exactly happens when the
 * gateway returns 502 halfway through" is not something to inherit blindly.
 */

const BASE = 'https://api.razorpay.com/v1';

export class RazorpayError extends Error {
  status: number;
  code: string;
  description: string;
  retryable: boolean;
  constructor(status: number, code: string, description: string) {
    super(`Razorpay ${status} ${code}: ${description}`);
    this.name = 'RazorpayError';
    this.status = status;
    this.code = code;
    this.description = description;
    // 4xx means we sent something wrong; retrying sends the same wrong thing.
    // 429 and 5xx are the gateway's problem and may clear on their own.
    this.retryable = status === 429 || status >= 500;
  }
}

export class CircuitOpenError extends Error {
  constructor(until: number) {
    super(`Razorpay circuit breaker is open until ${new Date(until).toISOString()}. No request was sent.`);
    this.name = 'CircuitOpenError';
  }
}

/**
 * Circuit breaker. After repeated gateway failures we stop sending requests
 * entirely for a cooldown, rather than hammering a struggling gateway and
 * piling up ambiguous in-flight charges. Ambiguity is the enemy: a request that
 * may or may not have taken money is worse than one that definitely did not.
 */
const BREAKER = { failures: 0, openUntil: 0, threshold: 4, cooldownMs: 30_000 };

export function circuitState() {
  return {
    open: Date.now() < BREAKER.openUntil,
    failures: BREAKER.failures,
    openUntil: BREAKER.openUntil ? new Date(BREAKER.openUntil).toISOString() : null,
  };
}

export function resetCircuit(): void {
  BREAKER.failures = 0;
  BREAKER.openUntil = 0;
}

function recordFailure(): void {
  BREAKER.failures += 1;
  if (BREAKER.failures >= BREAKER.threshold) {
    BREAKER.openUntil = Date.now() + BREAKER.cooldownMs;
    BREAKER.failures = 0;
  }
}

function authHeader(): string {
  const raw = `${config.razorpay.keyId}:${config.razorpay.keySecret}`;
  return `Basic ${Buffer.from(raw).toString('base64')}`;
}

export interface CallOptions {
  method?: 'GET' | 'POST';
  body?: Record<string, unknown>;
  attempts?: number;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function call<T>(path: string, opts: CallOptions = {}): Promise<T> {
  if (!config.razorpay.configured) {
    throw new RazorpayError(0, 'not_configured', 'Razorpay keys are not set; checkout is disabled.');
  }
  if (Date.now() < BREAKER.openUntil) throw new CircuitOpenError(BREAKER.openUntil);

  const doFetch = opts.fetchImpl ?? fetch;
  const method = opts.method ?? 'GET';
  /**
   * Only a GET may be repeated freely.
   *
   * POST /orders and POST /payment_links are not idempotent and we send no
   * idempotency key, so a request that SUCCEEDED at Razorpay but whose
   * response was lost -- a timeout, a dropped connection, a 502 from a proxy
   * in front of a request that already ran -- creates a second real Order or a
   * second real, payable Payment Link when it is retried. Only the last
   * response is returned, so the orphan link is live, carries our reference
   * id, and is invisible to us. Worse, because reference ids must be unique,
   * the retry usually comes back 4xx and the checkout is marked failed while a
   * payable link exists.
   *
   * This module's own stated principle is that "a request that may or may not
   * have taken money is worse than one that definitely did not", and blanket
   * retries contradicted it. A 429 is the one safe case: Razorpay rejects it
   * before doing any work.
   */
  const repeatable = method === 'GET';
  const attempts = opts.attempts ?? 3;
  let lastErr: unknown;

  for (let attempt = 1; attempt <= attempts; attempt++) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), opts.timeoutMs ?? 15_000);
    try {
      const res = await doFetch(`${BASE}${path}`, {
        method,
        headers: {
          authorization: authHeader(),
          'content-type': 'application/json',
          accept: 'application/json',
        },
        body: opts.body ? JSON.stringify(opts.body) : undefined,
        signal: ctl.signal,
      });

      const text = await res.text();
      const parsed = text ? (JSON.parse(text) as Record<string, unknown>) : {};

      if (!res.ok) {
        const err = (parsed.error ?? {}) as { code?: string; description?: string };
        const rzpErr = new RazorpayError(res.status, err.code ?? 'unknown', err.description ?? text.slice(0, 200));
        const mayRepeat = rzpErr.retryable && (repeatable || res.status === 429);
        if (!mayRepeat || attempt === attempts) {
          if (rzpErr.retryable) recordFailure();
          throw rzpErr;
        }
        recordFailure();
        lastErr = rzpErr;
        await sleep(200 * 2 ** (attempt - 1));
        continue;
      }

      resetCircuit();
      return parsed as T;
    } catch (err) {
      if (err instanceof RazorpayError) throw err;
      recordFailure();
      lastErr = err;
      // A network failure on a write is ambiguous: the charge may exist.
      // Repeating it is how one checkout becomes two payable links.
      if (!repeatable) break;
      if (attempt === attempts) break;
      await sleep(200 * 2 ** (attempt - 1));
    } finally {
      clearTimeout(timer);
    }
  }

  throw lastErr instanceof Error ? lastErr : new Error('Razorpay request failed');
}

export interface RzpOrder { id: string; amount: number; currency: string; receipt?: string; status: string; }
export interface RzpPaymentLink {
  id: string; short_url: string; status: string; amount: number; amount_paid?: number; currency?: string;
  reference_id?: string; order_id?: string;
  payments?: Array<{ payment_id: string; status: string; amount: number; created_at?: number }> | null;
}
export interface RzpPayment { id: string; amount: number; currency: string; status: string; order_id?: string; error_code?: string | null; error_description?: string | null; }

export function createOrder(input: {
  amountMinor: number; currency: string; receipt: string; notes?: Record<string, string>;
}, opts: CallOptions = {}): Promise<RzpOrder> {
  return call<RzpOrder>('/orders', {
    ...opts,
    method: 'POST',
    body: {
      amount: input.amountMinor,
      currency: input.currency,
      receipt: input.receipt.slice(0, 40),
      notes: input.notes ?? {},
    },
  });
}

export function createPaymentLink(input: {
  amountMinor: number; currency: string; description: string; referenceId: string;
  callbackUrl?: string; notes?: Record<string, string>; expireBy?: number;
}, opts: CallOptions = {}): Promise<RzpPaymentLink> {
  const body: Record<string, unknown> = {
    amount: input.amountMinor,
    currency: input.currency,
    description: input.description.slice(0, 2048),
    reference_id: input.referenceId.slice(0, 40),
    notes: input.notes ?? {},
    notify: { sms: false, email: false },
    reminder_enable: false,
  };
  if (input.callbackUrl) { body.callback_url = input.callbackUrl; body.callback_method = 'get'; }
  if (input.expireBy) body.expire_by = input.expireBy;
  return call<RzpPaymentLink>('/payment_links', { ...opts, method: 'POST', body });
}

export interface RzpTransfer {
  id: string; entity?: string; source?: string; recipient?: string;
  amount: number; currency: string; status?: string;
  error?: { code?: string; description?: string } | null;
}

/**
 * Route: move a captured payment on to the merchant's linked account.
 *
 * Deliberately AFTER capture, against the payment id, rather than as a
 * `transfers` array on the order we create at checkout. Two reasons, and the
 * first is this project's oldest scar.
 *
 * A Razorpay Order and a Payment Link are different objects, and our customers
 * pay the LINK -- which is why reconciliation had to learn to look at the link
 * first. Transfers attached to the order we create would hang off the object
 * the money does not arrive on. Splitting at capture time sidesteps the whole
 * distinction: whatever route the money took, `settleOrder` ends up holding the
 * payment id that actually received it.
 *
 * Second, it is retryable. A transfer that fails leaves a captured payment and
 * an order that plainly says the money has not been passed on yet, and the
 * reconciler tries again. A split declared at order creation either happens or
 * silently does not.
 *
 * Shape is per Razorpay's "Create Transfers from Payments":
 *   POST /payments/{id}/transfers  { transfers: [{ account, amount, currency }] }
 * Note `account`, not `account_id` -- the linked-account docs use both spellings
 * for different endpoints and this is the one this call wants.
 */
export function createTransfer(paymentId: string, input: {
  account: string; amountMinor: number; currency: string; notes?: Record<string, string>;
}, opts: CallOptions = {}): Promise<{ items?: RzpTransfer[] }> {
  return call<{ items?: RzpTransfer[] }>(`/payments/${paymentId}/transfers`, {
    ...opts,
    method: 'POST',
    body: {
      transfers: [{
        account: input.account,
        amount: input.amountMinor,
        currency: input.currency,
        notes: input.notes ?? {},
      }],
    },
  });
}

export function fetchPayment(paymentId: string, opts: CallOptions = {}): Promise<RzpPayment> {
  return call<RzpPayment>(`/payments/${paymentId}`, opts);
}

export function fetchOrderPayments(orderId: string, opts: CallOptions = {}): Promise<{ count: number; items: RzpPayment[] }> {
  return call<{ count: number; items: RzpPayment[] }>(`/orders/${orderId}/payments`, opts);
}

export function fetchPaymentLink(linkId: string, opts: CallOptions = {}): Promise<RzpPaymentLink> {
  return call<RzpPaymentLink>(`/payment_links/${linkId}`, opts);
}
