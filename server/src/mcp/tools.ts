import { getMerchant, searchCatalog, getProduct, latestRun, getVariant } from '../catalog/store.ts';
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
  /** The shop, on a per-shop connection. Empty string on a buyer connection. */
  merchantId: string;
  /**
   * Present only on a BUYER connection: the shops this visitor has connected.
   *
   * A buyer link is one connector for every shop its owner has added, which is
   * what makes an assistant useful across more than one merchant. It is also a
   * wider capability than a single shop's address, so it is bounded by exactly
   * this list and nothing widens it at request time -- an id belonging to a
   * shop outside the list reads as not-found, the same answer a stranger gets.
   */
  shopIds?: string[];
  /** The workspace of the person this connection belongs to, on a buyer link. */
  buyerWorkspaceId?: string | null;
  agentId: string | null;
  /** True only when the caller presented a matching agent key. */
  identityProven: boolean;
}

/** Is this shop inside the connection's reach? */
function allows(ctx: ToolContext, merchantId: string | null | undefined): boolean {
  if (!merchantId) return false;
  return ctx.shopIds ? ctx.shopIds.includes(merchantId) : merchantId === ctx.merchantId;
}

/** Every shop this connection can act on. One on a shop link, many on a buyer link. */
function reach(ctx: ToolContext): string[] {
  return ctx.shopIds ?? (ctx.merchantId ? [ctx.merchantId] : []);
}

/**
 * The shops on a buyer's connection, so an assistant can say where it is
 * shopping before it searches. Only present on a buyer link -- a single shop's
 * connection already knows its one shop.
 */
export function toolListShops(ctx: ToolContext) {
  const shops = reach(ctx).map((mid) => getMerchant(mid)).filter((m): m is NonNullable<typeof m> => Boolean(m));
  return {
    count: shops.length,
    shops: shops.map((m) => ({
      merchant_id: m.id,
      name: m.name,
      storefront: m.originUrl,
      currency: m.currency,
    })),
    note: shops.length === 0
      ? 'This buyer has not connected any shops yet. Nothing can be searched or bought until they do.'
      : 'Search covers all of these at once. Every product and quote names the shop it belongs to.',
  };
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

  /**
   * One shop or many, the same search -- but the merge across shops is
   * round-robin, one from each in turn, not concatenate-and-trim.
   *
   * Every shop is searched under the caller's FULL limit, because none of them
   * knows what the others hold. Concatenating those lists and slicing back to
   * the limit therefore returns the first shop's hits and stops: with two shops
   * and ten results asked for, shop one supplies all ten and shop two is
   * invisible. A buyer with five shops connected could only ever see one of
   * them -- which is the entire reason a buyer link exists, and it failed
   * silently, as a shorter list of plausible products rather than an error.
   *
   * Taking one from each shop in turn keeps every shop's own relevance order,
   * gives each of them a turn at the top, and still fills the limit from
   * whoever has hits left once a shop runs out -- so a single-shop link and a
   * link whose other shops match nothing both return exactly what they did
   * before.
   */
  const limit = opts.limit ?? 10;
  const shops = reach(ctx);
  const perShop = shops.map((mid) => ({ mid, hits: searchCatalog(mid, opts) }));
  const shopNames = new Map(shops.map((mid) => [mid, getMerchant(mid)?.name ?? mid]));

  const picked: Array<{ mid: string; product: Product }> = [];
  const deepest = perShop.reduce((n, p) => Math.max(n, p.hits.length), 0);
  for (let rank = 0; rank < deepest && picked.length < limit; rank++) {
    for (const { mid, hits } of perShop) {
      const hit = hits[rank];
      if (!hit) continue;
      picked.push({ mid, product: hit });
      if (picked.length >= limit) break;
    }
  }

  const results = picked.map(({ mid, product }) => ({
    ...shapeProduct(product),
    // Which shop a price came from is not a detail on a multi-shop link: the
    // agent has to name it to the human, and the quote will be settled to it.
    merchant_id: mid,
    shop: shopNames.get(mid) ?? mid,
  }));

  record({
    actor: ctx.agentId ? `agent:${ctx.agentId}` : 'agent:anonymous',
    action: 'catalog.searched',
    subjectId: shops.length === 1 ? shops[0] : `buyer:${shops.length}shops`,
    outcome: 'ok',
    detail: { query: args.query ?? null, filters: { max: opts.maxPriceMinor ?? null, min: opts.minPriceMinor ?? null, inStockOnly: opts.inStockOnly }, hits: results.length, shops: shops.length },
  });

  return {
    count: results.length,
    products: results,
    note: results.length === 0
      ? shops.length === 0
        ? 'No shops are connected to this link yet, so there is nothing to search.'
        : 'Nothing matched. Try fewer words, or drop the price filter — these catalogues may simply not carry it.'
      : undefined,
  };
}

