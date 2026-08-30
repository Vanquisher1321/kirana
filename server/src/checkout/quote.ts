import { createHmac, timingSafeEqual } from 'node:crypto';
import { db, nowIso } from '../lib/db.ts';
import { id } from '../lib/id.ts';
import { config } from '../lib/config.ts';
import { getVariant, getMerchant } from '../catalog/store.ts';
import { record } from '../audit/ledger.ts';
import { ensureAgent } from './agents.ts';

/**
 * A quote is a signed, expiring, immutable price.
 *
 * The threat this exists for is specific to agentic commerce: the buyer is a
 * program holding a JSON object, and the cheapest attack in the world is to
 * edit `total_minor` before paying. So the total is HMAC-signed by the server,
 * and at capture time it is BOTH signature-checked and re-derived from live
 * catalog prices. The agent never gets to assert what something costs.
 */

export const QUOTE_TTL_MS = 10 * 60 * 1000;

/** Free shipping over ₹500, else ₹49. Deliberately simple and deliberately visible. */
export const FREE_SHIPPING_THRESHOLD_MINOR = 50_000;
export const FLAT_SHIPPING_MINOR = 4_900;

export interface QuoteLineInput {
  variantId: string;
  quantity: number;
}

export interface QuoteLine {
  variantId: string;
  productTitle: string;
  variantTitle: string;
  quantity: number;
  unitPriceMinor: number;
  lineTotalMinor: number;
}

export interface Quote {
  id: string;
  merchantId: string;
  agentId: string | null;
  lines: QuoteLine[];
  subtotalMinor: number;
  shippingMinor: number;
  taxMinor: number;
  totalMinor: number;
  currency: string;
  signature: string;
  createdAt: string;
  expiresAt: string;
  status: 'open' | 'consumed' | 'expired' | 'void';
}

export class QuoteError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'QuoteError';
    this.code = code;
  }
}

/** Stable serialisation. Key order is fixed by construction, not by JSON.stringify luck. */
function canonical(q: Omit<Quote, 'signature' | 'status'>): string {
  return JSON.stringify([
    q.id, q.merchantId, q.currency,
    q.lines.map((l) => [l.variantId, l.quantity, l.unitPriceMinor]),
    q.subtotalMinor, q.shippingMinor, q.taxMinor, q.totalMinor, q.expiresAt,
  ]);
}

export function sign(payload: string): string {
  return createHmac('sha256', config.signingSecret).update(payload).digest('hex');
}

export function signatureMatches(expected: string, actual: string): boolean {
  const a = Buffer.from(expected, 'hex');
  const b = Buffer.from(actual, 'hex');
  if (a.length !== b.length || a.length === 0) return false;
  return timingSafeEqual(a, b);
}

export function computeShipping(subtotalMinor: number): number {
  return subtotalMinor >= FREE_SHIPPING_THRESHOLD_MINOR ? 0 : FLAT_SHIPPING_MINOR;
}

export function createQuote(
  merchantId: string,
  lines: QuoteLineInput[],
  agentId: string | null = null,
): Quote {
  const merchant = getMerchant(merchantId);
  if (!merchant) throw new QuoteError('merchant_not_found', `No merchant ${merchantId}.`);
  ensureAgent(agentId);

  if (!Array.isArray(lines) || lines.length === 0) {
    throw new QuoteError('empty_cart', 'A quote needs at least one line item.');
  }
  if (lines.length > 50) {
    throw new QuoteError('too_many_lines', 'A quote may contain at most 50 line items.');
  }

  const resolved: QuoteLine[] = [];
  for (const line of lines) {
    const qty = Number(line.quantity);
    if (!Number.isInteger(qty) || qty < 1 || qty > 100) {
      throw new QuoteError('bad_quantity', `Quantity for ${line.variantId} must be a whole number between 1 and 100, got ${line.quantity}.`);
    }
    const v = getVariant(line.variantId);
    if (!v) throw new QuoteError('variant_not_found', `No such item: ${line.variantId}.`);
    if (v.merchantId !== merchantId) {
      // Cross-merchant carts are refused outright: a quote is signed by one
      // merchant's catalog and settled to one merchant's Razorpay account.
      throw new QuoteError('cross_merchant', `Item ${line.variantId} does not belong to this merchant.`);
    }
    if (!v.available) {
      throw new QuoteError('out_of_stock', `"${v.productTitle} — ${v.title}" is out of stock.`);
    }
    resolved.push({
      variantId: v.id,
      productTitle: v.productTitle,
      variantTitle: v.title,
      quantity: qty,
      unitPriceMinor: v.priceMinor,
      lineTotalMinor: v.priceMinor * qty,
    });
  }

  const subtotalMinor = resolved.reduce((s, l) => s + l.lineTotalMinor, 0);
  const shippingMinor = computeShipping(subtotalMinor);
  const taxMinor = 0; // Indian D2C list prices are GST-inclusive; we do not re-add tax.
  const totalMinor = subtotalMinor + shippingMinor + taxMinor;

  const now = Date.now();
  const draft = {
    id: id('qte'),
    merchantId,
    agentId,
    lines: resolved,
    subtotalMinor,
    shippingMinor,
    taxMinor,
    totalMinor,
    currency: merchant.currency,
    createdAt: new Date(now).toISOString(),
    expiresAt: new Date(now + QUOTE_TTL_MS).toISOString(),
  };
  const signature = sign(canonical(draft));

  db.prepare(
    `INSERT INTO quotes (id, merchant_id, agent_id, lines, subtotal_minor, shipping_minor, tax_minor, total_minor, currency, signature, created_at, expires_at, status)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,'open')`,
  ).run(
    draft.id, merchantId, agentId, JSON.stringify(resolved), subtotalMinor,
    shippingMinor, taxMinor, totalMinor, merchant.currency, signature,
    draft.createdAt, draft.expiresAt,
  );

  record({
    actor: agentId ? `agent:${agentId}` : 'agent:anonymous',
    action: 'quote.created',
    subjectId: draft.id,
    outcome: 'ok',
    detail: {
      merchantId, lines: resolved.length, subtotalMinor, shippingMinor,
      totalMinor, currency: merchant.currency, expiresAt: draft.expiresAt,
    },
  });

  return { ...draft, signature, status: 'open' };
}

