import { shopifyAdapter } from '../adapters/shopify.ts';
import { persistIngest, type PersistSummary } from './store.ts';
import { record } from '../audit/ledger.ts';
import { nowIso } from '../lib/db.ts';
import type { FetchLike, IngestOptions, StorefrontAdapter } from '../types.ts';

/**
 * The ingestion ladder, in order. Each rung is cheaper, more accurate and more
 * deterministic than the one below it, so we always climb from the top.
 *
 * This ordering is the whole engineering opinion of the project: an LLM is the
 * LAST resort for reading a storefront, not the first. Structured feeds are
 * free, exact and never hallucinate a price. Reaching for a model first is how
 * you end up with a catalog that is 95% right, which in a payments context is
 * another way of saying wrong.
 */
export const LADDER: StorefrontAdapter[] = [shopifyAdapter];

export class IngestError extends Error {
  // NOTE: Node's strip-only TypeScript mode forbids parameter properties
  // (`constructor(readonly x)`), enums and namespaces -- it erases types, it
  // does not transform code. Fields are declared explicitly throughout.
  origin: string;
  constructor(message: string, origin: string) {
    super(message);
    this.name = 'IngestError';
    this.origin = origin;
  }
}

export function normaliseOrigin(input: string): string {
  const withScheme = /^https?:\/\//i.test(input) ? input : `https://${input}`;
  const u = new URL(withScheme);
  u.protocol = 'https:';
  return `${u.protocol}//${u.host}`;
}

const DEFAULT_HEADERS = {
  'user-agent': 'KiranaBot/0.1 (+agent-commerce ingestion; contact: merchant console)',
  'accept-language': 'en-IN,en;q=0.9',
};

/** Timeout + identifying UA. Politeness is not optional when crawling someone's shop. */
export function makeFetch(timeoutMs = 15_000): FetchLike {
  return async (url, init) => {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeoutMs);
    try {
      return await fetch(url, {
        ...init,
        signal: ctl.signal,
        headers: { ...DEFAULT_HEADERS, ...(init?.headers as Record<string, string> | undefined) },
      });
    } finally {
      clearTimeout(timer);
    }
  };
}

export interface IngestReport extends PersistSummary {
  origin: string;
  adapter: string;
  usedLlm: boolean;
  warnings: string[];
  durationMs: number;
}

export async function ingestStorefront(
  rawOrigin: string,
  opts: Partial<IngestOptions> & { fetchImpl?: FetchLike } = {},
): Promise<IngestReport> {
  const origin = normaliseOrigin(rawOrigin);
  const fetchImpl = opts.fetchImpl ?? makeFetch();
  const options: IngestOptions = { maxProducts: opts.maxProducts ?? 500, llm: opts.llm };
  const startedAt = nowIso();
  const t0 = performance.now();

  record({ actor: 'console', action: 'ingest.started', subjectId: origin, outcome: 'ok', detail: { origin } });

  let chosen: StorefrontAdapter | null = null;
  for (const adapter of LADDER) {
    if (await adapter.detect(origin, fetchImpl)) { chosen = adapter; break; }
  }

  if (!chosen) {
    record({ actor: 'console', action: 'ingest.failed', subjectId: origin, outcome: 'failed', detail: { reason: 'no adapter matched' } });
    throw new IngestError(
      `No ingestion adapter could read ${origin}. Supported today: ${LADDER.map((a) => a.platform).join(', ')}.`,
      origin,
    );
  }

  const result = await chosen.ingest(origin, fetchImpl, options);
  const durationMs = performance.now() - t0;
  const summary = persistIngest(result, durationMs, startedAt);

  record({
    actor: 'console',
    action: 'ingest.completed',
    subjectId: summary.merchantId,
    outcome: 'ok',
    detail: {
      origin,
      adapter: chosen.platform,
      usedLlm: result.provenance.usedLlm,
      products: summary.productCount,
      variants: summary.variantCount,
      warnings: result.warnings.length,
      replacedPrevious: summary.replacedPrevious,
      durationMs: Math.round(durationMs),
    },
  });

  return {
    ...summary,
    origin,
    adapter: chosen.platform,
    usedLlm: result.provenance.usedLlm,
    warnings: result.warnings,
    durationMs: Math.round(durationMs),
  };
}
