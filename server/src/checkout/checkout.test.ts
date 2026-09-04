import { test, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';

// A temp file, not the working tree: test artefacts in a mounted repo
// become undeletable locks that fail the NEXT run with a bare disk I/O error.
process.env.KIRANA_DB = join(tmpdir(), `kirana-test-checkout-${process.pid}-${Date.now()}.db`);
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

/** Records every gateway call so we can assert on how many charges were attempted. */
let rzpCalls: string[] = [];
/**
 * A DISTINCT id per call, deliberately.
 *
 * This mock used to answer `order_TEST123` for every checkout in the file, so
 * four different orders shared one gateway id and a settlement test could match
 * a different order than the one it had just created and still pass. A mock
 * that returns the same thing regardless of what it is asked models a global
 * variable, not a dependency -- and this project has already shipped one real
 * bug that eight passing tests missed for exactly that reason.
 */
let rzpSeq = 0;
const okRazorpay = async (url: string | URL) => {
  const u = String(url);
  rzpCalls.push(u);
  if (u.endsWith('/orders')) {
    rzpSeq++;
    return new Response(JSON.stringify({ id: `order_TEST${rzpSeq}`, amount: 99800, currency: 'INR', status: 'created' }), { status: 200, headers: { 'content-type': 'application/json' } });
  }
  if (u.endsWith('/payment_links')) {
    return new Response(JSON.stringify({ id: `plink_TEST${rzpSeq}`, short_url: `https://rzp.io/i/test${rzpSeq}`, status: 'created', amount: 99800 }), { status: 200, headers: { 'content-type': 'application/json' } });
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
  const c = grantConsent({ quoteId: q.id, agentId: null, capMinor: 100000, scope: 'bluehill-example', grantedBy: 'om', delivery: SAMPLE_DELIVERY });
  const out = await checkout({
    quoteId: q.id, consentId: c.id, merchantId, agentId: null,
    idempotencyKey: 'idem-happy-1', rzpOptions: { fetchImpl: okRazorpay as never },
  });
  assert.equal(out.ok, true, out.reason);
  assert.equal(out.amount, '₹998.00');
  assert.match(String(out.razorpayOrderId), /^order_TEST\d+$/);
  assert.match(String(out.payUrl), /^https:\/\/rzp\.io\/i\/test\d+$/);
  assert.equal(out.status, 'awaiting_payment');
  // Every gate is reported, not just the failing one.
  assert.ok(out.checks.length >= 10);
  assert.ok(out.checks.every((c2) => c2.passed));
});

test('a quote and its approval are single use', async () => {
  const q = basket();
  const c = grantConsent({ quoteId: q.id, agentId: null, capMinor: 100000, scope: 's', grantedBy: 'om', delivery: SAMPLE_DELIVERY });
  const first = await checkout({ quoteId: q.id, consentId: c.id, merchantId, agentId: null, idempotencyKey: 'idem-once-1', rzpOptions: { fetchImpl: okRazorpay as never } });
  assert.equal(first.ok, true);
  const replay = await checkout({ quoteId: q.id, consentId: c.id, merchantId, agentId: null, idempotencyKey: 'idem-once-2', rzpOptions: { fetchImpl: okRazorpay as never } });
  assert.equal(replay.ok, false);
  assert.equal(replay.blockedBy, 'quote_integrity');
});

test('THE CAP: an agent cannot spend above what the human approved', async () => {
  const q = basket();                       // ₹998.00
  const c = grantConsent({ quoteId: q.id, agentId: null, capMinor: 50000, scope: 's', grantedBy: 'om', delivery: SAMPLE_DELIVERY }); // ₹500.00
  const out = await checkout({ quoteId: q.id, consentId: c.id, merchantId, agentId: null, idempotencyKey: 'idem-cap', rzpOptions: { fetchImpl: okRazorpay as never } });
  assert.equal(out.ok, false);
  assert.equal(out.blockedBy, 'within_consent_cap');
  assert.match(out.reason ?? '', /₹998\.00 but the approved cap is ₹500\.00/);
  assert.equal(rzpCalls.length, 0, 'refused before any gateway call');
});

test('revoking approval stops a payment that was about to happen', async () => {
  const q = basket();
  const c = grantConsent({ quoteId: q.id, agentId: null, capMinor: 100000, scope: 's', grantedBy: 'om', delivery: SAMPLE_DELIVERY });
  revokeConsent(c.id, 'om');
  const out = await checkout({ quoteId: q.id, consentId: c.id, merchantId, agentId: null, idempotencyKey: 'idem-revoke', rzpOptions: { fetchImpl: okRazorpay as never } });
  assert.equal(out.ok, false);
  assert.equal(out.blockedBy, 'consent_live');
  assert.match(out.reason ?? '', /revoked/);
  assert.equal(rzpCalls.length, 0);
});

test('approval given to one agent cannot be used by another', async () => {
  const q = basket();
  const c = grantConsent({ quoteId: q.id, agentId: 'agent_alpha', capMinor: 100000, scope: 's', grantedBy: 'om', delivery: SAMPLE_DELIVERY });
  const out = await checkout({ quoteId: q.id, consentId: c.id, merchantId, agentId: 'agent_beta', idempotencyKey: 'idem-agent', rzpOptions: { fetchImpl: okRazorpay as never } });
  assert.equal(out.ok, false);
  assert.equal(out.blockedBy, 'consent_agent_match');
  assert.equal(rzpCalls.length, 0);
});

test('approval for one basket cannot pay for a different basket', async () => {
  const qA = basket(1);
  const qB = basket(2);
  const c = grantConsent({ quoteId: qA.id, agentId: null, capMinor: 500000, scope: 's', grantedBy: 'om', delivery: SAMPLE_DELIVERY });
  const out = await checkout({ quoteId: qB.id, consentId: c.id, merchantId, agentId: null, idempotencyKey: 'idem-swap', rzpOptions: { fetchImpl: okRazorpay as never } });
  assert.equal(out.ok, false);
  assert.equal(out.blockedBy, 'consent_quote_match');
});

test('THE DOUBLE CHARGE: the same idempotency key never charges twice', async () => {
  const q1 = basket();
  const c1 = grantConsent({ quoteId: q1.id, agentId: null, capMinor: 100000, scope: 's', grantedBy: 'om', delivery: SAMPLE_DELIVERY });
  const a = await checkout({ quoteId: q1.id, consentId: c1.id, merchantId, agentId: null, idempotencyKey: 'idem-dupe', rzpOptions: { fetchImpl: okRazorpay as never } });
  assert.equal(a.ok, true);
  const callsAfterFirst = rzpCalls.length;

  const q2 = basket();
  const c2 = grantConsent({ quoteId: q2.id, agentId: null, capMinor: 100000, scope: 's', grantedBy: 'om', delivery: SAMPLE_DELIVERY });
  const b = await checkout({ quoteId: q2.id, consentId: c2.id, merchantId, agentId: null, idempotencyKey: 'idem-dupe', rzpOptions: { fetchImpl: okRazorpay as never } });
  assert.equal(b.ok, false);
  assert.equal(b.blockedBy, 'idempotency');
  assert.match(b.reason ?? '', /No second charge was made/);
  assert.equal(rzpCalls.length, callsAfterFirst, 'the duplicate never reached the gateway');
});

test('price drift after approval blocks the charge before any money moves', async () => {
  const q = basket();
  const c = grantConsent({ quoteId: q.id, agentId: null, capMinor: 200000, scope: 's', grantedBy: 'om', delivery: SAMPLE_DELIVERY });
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
  const c = grantConsent({ quoteId: q.id, agentId: null, capMinor: 200000, scope: 's', grantedBy: 'om', delivery: SAMPLE_DELIVERY });
  engageKillSwitch('demo: operator pulled the cord');
  const out = await checkout({ quoteId: q.id, consentId: c.id, merchantId, agentId: null, idempotencyKey: 'idem-kill', rzpOptions: { fetchImpl: okRazorpay as never } });
  assert.equal(out.ok, false);
  assert.equal(out.blockedBy, 'kill_switch');
  assert.equal(rzpCalls.length, 0);
  releaseKillSwitch();
});

test('GRACEFUL FAILURE: a gateway outage records a failed order and charges nothing', async () => {
  const q = basket();
  const c = grantConsent({ quoteId: q.id, agentId: null, capMinor: 200000, scope: 's', grantedBy: 'om', delivery: SAMPLE_DELIVERY });
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
  const c = grantConsent({ quoteId: q.id, agentId: null, capMinor: 200000, scope: 's', grantedBy: 'om', delivery: SAMPLE_DELIVERY });
  const out = await checkout({ quoteId: q.id, consentId: c.id, merchantId, agentId: null, idempotencyKey: 'idem-settle', rzpOptions: { fetchImpl: okRazorpay as never } });
  assert.equal(out.ok, true);
  // Settle the order this test actually created, not whichever row happens to
  // carry a shared mock id. That distinction is the whole reason the mock now
  // answers a different id per call.
  const settled = settleOrder({ razorpayOrderId: out.razorpayOrderId!, paymentId: 'pay_TEST999', status: 'paid' });
  assert.equal(settled, out.orderId, 'settlement matched the right order');
  assert.equal(getOrder(settled!)!.status, 'paid');

  // A late failure for an already-captured payment must not un-pay it.
  // Razorpay emits payment.failed for every abandoned attempt and delivery is
  // not ordered, so a customer who fails 3-D Secure once and then succeeds can
  // have the failure land second. The UPDATE used to be unconditional, and
  // nothing recovers a downgraded order: the reconciler only sweeps
  // awaiting_payment, so `failed` is terminal.
  settleOrder({ razorpayOrderId: out.razorpayOrderId!, paymentId: 'pay_EARLIER_FAIL', status: 'failed' });
  const after = getOrder(out.orderId!)!;
  assert.equal(after.status, 'paid', 'a captured payment is never un-captured by a later event');
  assert.equal(after.razorpay_payment_id, 'pay_TEST999', 'and the capture keeps its own payment id');
});

test('the audit chain still verifies after every one of those decisions', () => {
  const v = verify();
  assert.equal(v.ok, true);
  assert.ok(v.checked > 20);
});

// ---------------------------------------------------------------------------
// Concurrency.
//
// Every single-use guarantee in this project was enforced by reading a status
// in the guard and writing it after the gateway call -- with two awaited
// network round-trips in between. Node hands the event loop to every other
// in-flight request inside that window, so N callers all read `open`, all
// passed, and all got an order. One human approval, N payment links, each cap
// satisfied individually and none of them in aggregate.
//
// Nothing in the suite had two overlapping checkouts in it, which is precisely
// the regime where the bug does not appear.
// ---------------------------------------------------------------------------

test('RACE: one approval cannot fund two orders, however many callers overlap', async () => {
  const q = basket();                       // ₹998.00
  const c = grantConsent({ quoteId: q.id, agentId: null, capMinor: 200000, scope: 'bluehill-example', grantedBy: 'om', delivery: SAMPLE_DELIVERY });

  // Ten simultaneous calls, each with its OWN idempotency key -- which is what
  // the MCP tool mints whenever an agent omits one, so this is the default
  // behaviour of a retrying agent, not a contrived attack.
  const results = await Promise.all(
    Array.from({ length: 10 }, (_, i) =>
      checkout({
        quoteId: q.id, consentId: c.id, merchantId, agentId: null,
        idempotencyKey: `race-distinct-${i}`, rzpOptions: { fetchImpl: okRazorpay as never },
      })),
  );

  const won = results.filter((r) => r.ok);
  assert.equal(won.length, 1, `exactly one order may exist for one approval, got ${won.length}`);
  // The losers are refused either by the atomic claim itself, or by the guard
  // one call later -- which now sees `consumed`, because the claim is
  // synchronous and lands before any caller reaches the network. Before the
  // fix the burn happened after two awaits, so every one of these ten read
  // `open` and every one of them got an order.
  const refusals = results.filter((r) => !r.ok).map((r) => r.blockedBy);
  assert.ok(
    refusals.every((b) => b === 'quote_single_use' || b === 'consent_single_use' || b === 'quote_integrity'),
    `the losers must be refused as duplicates, got ${JSON.stringify(refusals)}`,
  );

  // The money question, asked directly: how many payable links now exist?
  const links = (db.prepare(
    "SELECT COUNT(*) AS n FROM orders WHERE quote_id = ? AND razorpay_payment_link_id IS NOT NULL",
  ).get(q.id) as { n: number }).n;
  assert.equal(links, 1, 'one basket, one payable link');
});

test('RACE: the same idempotency key still collapses to one order', async () => {
  const q = basket();
  const c = grantConsent({ quoteId: q.id, agentId: null, capMinor: 200000, scope: 'bluehill-example', grantedBy: 'om', delivery: SAMPLE_DELIVERY });
  const results = await Promise.all(
    Array.from({ length: 5 }, () =>
      checkout({
        quoteId: q.id, consentId: c.id, merchantId, agentId: null,
        idempotencyKey: 'race-same-key', rzpOptions: { fetchImpl: okRazorpay as never },
      })),
  );
  assert.equal(results.filter((r) => r.ok).length, 1);
  assert.ok(results.filter((r) => !r.ok).every((r) => r.blockedBy === 'idempotency'));
});

test('a definite gateway refusal hands the approval back, so the human need not approve twice', async () => {
  const q = basket();
  const c = grantConsent({ quoteId: q.id, agentId: null, capMinor: 200000, scope: 'bluehill-example', grantedBy: 'om', delivery: SAMPLE_DELIVERY });

  // 400 is a definite answer: Razorpay saw the request and refused it, so
  // nothing was created and the quote is safe to reuse.
  const refuse = async (url: string | URL) => {
    rzpCalls.push(String(url));
    return new Response(JSON.stringify({ error: { code: 'BAD_REQUEST_ERROR', description: 'nope' } }), { status: 400, headers: { 'content-type': 'application/json' } });
  };
  const bad = await checkout({
    quoteId: q.id, consentId: c.id, merchantId, agentId: null,
    idempotencyKey: 'idem-definite-fail', rzpOptions: { fetchImpl: refuse as never },
  });
  assert.equal(bad.ok, false);
  assert.equal(bad.blockedBy, 'gateway');

  const retry = await checkout({
    quoteId: q.id, consentId: c.id, merchantId, agentId: null,
    idempotencyKey: 'idem-definite-retry', rzpOptions: { fetchImpl: okRazorpay as never },
  });
  assert.equal(retry.ok, true, `the same approval should still be usable: ${retry.reason}`);
  resetCircuit();
});

test('an AMBIGUOUS gateway failure keeps the approval burned', async () => {
  const q = basket();
  const c = grantConsent({ quoteId: q.id, agentId: null, capMinor: 200000, scope: 'bluehill-example', grantedBy: 'om', delivery: SAMPLE_DELIVERY });

  // A 502 may or may not have created something at Razorpay. Handing the quote
  // back here is how one approval quietly becomes two payable links, so the
  // human is asked again instead.
  const bad = await checkout({
    quoteId: q.id, consentId: c.id, merchantId, agentId: null,
    idempotencyKey: 'idem-ambiguous', rzpOptions: { fetchImpl: failingRazorpay as never },
  });
  assert.equal(bad.ok, false);
  const retry = await checkout({
    quoteId: q.id, consentId: c.id, merchantId, agentId: null,
    idempotencyKey: 'idem-ambiguous-retry', rzpOptions: { fetchImpl: okRazorpay as never },
  });
  assert.equal(retry.ok, false, 'an ambiguous failure must not silently re-arm the approval');
  resetCircuit();
});
