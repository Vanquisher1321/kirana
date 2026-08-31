import type { FetchLike, IngestOptions, IngestResult, StorefrontAdapter } from '../types.ts';
import { toMinor } from '../lib/money.ts';

/**
 * Tier 1 of the ingestion ladder.
 *
 * Shopify serves an unauthenticated /products.json on essentially every store.
 * That is a real, stable, structured feed -- so for a Shopify merchant we need
 * no scraping, no LLM and no cooperation from the merchant whatsoever. This is
 * why "make any merchant agent-transactable" is tractable rather than fantasy:
 * a large share of Indian D2C runs on Shopify and is already machine-readable,
 * it just has nobody reading it.
 */

const PAGE_SIZE = 250;

interface ShopifyVariant {
  id: number; title: string; sku?: string | null; price: string;
  compare_at_price?: string | null; available?: boolean; grams?: number | null;
  option1?: string | null; option2?: string | null; option3?: string | null;
}
interface ShopifyProduct {
  id: number; title: string; handle: string; body_html?: string | null;
  vendor?: string | null; product_type?: string | null;
  tags?: string[] | string | null;
  variants?: ShopifyVariant[];
  images?: Array<{ src?: string }> | null;
  options?: Array<{ name: string }> | null;
}

function stripHtml(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|h[1-6])>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#39;|&rsquo;/g, "'")
    .replace(/&quot;|&ldquo;|&rdquo;/g, '"')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function normaliseTags(tags: ShopifyProduct['tags']): string[] {
  if (!tags) return [];
  if (Array.isArray(tags)) return tags.map((t) => String(t).trim()).filter(Boolean);
  return String(tags).split(',').map((t) => t.trim()).filter(Boolean);
}

function buildOptions(v: ShopifyVariant, names: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  const vals = [v.option1, v.option2, v.option3];
  vals.forEach((val, i) => {
    if (val == null || val === '') return;
    out[names[i] ?? `option${i + 1}`] = String(val);
  });
  return out;
}

