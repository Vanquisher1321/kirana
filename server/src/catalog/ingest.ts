import { shopifyAdapter } from '../adapters/shopify.ts';
import { persistIngest, type PersistSummary } from './store.ts';
import { record } from '../audit/ledger.ts';
import { nowIso } from '../lib/db.ts';
import type { FetchLike, IngestOptions, StorefrontAdapter } from '../types.ts';
import { normaliseOrigin, makeFetch } from '../lib/http.ts';
import { robotsAllows } from '../lib/robots.ts';
import { assertFetchableUrl, BlockedHostError } from '../lib/security.ts';

export { normaliseOrigin, makeFetch };

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

export interface IngestReport extends PersistSummary {
  origin: string;
  adapter: string;
  usedLlm: boolean;
  warnings: string[];
  durationMs: number;
}

export async function ingestStorefront(
  rawOrigin: string,
  opts: Partial<IngestOptions> & { fetchImpl?: FetchLike; guard?: boolean; workspaceId?: string | null } = {},
): Promise<IngestReport> {
  const origin = normaliseOrigin(rawOrigin);
  const fetchImpl = opts.fetchImpl ?? makeFetch();

  // The SSRF guard protects the REAL network path. When a caller injects its
  // own transport (tests, the offline seed) no request reaches the network at
  // all, so DNS validation would only be rejecting fixture hostnames. The guard
  // therefore defaults on and is skipped only for an explicitly injected fetch
  // -- never because a hostname looked awkward.
  const guard = opts.guard ?? !opts.fetchImpl;
  const options: IngestOptions = { maxProducts: opts.maxProducts ?? 500, llm: opts.llm };
  const startedAt = nowIso();
  const t0 = performance.now();

  // Validated before a single request leaves the process. `origin` came from a
  // user, and this endpoint's whole job is to fetch what a user names.
  try {
    if (guard) await assertFetchableUrl(origin);
  } catch (err) {
    record({
      actor: 'console', action: 'ingest.refused', subjectId: origin, outcome: 'blocked',
      detail: { origin, reason: err instanceof BlockedHostError ? err.reason : 'invalid target' },
    });
    throw new IngestError(
      err instanceof BlockedHostError
        ? `Refusing to fetch ${origin}: ${err.reason}. Only public web addresses can be ingested.`
        : `Refusing to fetch ${origin}.`,
      origin,
    );
  }

  /**
   * Ask before reading.
   *
   * The product feed is public and a default Shopify robots.txt does not
   * disallow it, so this refuses almost nothing. That is the point: the claim
   * worth being able to make to a merchant is not "your data was public", it is
   * "your data was public and we checked what you asked for first". It fails
   * open -- a missing or unreachable robots.txt is no preference stated, not a
   * refusal -- and it is skipped when a caller injects its own transport, for
   * the same reason the SSRF guard is: no request reaches the network at all.
   */
  if (guard) {
    // Its own short timeout, not the ingest's. This is a courtesy check on a
    // file most shops never think about; it must not be able to hold a shop's
    // connection hostage for fifteen seconds because one static file is slow.
    const verdict = await robotsAllows(origin, '/products.json', makeFetch(4_000));
    if (!verdict.allowed) {
      record({
        actor: 'console', action: 'ingest.refused', subjectId: origin, outcome: 'blocked',
        detail: { origin, reason: 'robots.txt', rule: verdict.rule ?? null },
      });
      throw new IngestError(
        `${origin} asks crawlers not to read its product feed (${verdict.rule}). ` +
        `Kirana respects that, so this shop cannot be connected without the merchant's involvement.`,
        origin,
      );
    }
  }

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
  const summary = persistIngest(result, durationMs, startedAt, opts.workspaceId ?? null);

  record({
    actor: 'console',
    action: 'ingest.completed',
    subjectId: summary.merchantId,
    outcome: 'ok',
    detail: {
      origin,
      workspaceId: opts.workspaceId ?? null,
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
