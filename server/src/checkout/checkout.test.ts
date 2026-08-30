import { test, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

process.env.KIRANA_DB = `data/test-checkout-${process.pid}.db`;
process.env.KIRANA_SIGNING_SECRET = 'c'.repeat(64);
process.env.RAZORPAY_KEY_ID = 'rzp_test_fake123456';
process.env.RAZORPAY_KEY_SECRET = 'fakesecret';

const { ingestStorefront } = await import('../catalog/ingest.ts');
const { getMerchant, searchCatalog } = await import('../catalog/store.ts');
const { createQuote } = await import('./quote.ts');
const { grantConsent, revokeConsent } = await import('./consent.ts');
const { checkout, getOrder, settleOrder } = await import('./checkout.ts');
const { engageKillSwitch, releaseKillSwitch } = await import('./guard.ts');
const { resetCircuit } = await import('../razorpay/client.ts');
const { verify } = await import('../audit/ledger.ts');
const { db } = await import('../lib/db.ts');

const FIXTURE = readFileSync(new URL('../adapters/__fixtures__/shopify-store.json', import.meta.url), 'utf8');
const fixtureFetch = async (url: string | URL) => {
  const u = String(url);
  if (u.includes('/meta.json')) return new Response('{"currency":"INR"}', { headers: { 'content-type': 'application/json' } });
  if (u.includes('/products.json')) {
    const page = Number(new URL(u).searchParams.get('page') ?? '1');
    return new Response(page > 1 ? '{"products":[]}' : FIXTURE, { headers: { 'content-type': 'application/json' } });
  }
  return new Response('<html><title>Blue Hill</title></html>', { headers: { 'content-type': 'text/html' } });
};

/** Records every gateway call so we can assert on how many charges were attempted. */
let rzpCalls: string[] = [];
const okRazorpay = async (url: string | URL) => {
  const u = String(url);
  rzpCalls.push(u);
  if (u.endsWith('/orders')) {
    return new Response(JSON.stringify({ id: 'order_TEST123', amount: 99800, currency: 'INR', status: 'created' }), { status: 200, headers: { 'content-type': 'application/json' } });
  }
  if (u.endsWith('/payment_links')) {
    return new Response(JSON.stringify({ id: 'plink_TEST123', short_url: 'https://rzp.io/i/testlink', status: 'created', amount: 99800 }), { status: 200, headers: { 'content-type': 'application/json' } });
  }
  return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
};
const failingRazorpay = async (url: string | URL) => {
  rzpCalls.push(String(url));
  return new Response(JSON.stringify({ error: { code: 'SERVER_ERROR', description: 'we are down' } }), { status: 502, headers: { 'content-type': 'application/json' } });
};

let merchantId = '';
let cheapVariant = '';

before(async () => {
  await ingestStorefront('bluehill.example', { fetchImpl: fixtureFetch as never });
  merchantId = getMerchant('bluehill-example')!.id;
  const attikan = searchCatalog(merchantId, { query: 'attikan' })[0]!;
  cheapVariant = attikan.variants.find((v) => v.priceMinor === 49900)!.id;
});

beforeEach(() => { rzpCalls = []; releaseKillSwitch(); resetCircuit(); });

function basket(qty = 2) {
  return createQuote(merchantId, [{ variantId: cheapVariant, quantity: qty }]);
}

test('happy path: guarded, charged, audited', async () => {
  const q = basket();                       // ₹998.00
  const c = grantConsent({ quoteId: q.id, agentId: null, capMinor: 100000, scope: 'bluehill-example', grantedBy: 'om' });
  const out = await checkout({
    quoteId: q.id, consentId: c.id, merchantId, agentId: null,
    idempotencyKey: 'idem-happy-1', rzpOptions: { fetchImpl: okRazorpay as never },
  });
  assert.equal(out.ok, true, out.reason);
  assert.equal(out.amount, '₹998.00');
  assert.equal(out.razorpayOrderId, 'order_TEST123');
  assert.equal(out.payUrl, 'https://rzp.io/i/testlink');
  assert.equal(out.status, 'awaiting_payment');
  // Every gate is reported, not just the failing one.
  assert.ok(out.checks.length >= 10);
  assert.ok(out.checks.every((c2) => c2.passed));
});

test('a quote and its approval are single use', async () => {
  const q = basket();
  const c = grantConsent({ quoteId: q.id, agentId: null, capMinor: 100000, scope: 's', grantedBy: 'om' });
  const first = await checkout({ quoteId: q.id, consentId: c.id, merchantId, agentId: null, idempotencyKey: 'idem-once-1', rzpOptions: { fetchImpl: okRazorpay as never } });
  assert.equal(first.ok, true);
  const replay = await checkout({ quoteId: q.id, consentId: c.id, merchantId, agentId: null, idempotencyKey: 'idem-once-2', rzpOptions: { fetchImpl: okRazorpay as never } });
  assert.equal(replay.ok, false);
  assert.equal(replay.blockedBy, 'quote_integrity');
});

test('THE CAP: an agent cannot spend above what the human approved', async () => {
  const q = basket();                       // ₹998.00
  const c = grantConsent({ quoteId: q.id, agentId: null, capMinor: 50000, scope: 's', grantedBy: 'om' }); // ₹500.00
  const out = await checkout({ quoteId: q.id, consentId: c.id, merchantId, agentId: null, idempotencyKey: 'idem-cap', rzpOptions: { fetchImpl: okRazorpay as never } });
  assert.equal(out.ok, false);
  assert.equal(out.blockedBy, 'within_consent_cap');
  assert.match(out.reason ?? '', /₹998\.00 but the approved cap is ₹500\.00/);
  assert.equal(rzpCalls.length, 0, 'refused before any gateway call');
});

test('revoking approval stops a payment that was about to happen', async () => {
  const q = basket();
  const c = grantConsent({ quoteId: q.id, agentId: null, capMinor: 100000, scope: 's', grantedBy: 'om' });
  revokeConsent(c.id, 'om');
  const out = await checkout({ quoteId: q.id, consentId: c.id, merchantId, agentId: null, idempotencyKey: 'idem-revoke', rzpOptions: { fetchImpl: okRazorpay as never } });
  assert.equal(out.ok, false);
  assert.equal(out.blockedBy, 'consent_live');
  assert.match(out.reason ?? '', /revoked/);
  assert.equal(rzpCalls.length, 0);
});

test('approval given to one agent cannot be used by another', async () => {
  const q = basket();
  const c = grantConsent({ quoteId: q.id, agentId: 'agent_alpha', capMinor: 100000, scope: 's', grantedBy: 'om' });
  const out = await checkout({ quoteId: q.id, consentId: c.id, merchantId, agentId: 'agent_beta', idempotencyKey: 'idem-agent', rzpOptions: { fetchImpl: okRazorpay as never } });
  assert.equal(out.ok, false);
  assert.equal(out.blockedBy, 'consent_agent_match');
  assert.equal(rzpCalls.length, 0);
});

test('approval for one basket cannot pay for a different basket', async () => {
  const qA = basket(1);
  const qB = basket(2);
  const c = grantConsent({ quoteId: qA.id, agentId: null, capMinor: 500000, scope: 's', grantedBy: 'om' });
  const out = await checkout({ quoteId: qB.id, consentId: c.id, merchantId, agentId: null, idempotencyKey: 'idem-swap', rzpOptions: { fetchImpl: okRazorpay as never } });
  assert.equal(out.ok, false);
  assert.equal(out.blockedBy, 'consent_quote_match');
});

test('THE DOUBLE CHARGE: the same idempotency key never charges twice', async () => {
  const q1 = basket();
  const c1 = grantConsent({ quoteId: q1.id, agentId: null, capMinor: 100000, scope: 's', grantedBy: 'om' });
  const a = await checkout({ quoteId: q1.id, consentId: c1.id, merchantId, agentId: null, idempotencyKey: 'idem-dupe', rzpOptions: { fetchImpl: okRazorpay as never } });
  assert.equal(a.ok, true);
  const callsAfterFirst = rzpCalls.length;

  const q2 = basket();
  const c2 = grantConsent({ quoteId: q2.id, agentId: null, capMinor: 100000, scope: 's', grantedBy: 'om' });
  const b = await checkout({ quoteId: q2.id, consentId: c2.id, merchantId, agentId: null, idempotencyKey: 'idem-dupe', rzpOptions: { fetchImpl: okRazorpay as never } });
  assert.equal(b.ok, false);
  assert.equal(b.blockedBy, 'idempotency');
  assert.match(b.reason ?? '', /No second charge was made/);
  assert.equal(rzpCalls.length, callsAfterFirst, 'the duplicate never reached the gateway');
});

test('price drift after approval blocks the charge before any money moves', async () => {
  const q = basket();
  const c = grantConsent({ quoteId: q.id, agentId: null, capMinor: 200000, scope: 's', grantedBy: 'om' });
  db.prepare('UPDATE variants SET price_minor = 59900 WHERE id = ?').run(cheapVariant);
  const out = await checkout({ quoteId: q.id, consentId: c.id, merchantId, agentId: null, idempotencyKey: 'idem-drift', rzpOptions: { fetchImpl: okRazorpay as never } });
  assert.equal(out.ok, false);
  assert.equal(out.blockedBy, 'quote_integrity');
  assert.match(out.reason ?? '', /prices changed/);
  assert.equal(rzpCalls.length, 0);
  db.prepare('UPDATE variants SET price_minor = 49900 WHERE id = ?').run(cheapVariant);
});

test('the kill switch stops everything instantly', async () => {
  const q = basket();
  const c = grantConsent({ quoteId: q.id, agentId: null, capMinor: 200000, scope: 's', grantedBy: 'om' });
  engageKillSwitch('demo: operator pulled the cord');
  const out = await checkout({ quoteId: q.id, consentId: c.id, merchantId, agentId: null, idempotencyKey: 'idem-kill', rzpOptions: { fetchImpl: okRazorpay as never } });
  assert.equal(out.ok, false);
  assert.equal(out.blockedBy, 'kill_switch');
  assert.equal(rzpCalls.length, 0);
  releaseKillSwitch();
});

test('GRACEFUL FAILURE: a gateway outage records a failed order and charges nothing', async () => {
  const q = basket();
  const c = grantConsent({ quoteId: q.id, agentId: null, capMinor: 200000, scope: 's', grantedBy: 'om' });
  const out = await checkout({
    quoteId: q.id, consentId: c.id, merchantId, agentId: null, idempotencyKey: 'idem-outage',
    rzpOptions: { fetchImpl: failingRazorpay as never, attempts: 2 },
  });
  assert.equal(out.ok, false);
  assert.equal(out.blockedBy, 'gateway');
  assert.match(out.reason ?? '', /Nothing was charged/);
  const order = getOrder(out.orderId!)!;
  assert.equal(order.status, 'failed');
  assert.match(String(order.failure_reason), /SERVER_ERROR/);
  resetCircuit();
});

test('webhook settlement marks the order paid and is auditable', async () => {
  const q = basket();
  const c = grantConsent({ quoteId: q.id, agentId: null, capMinor: 200000, scope: 's', grantedBy: 'om' });
  const out = await checkout({ quoteId: q.id, consentId: c.id, merchantId, agentId: null, idempotencyKey: 'idem-settle', rzpOptions: { fetchImpl: okRazorpay as never } });
  assert.equal(out.ok, true);
  const settled = settleOrder({ razorpayOrderId: 'order_TEST123', paymentId: 'pay_TEST999', status: 'paid' });
  assert.ok(settled);
  assert.equal(getOrder(settled!)!.status, 'paid');
});

test('the audit chain still verifies after every one of those decisions', () => {
  const v = verify();
  assert.equal(v.ok, true);
  assert.ok(v.checked > 20);
});
