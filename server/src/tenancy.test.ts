/**
 * Tenancy: one visitor must never reach another visitor's records.
 *
 * The dangerous shape is not the list endpoints -- a filtered list simply omits
 * what you may not see. It is every route that takes an ID, because there the
 * ID *is* the query and there is nothing to filter. `POST /approvals/:id/approve`
 * is the worst of them: without a check, any visitor could grant another
 * visitor's spending by guessing an identifier, which is the entire human half
 * of the loop, bypassed.
 *
 * These tests run in DEMO mode on purpose. The public sandbox is where
 * strangers share one instance, so it is where this matters most.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';

process.env.KIRANA_DB = join(tmpdir(), `kirana-test-tenancy-${process.pid}-${Date.now()}.db`);
process.env.KIRANA_SIGNING_SECRET = 'c'.repeat(64);
process.env.KIRANA_QUIET = '1';
process.env.KIRANA_ACCESS = 'demo';
delete process.env.KIRANA_CONSOLE_TOKEN;

const { buildApp } = await import('./app.ts');
const { ingestStorefront } = await import('./catalog/ingest.ts');
const { getMerchant, searchCatalog } = await import('./catalog/store.ts');
const { createQuote } = await import('./checkout/quote.ts');
const { requestConsent } = await import('./checkout/consent.ts');
import type { FastifyInstance } from 'fastify';

const FIXTURE = readFileSync(new URL('./adapters/__fixtures__/shopify-store.json', import.meta.url), 'utf8');
const fixtureFetch = async (url: string | URL) => {
  const u = String(url);
  if (u.includes('/meta.json')) return new Response('{"currency":"INR"}', { headers: { 'content-type': 'application/json' } });
  if (u.includes('/products.json')) {
    const page = Number(new URL(u).searchParams.get('page') ?? '1');
    return new Response(page > 1 ? '{"products":[]}' : FIXTURE, { headers: { 'content-type': 'application/json' } });
  }
  return new Response('<html><title>Blue Hill Coffee</title></html>', { headers: { 'content-type': 'text/html' } });
};

let app: FastifyInstance;
let base = '';

/** A visitor is just a cookie jar, exactly like a browser. */
class Visitor {
  cookie = '';
  async fetch(path: string, init: RequestInit = {}): Promise<Response> {
    const res = await fetch(`${base}${path}`, {
      ...init,
      headers: { 'content-type': 'application/json', ...(init.headers ?? {}), ...(this.cookie ? { cookie: this.cookie } : {}) },
    });
    const set = res.headers.get('set-cookie');
    if (set) this.cookie = set.split(';')[0]!;
    return res;
  }
  async role(r: 'merchant' | 'shopper' | 'platform') {
    await this.fetch('/api/session/role', { method: 'POST', body: JSON.stringify({ role: r }) });
  }
}

let alice: Visitor;
let mallory: Visitor;
let aliceConsentId = '';
let aliceOrderMerchant = '';

before(async () => {
  app = buildApp();
  await app.listen({ port: 0, host: '127.0.0.1' });
  base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;

  alice = new Visitor();
  mallory = new Visitor();
  // Both are ordinary visitors. Neither claims the platform view.
  await alice.role('merchant');
  await mallory.role('merchant');

  // Alice connects a shop into HER workspace, then has a pending approval.
  const aliceWs = ((await (await alice.fetch('/api/session')).json()) as { workspaceId: string }).workspaceId;
  await ingestStorefront('alice-shop.example', { fetchImpl: fixtureFetch as never, workspaceId: aliceWs });
  const merchant = getMerchant('alice-shop-example')!;
  aliceOrderMerchant = merchant.id;
  const variant = searchCatalog(merchant.id, { limit: 1 })[0]!.variants[0]!;
  const quote = createQuote(merchant.id, [{ variantId: variant.id, quantity: 1 }], 'alice-agent');
  // A *pending* request -- the agent asked, no human has answered yet. That is
  // the record an attacker would most want to answer on someone else's behalf.
  aliceConsentId = requestConsent({
    quoteId: quote.id, agentId: 'alice-agent', capMinor: 5_000_00, scope: merchant.id,
  }).id;
});

after(async () => { await app.close(); });

test('two visitors get two different workspaces without signing up', async () => {
  const a = await (await alice.fetch('/api/session')).json() as { workspaceId: string };
  const m = await (await mallory.fetch('/api/session')).json() as { workspaceId: string };
  assert.ok(a.workspaceId.startsWith('ws_'));
  assert.notEqual(a.workspaceId, m.workspaceId);
});

test("Alice sees her own pending approval", async () => {
  const list = await (await alice.fetch('/api/approvals')).json() as Array<{ id: string }>;
  assert.ok(list.some((c) => c.id === aliceConsentId), 'the owner must see her own request');
});

