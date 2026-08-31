/**
 * Canonical, platform-independent catalog model.
 *
 * Design rule that everything else depends on: MONEY IS ALWAYS AN INTEGER IN
 * MINOR UNITS (paise for INR). No floats touch a price anywhere in this system.
 * Razorpay's own APIs work in paise; matching that end-to-end removes a whole
 * class of rounding bugs that are unacceptable in a payments path.
 */

export type Platform = 'shopify' | 'woocommerce' | 'jsonld' | 'html';

export interface Merchant {
  id: string;
  slug: string;
  /** Globally unique, unguessable. This is what an MCP URL carries. */
  publicId: string;
  /** The tenant this shop belongs to. Null for pre-tenancy rows. */
  workspaceId: string | null;
  name: string;
  originUrl: string;
  platform: Platform;
  currency: string;
  ingestedAt: string;
  /** Free-text policies surfaced to buyer agents so they can answer questions without guessing. */
  policies: MerchantPolicies;
}

export interface MerchantPolicies {
  returns?: string;
  shipping?: string;
  contact?: string;
}

export interface Product {
  id: string;
  merchantId: string;
  externalId: string;
  title: string;
  description: string;
  vendor?: string;
  productType?: string;
  tags: string[];
  url: string;
  imageUrl?: string;
  variants: Variant[];
}

export interface Variant {
  id: string;
  productId: string;
  externalId: string;
  title: string;
  sku?: string;
  /** Integer minor units. 49900 === Rs 499.00 */
  priceMinor: number;
  /** Integer minor units. Original/compare-at price when discounted. */
  compareAtMinor?: number;
  currency: string;
  available: boolean;
  inventoryQty?: number;
  options: Record<string, string>;
  weightGrams?: number;
}

/**
 * What an adapter returns before it is persisted.
 *
 * Identity and tenancy are assigned at persistence, not by the adapter — an
 * adapter reads a shop, it does not decide who owns the result.
 */
export interface IngestResult {
  merchant: Omit<Merchant, 'id' | 'ingestedAt' | 'publicId' | 'workspaceId'>;
  products: Array<Omit<Product, 'id' | 'merchantId' | 'variants'> & {
    variants: Array<Omit<Variant, 'id' | 'productId'>>;
  }>;
  /** Non-fatal problems worth showing the merchant rather than hiding. */
  warnings: string[];
  /** How the catalog was obtained, for the audit trail and the console. */
  provenance: {
    adapter: Platform;
    sourceUrls: string[];
    fetchedAt: string;
    usedLlm: boolean;
  };
}

export interface StorefrontAdapter {
  readonly platform: Platform;
  /** Cheap probe: can this adapter handle the origin at all? */
  detect(origin: string, fetchImpl: FetchLike): Promise<boolean>;
  ingest(origin: string, fetchImpl: FetchLike, opts: IngestOptions): Promise<IngestResult>;
}

export interface IngestOptions {
  maxProducts: number;
  /** Only consulted by adapters that need it; keeps the zero-cost path LLM-free. */
  llm?: LlmClient;
}

export interface LlmClient {
  readonly name: string;
  extractJson(prompt: string, schemaHint: string): Promise<unknown>;
}

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;