export const shopifyAdapter: StorefrontAdapter = {
  platform: 'shopify',

  async detect(origin, fetchImpl) {
    try {
      const res = await fetchImpl(`${origin}/products.json?limit=1`, {
        headers: { accept: 'application/json' },
      });
      if (!res.ok) return false;
      const ct = res.headers.get('content-type') ?? '';
      if (!ct.includes('json')) return false;
      const body = (await res.json()) as { products?: unknown };
      return Array.isArray(body.products);
    } catch {
      return false;
    }
  },

  async ingest(origin, fetchImpl, opts: IngestOptions): Promise<IngestResult> {
    const warnings: string[] = [];
    const sourceUrls: string[] = [];

    let currency = 'INR';
    try {
      const metaRes = await fetchImpl(`${origin}/meta.json`, { headers: { accept: 'application/json' } });
      if (metaRes.ok) {
        const meta = (await metaRes.json()) as { currency?: string; name?: string };
        if (meta.currency) currency = meta.currency;
        sourceUrls.push(`${origin}/meta.json`);
      }
    } catch {
      warnings.push('Could not read /meta.json; assuming INR. Verify before going live.');
    }

    // Fall back to a readable form of the domain, not the domain itself:
    // Gymshark's homepage gave us nothing usable and the shop was listed to
    // buyers as "gymshark.com".
    let shopName = titleFromHost(new URL(origin).hostname);
    try {
      const shopRes = await fetchImpl(`${origin}/`, { headers: { accept: 'text/html' } });
      if (shopRes.ok) {
        const html = await shopRes.text();
        const m = html.match(/<meta\s+property=["']og:site_name["']\s+content=["']([^"']+)["']/i)
          ?? html.match(/<title[^>]*>([^<]+)<\/title>/i);
        // Decode entities: a shop called "Dot &amp; Key" was handed to buying
        // agents, and shown in the console, exactly like that.
        // Trim the tagline: "Dot & Key - Skincare" is a title, "Dot & Key" is
        // a shop. Split on separators that are actually separators -- an
        // EM-dash counts (decoding produces them), and a hyphen only when it
        // is spaced, so a hyphenated brand name survives intact.
        if (m?.[1]) shopName = decodeEntities(m[1]).split(/\s*[|\u2013\u2014\u00b7]\s*|\s+-\s+/)[0]!.trim() || shopName;
      }
    } catch { /* name is cosmetic; never fail ingestion over it */ }

    const collected: ShopifyProduct[] = [];
    for (let page = 1; collected.length < opts.maxProducts && page <= 20; page++) {
      const url = `${origin}/products.json?limit=${PAGE_SIZE}&page=${page}`;
      const res = await fetchImpl(url, { headers: { accept: 'application/json' } });
      if (!res.ok) {
        warnings.push(`Page ${page} returned HTTP ${res.status}; stopped paginating.`);
        break;
      }
      sourceUrls.push(url);
      const body = (await res.json()) as { products?: ShopifyProduct[] };
      const batch = body.products ?? [];
      if (batch.length === 0) break;
      collected.push(...batch);
      if (batch.length < PAGE_SIZE) break;
    }

    const products: IngestResult['products'] = [];
    for (const p of collected.slice(0, opts.maxProducts)) {
      const optionNames = (p.options ?? []).map((o) => o.name);
      const variants: IngestResult['products'][number]['variants'] = [];

      for (const v of p.variants ?? []) {
        let priceMinor: number;
        try {
          priceMinor = toMinor(v.price);
        } catch {
          warnings.push(`Skipped variant ${v.id} of "${p.title}": unparseable price ${JSON.stringify(v.price)}.`);
          continue;
        }
        // toMinor accepts a leading minus, deliberately, because it is also
        // used for refunds. A CATALOG price is different: a storefront we do
        // not control can publish a negative one, and since every cap is a
        // statement about the signed sum, a -₹499,000 line makes a ₹500,000
        // basket total ₹1,000 and pass every gate. A price is a positive
        // number of paise or it is not a price.
        if (!Number.isSafeInteger(priceMinor) || priceMinor < 1) {
          warnings.push(`Skipped variant ${v.id} of "${p.title}": price is not a positive amount.`);
          continue;
        }
        let compareAtMinor: number | undefined;
        if (v.compare_at_price) {
          try { compareAtMinor = toMinor(v.compare_at_price); } catch { /* optional */ }
        }
        variants.push({
          externalId: String(v.id),
          title: v.title ?? 'Default',
          sku: v.sku ?? undefined,
          priceMinor,
          compareAtMinor,
          currency,
          // Shopify omits `available` on some themes; absent is treated as
          // unavailable rather than available, because an agent buying a
          // sold-out item is a worse failure than an agent missing a sale.
          available: v.available === true,
          options: buildOptions(v, optionNames),
          weightGrams: typeof v.grams === 'number' ? v.grams : undefined,
        });
      }

      if (variants.length === 0) {
        warnings.push(`Product "${p.title}" has no usable variants; excluded from the agent catalog.`);
        continue;
      }

      products.push({
        externalId: String(p.id),
        title: p.title,
        description: stripHtml(p.body_html ?? '').slice(0, 4000),
        vendor: p.vendor ?? undefined,
        productType: p.product_type ?? undefined,
        tags: normaliseTags(p.tags),
        url: `${origin}/products/${p.handle}`,
        imageUrl: p.images?.[0]?.src,
        variants,
      });
    }

    if (products.length === 0) warnings.push('No purchasable products found. The store may be password-protected or empty.');

    return {
      merchant: {
        slug: new URL(origin).hostname.replace(/^www\./, '').replace(/[^a-z0-9]+/gi, '-').toLowerCase(),
        name: shopName,
        originUrl: origin,
        platform: 'shopify',
        currency,
        policies: {},
      },
      products,
      warnings,
      provenance: { adapter: 'shopify', sourceUrls, fetchedAt: new Date().toISOString(), usedLlm: false },
    };
  },
};

/**
 * A shop's own HTML is the source of its name, and HTML is entity-encoded.
 * Without this, "Dot &amp; Key" reaches the console and every buying agent
 * verbatim. Only the five XML entities plus numeric refs -- this is a label,
 * not a document, and a full HTML parser here would be a dependency and an
 * attack surface for a cosmetic field.
 */
function decodeEntities(text: string): string {
  return text
    .replace(/&#(\d+);/g, (_, d: string) => safeChar(Number(d)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h: string) => safeChar(parseInt(h, 16)))
    .replace(/&quot;/gi, '"')
    .replace(/&apos;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&');   // last, so &amp;lt; does not become <
}

function safeChar(code: number): string {
  // No control characters from a remote shop's markup into our own strings.
  if (!Number.isFinite(code) || code < 32 || (code >= 127 && code < 160)) return '';
  try { return String.fromCodePoint(code); } catch { return ''; }
}

/** "gymshark.com" -> "Gymshark". Better than the bare domain when a shop's own page tells us nothing. */
function titleFromHost(hostname: string): string {
  const base = hostname.replace(/^www\./, '').split('.')[0] ?? hostname;
  return base
    .split(/[-_]/)
    .filter(Boolean)
    .map((w) => w[0]!.toUpperCase() + w.slice(1))
    .join(' ') || hostname;
}