test("TENANCY: Mallory's approval list does not contain Alice's request", async () => {
  const list = await (await mallory.fetch('/api/approvals')).json() as Array<{ id: string }>;
  assert.equal(list.some((c) => c.id === aliceConsentId), false);
});

test("TENANCY: Mallory cannot APPROVE Alice's spending by id", async () => {
  const res = await mallory.fetch(`/api/approvals/${aliceConsentId}/approve`, {
    method: 'POST', body: JSON.stringify({ by: 'mallory' }),
  });
  assert.equal(res.status, 404, 'the human half of the loop must not be reachable across tenants');
  // And it really is still pending for its owner.
  const mine = await (await alice.fetch(`/api/approvals/${aliceConsentId}`)).json() as { status: string };
  assert.equal(mine.status, 'pending');
});

test("TENANCY: Mallory cannot reject, revoke or even read Alice's request", async () => {
  for (const path of [`/api/approvals/${aliceConsentId}/reject`, `/api/approvals/${aliceConsentId}/revoke`]) {
    const res = await mallory.fetch(path, { method: 'POST', body: JSON.stringify({ by: 'mallory' }) });
    assert.equal(res.status, 404, `${path} must not be reachable across tenants`);
  }
  const read = await mallory.fetch(`/api/approvals/${aliceConsentId}`);
  assert.equal(read.status, 404, 'a 404 also refuses to confirm that the id exists');
});

test("TENANCY: Mallory cannot raise caps or mint a key for Alice's agent", async () => {
  const caps = await mallory.fetch('/api/agents/alice-agent/caps', {
    method: 'POST', body: JSON.stringify({ perOrderMinor: 100_000_00, dailyMinor: 100_000_00 }),
  });
  assert.equal(caps.status, 404);
  const key = await mallory.fetch('/api/agents/alice-agent/key', { method: 'POST', body: JSON.stringify({ label: 'stolen' }) });
  assert.equal(key.status, 404, 'minting a key for someone else’s agent is a takeover');
});

test('TENANCY: lists are confined to the caller', async () => {
  const mine = await (await alice.fetch('/api/merchants')).json() as Array<{ slug: string }>;
  assert.ok(mine.some((m) => m.slug === 'alice-shop-example'));
  const theirs = await (await mallory.fetch('/api/merchants')).json() as Array<{ slug: string }>;
  assert.equal(theirs.length, 0, 'a fresh visitor owns no shops');
  const agents = await (await mallory.fetch('/api/agents')).json() as unknown[];
  assert.equal(agents.length, 0);
  const orders = await (await mallory.fetch('/api/orders')).json() as unknown[];
  assert.equal(orders.length, 0);
});

test('DISCOVERY stays public: any shopper can browse every shop', async () => {
  // Hiding the directory would hide nothing -- the MCP endpoint is already open
  // to the world -- while breaking the entire premise of the product.
  const dir = await (await mallory.fetch('/api/merchants?scope=directory')).json() as Array<{ slug: string }>;
  assert.ok(dir.some((m) => m.slug === 'alice-shop-example'), 'shops are a public index');
});

test('TENANCY: asking for the platform scope is not enough on its own', async () => {
  // Mallory is a merchant. The query parameter is a request, not a permission.
  const res = await mallory.fetch('/api/orders?scope=platform');
  const rows = await res.json() as unknown[];
  assert.equal(rows.length, 0, 'the role decides, not the query string');
});

test('the platform persona is the one view that legitimately reads across', async () => {
  const rzp = new Visitor();
  await rzp.role('platform');
  const list = await (await rzp.fetch('/api/approvals?scope=platform')).json() as Array<{ id: string }>;
  assert.ok(list.some((c) => c.id === aliceConsentId), 'a platform console that cannot see the platform is useless');
  assert.ok(aliceOrderMerchant.length > 0);
});

test('ESCALATION: choosing the Razorpay persona does not grant the right to approve', async () => {
  // The sandbox lets any visitor hand themselves the platform role or reviewer
  // mode -- one unauthenticated POST each, deliberately, because judges need to
  // see all three consoles. The bug was that the SAME predicate then guarded
  // acting: `owns()` returned true for anyone with `role=platform` or
  // `fullAccess`, so two requests turned a stranger into someone who could
  // approve, reject or revoke another visitor's spending. Reading widely and
  // acting widely are different powers.
  const mallory2 = new Visitor();
  await mallory2.role('platform');

  // The read view really does widen -- that part is intended.
  const seen = await (await mallory2.fetch('/api/approvals?scope=platform')).json() as Array<{ id: string }>;
  assert.ok(seen.some((c) => c.id === aliceConsentId), 'the platform console can see the queue');

  // Acting on it does not.
  for (const verb of ['approve', 'reject', 'revoke']) {
    const res = await mallory2.fetch(`/api/approvals/${aliceConsentId}/${verb}`, {
      method: 'POST', body: JSON.stringify({ by: 'mallory' }),
    });
    assert.equal(res.status, 404, `${verb} must stay out of reach of a self-selected role`);
  }

  // Reviewer mode is the same story from the other direction.
  const judge = new Visitor();
  await judge.role('merchant');
  await judge.fetch('/api/session/full-access', { method: 'POST', body: JSON.stringify({ enabled: true }) });
  const res = await judge.fetch(`/api/approvals/${aliceConsentId}/approve`, {
    method: 'POST', body: JSON.stringify({ by: 'judge' }),
  });
  assert.equal(res.status, 404, 'reviewer mode is a wider view, not a wider hand');

  const still = await (await alice.fetch(`/api/approvals/${aliceConsentId}`)).json() as { status: string };
  assert.equal(still.status, 'pending', 'and the approval is still the owner’s to make');
});

