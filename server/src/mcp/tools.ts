import { getMerchant, searchCatalog, getProduct, latestRun } from '../catalog/store.ts';
import { createQuote, getQuote, QuoteError, type QuoteLineInput } from '../checkout/quote.ts';
import { formatInr, toMinor } from '../lib/money.ts';
import { record } from '../audit/ledger.ts';
import type { Product } from '../types.ts';

/**
 * Tool implementations, kept free of any MCP transport concern so they can be
 * tested directly and reused by the REST console.
 *
 * A consistent principle in the shapes below: prices are returned BOTH as exact
 * integer paise and as a formatted string. The integer is what the system
 * reasons with; the string is what the agent repeats to the human. Handing a
 * language model a float and hoping is how you get an agent that confidently
 * quotes ₹499.0000001.
 */

export interface ToolContext {
  merchantId: string;
  agentId: string | null;
  /** True only when the caller presented a matching agent key. */
  identityProven: boolean;
}

function shapeVariant(v: Product['variants'][number]) {
  return {
    variant_id: v.id,
    title: v.title,
    sku: v.sku ?? null,
    price_minor: v.priceMinor,
    price: formatInr(v.priceMinor),
    compare_at: v.compareAtMinor ? formatInr(v.compareAtMinor) : null,
    currency: v.currency,
    in_stock: v.available,
    options: v.options,
    weight_grams: v.weightGrams ?? null,
  };
}

function shapeProduct(p: Product) {
  const prices = p.variants.map((v) => v.priceMinor);
  return {
    product_id: p.id,
    title: p.title,
    vendor: p.vendor ?? null,
    type: p.productType ?? null,
    tags: p.tags,
    url: p.url,
    image_url: p.imageUrl ?? null,
    price_from: prices.length ? formatInr(Math.min(...prices)) : null,
    any_in_stock: p.variants.some((v) => v.available),
    variants: p.variants.map(shapeVariant),
  };
}

export function toolGetMerchantInfo(ctx: ToolContext) {
  const m = getMerchant(ctx.merchantId);
  if (!m) return { error: 'merchant_not_found' };
  const run = latestRun(m.id);
  return {
    merchant_id: m.id,
    name: m.name,
    storefront: m.originUrl,
    currency: m.currency,
    policies: m.policies,
    catalog: {
      products: run ? Number(run.product_count) : 0,
      variants: run ? Number(run.variant_count) : 0,
      last_synced: m.ingestedAt,
      // Provenance is exposed to the buyer agent on purpose. An agent spending
      // someone's money deserves to know whether this catalog came from a
      // structured feed or was guessed at by a model.
      source: run ? String(run.adapter) : 'unknown',
      extracted_by_model: run ? Number(run.used_llm) === 1 : false,
    },
    shipping_note: 'Free delivery on orders of ₹500.00 and above, otherwise ₹49.00 flat.',
  };
}

export interface SearchArgs {
  query?: string;
  max_price_inr?: number | string;
  min_price_inr?: number | string;
  in_stock_only?: boolean;
  limit?: number;
}

export function toolSearchProducts(ctx: ToolContext, args: SearchArgs) {
  const opts: Parameters<typeof searchCatalog>[1] = {
    query: args.query,
    inStockOnly: args.in_stock_only ?? false,
    limit: Math.min(Number(args.limit ?? 10) || 10, 50),
  };
  try {
    if (args.max_price_inr != null) opts.maxPriceMinor = toMinor(args.max_price_inr as string | number);
    if (args.min_price_inr != null) opts.minPriceMinor = toMinor(args.min_price_inr as string | number);
  } catch {
    return { error: 'bad_price_filter', message: 'Price filters must be plain rupee amounts, e.g. 1500 or "1500.00".' };
  }

  const results = searchCatalog(ctx.merchantId, opts);
  record({
    actor: ctx.agentId ? `agent:${ctx.agentId}` : 'agent:anonymous',
    action: 'catalog.searched',
    subjectId: ctx.merchantId,
    outcome: 'ok',
    detail: { query: args.query ?? null, filters: { max: opts.maxPriceMinor ?? null, min: opts.minPriceMinor ?? null, inStockOnly: opts.inStockOnly }, hits: results.length },
  });

  return {
    count: results.length,
    products: results.map(shapeProduct),
    note: results.length === 0
      ? 'Nothing matched. Try fewer words, or drop the price filter — this catalog may simply not carry it.'
      : undefined,
  };
}

