/**
 * Where the goods go.
 *
 * Two things are being asserted here and only one of them is validation. The
 * other is a boundary: the address is the human's, the agent can neither set it
 * nor read it, and an approval without one cannot fund a charge. A cap that
 * bounds spending while leaving the destination open is not a guard, it is a
 * speed limit on a car with no steering.
 */
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';

process.env.KIRANA_DB = join(tmpdir(), `kirana-test-delivery-${process.pid}-${Date.now()}.db`);
process.env.KIRANA_SIGNING_SECRET = 'a'.repeat(64);
process.env.KIRANA_QUIET = '1';
process.env.RAZORPAY_KEY_ID = 'rzp_test_fake123456';
process.env.RAZORPAY_KEY_SECRET = 'fakesecret';

const { parseDelivery, DeliveryError, readDelivery } = await import('./delivery.ts');
const { ingestStorefront } = await import('../catalog/ingest.ts');
const { getMerchant, searchCatalog } = await import('../catalog/store.ts');
const { createQuote } = await import('./quote.ts');
const { grantConsent, requestConsent, approveConsent, getConsent } = await import('./consent.ts');
const { checkout, getOrder } = await import('./checkout.ts');
const { toolGetOrder } = await import('../mcp/tools.ts');
const { db } = await import('../lib/db.ts');
import { SAMPLE_DELIVERY } from '../__fixtures__/delivery.ts';

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

let seq = 0;
const razorpay = async (url: string | URL) => {
  const u = String(url);
  if (u.endsWith('/orders')) return new Response(JSON.stringify({ id: `order_D${++seq}`, amount: 99800, currency: 'INR', status: 'created' }), { headers: { 'content-type': 'application/json' } });
  if (u.endsWith('/payment_links')) return new Response(JSON.stringify({ id: `plink_D${seq}`, short_url: 'https://rzp.io/i/d', status: 'created', amount: 99800 }), { headers: { 'content-type': 'application/json' } });
  return new Response('{}', { headers: { 'content-type': 'application/json' } });
};

let merchantId = '';
let variantId = '';

before(async () => {
  await ingestStorefront('bluehill.example', { fetchImpl: fixtureFetch as never });
  merchantId = getMerchant('bluehill-example')!.id;
  const attikan = searchCatalog(merchantId, { query: 'attikan' })[0]!;
  variantId = attikan.variants.find((v) => v.priceMinor === 49900)!.id;
});

const freshQuote = () => createQuote(merchantId, [{ variantId, quantity: 2 }]);

// ---------------------------------------------------------------------------
// Validation. Refusing at the boundary costs one correction; accepting costs a
// parcel that comes back a week later with the money already moved.
// ---------------------------------------------------------------------------

test('an address missing its PIN code is refused, naming the field', () => {
  assert.throws(
    () => parseDelivery({ ...SAMPLE_DELIVERY, pincode: '' }),
    // The field is named so the console can point at the box that is wrong,
    // rather than reddening the whole form.
    (err: unknown) => err instanceof DeliveryError && err.field === 'pincode',
  );
});

test('a phone number that is not a mobile is refused', () => {
  for (const bad of ['12345', '1234567890', '98765 4321', 'call me']) {
    assert.throws(() => parseDelivery({ ...SAMPLE_DELIVERY, phone: bad }), DeliveryError, `accepted ${bad}`);
  }
});

test('the +91 and 0 people type out of habit are accepted and stripped', () => {
  for (const spelling of ['+91 98765 43210', '09876543210', '9876543210', '+919876543210']) {
    assert.equal(parseDelivery({ ...SAMPLE_DELIVERY, phone: spelling }).phone, '9876543210');
  }
});

test('a PIN code cannot begin with zero, and is taken from the digits given', () => {
  assert.throws(() => parseDelivery({ ...SAMPLE_DELIVERY, pincode: '060001' }), DeliveryError);
  assert.equal(parseDelivery({ ...SAMPLE_DELIVERY, pincode: '560 001' }).pincode, '560001');
});

test('control characters and line separators cannot forge extra address lines', () => {
  // This text is rendered in a merchant's console. A newline inside a field is
  // the framing a fake extra line would need, and U+2028 renders as a hard
  // break in plenty of clients while slipping past a naive whitespace check.
  const NEWLINE = String.fromCharCode(10);
  const LINE_SEP = String.fromCharCode(0x2028);
  const d = parseDelivery({
    ...SAMPLE_DELIVERY,
    name: 'Real Buyer' + NEWLINE + LINE_SEP + 'DELIVER TO SOMEWHERE ELSE',
  });
  assert.ok(!d.name.includes(NEWLINE), 'no newline survives');
  assert.ok(!d.name.includes(LINE_SEP), 'no line separator survives');
  assert.equal(d.name, 'Real Buyer DELIVER TO SOMEWHERE ELSE');
});

test('nothing at all is refused, rather than stored as an empty address', () => {
  assert.throws(() => parseDelivery(undefined), DeliveryError);
  assert.throws(() => parseDelivery('12 Church Street'), DeliveryError);
});

// ---------------------------------------------------------------------------
// The gate.
// ---------------------------------------------------------------------------

