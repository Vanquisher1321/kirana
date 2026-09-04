import { db, nowIso } from '../lib/db.ts';
import { id } from '../lib/id.ts';
import type { IngestResult, Merchant, Product, Variant } from '../types.ts';
import { randomBytes } from 'node:crypto';

export interface PersistSummary {
  merchantId: string;
  publicId: string;
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
export function persistIngest(
  result: IngestResult,
  durationMs: number,
  startedAt: string,
  workspaceId: string | null = null,
): PersistSummary {
  const { merchant, products, warnings, provenance } = result;
  // A slug is unique WITHIN a workspace, not globally: two tenants may both
  // ingest the same shop and must not collide.
  const existing = (workspaceId
    ? db.prepare('SELECT id, public_id FROM merchants WHERE slug = ? AND workspace_id IS ?').get(merchant.slug, workspaceId)
    : db.prepare('SELECT id, public_id FROM merchants WHERE slug = ? AND workspace_id IS NULL').get(merchant.slug)
  ) as { id?: string; public_id?: string } | undefined;
  const merchantId = existing?.id ?? id('mch');
  const publicId = existing?.public_id ?? `shp_${randomBytes(18).toString('base64url')}`;
  const replacedPrevious = Boolean(existing?.id);

  db.exec('BEGIN');
  try {
    if (replacedPrevious) {
      db.prepare('UPDATE merchants SET name=?, origin_url=?, platform=?, currency=?, policies=?, ingested_at=?, public_id=COALESCE(public_id, ?) WHERE id=?')
        .run(merchant.name, merchant.originUrl, merchant.platform, merchant.currency, JSON.stringify(merchant.policies), nowIso(), publicId, merchantId);
      db.prepare('DELETE FROM products WHERE merchant_id = ?').run(merchantId);
    } else {
      db.prepare('INSERT INTO merchants (id, slug, name, origin_url, platform, currency, policies, ingested_at, workspace_id, public_id) VALUES (?,?,?,?,?,?,?,?,?,?)')
        .run(merchantId, merchant.slug, merchant.name, merchant.originUrl, merchant.platform, merchant.currency, JSON.stringify(merchant.policies), nowIso(), workspaceId, publicId);
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
    return { merchantId, publicId, runId, productCount: products.length, variantCount, replacedPrevious };
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

function rowToMerchant(r: Record<string, unknown>): Merchant {
  return {
    id: String(r.id), slug: String(r.slug), name: String(r.name), originUrl: String(r.origin_url),
    publicId: (r.public_id as string | null) ?? '',
    workspaceId: (r.workspace_id as string | null) ?? null,
    platform: r.platform as Merchant['platform'], currency: String(r.currency),
    razorpayAccountId: (r.razorpay_account_id as string | null) ?? null,
    policies: JSON.parse(String(r.policies)), ingestedAt: String(r.ingested_at),
  };
}

/**
 * Point a shop's takings at its own Razorpay account.
 *
 * Console-only, and deliberately not part of ingestion: reading a storefront
 * can establish what a shop SELLS and never who it banks with. A linked account
 * arrives from a person who can prove they are the merchant, which is also why
 * `null` has to remain expressible -- clearing it is how you stop transferring
 * to an account that is no longer theirs.
 */
export function setMerchantPayout(merchantId: string, accountId: string | null): Merchant | null {
  db.prepare('UPDATE merchants SET razorpay_account_id = ? WHERE id = ?').run(accountId, merchantId);
  return getMerchant(merchantId);
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

/** Scoped to one workspace. Pass null for the cross-tenant platform view. */
export function listMerchants(workspaceId?: string | null): Merchant[] {
  const rows = workspaceId === undefined
    ? db.prepare('SELECT * FROM merchants ORDER BY ingested_at DESC').all()
    : db.prepare('SELECT * FROM merchants WHERE workspace_id IS ? ORDER BY ingested_at DESC').all(workspaceId);
  return (rows as Record<string, unknown>[]).map(rowToMerchant);
}

/**
 * Look a merchant up by id, public id, or slug.
 *
 * When a workspace is given the lookup is confined to it, so one tenant can
 * never reach another's shop by guessing a slug. The public id is globally
 * unique and unguessable, which is what makes an MCP URL safe to hand out.
 */
export function getMerchant(key: string, workspaceId?: string | null): Merchant | null {
  const scoped = workspaceId !== undefined;
  const r = (scoped
    ? db.prepare('SELECT * FROM merchants WHERE (id = ? OR slug = ? OR public_id = ?) AND workspace_id IS ?').get(key, key, key, workspaceId)
    : db.prepare('SELECT * FROM merchants WHERE id = ? OR slug = ? OR public_id = ?').get(key, key, key)
  ) as Record<string, unknown> | undefined;
  return r ? rowToMerchant(r) : null;
}

/** Resolves the merchant behind an MCP URL segment. Public id first. */
export function getMerchantForMcp(key: string): Merchant | null {
  const byPublic = db.prepare('SELECT * FROM merchants WHERE public_id = ?').get(key) as Record<string, unknown> | undefined;
  if (byPublic) return rowToMerchant(byPublic);
  // Slug fallback keeps older links working, but only when it is unambiguous.
  const bySlug = db.prepare('SELECT * FROM merchants WHERE slug = ?').all(key) as Record<string, unknown>[];
  return bySlug.length === 1 ? rowToMerchant(bySlug[0]!) : null;
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
  const joinParams: Array<string | number> = [];
  if (opts.maxPriceMinor != null) { joinConds.push('v.price_minor <= ?'); joinParams.push(opts.maxPriceMinor); }
  if (opts.minPriceMinor != null) { joinConds.push('v.price_minor >= ?'); joinParams.push(opts.minPriceMinor); }
  if (opts.inStockOnly) { joinConds.push('v.available = 1'); }

  const whereConds = ['p.merchant_id = ?'];
  const whereParams: Array<string | number> = [merchantId];
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

  const params = [...joinParams, ...whereParams, limit] as Array<string | number>;
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
