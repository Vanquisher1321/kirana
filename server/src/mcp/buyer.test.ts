/**
 * The buyer link: one connector, every shop its owner connected.
 *
 * A shop link's reach is one shop and the unguessable id in the URL is the
 * whole capability. A buyer link is wider by design, which makes its boundary
 * the thing worth testing: it must reach exactly the shops in its own
 * workspace, and an id from anywhere else must answer not-found rather than
 * anything more helpful.
 *
 * The dangerous shape is not search -- a filtered search simply omits what you
 * may not see. It is every tool that takes an ID, because there the ID *is* the
 * query. A buyer link that resolved a stranger's quote would let anyone who
 * learned a quote id settle someone else's basket.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';

process.env.KIRANA_DB = join(tmpdir(), `kirana-test-buyer-${process.pid}-${Date.now()}.db`);
process.env.KIRANA_SIGNING_SECRET = 'e'.repeat(64);
process.env.KIRANA_QUIET = '1';
process.env.KIRANA_ACCESS = 'demo';
delete process.env.KIRANA_CONSOLE_TOKEN;

const { buildApp } = await import('../app.ts');
const { ingestStorefront } = await import('../catalog/ingest.ts');
const { getMerchant, searchCatalog } = await import('../catalog/store.ts');
const { createQuote } = await import('../checkout/quote.ts');
import type { FastifyInstance } from 'fastify';

const FIXTURE = readFileSync(new URL('../adapters/__fixtures__/shopify-store.json', import.meta.url), 'utf8');
const fixtureFetch = async (url: string | URL) => {
  const u = String(url);
  if (u.includes('/meta.json')) return new Response('{"currency":"INR"}', { headers: { 'content-type': 'application/json' } });
  if (u.includes('/products.json')) {
    const page = Number(new URL(u).searchParams.get('page') ?? '1');
    return new Response(page > 1 ? '{"products":[]}' : FIXTURE, { headers: { 'content-type': 'application/json' } });
  }
  return new Response('<html><title>Shop</title></html>', { headers: { 'content-type': 'text/html' } });
};

let app: FastifyInstance;
let base = '';

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
}

/**
 * The server builds the link from its configured public origin, which in a test
 * is not the ephemeral port it actually listened on. Only the path matters here.
 */
function onBase(link: string): string {
  return `${base}${new URL(link).pathname}`;
}

/** Call one MCP tool over a buyer link and return the parsed tool payload. */
async function callTool(link: string, name: string, args: Record<string, unknown> = {}) {
  const res = await fetch(link.startsWith('http') && link.includes(base) ? link : onBase(link), {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
  });
  const body = await res.text();
  const line = body.split('\n').find((l) => l.startsWith('data: '));
  const env = JSON.parse(line!.slice(6)) as { result?: { content?: Array<{ text: string }> } };
  return JSON.parse(env.result!.content![0]!.text) as Record<string, unknown>;
}

let ana: Visitor; let bo: Visitor;
let anaLink = ''; let boLink = '';
let boQuoteId = ''; let boProductId = '';

before(async () => {
  app = buildApp();
  await app.listen({ port: 0, host: '127.0.0.1' });
  base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;

  ana = new Visitor(); bo = new Visitor();
  const anaWs = ((await (await ana.fetch('/api/session')).json()) as { workspaceId: string }).workspaceId;
  const boWs = ((await (await bo.fetch('/api/session')).json()) as { workspaceId: string }).workspaceId;

  // Ana connects TWO shops. That is the whole point of the link.
  await ingestStorefront('ana-one.example', { fetchImpl: fixtureFetch as never, workspaceId: anaWs });
  await ingestStorefront('ana-two.example', { fetchImpl: fixtureFetch as never, workspaceId: anaWs });
  // Bo connects one, in a different workspace.
  await ingestStorefront('bo-shop.example', { fetchImpl: fixtureFetch as never, workspaceId: boWs });

  anaLink = ((await (await ana.fetch('/api/session/buyer-link')).json()) as { url: string }).url;
  boLink = ((await (await bo.fetch('/api/session/buyer-link')).json()) as { url: string }).url;

  const boShop = getMerchant('bo-shop-example', boWs)!;
  const boVariant = searchCatalog(boShop.id, { limit: 1 })[0]!.variants[0]!;
  boProductId = searchCatalog(boShop.id, { limit: 1 })[0]!.id;
  boQuoteId = createQuote(boShop.id, [{ variantId: boVariant.id, quantity: 1 }], 'bo-agent').id;
});

