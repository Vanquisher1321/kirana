import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';

// A temp file, not the working tree: test artefacts in a mounted repo
// become undeletable locks that fail the NEXT run with a bare disk I/O error.
process.env.KIRANA_DB = join(tmpdir(), `kirana-test-ingest-${process.pid}-${Date.now()}.db`);
const { ingestStorefront, normaliseOrigin } = await import('./ingest.ts');
const { searchCatalog, getMerchant, listMerchants, latestRun } = await import('./store.ts');
const { verify } = await import('../audit/ledger.ts');

const FIXTURE = readFileSync(new URL('../adapters/__fixtures__/shopify-store.json', import.meta.url), 'utf8');

const fakeFetch = async (url: string | URL) => {
  const u = String(url);
  if (u.includes('/meta.json')) return new Response(JSON.stringify({ currency: 'INR' }), { headers: { 'content-type': 'application/json' } });
  if (u.includes('/products.json')) {
    const page = Number(new URL(u).searchParams.get('page') ?? '1');
    if (page > 1) return new Response(JSON.stringify({ products: [] }), { headers: { 'content-type': 'application/json' } });
    return new Response(FIXTURE, { headers: { 'content-type': 'application/json' } });
  }
  return new Response('<html><head><title>Blue Hill Coffee | Roasters</title></head></html>', { headers: { 'content-type': 'text/html' } });
};

test('normaliseOrigin accepts what a human would actually type', () => {
  assert.equal(normaliseOrigin('bluehill.in'), 'https://bluehill.in');
  assert.equal(normaliseOrigin('http://bluehill.in/collections/all'), 'https://bluehill.in');
  assert.equal(normaliseOrigin('https://www.bluehill.in/'), 'https://www.bluehill.in');
});

test('end to end: storefront URL becomes a queryable agent catalog', async () => {
  const report = await ingestStorefront('bluehill.in', { fetchImpl: fakeFetch as never });
  assert.equal(report.adapter, 'shopify');
  assert.equal(report.usedLlm, false);
  assert.equal(report.productCount, 2);
  assert.equal(report.variantCount, 4);

  const merchant = getMerchant('bluehill-in')!;
  assert.ok(merchant, 'merchant persisted under a slug');
  assert.equal(merchant.currency, 'INR');

  const hits = searchCatalog(merchant.id, { query: 'attikan' });
  assert.equal(hits.length, 1);
  assert.equal(hits[0]!.variants[0]!.priceMinor, 49900);
});

test('re-ingesting replaces the catalog rather than duplicating it', async () => {
  await ingestStorefront('bluehill.in', { fetchImpl: fakeFetch as never });
  const report = await ingestStorefront('bluehill.in', { fetchImpl: fakeFetch as never });
  assert.equal(report.replacedPrevious, true);
  assert.equal(listMerchants().length, 1);
  const merchant = getMerchant('bluehill-in')!;
  assert.equal(searchCatalog(merchant.id, {}).length, 2);
});

test('search filters by price ceiling and stock', async () => {
  const merchant = getMerchant('bluehill-in')!;
  // Cold Brew 349.50 only.
  assert.equal(searchCatalog(merchant.id, { maxPriceMinor: 40000 }).length, 1);
  // Cold Brew 349.50 and Attikan 250g 499.00.
  assert.equal(searchCatalog(merchant.id, { maxPriceMinor: 50000 }).length, 2);
  // Nothing this cheap exists.
  assert.equal(searchCatalog(merchant.id, { maxPriceMinor: 10000 }).length, 0);
  const inStock = searchCatalog(merchant.id, { query: 'cold brew', inStockOnly: true });
  assert.equal(inStock.length, 0, 'the only cold brew variant has no availability flag, so it is not sellable');
});

test('provenance and warnings are stored for the merchant to see', async () => {
  const merchant = getMerchant('bluehill-in')!;
  const run = latestRun(merchant.id)!;
  assert.equal(run.adapter, 'shopify');
  assert.equal(Number(run.used_llm), 0);
  const warnings = JSON.parse(String(run.warnings)) as string[];
  assert.ok(warnings.some((w) => w.includes('unparseable price')));
});

test('every ingestion is written to the audit chain and the chain still verifies', () => {
  const v = verify();
  assert.equal(v.ok, true);
  assert.ok(v.checked >= 6);
});

test('an unreadable storefront fails loudly instead of importing nothing silently', async () => {
  const dead = async () => new Response('nope', { status: 404 });
  await assert.rejects(
    () => ingestStorefront('unknown-platform.example', { fetchImpl: dead as never }),
    /No ingestion adapter could read/,
  );
});
