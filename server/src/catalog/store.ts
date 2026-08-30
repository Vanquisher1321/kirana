import { db, nowIso } from '../lib/db.ts';
import { id } from '../lib/id.ts';
import type { IngestResult, Merchant, Product, Variant } from '../types.ts';

export interface PersistSummary {
  merchantId: string;
  runId: string;
  productCount: number;
  variantCount: number;
  replacedPrevious: boolean;
}

/**
 * Ingestion is idempotent per merchant slug: re-ingesting replaces the catalog
 * rather than accumulating duplicates. Prices move; an agent must never be able
 * to find a stale row that a newer crawl already superseded.
 */
export function persistIngest(result: IngestResult, durationMs: number, startedAt: string): PersistSummary {
  const { merchant, products, warnings, provenance } = result;
  const existing = db.prepare('SELECT id FROM merchants WHERE slug = ?').get(merchant.slug) as { id?: string } | undefined;
  const merchantId = existing?.id ?? id('mch');
  const replacedPrevious = Boolean(existing?.id);

  db.exec('BEGIN');
  try {
    if (replacedPrevious) {
      db.prepare('UPDATE merchants SET name=?, origin_url=?, platform=?, currency=?, policies=?, ingested_at=? WHERE id=?')
        .run(merchant.name, merchant.originUrl, merchant.platform, merchant.currency, JSON.stringify(merchant.policies), nowIso(), merchantId);
      db.prepare('DELETE FROM products WHERE merchant_id = ?').run(merchantId);
    } else {
      db.prepare('INSERT INTO merchants (id, slug, name, origin_url, platform, currency, policies, ingested_at) VALUES (?,?,?,?,?,?,?,?)')
        .run(merchantId, merchant.slug, merchant.name, merchant.originUrl, merchant.platform, merchant.currency, JSON.stringify(merchant.policies), nowIso());
    }

    const insProduct = db.prepare(
      'INSERT INTO products (id, merchant_id, external_id, title, description, vendor, product_type, tags, url, image_url) VALUES (?,?,?,?,?,?,?,?,?,?)',
    );
    const insVariant = db.prepare(
      'INSERT INTO variants (id, product_id, external_id, title, sku, price_minor, compare_at_minor, currency, available, inventory_qty, options, weight_grams) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',
    );

    let variantCount = 0;
    for (const p of products) {
      const pid = id('prd');
      insProduct.run(pid, merchantId, p.externalId, p.title, p.description, p.vendor ?? null, p.productType ?? null, JSON.stringify(p.tags), p.url, p.imageUrl ?? null);
      for (const v of p.variants) {
        insVariant.run(id('var'), pid, v.externalId, v.title, v.sku ?? null, v.priceMinor, v.compareAtMinor ?? null, v.currency, v.available ? 1 : 0, v.inventoryQty ?? null, JSON.stringify(v.options), v.weightGrams ?? null);
        variantCount++;
      }
    }

    const runId = id('run');
    db.prepare('INSERT INTO ingest_runs (id, merchant_id, adapter, used_llm, source_urls, product_count, variant_count, warnings, duration_ms, started_at, finished_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)')
      .run(runId, merchantId, provenance.adapter, provenance.usedLlm ? 1 : 0, JSON.stringify(provenance.sourceUrls), products.length, variantCount, JSON.stringify(warnings), Math.round(durationMs), startedAt, nowIso());

    db.exec('COMMIT');
    return { merchantId, runId, productCount: products.length, variantCount, replacedPrevious };
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

function rowToMerchant(r: Record<string, unknown>): Merchant {
  return {
    id: String(r.id), slug: String(r.slug), name: String(r.name), originUrl: String(r.origin_url),
    platform: r.platform as Merchant['platform'], currency: String(r.currency),
    policies: JSON.parse(String(r.policies)), ingestedAt: String(r.ingested_at),
  };
}

function rowToVariant(r: Record<string, unknown>): Variant {
  return {
    id: String(r.id), productId: String(r.product_id), externalId: String(r.external_id),
    title: String(r.title), sku: (r.sku as string | null) ?? undefined,
    priceMinor: Number(r.price_minor),
    compareAtMinor: r.compare_at_minor == null ? undefined : Number(r.compare_at_minor),
    currency: String(r.currency), available: Number(r.available) === 1,
    inventoryQty: r.inventory_qty == null ? undefined : Number(r.inventory_qty),
    options: JSON.parse(String(r.options)),
    weightGrams: r.weight_grams == null ? undefined : Number(r.weight_grams),
  };
}

function rowToProduct(r: Record<string, unknown>, variants: Variant[]): Product {
  return {
    id: String(r.id), merchantId: String(r.merchant_id), externalId: String(r.external_id),
    title: String(r.title), description: String(r.description),
    vendor: (r.vendor as string | null) ?? undefined,
    productType: (r.product_type as string | null) ?? undefined,
    tags: JSON.parse(String(r.tags)), url: String(r.url),
    imageUrl: (r.image_url as string | null) ?? undefined, variants,
  };
}

export function listMerchants(): Merchant[] {
  return (db.prepare('SELECT * FROM merchants ORDER BY ingested_at DESC').all() as Record<string, unknown>[]).map(rowToMerchant);
}

export function getMerchant(idOrSlug: string): Merchant | null {
  const r = db.prepare('SELECT * FROM merchants WHERE id = ? OR slug = ?').get(idOrSlug, idOrSlug) as Record<string, unknown> | undefined;
  return r ? rowToMerchant(r) : null;
}

function variantsFor(productIds: string[]): Map<string, Variant[]> {
  const map = new Map<string, Variant[]>();
  if (productIds.length === 0) return map;
  const placeholders = productIds.map(() => '?').join(',');
  const rows = db.prepare(`SELECT * FROM variants WHERE product_id IN (${placeholders}) ORDER BY price_minor ASC`).all(...productIds) as Record<string, unknown>[];
  for (const r of rows) {
    const v = rowToVariant(r);
    const arr = map.get(v.productId) ?? [];
    arr.push(v);
    map.set(v.productId, arr);
  }
  return map;
}

export interface SearchOpts {
  query?: string;
  maxPriceMinor?: number;
  minPriceMinor?: number;
  inStockOnly?: boolean;
  limit?: number;
}

/**
 * Deliberately plain keyword search over title/description/tags/vendor.
 * A buyer agent is already a language model -- it does the semantic work. Our
 * job is to return honest, complete, cheap results, not to be clever.
 */
export function searchCatalog(merchantId: string, opts: SearchOpts = {}): Product[] {
  const limit = Math.min(opts.limit ?? 20, 100);

  // Params are assembled in SQL text order (JOIN conditions bind before WHERE),
  // not in the order the options happen to be read. Getting this backwards
  // silently returns the wrong rows rather than erroring, which is exactly the
  // kind of bug that reaches a buyer agent as a wrong price.
  const joinConds: string[] = [];
  const joinParams: unknown[] = [];
  if (opts.maxPriceMinor != null) { joinConds.push('v.price_minor <= ?'); joinParams.push(opts.maxPriceMinor); }
  if (opts.minPriceMinor != null) { joinConds.push('v.price_minor >= ?'); joinParams.push(opts.minPriceMinor); }
  if (opts.inStockOnly) { joinConds.push('v.available = 1'); }

  const whereConds = ['p.merchant_id = ?'];
  const whereParams: unknown[] = [merchantId];
  if (opts.query?.trim()) {
    const terms = opts.query.trim().toLowerCase().split(/\s+/).slice(0, 8);
    for (const t of terms) {
      whereConds.push("(lower(p.title) LIKE ? OR lower(p.description) LIKE ? OR lower(p.tags) LIKE ? OR lower(coalesce(p.vendor,'')) LIKE ?)");
      const like = `%${t}%`;
      whereParams.push(like, like, like, like);
    }
  }

  let sql = 'SELECT DISTINCT p.* FROM products p';
  if (joinConds.length) sql += ` JOIN variants v ON v.product_id = p.id AND ${joinConds.join(' AND ')}`;
  sql += ` WHERE ${whereConds.join(' AND ')} LIMIT ?`;

  const params = [...joinParams, ...whereParams, limit];
  const rows = db.prepare(sql).all(...params) as Record<string, unknown>[];
  const vmap = variantsFor(rows.map((r) => String(r.id)));
  return rows.map((r) => rowToProduct(r, vmap.get(String(r.id)) ?? []));
}

export function getProduct(productId: string): Product | null {
  const r = db.prepare('SELECT * FROM products WHERE id = ?').get(productId) as Record<string, unknown> | undefined;
  if (!r) return null;
  return rowToProduct(r, variantsFor([productId]).get(productId) ?? []);
}

export function getVariant(variantId: string): (Variant & { merchantId: string; productTitle: string }) | null {
  const r = db.prepare(
    `SELECT v.*, p.merchant_id AS m_id, p.title AS p_title FROM variants v JOIN products p ON p.id = v.product_id WHERE v.id = ?`,
  ).get(variantId) as Record<string, unknown> | undefined;
  if (!r) return null;
  return { ...rowToVariant(r), merchantId: String(r.m_id), productTitle: String(r.p_title) };
}

export function latestRun(merchantId: string): Record<string, unknown> | null {
  return (db.prepare('SELECT * FROM ingest_runs WHERE merchant_id = ? ORDER BY finished_at DESC LIMIT 1').get(merchantId) as Record<string, unknown>) ?? null;
}
