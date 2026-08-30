import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';

process.env.KIRANA_DB = `data/test-app-${process.pid}.db`;
process.env.KIRANA_SIGNING_SECRET = 'b'.repeat(64);
process.env.KIRANA_QUIET = '1';

const { buildApp } = await import('./app.ts');
const { ingestStorefront } = await import('./catalog/ingest.ts');
const { getMerchant, searchCatalog } = await import('./catalog/store.ts');
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

/** Minimal MCP client: one JSON-RPC call over Streamable HTTP, SSE or JSON. */
async function rpc(method: string, params?: unknown, idNum = 1): Promise<Record<string, unknown>> {
  const res = await fetch(`${base}/mcp/bluehill-example`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: idNum, method, params: params ?? {} }),
  });
  const text = await res.text();
  // Streamable HTTP may answer as SSE; take the last data: frame.
  const frames = text.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim());
  const payload = frames.length ? frames[frames.length - 1]! : text;
  return JSON.parse(payload) as Record<string, unknown>;
}

function toolJson(result: Record<string, unknown>): Record<string, unknown> {
  const content = (result.result as { content?: Array<{ text?: string }> })?.content;
  return JSON.parse(content?.[0]?.text ?? '{}') as Record<string, unknown>;
}

before(async () => {
  await ingestStorefront('bluehill.example', { fetchImpl: fixtureFetch as never });
  app = buildApp();
  await app.listen({ port: 0, host: '127.0.0.1' });
  const addr = app.server.address() as AddressInfo;
  base = `http://127.0.0.1:${addr.port}`;
});

after(async () => { await app.close(); });

test('health endpoint reports service state', async () => {
  const r = await (await fetch(`${base}/health`)).json() as { ok: boolean };
  assert.equal(r.ok, true);
});

test('MCP initialize handshake succeeds', async () => {
  const r = await rpc('initialize', {
    protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'kirana-test', version: '0' },
  });
  const result = r.result as { serverInfo?: { name?: string }; instructions?: string };
  assert.equal(result.serverInfo?.name, 'kirana-bluehill-example');
  assert.match(result.instructions ?? '', /cryptographically signed/);
});

test('MCP exposes the buyer-agent toolset', async () => {
  const r = await rpc('tools/list', {}, 2);
  const names = ((r.result as { tools: Array<{ name: string }> }).tools).map((t) => t.name).sort();
  assert.deepEqual(names, ['create_quote', 'get_merchant_info', 'get_product', 'get_quote', 'search_products']);
});

test('an agent can discover the shop', async () => {
  const r = await rpc('tools/call', { name: 'get_merchant_info', arguments: {} }, 3);
  const info = toolJson(r);
  assert.equal(info.name, 'Blue Hill Coffee');
  const cat = info.catalog as Record<string, unknown>;
  assert.equal(cat.products, 2);
  // Provenance is disclosed to the buyer, not hidden.
  assert.equal(cat.extracted_by_model, false);
  assert.equal(cat.source, 'shopify');
});

test('an agent can search within a budget', async () => {
  const r = await rpc('tools/call', { name: 'search_products', arguments: { query: 'coffee', max_price_inr: 600 } }, 4);
  const out = toolJson(r);
  // Both products match "coffee" -- one by title, one by vendor ("Blue Hill
  // Coffee") -- and both have a variant at or under ₹600.
  assert.equal(out.count, 2);
  const titles = (out.products as Array<Record<string, unknown>>).map((p) => String(p.title));
  assert.ok(titles.some((t) => /Attikan/.test(t)));
  assert.ok(titles.some((t) => /Cold Brew/.test(t)));
  const attikan = (out.products as Array<Record<string, unknown>>).find((p) => /Attikan/.test(String(p.title)))!;
  assert.equal(attikan.price_from, '₹499.00');

  // A tighter budget must exclude the ₹499 item and keep the ₹349.50 one.
  const tight = toolJson(await rpc('tools/call', { name: 'search_products', arguments: { query: 'coffee', max_price_inr: 400 } }, 41));
  assert.equal(tight.count, 1);
  assert.match(String((tight.products as Array<Record<string, unknown>>)[0]!.title), /Cold Brew/);
});

test('an agent gets a signed, fixed-price quote end to end', async () => {
  const merchant = getMerchant('bluehill-example')!;
  const attikan = searchCatalog(merchant.id, { query: 'attikan' })[0]!;
  const variant = attikan.variants.find((v) => v.priceMinor === 49900)!;

  const r = await rpc('tools/call', {
    name: 'create_quote', arguments: { items: [{ variant_id: variant.id, quantity: 2 }] },
  }, 5);
  const q = toolJson(r);
  assert.ok(String(q.quote_id).startsWith('qte_'));
  assert.equal(q.total, '₹998.00');
  assert.equal(q.total_minor, 99800);
  assert.match(String(q.next_step), /cannot raise it yourself/);
});

test('quoting an out-of-stock item is refused with a reason an agent can relay', async () => {
  const merchant = getMerchant('bluehill-example')!;
  const attikan = searchCatalog(merchant.id, { query: 'attikan' })[0]!;
  const soldOut = attikan.variants.find((v) => v.priceMinor === 349900)!;
  const r = await rpc('tools/call', { name: 'create_quote', arguments: { items: [{ variant_id: soldOut.id, quantity: 1 }] } }, 6);
  const out = toolJson(r);
  assert.equal(out.error, 'out_of_stock');
  assert.match(String(out.message), /out of stock/);
});

test('an unknown merchant slug is refused as JSON-RPC, not a stack trace', async () => {
  const res = await fetch(`${base}/mcp/never-ingested`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
  });
  assert.equal(res.status, 404);
  const body = await res.json() as { error?: { message?: string } };
  assert.match(body.error?.message ?? '', /has been ingested/);
});

test('the audit chain covers the agent session and still verifies', async () => {
  const v = await (await fetch(`${base}/api/audit/verify`)).json() as { ok: boolean; checked: number };
  assert.equal(v.ok, true);
  const rows = await (await fetch(`${base}/api/audit`)).json() as Array<{ action: string }>;
  const actions = new Set(rows.map((r) => r.action));
  assert.ok(actions.has('catalog.searched'));
  assert.ok(actions.has('quote.created'));
  assert.ok(actions.has('quote.rejected'));
});
