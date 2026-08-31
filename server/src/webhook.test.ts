import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import type { FastifyInstance } from 'fastify';

// A temp file, not the working tree: test artefacts in a mounted repo
// become undeletable locks that fail the NEXT run with a bare disk I/O error.
process.env.KIRANA_DB = join(tmpdir(), `kirana-test-webhook-${process.pid}-${Date.now()}.db`);
process.env.KIRANA_SIGNING_SECRET = 'd'.repeat(64);
process.env.KIRANA_QUIET = '1';
process.env.KIRANA_CONSOLE_TOKEN = 'test-console-token';
process.env.KIRANA_ACCESS = 'locked';
process.env.RAZORPAY_KEY_ID = 'rzp_test_fake123456';
process.env.RAZORPAY_KEY_SECRET = 'fakesecret';
process.env.RAZORPAY_WEBHOOK_SECRET = 'whsec_test_kirana';

const { buildApp } = await import('./app.ts');
const { ingestStorefront } = await import('./catalog/ingest.ts');
const { getMerchant, searchCatalog } = await import('./catalog/store.ts');
const { createQuote } = await import('./checkout/quote.ts');
const { grantConsent } = await import('./checkout/consent.ts');
const { checkout, getOrder } = await import('./checkout/checkout.ts');
const { list: auditList, verify } = await import('./audit/ledger.ts');

const SECRET = 'whsec_test_kirana';
const FIXTURE = readFileSync(new URL('./adapters/__fixtures__/shopify-store.json', import.meta.url), 'utf8');
const fixtureFetch = async (url: string | URL) => {
  const u = String(url);
  if (u.includes('/meta.json')) return new Response('{"currency":"INR"}', { headers: { 'content-type': 'application/json' } });
  if (u.includes('/products.json')) {
    const page = Number(new URL(u).searchParams.get('page') ?? '1');
    return new Response(page > 1 ? '{"products":[]}' : FIXTURE, { headers: { 'content-type': 'application/json' } });
  }
  return new Response('<html><title>Blue Hill</title></html>', { headers: { 'content-type': 'text/html' } });
};
const okRazorpay = async (url: string | URL) => {
  const u = String(url);
  if (u.endsWith('/orders')) return new Response(JSON.stringify({ id: 'order_WH1', amount: 99800, currency: 'INR', status: 'created' }), { headers: { 'content-type': 'application/json' } });
  if (u.endsWith('/payment_links')) return new Response(JSON.stringify({ id: 'plink_WH1', short_url: 'https://rzp.io/i/wh', status: 'created', amount: 99800 }), { headers: { 'content-type': 'application/json' } });
  return new Response('{}', { headers: { 'content-type': 'application/json' } });
};

let app: FastifyInstance;
let base = '';
let orderId = '';

/** Posts a webhook exactly as Razorpay does: signature over the raw bytes. */
async function post(payload: unknown, opts: { sign?: boolean; tamper?: boolean } = {}) {
  const raw = JSON.stringify(payload);
  const sig = createHmac('sha256', SECRET).update(opts.tamper ? raw + ' ' : raw).digest('hex');
  return fetch(`${base}/webhooks/razorpay`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(opts.sign === false ? {} : { 'x-razorpay-signature': sig }),
    },
    body: raw,
  });
}

const capturedEvent = (paymentId: string) => ({
  event: 'payment.captured',
  payload: { payment: { entity: { id: paymentId, order_id: 'order_WH1', amount: 99800, currency: 'INR', status: 'captured' } } },
});

before(async () => {
  await ingestStorefront('bluehill.example', { fetchImpl: fixtureFetch as never });
  const merchantId = getMerchant('bluehill-example')!.id;
  const attikan = searchCatalog(merchantId, { query: 'attikan' })[0]!;
  const variant = attikan.variants.find((v) => v.priceMinor === 49900)!;
  const q = createQuote(merchantId, [{ variantId: variant.id, quantity: 2 }]);
  const c = grantConsent({ quoteId: q.id, agentId: null, capMinor: 200000, scope: 's', grantedBy: 'om' });
  const out = await checkout({
    quoteId: q.id, consentId: c.id, merchantId, agentId: null,
    idempotencyKey: 'wh-1', rzpOptions: { fetchImpl: okRazorpay as never },
  });
  orderId = out.orderId!;

  app = buildApp();
  await app.listen({ port: 0, host: '127.0.0.1' });
  base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
});

after(async () => { await app.close(); });

test('a correctly signed webhook settles the order', async () => {
  assert.equal(getOrder(orderId)!.status, 'awaiting_payment');
  const res = await post(capturedEvent('pay_WH_REAL'));
  assert.equal(res.status, 200);
  assert.equal(getOrder(orderId)!.status, 'paid');
  assert.equal(getOrder(orderId)!.razorpay_payment_id, 'pay_WH_REAL');
});

test('THE RAW BODY BUG: signature is checked against the exact bytes sent', async () => {
  // Same JSON, different key order — a re-serialising verifier would compute a
  // different digest and wrongly reject this. Signed over what is actually sent,
  // it must be accepted.
  const reordered = {
    payload: { payment: { entity: { status: 'captured', currency: 'INR', amount: 99800, order_id: 'order_WH1', id: 'pay_WH_REAL' } } },
    event: 'payment.captured',
  };
  const res = await post(reordered);
  assert.equal(res.status, 200, 'a genuine webhook with different key order must still verify');
});

test('a tampered body is rejected', async () => {
  const res = await post(capturedEvent('pay_FORGED'), { tamper: true });
  assert.equal(res.status, 400);
  assert.equal(getOrder(orderId)!.razorpay_payment_id, 'pay_WH_REAL', 'the forged payment id was not applied');
});

test('an unsigned webhook is rejected when a secret is configured', async () => {
  const res = await post(capturedEvent('pay_UNSIGNED'), { sign: false });
  assert.equal(res.status, 400);
});

test('REPLAY: Razorpay retrying the same event does not settle twice', async () => {
  const before = auditList(200).filter((r) => r.action === 'payment.captured').length;
  await post(capturedEvent('pay_WH_REAL'));
  await post(capturedEvent('pay_WH_REAL'));
  const after = auditList(200).filter((r) => r.action === 'payment.captured').length;
  assert.equal(after, before, 'no extra "money received" entries for a retried webhook');
  assert.ok(auditList(200).some((r) => r.action === 'webhook.duplicate'));
});

test('an event for an unknown order is logged, not silently dropped', async () => {
  const res = await post({
    event: 'payment.captured',
    payload: { payment: { entity: { id: 'pay_GHOST', order_id: 'order_NEVER_SEEN', amount: 100, currency: 'INR' } } },
  });
  assert.equal(res.status, 200);
  assert.ok(auditList(200).some((r) => r.action === 'webhook.unmatched'));
});

test('events we do not act on still return 200 so Razorpay stops retrying', async () => {
  const res = await post({ event: 'subscription.charged', payload: {} });
  assert.equal(res.status, 200);
  assert.ok(auditList(200).some((r) => r.action === 'webhook.ignored'));
});

test('the audit chain survives every webhook path', () => {
  assert.equal(verify().ok, true);
});
