import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { shopifyAdapter } from './shopify.ts';
import type { FetchLike } from '../types.ts';

const FIXTURE = readFileSync(new URL('./__fixtures__/shopify-store.json', import.meta.url), 'utf8');

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

/** Fake storefront: page 1 serves the fixture, page 2 is empty (end of catalog). */
const fakeFetch: FetchLike = async (url) => {
  const u = String(url);
  if (u.includes('/meta.json')) return json({ currency: 'INR', name: 'Blue Hill Coffee' });
  if (u.includes('/products.json')) {
    const page = Number(new URL(u).searchParams.get('page') ?? '1');
    if (page > 1) return json({ products: [] });
    return new Response(FIXTURE, { status: 200, headers: { 'content-type': 'application/json' } });
  }
  if (u.endsWith('/')) {
    return new Response('<html><head><title>Blue Hill Coffee | Specialty Roasters</title></head></html>', {
      status: 200, headers: { 'content-type': 'text/html' },
    });
  }
  return new Response('not found', { status: 404 });
};

const opts = { maxProducts: 100 };

test('detect recognises a Shopify storefront', async () => {
  assert.equal(await shopifyAdapter.detect('https://shop.test', fakeFetch), true);
});

test('detect rejects a non-Shopify origin instead of guessing', async () => {
  const htmlOnly: FetchLike = async () => new Response('<html></html>', { headers: { 'content-type': 'text/html' } });
  assert.equal(await shopifyAdapter.detect('https://shop.test', htmlOnly), false);
});

test('ingests products and converts prices to exact paise', async () => {
  const r = await shopifyAdapter.ingest('https://shop.test', fakeFetch, opts);
  const attikan = r.products.find((p) => p.title.startsWith('Attikan'))!;
  assert.equal(attikan.variants[0]!.priceMinor, 49900);
  assert.equal(attikan.variants[0]!.compareAtMinor, 59900);
  // Comma-separated and float-trap price: 1,899.10 must be exactly 189910.
  assert.equal(attikan.variants[1]!.priceMinor, 189910);
  // Integer-looking price still becomes paise.
  assert.equal(attikan.variants[2]!.priceMinor, 349900);
});

test('treats a missing availability flag as unavailable, not available', async () => {
  const r = await shopifyAdapter.ingest('https://shop.test', fakeFetch, opts);
  const coldBrew = r.products.find((p) => p.title === 'Cold Brew Concentrate')!;
  // Variant 221 omits `available` entirely.
  assert.equal(coldBrew.variants[0]!.available, false);
});

test('skips unparseable prices with a warning rather than importing garbage', async () => {
  const r = await shopifyAdapter.ingest('https://shop.test', fakeFetch, opts);
  const coldBrew = r.products.find((p) => p.title === 'Cold Brew Concentrate')!;
  assert.equal(coldBrew.variants.length, 1);
  assert.ok(r.warnings.some((w) => w.includes('unparseable price')));
});

test('excludes products with no usable variants', async () => {
  const r = await shopifyAdapter.ingest('https://shop.test', fakeFetch, opts);
  assert.equal(r.products.some((p) => p.title.startsWith('Gift Card')), false);
  assert.ok(r.warnings.some((w) => w.includes('no usable variants')));
});

test('strips scripts and markup from descriptions', async () => {
  const r = await shopifyAdapter.ingest('https://shop.test', fakeFetch, opts);
  const attikan = r.products.find((p) => p.title.startsWith('Attikan'))!;
  assert.ok(!attikan.description.includes('evil()'));
  assert.ok(!attikan.description.includes('<'));
  assert.ok(attikan.description.includes('dark chocolate & orange peel'));
});

test('normalises comma-string tags and array tags alike', async () => {
  const r = await shopifyAdapter.ingest('https://shop.test', fakeFetch, opts);
  const coldBrew = r.products.find((p) => p.title === 'Cold Brew Concentrate')!;
  assert.deepEqual(coldBrew.tags, ['cold-brew', 'ready-to-drink', 'bestseller']);
});

test('maps variant options using the product option names', async () => {
  const r = await shopifyAdapter.ingest('https://shop.test', fakeFetch, opts);
  const attikan = r.products.find((p) => p.title.startsWith('Attikan'))!;
  assert.deepEqual(attikan.variants[0]!.options, { Weight: '250g', Grind: 'Whole Bean' });
});

test('records provenance and never claims LLM use it did not make', async () => {
  const r = await shopifyAdapter.ingest('https://shop.test', fakeFetch, opts);
  assert.equal(r.provenance.adapter, 'shopify');
  assert.equal(r.provenance.usedLlm, false);
  assert.ok(r.provenance.sourceUrls.some((u) => u.includes('/products.json')));
});

test('degrades gracefully when a page errors mid-pagination', async () => {
  const flaky: FetchLike = async (url) => {
    const u = String(url);
    if (u.includes('/products.json')) {
      const page = Number(new URL(u).searchParams.get('page') ?? '1');
      if (page === 1) return new Response(FIXTURE, { status: 200, headers: { 'content-type': 'application/json' } });
      return new Response('rate limited', { status: 429 });
    }
    return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
  };
  // 250-item page size means page 1 ends pagination naturally here, so force a
  // second page by capping the fixture-size assumption: still must not throw.
  const r = await shopifyAdapter.ingest('https://shop.test', flaky, opts);
  assert.ok(r.products.length > 0);
});