function rowToQuote(r: Record<string, unknown>): Quote {
  return {
    id: String(r.id), merchantId: String(r.merchant_id),
    agentId: (r.agent_id as string | null) ?? null,
    lines: JSON.parse(String(r.lines)) as QuoteLine[],
    subtotalMinor: Number(r.subtotal_minor), shippingMinor: Number(r.shipping_minor),
    taxMinor: Number(r.tax_minor), totalMinor: Number(r.total_minor),
    currency: String(r.currency), signature: String(r.signature),
    createdAt: String(r.created_at), expiresAt: String(r.expires_at),
    status: r.status as Quote['status'],
  };
}

export function getQuote(quoteId: string): Quote | null {
  const r = db.prepare('SELECT * FROM quotes WHERE id = ?').get(quoteId) as Record<string, unknown> | undefined;
  return r ? rowToQuote(r) : null;
}

export function markQuote(quoteId: string, status: Quote['status']): void {
  db.prepare('UPDATE quotes SET status = ? WHERE id = ?').run(status, quoteId);
}

export interface QuoteValidation {
  ok: boolean;
  code?: 'not_found' | 'bad_signature' | 'expired' | 'already_used' | 'price_drift' | 'stock_drift';
  reason?: string;
  quote?: Quote;
  /** Populated on drift so the agent can be told exactly what moved. */
  drift?: Array<{ variantId: string; field: 'price' | 'availability'; quotedAt: number | boolean; nowAt: number | boolean }>;
}

/**
 * The gate every payment must pass.
 *
 * Four independent checks, in increasing cost order: signature, expiry, reuse,
 * then a live re-derivation against the current catalog. The last one is the
 * interesting one -- it is what stops an agent paying yesterday's price for
 * today's product, and it is the failure this project demonstrates on camera.
 */
export function validateForPayment(quoteId: string): QuoteValidation {
  const quote = getQuote(quoteId);
  if (!quote) return { ok: false, code: 'not_found', reason: `No quote ${quoteId}.` };

  const expectedSig = sign(canonical(quote));
  if (!signatureMatches(expectedSig, quote.signature)) {
    return { ok: false, code: 'bad_signature', reason: 'Quote signature does not match its contents. The quote was altered after it was issued.', quote };
  }

  if (Date.parse(quote.expiresAt) <= Date.now()) {
    return { ok: false, code: 'expired', reason: `Quote expired at ${quote.expiresAt}. Request a fresh quote.`, quote };
  }

  if (quote.status !== 'open') {
    return { ok: false, code: 'already_used', reason: `Quote is ${quote.status} and cannot be paid again.`, quote };
  }

  const drift: NonNullable<QuoteValidation['drift']> = [];
  for (const line of quote.lines) {
    const v = getVariant(line.variantId);
    if (!v) {
      drift.push({ variantId: line.variantId, field: 'availability', quotedAt: true, nowAt: false });
      continue;
    }
    if (v.priceMinor !== line.unitPriceMinor) {
      drift.push({ variantId: line.variantId, field: 'price', quotedAt: line.unitPriceMinor, nowAt: v.priceMinor });
    }
    if (!v.available) {
      drift.push({ variantId: line.variantId, field: 'availability', quotedAt: true, nowAt: false });
    }
  }

  if (drift.length > 0) {
    const priceMoved = drift.some((d) => d.field === 'price');
    return {
      ok: false,
      code: priceMoved ? 'price_drift' : 'stock_drift',
      reason: priceMoved
        ? 'Catalog prices changed after this quote was issued. No payment was attempted; request a fresh quote.'
        : 'An item became unavailable after this quote was issued. No payment was attempted.',
      quote,
      drift,
    };
  }

  return { ok: true, quote };
}
