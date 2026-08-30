import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

process.env.KIRANA_DB = `data/test-recon-${process.pid}.db`;
process.env.KIRANA_SIGNING_SECRET = 'f'.repeat(64);
process.env.RAZORPAY_KEY_ID = 'rzp_test_fake123456';
process.env.RAZORPAY_KEY_SECRET = 'fakesecret';

const { ingestStorefront } = await import('../catalog/ingest.ts');
const { getMerchant, searchCatalog } = await import('../catalog/store.ts');
const { createQuote } = await import('./quote.ts');
const { grantConsent } = await import('./consent.ts');
const { checkout, getOrder } = await import('./checkout.ts');
const { reconcile } = await import('./reconcile.ts');
const { resetCircuit } = await import('../razorpay/client.ts');
const { list: auditList, verify } = await import('../audit/ledger.ts');

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

/**
 * A fake gateway that answers PER ORDER, the way the real one does.
 *
 * The first version of this returned the same payment list for every order,
 * which made a sweep look like it settled orders left pending by earlier tests.
 * A shared mock that ignores its input does not model a gateway, it models a
 * global variable -- and it hides exactly the cross-order bugs a reconciler
 * sweep is most likely to have.
 */
let seq = 0;
const PAYMENTS = new Map<string, Array<Record<string, unknown>>>();
const LINKS = new Map<string, Record<string, unknown>>();
let pendingOrderId = '';
let pendingLinkId = '';

const razorpay = async (url: string | URL) => {
  const u = String(url);
  if (u.endsWith('/orders')) {
    const orderId = `order_R${++seq}`;
    pendingOrderId = orderId;
    return new Response(JSON.stringify({ id: orderId, amount: 99800, currency: 'INR', status: 'created' }), { headers: { 'content-type': 'application/json' } });
  }
  if (u.endsWith('/payment_links')) {
    pendingLinkId = `plink_R${seq}`;
    return new Response(JSON.stringify({ id: pendingLinkId, short_url: 'https://rzp.io/i/r', status: 'created', amount: 99800 }), { headers: { 'content-type': 'application/json' } });
  }
  const linkMatch = u.match(/\/payment_links\/(plink_R\d+)$/);
  if (linkMatch) {
    const link = LINKS.get(linkMatch[1]!) ?? { id: linkMatch[1], status: 'created', amount: 99800, payments: [] };
    return new Response(JSON.stringify(link), { headers: { 'content-type': 'application/json' } });
  }
  const m = u.match(/\/orders\/(order_R\d+)\/payments/);
  if (m) {
    const items = PAYMENTS.get(m[1]!) ?? [];
    return new Response(JSON.stringify({ count: items.length, items }), { headers: { 'content-type': 'application/json' } });
  }
  return new Response('{}', { headers: { 'content-type': 'application/json' } });
};

let merchantId = '';
let variantId = '';
let n = 0;

/** Places an order and tells the fake gateway what that order's payments look like. */
async function placeOrder(payments: Array<Record<string, unknown>>) {
  const q = createQuote(merchantId, [{ variantId, quantity: 2 }]);
  const c = grantConsent({ quoteId: q.id, agentId: null, capMinor: 200000, scope: 's', grantedBy: 'om' });
  const out = await checkout({
    quoteId: q.id, consentId: c.id, merchantId, agentId: null,
    idempotencyKey: `recon-${++n}`, rzpOptions: { fetchImpl: razorpay as never },
  });
  assert.equal(out.ok, true, out.reason);
  PAYMENTS.set(pendingOrderId, payments);
  LINKS.set(pendingLinkId, { id: pendingLinkId, status: 'created', amount: 99800, payments: [] });
  return { orderId: out.orderId!, linkId: pendingLinkId };
}

/** Simulates the customer paying (or failing to pay) the payment link. */
function payLink(linkId: string, status: 'paid' | 'failed', paymentId: string) {
  LINKS.set(linkId, {
    id: linkId, amount: 99800,
    status: status === 'paid' ? 'paid' : 'created',
    payments: [{ payment_id: paymentId, status: status === 'paid' ? 'captured' : 'failed', amount: 99800 }],
  });
}

const sweep = () => reconcile({ minAgeMs: 0, rzpOptions: { fetchImpl: razorpay as never } });

before(async () => {
  await ingestStorefront('bluehill.example', { fetchImpl: fixtureFetch as never });
  merchantId = getMerchant('bluehill-example')!.id;
  const attikan = searchCatalog(merchantId, { query: 'attikan' })[0]!;
  variantId = attikan.variants.find((v) => v.priceMinor === 49900)!.id;
});

