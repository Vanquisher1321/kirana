import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';

process.env.KIRANA_DB = `data/test-app-${process.pid}.db`;
process.env.KIRANA_SIGNING_SECRET = 'b'.repeat(64);
process.env.KIRANA_QUIET = '1';
process.env.KIRANA_CONSOLE_TOKEN = 'test-console-token';
process.env.KIRANA_ACCESS = 'locked';

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

/** The console is authenticated; every /api call must carry the token. */
function authFetch(url: string, init: RequestInit = {}) {
  return fetch(url, { ...init, headers: { ...(init.headers ?? {}), authorization: 'Bearer test-console-token' } });
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
  assert.deepEqual(names, [
    'checkout', 'create_quote', 'get_approval', 'get_merchant_info', 'get_order',
    'get_product', 'get_quote', 'request_approval', 'search_products',
  ]);
});

test('the checkout tool documents the constraints an agent must obey', async () => {
  const r = await rpc('tools/list', {}, 21);
  const tools = (r.result as { tools: Array<{ name: string; description: string }> }).tools;
  const approval = tools.find((t) => t.name === 'request_approval')!;
  assert.match(approval.description, /CANNOT approve this yourself/);
  assert.match(approval.description, /cannot raise the cap/);
  const pay = tools.find((t) => t.name === 'checkout')!;
  assert.match(pay.description, /retry can never become a second charge/);
});

test('an agent asking to spend more than the basket is told to ask the human', async () => {
  const merchant = getMerchant('bluehill-example')!;
  const attikan = searchCatalog(merchant.id, { query: 'attikan' })[0]!;
  const variant = attikan.variants.find((v) => v.priceMinor === 189910)!;
  const q = toolJson(await rpc('tools/call', {
    name: 'create_quote', arguments: { items: [{ variant_id: variant.id, quantity: 1 }] },
  }, 22));

  // Cap deliberately below the basket total.
  const low = toolJson(await rpc('tools/call', {
    name: 'request_approval', arguments: { quote_id: q.quote_id, spend_cap_inr: 100 },
  }, 23));
  assert.equal(low.error, 'cap_below_total');
  assert.match(String(low.message), /do not lower the basket without telling them/);

  // A sufficient cap produces a PENDING approval — never an approved one.
  const pending = toolJson(await rpc('tools/call', {
    name: 'request_approval', arguments: { quote_id: q.quote_id, spend_cap_inr: 2000 },
  }, 24));
  assert.equal(pending.status, 'pending');
  assert.ok(String(pending.consent_id).startsWith('csnt_'));

  // And the agent cannot pay while it is still pending.
  const blocked = toolJson(await rpc('tools/call', {
    name: 'checkout', arguments: { quote_id: q.quote_id, consent_id: pending.consent_id },
  }, 25));
  assert.equal(blocked.paid, false);
  assert.equal(blocked.blocked_by, 'consent_live');
});

test('the console can approve a pending request, and only a human can', async () => {
  const approvals = await (await authFetch(`${base}/api/approvals`)).json() as Array<{ id: string; capFormatted: string }>;
  assert.ok(approvals.length >= 1);
  const target = approvals[0]!;
  assert.match(target.capFormatted, /^₹/);
  const res = await authFetch(`${base}/api/approvals/${target.id}/approve`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ by: 'om' }),
  });
  const granted = await res.json() as { status: string; grantedBy: string };
  assert.equal(granted.status, 'granted');
  assert.equal(granted.grantedBy, 'om');
});