export function toolGetProduct(ctx: ToolContext, args: { product_id: string }) {
  const p = getProduct(args.product_id);
  if (!p || p.merchantId !== ctx.merchantId) {
    return { error: 'product_not_found', message: `No product ${args.product_id} in this catalog.` };
  }
  return shapeProduct(p);
}

export interface QuoteArgs {
  items: Array<{ variant_id: string; quantity: number }>;
}

export function toolCreateQuote(ctx: ToolContext, args: QuoteArgs) {
  const items = Array.isArray(args.items) ? args.items : [];
  const lines: QuoteLineInput[] = items.map((i) => ({ variantId: String(i.variant_id), quantity: Number(i.quantity) }));

  try {
    const q = createQuote(ctx.merchantId, lines, ctx.agentId);
    return {
      quote_id: q.id,
      lines: q.lines.map((l) => ({
        variant_id: l.variantId,
        item: `${l.productTitle} — ${l.variantTitle}`,
        quantity: l.quantity,
        unit_price: formatInr(l.unitPriceMinor),
        line_total: formatInr(l.lineTotalMinor),
      })),
      subtotal: formatInr(q.subtotalMinor),
      shipping: formatInr(q.shippingMinor),
      total: formatInr(q.totalMinor),
      total_minor: q.totalMinor,
      currency: q.currency,
      expires_at: q.expiresAt,
      next_step:
        'This price is signed and fixed. To pay, call checkout with this quote_id and a spending cap ' +
        'at least equal to the total. The human must approve the cap; you cannot raise it yourself.',
    };
  } catch (err) {
    if (err instanceof QuoteError) {
      record({
        actor: ctx.agentId ? `agent:${ctx.agentId}` : 'agent:anonymous',
        action: 'quote.rejected',
        subjectId: ctx.merchantId,
        outcome: 'blocked',
        detail: { code: err.code, message: err.message },
      });
      return { error: err.code, message: err.message };
    }
    throw err;
  }
}

export function toolGetQuote(ctx: ToolContext, args: { quote_id: string }) {
  const q = getQuote(args.quote_id);
  if (!q || q.merchantId !== ctx.merchantId) {
    return { error: 'quote_not_found', message: `No quote ${args.quote_id}.` };
  }
  const expired = Date.parse(q.expiresAt) <= Date.now();
  return {
    quote_id: q.id,
    status: expired && q.status === 'open' ? 'expired' : q.status,
    total: formatInr(q.totalMinor),
    total_minor: q.totalMinor,
    currency: q.currency,
    expires_at: q.expiresAt,
    lines: q.lines.map((l) => ({
      variant_id: l.variantId,
      item: `${l.productTitle} — ${l.variantTitle}`,
      quantity: l.quantity,
      unit_price: formatInr(l.unitPriceMinor),
    })),
  };
}

// ---------------------------------------------------------------------------
// Payment tools. An agent may ask, quote, and pay within a cap. It may not
// approve its own spending, raise a cap, or alter a price.
// ---------------------------------------------------------------------------

import { requestConsent, getConsent, ConsentError } from '../checkout/consent.ts';
import { checkout, getOrder } from '../checkout/checkout.ts';
import { getQuote as loadQuote } from '../checkout/quote.ts';
import { config } from '../lib/config.ts';
import { id as newId } from '../lib/id.ts';

function consoleUrl(): string {
  return config.publicOrigin || `http://localhost:${config.port}`;
}