test('NO WEBHOOK NEEDED: a captured payment is discovered by asking the gateway', async () => {
  const { orderId } = await placeOrder([{ id: 'pay_RECON1', status: 'captured', amount: 99800, currency: 'INR' }]);
  assert.equal(getOrder(orderId)!.status, 'awaiting_payment');

  const report = await sweep();
  assert.equal(report.settled, 1);
  assert.equal(getOrder(orderId)!.status, 'paid');
  assert.equal(getOrder(orderId)!.razorpay_payment_id, 'pay_RECON1');
});

test('an authorised-but-not-captured payment is NOT reported as money received', async () => {
  const { orderId } = await placeOrder([{ id: 'pay_AUTH', status: 'authorized', amount: 99800, currency: 'INR' }]);
  const report = await sweep();
  assert.equal(report.settled, 0);
  assert.ok(report.stillPending >= 1);
  assert.equal(getOrder(orderId)!.status, 'awaiting_payment');
});

test('A FAILED ATTEMPT DOES NOT CLOSE THE ORDER: the customer can retry the same link', async () => {
  // A real 3-D Secure / OTP failure is the customer's most common outcome, and
  // they fix it by paying the same link again. Marking the order dead on the
  // first failure would strand a buyer who was one retry away from paying --
  // which is precisely what happened the first time this ran against Razorpay.
  const { orderId, linkId } = await placeOrder([]);
  payLink(linkId, 'failed', 'pay_AUTHFAIL');

  const first = await sweep();
  assert.ok(first.failed >= 1, 'the failed attempt is counted');
  assert.equal(getOrder(orderId)!.status, 'awaiting_payment', 'but the order stays open for a retry');

  // The customer retries and succeeds on the same link.
  payLink(linkId, 'paid', 'pay_RETRY_OK');
  const second = await sweep();
  assert.ok(second.settled >= 1);
  assert.equal(getOrder(orderId)!.status, 'paid');
  assert.equal(getOrder(orderId)!.razorpay_payment_id, 'pay_RETRY_OK');
});

test('THE LINKED-OBJECT BUG: a link-paid order settles even though the Razorpay order has no payments', async () => {
  // Razorpay Orders and Payment Links are separate objects. Paying the link
  // leaves the order's payment list empty forever, so reconciling only against
  // the order reports "unpaid" for a customer who definitely paid.
  const { orderId, linkId } = await placeOrder([]); // order has NO payments, ever
  payLink(linkId, 'paid', 'pay_VIA_LINK');
  const report = await sweep();
  assert.ok(report.settled >= 1);
  assert.equal(getOrder(orderId)!.status, 'paid');
  assert.equal(getOrder(orderId)!.razorpay_payment_id, 'pay_VIA_LINK');
});

test('an order with no payments at all stays pending', async () => {
  const { orderId } = await placeOrder([]);
  const report = await sweep();
  assert.equal(report.stillPending >= 1, true);
  assert.equal(getOrder(orderId)!.status, 'awaiting_payment');
});

test('reconciling twice does not double-settle', async () => {
  await placeOrder([{ id: 'pay_TWICE', status: 'captured', amount: 99800, currency: 'INR' }]);
  await sweep();
  const before = auditList(300).filter((r) => r.action === 'payment.captured').length;
  await sweep();
  const after = auditList(300).filter((r) => r.action === 'payment.captured').length;
  assert.equal(after, before, 'a second sweep must not record a second capture');
});

test('a gateway error is reported, not swallowed, and the sweep survives', async () => {
  // Guarantee there is something to sweep, then make the gateway fail.
  await placeOrder([]);
  const flaky = async (url: string | URL) => {
    const u = String(url);
    if (u.includes('/payments')) return new Response(JSON.stringify({ error: { code: 'SERVER_ERROR', description: 'down' } }), { status: 500, headers: { 'content-type': 'application/json' } });
    return new Response('{}', { headers: { 'content-type': 'application/json' } });
  };
  const report = await reconcile({ minAgeMs: 0, rzpOptions: { fetchImpl: flaky as never, attempts: 1 } });
  assert.ok(report.checked > 0, 'there was something to reconcile');
  assert.ok(report.errors.length > 0 || report.skipped > 0, 'the failure was reported rather than swallowed');
  resetCircuit();
});

test('the audit chain still verifies after reconciliation', () => {
  assert.equal(verify().ok, true);
});