test('the kill switch is reachable from the console and reported by the API', async () => {
  await authFetch(`${base}/api/system/kill-switch`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ engage: true, reason: 'test' }),
  });
  const sys = await (await authFetch(`${base}/api/system`)).json() as { killSwitch: { engaged: boolean } };
  assert.equal(sys.killSwitch.engaged, true);
  await authFetch(`${base}/api/system/kill-switch`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ engage: false }),
  });
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
  const v = await (await authFetch(`${base}/api/audit/verify`)).json() as { ok: boolean; checked: number };
  assert.equal(v.ok, true);
  const rows = await (await authFetch(`${base}/api/audit`)).json() as Array<{ action: string }>;
  const actions = new Set(rows.map((r) => r.action));
  assert.ok(actions.has('catalog.searched'));
  assert.ok(actions.has('quote.created'));
  assert.ok(actions.has('quote.rejected'));
});


test('SECURITY: the console refuses to act without a token', async () => {
  const approvals = await (await authFetch(`${base}/api/approvals`)).json() as Array<{ id: string }>;
  const id = approvals[0]?.id ?? 'csnt_none';

  // No token at all.
  const bare = await fetch(`${base}/api/approvals/${id}/approve`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
  });
  assert.equal(bare.status, 401, 'approving without a token must be refused');

  // A wrong token cannot ACT, even though reading is open.
  const wrong = await fetch(`${base}/api/approvals/${id}/approve`, {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer not-the-token' }, body: '{}',
  });
  assert.equal(wrong.status, 401);

  // An empty token must never authenticate.
  const empty = await fetch(`${base}/api/approvals/${id}/approve`, {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' }, body: '{}',
  });
  assert.equal(empty.status, 401);

  // Reading is deliberately open so the console stays legible without a token.
  assert.equal((await fetch(`${base}/api/audit`)).status, 200);

  // Pausing the whole system is not.
  assert.equal((await fetch(`${base}/api/system/kill-switch`, { method: 'POST', body: '{}', headers: { 'content-type': 'application/json' } })).status, 401);
});

test('SECURITY: the buyer-agent endpoint stays open, because discovery cannot need a password', async () => {
  const r = await rpc('tools/list', {}, 90);
  assert.ok((r.result as { tools: unknown[] }).tools.length > 0, 'an unauthenticated agent can still shop');
});

test('SECURITY: an unrecognised agent key is rejected rather than downgraded', async () => {
  const res = await fetch(`${base}/mcp/bluehill-example`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'x-kirana-agent-key': 'kag_totally_made_up' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
  });
  assert.equal(res.status, 401);
});

test('SECURITY: a self-asserted agent name cannot have its spending caps raised', async () => {
  await fetch(`${base}/mcp/bluehill-example`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'x-kirana-agent': 'impostor' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'get_merchant_info', arguments: {} } }),
  });
  const res = await authFetch(`${base}/api/agents/impostor/caps`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ perOrderMinor: 100000000, dailyMinor: 100000000 }),
  });
  assert.equal(res.status, 409);
  const body = await res.json() as { message: string };
  assert.match(body.message, /unverified/);
});

test('SECURITY: an issued key produces a verified agent whose caps CAN be raised', async () => {
  const issued = await (await authFetch(`${base}/api/agents/trusted-buyer/key`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ label: 'Trusted buyer' }),
  })).json() as { apiKey: string; agent: { verified: boolean } };
  assert.ok(issued.apiKey.startsWith('kag_'));
  assert.equal(issued.agent.verified, true);

  const raised = await authFetch(`${base}/api/agents/trusted-buyer/caps`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ perOrderMinor: 500000, dailyMinor: 2000000 }),
  });
  assert.equal(raised.status, 200);
});

