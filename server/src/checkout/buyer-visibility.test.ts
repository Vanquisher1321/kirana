/**
 * "I approved it and my purchase never appeared."
 *
 * Every scoped query in this codebase found a tenant by joining through the
 * MERCHANT. That answers "orders for my shops" and cannot answer "orders I
 * placed" — so a shopper buying from a shop that is not theirs, which is the
 * normal case when shops are a public directory, could approve a payment and
 * then watch it not exist. The sandbox's seeded shop belongs to nobody at all,
 * which made the demo path the broken one.
 *
 * The buyer is now recorded twice over: from the connection when it knows one,
 * and otherwise from the human who approved the spend, because approving IS the
 * act of being the buyer.
 */
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.KIRANA_DB = join(tmpdir(), `kirana-test-buyervis-${process.pid}-${Date.now()}.db`);
process.env.KIRANA_SIGNING_SECRET = 'k'.repeat(64);
process.env.KIRANA_QUIET = '1';

const { db } = await import('../lib/db.ts');
const { requestConsent, approveConsent } = await import('./consent.ts');
const { listOrders } = await import('./checkout.ts');

const SHOPPER = 'ws_theshopper';
const OTHER = 'ws_someoneelse';

function seedShop(id: string, workspaceId: string | null) {
  db.prepare(
    `INSERT OR IGNORE INTO merchants (id, slug, name, origin_url, platform, currency, policies, ingested_at, workspace_id)
     VALUES (?,?,?,?,'shopify','INR','{}',?,?)`,
  ).run(id, id, id, `https://${id}.example`, new Date().toISOString(), workspaceId);
}
function seedQuote(id: string, merchantId: string) {
  db.prepare(
    `INSERT INTO quotes (id, merchant_id, agent_id, lines, subtotal_minor, shipping_minor, tax_minor,
      total_minor, currency, expires_at, signature, created_at)
     VALUES (?,?,'a','[]',1000,0,0,1000,'INR',?, 'sig', ?)`,
  ).run(id, merchantId, new Date(Date.now() + 600_000).toISOString(), new Date().toISOString());
}
/** An order row as checkout writes one, buyer included. */
function seedOrder(id: string, merchantId: string, consentId: string, buyer: string | null) {
  db.prepare(
    `INSERT INTO orders (id, merchant_id, quote_id, consent_id, agent_id, idempotency_key,
      amount_minor, currency, status, created_at, updated_at, buyer_workspace_id)
     VALUES (?,?,?,?,'a',?,1000,'INR','paid',?,?,?)`,
  ).run(id, merchantId, `qte_${id}`, consentId, `idem_${id}`, new Date().toISOString(), new Date().toISOString(), buyer);
}

before(() => {
  // quotes.agent_id and orders.agent_id are foreign keys.
  db.prepare(
    `INSERT OR IGNORE INTO agents (id, label, api_key_hash, daily_cap_minor, per_order_cap_minor, active, verified, created_at)
     VALUES ('a','a','hash_a',1000000,200000,1,0,?)`,
  ).run(new Date().toISOString());
  // The sandbox's seeded shop: belongs to nobody.
  seedShop('mch_shared', null);
  // Somebody else's shop.
  seedShop('mch_theirs', OTHER);
});

test('approving stamps the approver as the buyer', () => {
  seedQuote('qte_o1', 'mch_shared');
  const c = requestConsent({ quoteId: 'qte_o1', agentId: 'a', capMinor: 5000, scope: 'mch_shared' });
  approveConsent(c.id, 'console', SHOPPER);
  const row = db.prepare('SELECT buyer_workspace_id AS w FROM consents WHERE id = ?').get(c.id) as { w: string | null };
  assert.equal(row.w, SHOPPER);
});

test("a purchase from the shop that belongs to nobody is visible to whoever bought it", () => {
  seedQuote('qte_o2', 'mch_shared');
  const c = requestConsent({ quoteId: 'qte_o2', agentId: 'a', capMinor: 5000, scope: 'mch_shared' });
  approveConsent(c.id, 'console', SHOPPER);
  seedOrder('o2', 'mch_shared', c.id, SHOPPER);

  const mine = listOrders(50, SHOPPER).map((o) => String(o.id));
  assert.ok(mine.includes('o2'), 'the buyer sees their own purchase');
});

test("and it is NOT visible to an unrelated visitor", () => {
  const theirs = listOrders(50, 'ws_astranger').map((o) => String(o.id));
  assert.ok(!theirs.includes('o2'), 'a stranger sees nothing of it');
});

test("buying from someone else's shop is visible to the buyer, and to that merchant", () => {
  seedQuote('qte_o3', 'mch_theirs');
  const c = requestConsent({ quoteId: 'qte_o3', agentId: 'a', capMinor: 5000, scope: 'mch_theirs' });
  approveConsent(c.id, 'console', SHOPPER);
  seedOrder('o3', 'mch_theirs', c.id, SHOPPER);

  assert.ok(listOrders(50, SHOPPER).map((o) => String(o.id)).includes('o3'), 'the buyer sees it');
  assert.ok(listOrders(50, OTHER).map((o) => String(o.id)).includes('o3'), 'the merchant still sees their own sale');
});

test('a pending approval reaches the buyer even when the shop is someone else\'s', () => {
  seedQuote('qte_o4', 'mch_theirs');
  const c = requestConsent({
    quoteId: 'qte_o4', agentId: 'a', capMinor: 5000, scope: 'mch_theirs',
    buyerWorkspaceId: SHOPPER,
  });
  const rows = db.prepare(
    `SELECT c.id FROM consents c JOIN quotes q ON q.id = c.quote_id JOIN merchants m ON m.id = q.merchant_id
     WHERE c.status='pending' AND (m.workspace_id IS ? OR m.workspace_id IS NULL OR c.buyer_workspace_id IS ?)`,
  ).all(SHOPPER, SHOPPER) as Array<{ id: string }>;
  assert.ok(rows.some((r) => r.id === c.id), 'the person being asked can see the request');
});