test('SECURITY: the audit feed never hands one visitor another visitor’s session', async () => {
  // A workspace id IS the cookie. It used to appear in `actor` on every
  // kill-switch press and in `detail` on every ingest, and unowned rows were
  // shown to everyone -- so GET /api/audit was a list of other people's
  // sessions, and this works with no token in locked mode too.
  await alice.fetch('/api/system/kill-switch', { method: 'POST', body: JSON.stringify({ engage: true, reason: 'test' }) });
  await alice.fetch('/api/system/kill-switch', { method: 'POST', body: JSON.stringify({ engage: false }) });

  const aliceWs = ((await (await alice.fetch('/api/session')).json()) as { workspaceId: string }).workspaceId;
  const snooper = new Visitor();
  await snooper.role('platform');   // the widest view any visitor can obtain
  const feed = await (await snooper.fetch('/api/audit?limit=500&scope=platform')).text();
  assert.equal(feed.includes(aliceWs), false, 'no scope may reveal a session id');
  assert.match(feed, /ws:[0-9a-f]{8}/, 'rows stay attributable by a one-way reference');
});

test("DEMO: a visitor can approve against the instance's own seeded shop", async () => {
  // The shop this server seeds on boot belongs to no workspace. Under a strict
  // owner===me rule nobody could ever approve against it, so a visitor shopping
  // the demo shop hit a dead end: the agent asks for permission and no human on
  // earth can grant it. This was found on the deployed instance, not in a test.
  const seeded = await ingestStorefront('seeded-shop.example', { fetchImpl: fixtureFetch as never });
  const merchant = getMerchant(seeded.merchantId)!;
  assert.equal(merchant.workspaceId ?? null, null, 'a boot-seeded shop is owned by nobody');

  const variant = searchCatalog(merchant.id, { limit: 1 })[0]!.variants[0]!;
  const quote = createQuote(merchant.id, [{ variantId: variant.id, quantity: 1 }], 'demo-agent');
  const pending = requestConsent({ quoteId: quote.id, agentId: 'demo-agent', capMinor: 5_000_00, scope: merchant.id });

  const visitor = new Visitor();
  await visitor.role('shopper');

  const queue = await (await visitor.fetch('/api/approvals')).json() as Array<{ id: string }>;
  assert.ok(queue.some((c) => c.id === pending.id), 'the shared demo queue is visible to a visitor');

  const res = await visitor.fetch(`/api/approvals/${pending.id}/approve`, { method: 'POST', body: '{}' });
  assert.equal(res.status, 200, 'and they can actually say yes');
  assert.equal((await res.json() as { status: string }).status, 'granted');
});

test("TENANCY: sharing the demo shop did not reopen the door to owned shops", async () => {
  // The important half, restated after the change above: a shop a visitor
  // CONNECTED is still theirs alone.
  const res = await mallory.fetch(`/api/approvals/${aliceConsentId}/approve`, {
    method: 'POST', body: JSON.stringify({ by: 'mallory' }),
  });
  assert.equal(res.status, 404, "an owned shop's approvals stay private");
  const still = await (await alice.fetch(`/api/approvals/${aliceConsentId}`)).json() as { status: string };
  assert.equal(still.status, 'pending');
});

test("SHARING THE DEMO SHOP DID NOT SHARE AGENTS", async () => {
  // The first version of the fix treated any null workspace as "the
  // instance's own", which is true of a boot-seeded shop and false of an
  // agent: ensureAgent is called without a workspace from the anonymous MCP
  // path, so agents get null by accident. Under the blanket rule one visitor
  // could raise another visitor's spending caps. This test is why the rule
  // now derives from the SHOP rather than from a bare null.
  const caps = await mallory.fetch('/api/agents/alice-agent/caps', {
    method: 'POST', body: JSON.stringify({ perOrderMinor: 100_000_00, dailyMinor: 100_000_00 }),
  });
  assert.equal(caps.status, 404, "caps on someone else's agent stay out of reach");
  const key = await mallory.fetch('/api/agents/demo-agent/key', { method: 'POST', body: JSON.stringify({ label: 'stolen' }) });
  assert.equal(key.status, 404, 'and an unowned agent is not a free agent');
});