test('LOCKED MODE: reading is open but acting still needs the token', async () => {
  // This test process sets PUBLIC_ORIGIN implicitly off but KIRANA_ACCESS is
  // unset, so it runs LOCKED (a token is present in these tests). The split the
  // hook makes: GET is the read surface, and every endpoint that spends,
  // approves, ingests or pauses is a POST.
  const readEndpoints = ['/api/merchants', '/api/audit', '/api/audit/verify', '/api/orders', '/api/agents', '/api/system', '/api/approvals'];
  for (const path of readEndpoints) {
    const withToken = await authFetch(`${base}${path}`);
    assert.equal(withToken.status, 200, `${path} readable with a token`);
  }

  // Reads stay open even without a token, so the console is legible.
  for (const path of readEndpoints) {
    const bare = await fetch(`${base}${path}`);
    assert.equal(bare.status, 200, `${path} is readable without a token`);
  }

  // And the write surface is refused without a token either way.
  const writes: Array<[string, string]> = [
    ['/api/ingest', '{"url":"example.com"}'],
    ['/api/system/kill-switch', '{"engage":true}'],
    ['/api/agents/x/key', '{}'],
    ['/api/reconcile', '{}'],
  ];
  for (const [path, body] of writes) {
    const res = await fetch(`${base}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body });
    assert.equal(res.status, 401, `${path} refuses an unauthenticated write`);
  }
});

test('SECURITY: the auth hook cannot be bypassed by encoding or normalising the path', async () => {
  // request.url is raw; Fastify's router decodes and normalises before
  // matching. All three of these reached the handler while the hook tested a
  // raw string prefix. Authorisation now keys on the matched route pattern.
  const bypasses = [
    '/%61pi/system/kill-switch',
    '/API/system/kill-switch',
    '//api/system/kill-switch',
    '/%2Fapi/system/kill-switch',
    '/api/./system/kill-switch',
  ];
  for (const path of bypasses) {
    const res = await fetch(`${base}${path}`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"engage":true}',
    });
    assert.ok(res.status === 401 || res.status === 404,
      `${path} must not reach the handler unauthenticated (got ${res.status})`);
  }
  // And the system is still running, i.e. none of them engaged the kill switch.
  const sys = await (await authFetch(`${base}/api/system`)).json() as { killSwitch: { engaged: boolean } };
  assert.equal(sys.killSwitch.engaged, false, 'no bypass managed to pause spending');
});

test('SECURITY: a self-asserted agent name cannot inherit a verified agent’s raised caps', async () => {
  const { issueAgentKey, setAgentCaps } = await import('./checkout/agents.ts');
  const { authorise } = await import('./checkout/guard.ts');
  const { createQuote } = await import('./checkout/quote.ts');
  const { grantConsent } = await import('./checkout/consent.ts');

  // An operator trusts one agent with a much larger ceiling.
  issueAgentKey('trusted-partner', 'Trusted partner');
  setAgentCaps('trusted-partner', 5_000_00, 50_000_00);

  const merchant = getMerchant('bluehill-example')!;
  const attikan = searchCatalog(merchant.id, { query: 'attikan' })[0]!;
  const pricey = attikan.variants.find((v) => v.priceMinor === 189910)!;

  // An impostor sends only the header — no key — and asks for a basket that
  // only the raised ceiling would allow.
  const q = createQuote(merchant.id, [{ variantId: pricey.id, quantity: 2 }], 'trusted-partner');
  const c = grantConsent({ quoteId: q.id, agentId: 'trusted-partner', capMinor: 5_000_00, scope: merchant.id, grantedBy: 'om' });

  // The impostor sends the NAME but proves nothing.
  const decision = authorise({
    quoteId: q.id, consentId: c.id, agentId: 'trusted-partner', identityProven: false,
    merchantId: merchant.id, idempotencyKey: `impostor-${Date.now()}`,
  });

  assert.equal(decision.allowed, false, 'a header alone must not unlock a verified agent’s ceiling');
  assert.ok(
    decision.blockedBy === 'consent_agent_match' || decision.blockedBy === 'within_per_order_cap',
    `expected an identity or cap refusal, got ${decision.blockedBy}`,
  );

  // And the same request, from a caller that DID prove the identity, is allowed.
  const allowed = authorise({
    quoteId: q.id, consentId: c.id, agentId: 'trusted-partner', identityProven: true,
    merchantId: merchant.id, idempotencyKey: `genuine-${Date.now()}`,
  });
  assert.equal(allowed.allowed, true, `a proven identity should pass: ${allowed.reason}`);
});
