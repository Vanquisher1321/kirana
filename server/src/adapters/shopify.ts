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

/**
 * Turn a shop's `body_html` into plain text.
 *
 * Written as a small scanner rather than a chain of `.replace()` calls,
 * because a single regex pass is not a sanitiser and CodeQL is right to say
 * so. Two concrete defeats of the old version:
 *
 *   - `<scr<script>ipt>alert(1)</scr</script>ipt>` -- removing the inner
 *     `<script>` once splices the outer one back into a valid tag. Any
 *     single-pass removal has this property; only running to a fixed point
 *     does not.
 *   - `<a title="a>b" onclick=...>` -- `<[^>]+>` stops at the `>` INSIDE the
 *     quoted attribute, leaving `b" onclick=...>` as visible text.
 *
 * This walks the string once, tracking whether it is inside a quoted attribute
 * value, so a `>` in an attribute cannot end a tag; then it repeats until the
 * output stops changing, so nothing can be reassembled by its own removal. The
 * result is stored and shown as text and never as markup, but "it is not
 * rendered as HTML today" is a property of the consumer, not of this function.
 */
function stripTagsOnce(input: string): string {
  let out = '';
  let i = 0;
  while (i < input.length) {
    if (input[i] !== '<') { out += input[i]; i++; continue; }
    // Comments and CDATA-ish constructs.
    if (input.startsWith('<!--', i)) {
      const end = input.indexOf('-->', i + 4);
      i = end === -1 ? input.length : end + 3;
      continue;
    }
    let j = i + 1;
    let quote: string | null = null;
    while (j < input.length) {
      const ch = input[j]!;
      if (quote) { if (ch === quote) quote = null; }
      else if (ch === '"' || ch === "'") quote = ch;
      else if (ch === '>') break;
      j++;
    }
    if (j >= input.length) { i = input.length; break; }   // unterminated tag: drop the rest
    const tag = input.slice(i + 1, j).trim();
    const name = (/^\/?\s*([a-zA-Z0-9]+)/.exec(tag)?.[1] ?? '').toLowerCase();
    if (name === 'br' || (tag.startsWith('/') && ['p', 'div', 'li', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6'].includes(name))) {
      out += '\n';
    }
    i = j + 1;
  }
  return out;
}

/** Remove a whole element and its contents, to a fixed point. */
function dropElement(input: string, name: string): string {
  const open = new RegExp(`<${name}\\b[^>]*>`, 'i');
  const close = new RegExp(`</${name}\\s*>`, 'i');
  let out = input;
  for (let guard = 0; guard < 100; guard++) {
    const start = out.search(open);
    if (start === -1) return out;
    const rest = out.slice(start);
    const m = close.exec(rest);
    out = m ? out.slice(0, start) + rest.slice(m.index + m[0].length) : out.slice(0, start);
  }
  return out;
}

function stripHtml(html: string): string {
  let text = html;
  for (let pass = 0; pass < 10; pass++) {
    const before = text;
    text = stripTagsOnce(dropElement(dropElement(text, 'script'), 'style'));
    if (text === before) break;   // fixed point: nothing left to reassemble
  }
  return text
    // One pass, after the tags are gone. Chained replaces here decoded `&amp;`
    // BEFORE `&lt;`, so `&amp;lt;script&amp;gt;` in a shop's body_html became
    // a literal `<script>` in the stored description -- markup reconstructed
    // after tag-stripping had already run.
    .replace(
      /&(?:#(\d{1,7})|#[xX]([0-9a-fA-F]{1,6})|(nbsp|amp|lt|gt|quot|apos|rsquo|lsquo|ldquo|rdquo));/g,
      (whole, dec?: string, hex?: string, name?: string) => {
        if (dec !== undefined) return safeChar(Number(dec));
        if (hex !== undefined) return safeChar(parseInt(hex, 16));
        switch ((name ?? '').toLowerCase()) {
          case 'nbsp': return ' ';
          case 'amp': return '&';
          case 'lt': return '<';
          case 'gt': return '>';
          case 'quot': case 'ldquo': case 'rdquo': return '"';
          case 'apos': case 'rsquo': case 'lsquo': return "'";
          default: return whole;
        }
      },
    )
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
        if (m?.[1]) shopName = decodeEntities(m[1]).slice(0, 400).split(/\s*[|\u2013\u2014\u00b7]\s*|\s+-\s+/)[0]!.trim() || shopName;
      }
    } catch { /* name is cosmetic; never fail ingestion over it */ }
    // A shop's <title> is unbounded attacker-controlled text and this is
    // stored, listed and handed to buying agents. 120 characters is a name.
    shopName = shopName.replace(/\s+/gu, ' ').trim().slice(0, 120) || titleFromHost(new URL(origin).hostname);

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
  // ONE pass, so nothing this produces can be re-read as markup.
  //
  // The previous version chained .replace() calls with `&amp;` last, on the
  // theory that ordering stopped `&amp;lt;` becoming `<`. It did, for that
  // spelling -- but the NUMERIC pass ran first and its output was re-scanned
  // by the later named passes, so `&#38;lt;script&#38;gt;` decoded all the way
  // to `<script>`. A single pass over the original string cannot double-decode
  // by construction, whatever spelling arrives.
  return text.replace(
    /&(?:#(\d{1,7})|#[xX]([0-9a-fA-F]{1,6})|(quot|apos|lt|gt|nbsp|amp));/g,
    (whole, dec?: string, hex?: string, name?: string) => {
      if (dec !== undefined) return safeChar(Number(dec));
      if (hex !== undefined) return safeChar(parseInt(hex, 16));
      switch ((name ?? '').toLowerCase()) {
        case 'quot': return '"';
        case 'apos': return "'";
        case 'lt': return '<';
        case 'gt': return '>';
        case 'nbsp': return ' ';
        case 'amp': return '&';
        default: return whole;
      }
    },
  );
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

/** Exported for tests only: both run on hostile remote HTML. */
export const decodeEntitiesForTest = decodeEntities;
export const stripHtmlForTest = stripHtml;