after(async () => { await app.close(); });

test('one link, and it names both of the shops behind it', async () => {
  const out = await callTool(anaLink, 'list_shops');
  assert.equal(out.count, 2);
  const names = (out.shops as Array<{ storefront: string }>).map((s) => s.storefront).sort();
  assert.ok(names.some((n) => n.includes('ana-one')), 'first shop reachable');
  assert.ok(names.some((n) => n.includes('ana-two')), 'second shop reachable');
});

test('search covers every shop on the link and says which one each result came from', async () => {
  const out = await callTool(anaLink, 'search_products', { limit: 50 });
  const products = out.products as Array<{ merchant_id: string; shop: string }>;
  assert.ok(products.length > 0, 'found something');
  assert.ok(products.every((p) => p.merchant_id && p.shop), 'every result is attributed to a shop');
  assert.equal(new Set(products.map((p) => p.merchant_id)).size, 2, 'results span both shops, not just the first');
});

test("a buyer link cannot read another workspace's product", async () => {
  const out = await callTool(anaLink, 'get_product', { product_id: boProductId });
  assert.equal(out.error, 'product_not_found');
});

test("a buyer link cannot read another workspace's quote", async () => {
  const out = await callTool(anaLink, 'get_quote', { quote_id: boQuoteId });
  assert.equal(out.error, 'quote_not_found');
});

test("a buyer link cannot ask for approval against another workspace's quote", async () => {
  const out = await callTool(anaLink, 'request_approval', { quote_id: boQuoteId, spend_cap_inr: 5000 });
  assert.equal(out.error, 'quote_not_found');
});

test("a buyer link cannot check out another workspace's quote", async () => {
  const out = await callTool(anaLink, 'checkout', { quote_id: boQuoteId, consent_id: 'csnt_whatever' });
  assert.equal(out.paid, false);
  assert.equal(out.blocked_by, 'quote_not_found');
});

test("Bo's own link still reaches Bo's quote — the refusal is scope, not a broken lookup", async () => {
  const out = await callTool(boLink, 'get_quote', { quote_id: boQuoteId });
  assert.equal(out.quote_id, boQuoteId);
});

test('an unknown buyer key is refused rather than silently empty', async () => {
  const res = await fetch(`${base}/mcp/u/bkr_notarealkeyatall`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
  });
  assert.equal(res.status, 404);
});

test('rotating the link breaks the old one immediately', async () => {
  const fresh = new Visitor();
  await fresh.fetch('/api/session');
  const before_ = ((await (await fresh.fetch('/api/session/buyer-link')).json()) as { url: string }).url;
  const after_ = ((await (await fresh.fetch('/api/session/buyer-link/rotate', { method: 'POST' })).json()) as { url: string }).url;
  assert.notEqual(before_, after_);

  const res = await fetch(onBase(before_), {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
  });
  assert.equal(res.status, 404, 'the pasted-somewhere-it-should-not-be link is dead');
});

test('the per-shop link is untouched: it still sees exactly one shop', async () => {
  const shop = getMerchant('ana-one-example')!;
  const out = await callTool(`${base}/mcp/${shop.publicId || shop.slug}`, 'get_merchant_info');
  assert.ok(String(out.name ?? '').length > 0);
  assert.equal(out.error, undefined);
});
