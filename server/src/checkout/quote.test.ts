import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

process.env.KIRANA_DB = `data/test-quote-${process.pid}.db`;
process.env.KIRANA_SIGNING_SECRET = 'a'.repeat(64);

const { ingestStorefront } = await import('../catalog/ingest.ts');
const { getMerchant, searchCatalog } = await import('../catalog/store.ts');
const { createQuote, validateForPayment, markQuote, QuoteError, computeShipping } = await import('./quote.ts');
const { db } = await import('../lib/db.ts');
const { verify } = await import('../audit/ledger.ts');

const FIXTURE = readFileSync(new URL('../adapters/__fixtures__/shopify-store.json', import.meta.url), 'utf8');
const fakeFetch = async (url: string | URL) => {
  const u = String(url);
  if (u.includes('/meta.json')) return new Response(JSON.stringify({ currency: 'INR' }), { headers: { 'content-type': 'application/json' } });
  if (u.includes('/products.json')) {
    const page = Number(new URL(u).searchParams.get('page') ?? '1');
    return new Response(page > 1 ? '{"products":[]}' : FIXTURE, { headers: { 'content-type': 'application/json' } });
  }
  return new Response('<html><title>Blue Hill</title></html>', { headers: { 'content-type': 'text/html' } });
};

let merchantId = '';
let cheapVariant = '';   // Attikan 250g @ 499.00, available
let bigVariant = '';     // Attikan 500g @ 1899.10, available
let soldOutVariant = ''; // Attikan 1kg @ 3499.00, unavailable

before(async () => {
  await ingestStorefront('bluehill.in', { fetchImpl: fakeFetch as never });
  merchantId = getMerchant('bluehill-in')!.id;
  const attikan = searchCatalog(merchantId, { query: 'attikan' })[0]!;
  cheapVariant = attikan.variants.find((v) => v.priceMinor === 49900)!.id;
  bigVariant = attikan.variants.find((v) => v.priceMinor === 189910)!.id;
  soldOutVariant = attikan.variants.find((v) => v.priceMinor === 349900)!.id;
});

test('shipping rule is applied at the documented threshold', () => {
  assert.equal(computeShipping(49900), 4900);
  assert.equal(computeShipping(50000), 0);
  assert.equal(computeShipping(189910), 0);
});

test('a quote totals exactly, in paise', () => {
  const q = createQuote(merchantId, [{ variantId: cheapVariant, quantity: 2 }]);
  assert.equal(q.subtotalMinor, 99800);
  assert.equal(q.shippingMinor, 0);
  assert.equal(q.totalMinor, 99800);
  assert.equal(q.currency, 'INR');
  assert.equal(q.status, 'open');
});

test('a small order carries flat shipping', () => {
  const q = createQuote(merchantId, [{ variantId: cheapVariant, quantity: 1 }]);
  assert.equal(q.subtotalMinor, 49900);
  assert.equal(q.shippingMinor, 4900);
  assert.equal(q.totalMinor, 54800);
});

test('a fresh quote passes every payment gate', () => {
  const q = createQuote(merchantId, [{ variantId: bigVariant, quantity: 1 }]);
  const v = validateForPayment(q.id);
  assert.equal(v.ok, true, v.reason);
});

test('out-of-stock items cannot even be quoted', () => {
  assert.throws(
    () => createQuote(merchantId, [{ variantId: soldOutVariant, quantity: 1 }]),
    (e: unknown) => e instanceof QuoteError && (e as InstanceType<typeof QuoteError>).code === 'out_of_stock',
  );
});

test('quantities are validated rather than coerced', () => {
  for (const bad of [0, -1, 1.5, 101, NaN]) {
    assert.throws(() => createQuote(merchantId, [{ variantId: cheapVariant, quantity: bad }]), QuoteError, `quantity ${bad}`);
  }
});

test('an unknown item is refused, not silently dropped', () => {
  assert.throws(() => createQuote(merchantId, [{ variantId: 'var_nonexistent', quantity: 1 }]), QuoteError);
});

test('THE ATTACK: an agent editing the total is caught by the signature', () => {
  const q = createQuote(merchantId, [{ variantId: bigVariant, quantity: 1 }]);
  assert.equal(validateForPayment(q.id).ok, true);
  // The agent rewrites the price it intends to pay: ₹1899.10 -> ₹1.00
  db.prepare('UPDATE quotes SET total_minor = 100, subtotal_minor = 100 WHERE id = ?').run(q.id);
  const v = validateForPayment(q.id);
  assert.equal(v.ok, false);
  assert.equal(v.code, 'bad_signature');
  assert.match(v.reason ?? '', /altered after it was issued/);
});

test('an expired quote is refused', () => {
  const q = createQuote(merchantId, [{ variantId: bigVariant, quantity: 1 }]);
  db.prepare('UPDATE quotes SET expires_at = ? WHERE id = ?').run(new Date(Date.now() - 1000).toISOString(), q.id);
  const v = validateForPayment(q.id);
  assert.equal(v.ok, false);
  // Signature covers expires_at, so tampering with it trips the signature gate
  // first. Either refusal is correct; what matters is that it does not pass.
  assert.ok(v.code === 'expired' || v.code === 'bad_signature');
});

test('a quote cannot be paid twice', () => {
  const q = createQuote(merchantId, [{ variantId: bigVariant, quantity: 1 }]);
  markQuote(q.id, 'consumed');
  const v = validateForPayment(q.id);
  assert.equal(v.ok, false);
  assert.equal(v.code, 'already_used');
});

test('THE DEMO FAILURE: price drift between quote and payment blocks the charge', () => {
  const q = createQuote(merchantId, [{ variantId: cheapVariant, quantity: 1 }]);
  assert.equal(validateForPayment(q.id).ok, true);
  // The merchant raises the price after the agent got its quote.
  db.prepare('UPDATE variants SET price_minor = 59900 WHERE id = ?').run(cheapVariant);
  const v = validateForPayment(q.id);
  assert.equal(v.ok, false);
  assert.equal(v.code, 'price_drift');
  assert.deepEqual(v.drift, [{ variantId: cheapVariant, field: 'price', quotedAt: 49900, nowAt: 59900 }]);
  assert.match(v.reason ?? '', /No payment was attempted/);
  db.prepare('UPDATE variants SET price_minor = 49900 WHERE id = ?').run(cheapVariant);
});

test('stock drift between quote and payment blocks the charge', () => {
  const q = createQuote(merchantId, [{ variantId: cheapVariant, quantity: 1 }]);
  db.prepare('UPDATE variants SET available = 0 WHERE id = ?').run(cheapVariant);
  const v = validateForPayment(q.id);
  assert.equal(v.ok, false);
  assert.equal(v.code, 'stock_drift');
  db.prepare('UPDATE variants SET available = 1 WHERE id = ?').run(cheapVariant);
});

test('every quote decision is on the audit chain and the chain verifies', () => {
  assert.equal(verify().ok, true);
});
