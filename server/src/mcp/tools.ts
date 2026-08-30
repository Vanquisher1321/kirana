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
