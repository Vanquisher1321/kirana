/**
 * Getting the money to the merchant.
 *
 * Until this existed the system could prove an agent had paid and could not
 * show the shop being paid: every rupee settled into the platform's own
 * Razorpay account and stopped. "Make any merchant transactable" was true right
 * up to the point that matters most to the merchant.
 *
 * A caveat this file states rather than hides. Razorpay Route is not exercised
 * against the live API anywhere in this repository -- no linked account exists
 * to transfer to, and placing real orders is out of scope. So what is proven
 * here is everything on our side of the seam: that the request is built to the
 * documented shape, aimed at the documented path, for the full amount; that it
 * is attempted exactly once per order; that a failure is recorded and retried
 * rather than lost; and that a shop with nowhere to be paid is left alone
 * instead of retried forever. What is NOT proven is that Razorpay accepts it.
 * That is precisely the class of assumption FAILURES.md exists to warn about,
 * so it is written down rather than quietly assumed.
 */
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';

process.env.KIRANA_DB = join(tmpdir(), `kirana-test-transfer-${process.pid}-${Date.now()}.db`);
process.env.KIRANA_SIGNING_SECRET = 'c'.repeat(64);
process.env.KIRANA_QUIET = '1';
process.env.RAZORPAY_KEY_ID = 'rzp_test_fake123456';
process.env.RAZORPAY_KEY_SECRET = 'fakesecret';

const { ingestStorefront } = await import('../catalog/ingest.ts');
const { getMerchant, searchCatalog, setMerchantPayout } = await import('../catalog/store.ts');
const { createQuote } = await import('./quote.ts');
const { grantConsent } = await import('./consent.ts');
const { checkout, getOrder, settleOrder } = await import('./checkout.ts');
const { reconcile } = await import('./reconcile.ts');
const { resetCircuit } = await import('../razorpay/client.ts');
const { list: auditList, verify } = await import('../audit/ledger.ts');
import { SAMPLE_DELIVERY } from '../__fixtures__/delivery.ts';

const FIXTURE = readFileSync(new URL('../adapters/__fixtures__/shopify-store.json', import.meta.url), 'utf8');
const shopFetch = (title: string) => async (url: string | URL) => {
  const u = String(url);
  if (u.includes('/meta.json')) return new Response('{"currency":"INR"}', { headers: { 'content-type': 'application/json' } });
  if (u.includes('/products.json')) {
    const page = Number(new URL(u).searchParams.get('page') ?? '1');
    return new Response(page > 1 ? '{"products":[]}' : FIXTURE, { headers: { 'content-type': 'application/json' } });
  }
  return new Response(`<html><title>${title}</title></html>`, { headers: { 'content-type': 'text/html' } });
};

/** Every transfer request the code made, exactly as it would have gone out. */
interface Sent { path: string; body: Record<string, unknown> }
let sent: Sent[] = [];
let transferFails: string | null = null;
let seq = 0;

const razorpay = async (url: string | URL, init?: RequestInit) => {
  const u = String(url);
  if (u.endsWith('/orders')) {
    return new Response(JSON.stringify({ id: `order_T${++seq}`, amount: 99800, currency: 'INR', status: 'created' }), { headers: { 'content-type': 'application/json' } });
  }
  if (u.endsWith('/payment_links')) {
    return new Response(JSON.stringify({ id: `plink_T${seq}`, short_url: 'https://rzp.io/i/t', status: 'created', amount: 99800 }), { headers: { 'content-type': 'application/json' } });
  }
  if (u.includes('/transfers')) {
    sent.push({ path: new URL(u).pathname, body: JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown> });
    if (transferFails) {
      return new Response(JSON.stringify({ error: { code: 'BAD_REQUEST_ERROR', description: transferFails } }), {
        status: 400, headers: { 'content-type': 'application/json' },
      });
    }
    return new Response(JSON.stringify({ items: [{ id: `trf_T${sent.length}`, amount: 99800, currency: 'INR', status: 'created' }] }), { headers: { 'content-type': 'application/json' } });
  }
  // Nothing is left awaiting payment in these tests, so the settlement sweep
  // has nothing to poll.
  return new Response(JSON.stringify({ count: 0, items: [] }), { headers: { 'content-type': 'application/json' } });
};

let paidShop = '';
let unpaidShop = '';

/** Places an order and settles it, so it is sitting ready to be transferred. */
async function paidOrder(merchantId: string, key: string): Promise<string> {
  const product = searchCatalog(merchantId, { query: 'attikan' })[0]!;
  const variantId = product.variants.find((v) => v.priceMinor === 49900)!.id;
  const q = createQuote(merchantId, [{ variantId, quantity: 2 }]);
  const c = grantConsent({
    quoteId: q.id, agentId: null, capMinor: 200000, scope: merchantId,
    grantedBy: 'test', delivery: SAMPLE_DELIVERY,
  });
  const out = await checkout({
    quoteId: q.id, consentId: c.id, merchantId, agentId: null,
    idempotencyKey: key, rzpOptions: { fetchImpl: razorpay as never },
  });
  assert.equal(out.ok, true, out.reason);
  settleOrder({
    razorpayOrderId: out.razorpayOrderId!, paymentId: `pay_${key}`, status: 'paid',
    amountMinor: out.amountMinor, currency: 'INR',
  });
  assert.equal(getOrder(out.orderId!)!.status, 'paid');
  return out.orderId!;
}