export function toolRequestApproval(ctx: ToolContext, args: { quote_id: string; spend_cap_inr: number | string }) {
  const q = loadQuote(args.quote_id);
  if (!q || q.merchantId !== ctx.merchantId) return { error: 'quote_not_found', message: `No quote ${args.quote_id}.` };

  let capMinor: number;
  try {
    capMinor = toMinor(args.spend_cap_inr);
  } catch {
    return { error: 'bad_cap', message: 'spend_cap_inr must be a rupee amount, e.g. 1500.' };
  }

  if (capMinor < q.totalMinor) {
    return {
      error: 'cap_below_total',
      message: `You asked for a cap of ${formatInr(capMinor)} but the basket totals ${formatInr(q.totalMinor)}. ` +
        `Ask the human whether to raise the budget — do not lower the basket without telling them.`,
    };
  }

  try {
    const c = requestConsent({
      quoteId: q.id, agentId: ctx.agentId, capMinor, scope: ctx.merchantId,
      identityProven: ctx.identityProven,
    });
    // A standing rule may already have answered. Telling the agent to go and
    // wait for a human when the human decided last Tuesday would send it into
    // a polling loop against a status that is never going to change.
    if (c.status === 'granted') {
      return {
        consent_id: c.id,
        status: 'granted',
        cap: formatInr(c.capMinor),
        basket_total: formatInr(q.totalMinor),
        expires_at: c.expiresAt,
        granted_by: 'a standing approval this person set up in advance',
        message:
          'Approved under a standing approval the account holder set earlier, within its ceilings. ' +
          'No human was asked just now. You may proceed to checkout with this consent_id. ' +
          'The person can revoke the standing approval at any time, and this grant still expires.',
      };
    }

    return {
      consent_id: c.id,
      status: 'pending',
      cap: formatInr(c.capMinor),
      basket_total: formatInr(q.totalMinor),
      expires_at: c.expiresAt,
      approve_url: `${consoleUrl()}/approve/${c.id}`,
      message:
        'A human must approve this before anything can be charged. Show them the approval link, ' +
        'or tell them to open the Kirana console. Poll get_approval until the status changes; ' +
        'do not attempt checkout before it says granted.',
    };
  } catch (err) {
    if (err instanceof ConsentError) return { error: err.code, message: err.message };
    throw err;
  }
}

export function toolGetApproval(ctx: ToolContext, args: { consent_id: string }) {
  const c = getConsent(args.consent_id);
  // Scoped like every other read: an agent may only see approvals for this
  // merchant that were issued to it. Unscoped, this is the read primitive that
  // turns a leaked consent id into someone else's spending power.
  if (!c || c.scope !== ctx.merchantId || (c.agentId ?? null) !== (ctx.agentId ?? null)) {
    return { error: 'not_found', message: `No approval ${args.consent_id}.` };
  }
  const expired = Date.parse(c.expiresAt) <= Date.now() && c.status === 'pending';
  return {
    consent_id: c.id,
    status: expired ? 'expired' : c.status,
    cap: formatInr(c.capMinor),
    quote_id: c.quoteId,
    approved_by: c.grantedBy || null,
    expires_at: c.expiresAt,
    next_step:
      c.status === 'granted' ? 'Approved. You may now call checkout with this consent_id.'
      : c.status === 'pending' ? 'Still waiting on the human. Do not retry more than once every few seconds.'
      : `This approval is ${c.status} and cannot be used. Tell the human what happened.`,
  };
}

export async function toolCheckout(ctx: ToolContext, args: { quote_id: string; consent_id: string; idempotency_key?: string }) {
  const key = args.idempotency_key?.trim() || newId('idem');
  const out = await checkout({
    quoteId: args.quote_id,
    consentId: args.consent_id,
    merchantId: ctx.merchantId,
    agentId: ctx.agentId,
    identityProven: ctx.identityProven,
    idempotencyKey: key,
  });

  if (!out.ok) {
    return {
      paid: false,
      blocked_by: out.blockedBy,
      reason: out.reason,
      // The agent is told exactly which gate stopped it and what every gate
      // checks, so it can explain the refusal to the human rather than
      // inventing one or silently retrying.
      gates: out.checks.map((c) => ({ gate: c.name, enforces: c.says, passed: c.passed, detail: c.detail })),
      idempotency_key: key,
    };
  }

  return {
    paid: false,
    status: 'awaiting_payment',
    order_id: out.orderId,
    razorpay_order_id: out.razorpayOrderId,
    amount: out.amount,
    currency: out.currency,
    pay_url: out.payUrl,
    idempotency_key: key,
    gates: out.checks.map((c) => ({ gate: c.name, enforces: c.says, passed: c.passed })),
    message:
      'Authorised and an order was created on Razorpay. Give the human the pay_url to complete payment. ' +
      'Poll get_order until status is "paid". If you retry checkout, reuse this exact idempotency_key ' +
      'so a retry can never become a second charge.',
  };
}

export function toolGetOrder(ctx: ToolContext, args: { order_id: string }) {
  const o = getOrder(args.order_id);
  if (!o || String(o.merchant_id) !== ctx.merchantId) return { error: 'not_found', message: `No order ${args.order_id}.` };
  return {
    order_id: String(o.id),
    status: String(o.status),
    amount: formatInr(Number(o.amount_minor)),
    currency: String(o.currency),
    razorpay_order_id: (o.razorpay_order_id as string | null) ?? null,
    razorpay_payment_id: (o.razorpay_payment_id as string | null) ?? null,
    failure_reason: (o.failure_reason as string | null) ?? null,
    created_at: String(o.created_at),
  };
}