export function toolGetProduct(ctx: ToolContext, args: { product_id: string }) {
  const p = getProduct(args.product_id);
  if (!p || !allows(ctx, p.merchantId)) {
    return { error: 'product_not_found', message: `No product ${args.product_id} in this catalog.` };
  }
  return { ...shapeProduct(p), merchant_id: p.merchantId, shop: getMerchant(p.merchantId)?.name ?? p.merchantId };
}

export interface QuoteArgs {
  items: Array<{ variant_id: string; quantity: number }>;
}

export function toolCreateQuote(ctx: ToolContext, args: QuoteArgs) {
  const items = Array.isArray(args.items) ? args.items : [];
  const lines: QuoteLineInput[] = items.map((i) => ({ variantId: String(i.variant_id), quantity: Number(i.quantity) }));

  // On a buyer link there is no single shop in context, so the basket names it.
  // getVariant already knows which merchant a variant belongs to, and
  // createQuote refuses a cart that spans two of them -- a quote is signed by
  // one catalogue and settles to one Razorpay account.
  let merchantId = ctx.merchantId;
  if (ctx.shopIds) {
    const first = lines[0] ? getVariant(lines[0].variantId) : null;
    if (!first || !allows(ctx, first.merchantId)) {
      return { error: 'variant_not_found', message: `No such item: ${lines[0]?.variantId ?? '(none given)'}.` };
    }
    merchantId = first.merchantId;
  }

  try {
    const q = createQuote(merchantId, lines, ctx.agentId);
    return {
      quote_id: q.id,
      merchant_id: merchantId,
      shop: getMerchant(merchantId)?.name ?? merchantId,
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
        subjectId: merchantId,
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
  if (!q || !allows(ctx, q.merchantId)) {
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
  if (!q || !allows(ctx, q.merchantId)) return { error: 'quote_not_found', message: `No quote ${args.quote_id}.` };

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
      quoteId: q.id, agentId: ctx.agentId, capMinor, scope: q.merchantId,
      identityProven: ctx.identityProven,
      buyerWorkspaceId: ctx.buyerWorkspaceId ?? null,
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
        'do not attempt checkout before it says granted. They also give the delivery address ' +
        'there, on the same screen — you cannot supply one and you will not be told what it is. ' +
        'Do not ask them for it in the conversation.',
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
  if (!c || !allows(ctx, c.scope) || (c.agentId ?? null) !== (ctx.agentId ?? null)) {
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

  // The quote names the shop. On a buyer link that is the only thing that can:
  // taking it from an argument would let a caller settle one shop's basket to
  // another shop's account.
  let merchantId = ctx.merchantId;
  if (ctx.shopIds) {
    const q = loadQuote(args.quote_id);
    if (!q || !allows(ctx, q.merchantId)) {
      return { paid: false, blocked_by: 'quote_not_found', reason: `No quote ${args.quote_id}.`, gates: [], idempotency_key: key };
    }
    merchantId = q.merchantId;
  }

  const out = await checkout({
    quoteId: args.quote_id,
    consentId: args.consent_id,
    merchantId,
    agentId: ctx.agentId,
    identityProven: ctx.identityProven,
    idempotencyKey: key,
    buyerWorkspaceId: ctx.buyerWorkspaceId ?? null,
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

/**
 * What the agent may know about an order it placed.
 *
 * Allowlisted, and the omission that matters is the delivery address. The agent
 * arranged this purchase and still has no business reading where it is going:
 * a buyer agent is software someone else wrote, running somewhere we do not
 * control, and an address is the most personal thing this system holds. The
 * merchant who has to ship it sees it in their console; nothing on this surface
 * returns it. Do not add it here for convenience.
 */
export function toolGetOrder(ctx: ToolContext, args: { order_id: string }) {
  const o = getOrder(args.order_id);
  if (!o || !allows(ctx, String(o.merchant_id))) return { error: 'not_found', message: `No order ${args.order_id}.` };
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