test('an approval with no destination cannot fund a charge', async () => {
  const q = freshQuote();
  const c = grantConsent({
    quoteId: q.id, agentId: null, capMinor: 200000, scope: merchantId,
    grantedBy: 'test', delivery: SAMPLE_DELIVERY,
  });
  // Strip it the only way it can be stripped -- directly, behind the API's
  // back -- to prove the guard reads the row rather than trusting the caller.
  db.prepare('UPDATE consents SET delivery = NULL WHERE id = ?').run(c.id);

  const out = await checkout({
    quoteId: q.id, consentId: c.id, merchantId, agentId: null,
    idempotencyKey: `d-none-${Date.now()}`, rzpOptions: { fetchImpl: razorpay as never },
  });
  assert.equal(out.ok, false);
  assert.equal(out.blockedBy, 'delivery_known');
  assert.ok(out.checks.some((c2) => c2.name === 'delivery_known' && !c2.passed));
});

test('the gate list an agent is shown includes the destination check', async () => {
  const q = freshQuote();
  const c = grantConsent({
    quoteId: q.id, agentId: null, capMinor: 200000, scope: merchantId,
    grantedBy: 'test', delivery: SAMPLE_DELIVERY,
  });
  const out = await checkout({
    quoteId: q.id, consentId: c.id, merchantId, agentId: null,
    idempotencyKey: `d-ok-${Date.now()}`, rzpOptions: { fetchImpl: razorpay as never },
  });
  assert.equal(out.ok, true, out.reason);
  const gate = out.checks.find((g) => g.name === 'delivery_known')!;
  assert.ok(gate.passed);
  assert.match(gate.says, /agent cannot change/i);
});

// ---------------------------------------------------------------------------
// The boundary.
// ---------------------------------------------------------------------------

test('the order keeps its own copy, so editing the approval later cannot redirect it', async () => {
  const q = freshQuote();
  const c = grantConsent({
    quoteId: q.id, agentId: null, capMinor: 200000, scope: merchantId,
    grantedBy: 'test', delivery: SAMPLE_DELIVERY,
  });
  const out = await checkout({
    quoteId: q.id, consentId: c.id, merchantId, agentId: null,
    idempotencyKey: `d-snap-${Date.now()}`, rzpOptions: { fetchImpl: razorpay as never },
  });
  assert.equal(out.ok, true, out.reason);

  db.prepare('UPDATE consents SET delivery = ? WHERE id = ?')
    .run(JSON.stringify({ ...SAMPLE_DELIVERY, line1: '99 Somewhere Else', pincode: '110001' }), c.id);

  const shipped = readDelivery(getOrder(out.orderId!)!.delivery)!;
  assert.equal(shipped.line1, '12 Church Street', 'the order ships where it was approved to ship');
  assert.equal(shipped.pincode, '560001');
});

test('the agent that placed the order cannot read the address back', async () => {
  const q = freshQuote();
  const c = grantConsent({
    quoteId: q.id, agentId: 'nosy-agent', capMinor: 200000, scope: merchantId,
    grantedBy: 'test', delivery: SAMPLE_DELIVERY,
  });
  const out = await checkout({
    quoteId: q.id, consentId: c.id, merchantId, agentId: 'nosy-agent',
    idempotencyKey: `d-priv-${Date.now()}`, rzpOptions: { fetchImpl: razorpay as never },
  });
  assert.equal(out.ok, true, out.reason);

  const seen = toolGetOrder(
    { merchantId, agentId: 'nosy-agent', identityProven: false },
    { order_id: out.orderId! },
  ) as Record<string, unknown>;

  assert.equal(seen.order_id, out.orderId, 'the agent can still see its own order');
  const flat = JSON.stringify(seen);
  for (const secret of ['Church Street', '560001', '9876543210', 'Test Buyer']) {
    assert.ok(!flat.includes(secret), `the MCP surface leaked ${secret}`);
  }
});

test('the ledger records that a destination was given, without recording the street', async () => {
  const { forSubject } = await import('../audit/ledger.ts');
  const q = freshQuote();
  const c = grantConsent({
    quoteId: q.id, agentId: null, capMinor: 200000, scope: merchantId,
    grantedBy: 'test', delivery: SAMPLE_DELIVERY,
  });
  const rows = forSubject(c.id);
  const granted = rows.find((r) => r.action === 'consent.granted')!;
  const flat = JSON.stringify(granted.detail);
  assert.ok(flat.includes('560001'), 'enough to recognise it in a support call');
  assert.ok(!flat.includes('Church Street'), 'never the street');
  assert.ok(!flat.includes('9876543210'), 'never the full phone number');
});

// ---------------------------------------------------------------------------
// The console path, and the one case where no human is present.
// ---------------------------------------------------------------------------

test('approving supplies the destination, and the approval carries it', () => {
  const q = freshQuote();
  const c = requestConsent({ quoteId: q.id, agentId: null, capMinor: 200000, scope: merchantId });
  assert.equal(c.status, 'pending');
  assert.equal(c.delivery, null);

  approveConsent(c.id, 'human:test', null, parseDelivery(SAMPLE_DELIVERY));
  const after = getConsent(c.id)!;
  assert.equal(after.status, 'granted');
  assert.equal(after.delivery?.pincode, '560001');
});