before(async () => {
  await ingestStorefront('paid-shop.example', { fetchImpl: shopFetch('Paid Shop') as never });
  await ingestStorefront('unpaid-shop.example', { fetchImpl: shopFetch('Unpaid Shop') as never });
  paidShop = getMerchant('paid-shop-example')!.id;
  unpaidShop = getMerchant('unpaid-shop-example')!.id;
  setMerchantPayout(paidShop, 'acc_TESTLINKED12345');
});

test('the transfer is built to the documented shape, at the documented path', async () => {
  sent = []; transferFails = null; resetCircuit();
  const orderId = await paidOrder(paidShop, 'trf-shape');
  await reconcile({ minAgeMs: 0, rzpOptions: { fetchImpl: razorpay as never } });

  assert.equal(sent.length, 1, 'exactly one transfer request');
  const [req] = sent;
  // POST /payments/{id}/transfers -- against the PAYMENT, not the order we
  // created. Our customers pay the payment link, which is its own object; a
  // split declared on our order would hang off the thing the money never
  // touched. That distinction is the oldest scar in this repository.
  assert.equal(req!.path, '/v1/payments/pay_trf-shape/transfers');

  const transfers = req!.body.transfers as Array<Record<string, unknown>>;
  assert.ok(Array.isArray(transfers) && transfers.length === 1, 'transfers is a one-element array');
  // `account`, not `account_id`: the linked-account docs use both spellings for
  // different endpoints and this endpoint wants this one.
  assert.equal(transfers[0]!.account, 'acc_TESTLINKED12345');
  assert.equal(transfers[0]!.currency, 'INR');

  const order = getOrder(orderId)!;
  assert.equal(transfers[0]!.amount, Number(order.amount_minor), 'the full amount, in paise');
  assert.equal(order.razorpay_transfer_id, 'trf_T1');
  assert.equal(order.transfer_error, null);
});

test('the shop receives the whole amount — the platform takes no cut', async () => {
  sent = []; transferFails = null; resetCircuit();
  const orderId = await paidOrder(paidShop, 'trf-full');
  await reconcile({ minAgeMs: 0, rzpOptions: { fetchImpl: razorpay as never } });

  const charged = Number(getOrder(orderId)!.amount_minor);
  const transferred = ((sent[0]!.body.transfers as Array<Record<string, unknown>>)[0]!).amount;
  assert.equal(transferred, charged, 'every paisa the buyer paid reaches the shop');
});

test('a shop with nowhere to be paid is left alone, not retried forever', async () => {
  sent = []; transferFails = null; resetCircuit();
  const orderId = await paidOrder(unpaidShop, 'trf-none');
  await reconcile({ minAgeMs: 0, rzpOptions: { fetchImpl: razorpay as never } });
  await reconcile({ minAgeMs: 0, rzpOptions: { fetchImpl: razorpay as never } });

  assert.equal(sent.length, 0, 'no transfer is attempted with no destination');
  const order = getOrder(orderId)!;
  assert.equal(order.razorpay_transfer_id, null);
  assert.equal(order.transfer_error, null, 'not having a payout account is not an error state');
  assert.equal(order.status, 'paid', 'the order is still paid — the buyer did their part');
});

test('an order is never transferred twice', async () => {
  sent = []; transferFails = null; resetCircuit();
  await paidOrder(paidShop, 'trf-once');
  await reconcile({ minAgeMs: 0, rzpOptions: { fetchImpl: razorpay as never } });
  await reconcile({ minAgeMs: 0, rzpOptions: { fetchImpl: razorpay as never } });
  await reconcile({ minAgeMs: 0, rzpOptions: { fetchImpl: razorpay as never } });
  assert.equal(sent.length, 1, 'the transfer id on the row is what stops a second attempt');
});

test('a transfer that fails is recorded, retried, and eventually lands', async () => {
  sent = []; resetCircuit();
  transferFails = 'The linked account is not activated yet.';
  const orderId = await paidOrder(paidShop, 'trf-retry');
  await reconcile({ minAgeMs: 0, rzpOptions: { fetchImpl: razorpay as never } });

  let order = getOrder(orderId)!;
  assert.equal(order.razorpay_transfer_id, null, 'no id, because nothing was transferred');
  assert.match(String(order.transfer_error), /not activated/);
  assert.equal(order.status, 'paid', 'a failed transfer does not un-capture the payment');
  assert.ok(auditList(400).some((r) => r.action === 'settlement.transfer_failed'));

  // The next sweep tries again. Money already captured is not lost by a
  // transfer that did not go through; it is money not yet passed on.
  transferFails = null;
  resetCircuit();
  await reconcile({ minAgeMs: 0, rzpOptions: { fetchImpl: razorpay as never } });

  order = getOrder(orderId)!;
  assert.ok(String(order.razorpay_transfer_id).startsWith('trf_'), 'the retry landed');
  assert.equal(order.transfer_error, null, 'and the failure note is cleared');
  assert.ok(auditList(400).some((r) => r.action === 'settlement.transferred'));
});

test('the ledger says who was paid, and the chain still verifies', () => {
  const row = auditList(400).find((r) => r.action === 'settlement.transferred')!;
  assert.equal((row.detail as { account?: string }).account, 'acc_TESTLINKED12345');
  assert.equal(verify().ok, true);
});
