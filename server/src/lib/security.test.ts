import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
process.env.KIRANA_DB = join(tmpdir(), `kirana-security-${process.pid}-${Date.now()}.db`);

import { classifyAddress, assertPublicHost, assertFetchableUrl, BlockedHostError, secretEquals, rateLimit, resetRateLimits } from './security.ts';

test('SSRF: the hex spelling of an IPv4-mapped address is caught, not just the dotted one', () => {
  // ::ffff:a9fe:a9fe IS 169.254.169.254. The WHATWG URL parser normalises
  // [0:0:0:0:0:ffff:169.254.169.254] into that hex form, which a
  // dotted-quad regex does not match — so the cloud metadata endpoint was
  // reachable through a redirect until the address was parsed rather than
  // pattern-matched.
  assert.ok(classifyAddress('::ffff:a9fe:a9fe'), '::ffff:a9fe:a9fe is 169.254.169.254');
  assert.ok(classifyAddress('::ffff:7f00:1'), '::ffff:7f00:1 is 127.0.0.1');
  assert.ok(classifyAddress('0:0:0:0:0:ffff:7f00:1'), 'expanded form');
  assert.ok(classifyAddress('64:ff9b::7f00:1'), 'NAT64 embedding a loopback address');
  assert.ok(classifyAddress('192.88.99.1'), '6to4 relay anycast');
  // Genuinely public IPv6 still passes.
  assert.equal(classifyAddress('2606:4700::1111'), null);
  assert.equal(classifyAddress('2001:4860:4860::8888'), null);
});

test('SSRF: cloud metadata and every private range are classified as internal', () => {
  const internal = [
    '127.0.0.1', '127.1.1.1', '0.0.0.0',
    '169.254.169.254',            // AWS/GCP/Azure instance metadata
    '10.0.0.5', '172.16.0.1', '172.31.255.255', '192.168.1.1',
    '100.64.0.1',                 // CGNAT
    '192.0.0.1', '198.18.0.1', '224.0.0.1', '255.255.255.255',
    '::1', '::', 'fe80::1', 'fd00::1', '::ffff:127.0.0.1',
  ];
  for (const ip of internal) {
    assert.ok(classifyAddress(ip), `${ip} must be treated as internal`);
  }
});

test('SSRF: genuinely public addresses are allowed', () => {
  for (const ip of ['8.8.8.8', '1.1.1.1', '104.18.0.1', '2606:4700::1111']) {
    assert.equal(classifyAddress(ip), null, `${ip} should be allowed`);
  }
});

test('SSRF: literal internal IPs in a URL are refused', async () => {
  for (const url of [
    'http://169.254.169.254/latest/meta-data/iam/security-credentials/',
    'http://127.0.0.1:3000/api/audit',
    'https://10.0.0.5/products.json',
    'http://[::1]/',
  ]) {
    await assert.rejects(() => assertFetchableUrl(url), BlockedHostError, url);
  }
});

test('SSRF: internal hostnames are refused without needing DNS', async () => {
  for (const host of ['localhost', 'foo.localhost', 'db.internal', 'printer.local', 'x.home.arpa']) {
    await assert.rejects(() => assertPublicHost(host), BlockedHostError, host);
  }
});

test('SSRF: non-http schemes and odd ports are refused', async () => {
  await assert.rejects(() => assertFetchableUrl('file:///etc/passwd'), BlockedHostError);
  await assert.rejects(() => assertFetchableUrl('gopher://example.com/'), BlockedHostError);
  await assert.rejects(() => assertFetchableUrl('ftp://example.com/'), BlockedHostError);
  await assert.rejects(() => assertFetchableUrl('https://example.com:22/'), BlockedHostError);
  await assert.rejects(() => assertFetchableUrl('http://example.com:6379/'), BlockedHostError);
});

test('SSRF: a hostname that does not resolve is refused rather than attempted', async () => {
  await assert.rejects(
    () => assertPublicHost('this-domain-should-not-exist-kirana-test.invalid'),
    BlockedHostError,
  );
});

test('secret comparison is length-safe and rejects empties', () => {
  assert.equal(secretEquals('hunter2', 'hunter2'), true);
  assert.equal(secretEquals('hunter2', 'hunter3'), false);
  assert.equal(secretEquals('short', 'a-much-longer-secret'), false);
  assert.equal(secretEquals('', ''), false, 'an empty token must never authenticate');
});

test('rate limiter allows a burst then refuses with a retry hint', () => {
  resetRateLimits();
  for (let i = 0; i < 5; i++) {
    assert.equal(rateLimit('agent:x', 5, 60_000).ok, true, `request ${i + 1} allowed`);
  }
  const blocked = rateLimit('agent:x', 5, 60_000);
  assert.equal(blocked.ok, false);
  assert.ok(blocked.retryAfterMs > 0);
  // A different caller has its own budget.
  assert.equal(rateLimit('agent:y', 5, 60_000).ok, true);
});

test('SANDBOX: the merchant cap is per visitor and never reaches another tenant', async () => {
  process.env.KIRANA_ACCESS = 'demo';
  const { evictOldestMerchants } = await import('./selfheal.ts');
  const { db } = await import('./db.ts');

  db.exec("DELETE FROM merchants;");
  const ins = db.prepare(
    "INSERT INTO merchants (id, slug, name, origin_url, platform, currency, policies, ingested_at, workspace_id) VALUES (?,?,?,?,'shopify','INR','{}',?,?)",
  );
  // The greedy visitor.
  for (let i = 0; i < 6; i++) {
    ins.run(`m${i}`, `shop-${i}`, `Shop ${i}`, `https://s${i}.test`, new Date(2026, 0, i + 1).toISOString(), 'ws_greedy');
  }
  // A bystander, and the instance's own seeded shop (workspace_id NULL).
  ins.run('mV', 'victim-shop', 'Victim Shop', 'https://v.test', new Date(2026, 0, 1).toISOString(), 'ws_victim');
  ins.run('mS', 'seeded-shop', 'Seeded Shop', 'https://s.test', new Date(2025, 0, 1).toISOString(), null);

  const evicted = evictOldestMerchants(3, 'ws_greedy');
  assert.equal(evicted, 3, 'three of the greedy visitor’s oldest shops removed');

  const mine = (db.prepare("SELECT slug FROM merchants WHERE workspace_id = 'ws_greedy' ORDER BY ingested_at DESC").all() as Array<{ slug: string }>).map((r) => r.slug);
  assert.deepEqual(mine, ['shop-5', 'shop-4', 'shop-3'], 'their newest survive');

  // The whole point of the fix: nobody else was touched.
  const others = (db.prepare('SELECT slug FROM merchants WHERE workspace_id IS NOT ? ORDER BY slug').all('ws_greedy') as Array<{ slug: string }>).map((r) => r.slug);
  assert.deepEqual(others, ['seeded-shop', 'victim-shop'], 'a bystander and the seeded shop both survive');

  // And the seeded shop is not evictable by a cap at all.
  assert.equal(evictOldestMerchants(0, null), 0, 'the instance’s own shops are never a visitor’s to evict');
  db.exec("DELETE FROM merchants;");
});

test('TENANCY: two workspaces cannot see each other’s shops, orders or record', async () => {
  const { createWorkspace } = await import('./workspace.ts');
  const { ingestStorefront } = await import('../catalog/ingest.ts');
  const { listMerchants, getMerchant, getMerchantForMcp } = await import('../catalog/store.ts');
  const { readFileSync } = await import('node:fs');

  const FIXTURE = readFileSync(new URL('../adapters/__fixtures__/shopify-store.json', import.meta.url), 'utf8');
  const fetchImpl = async (url: string | URL) => {
    const u = String(url);
    if (u.includes('/meta.json')) return new Response('{"currency":"INR"}', { headers: { 'content-type': 'application/json' } });
    if (u.includes('/products.json')) {
      const page = Number(new URL(u).searchParams.get('page') ?? '1');
      return new Response(page > 1 ? '{"products":[]}' : FIXTURE, { headers: { 'content-type': 'application/json' } });
    }
    return new Response('<html><title>Shop</title></html>', { headers: { 'content-type': 'text/html' } });
  };

  const alice = createWorkspace('Alice');
  const bob = createWorkspace('Bob');

  // BOTH tenants ingest the SAME storefront — the case that collides without
  // tenancy, because the slug would be identical.
  const a = await ingestStorefront('sharedshop.example', { fetchImpl: fetchImpl as never, workspaceId: alice.id });
  const b = await ingestStorefront('sharedshop.example', { fetchImpl: fetchImpl as never, workspaceId: bob.id });

  assert.notEqual(a.merchantId, b.merchantId, 'the same shop in two workspaces is two distinct records');
  assert.notEqual(a.publicId, b.publicId, 'and two distinct MCP addresses');

  // Each tenant sees exactly one shop: their own.
  assert.deepEqual(listMerchants(alice.id).map((m) => m.id), [a.merchantId]);
  assert.deepEqual(listMerchants(bob.id).map((m) => m.id), [b.merchantId]);

  // Alice cannot reach Bob's shop by guessing the slug.
  assert.equal(getMerchant('sharedshop-example', alice.id)!.id, a.merchantId);
  assert.equal(getMerchant(b.merchantId, alice.id), null, 'another tenant’s shop is not reachable by id');

  // The MCP address resolves to exactly one shop, unambiguously.
  assert.equal(getMerchantForMcp(a.publicId)!.id, a.merchantId);
  assert.equal(getMerchantForMcp(b.publicId)!.id, b.merchantId);
  // The now-ambiguous slug resolves to neither, rather than guessing.
  assert.equal(getMerchantForMcp('sharedshop-example'), null, 'an ambiguous slug must not pick a tenant at random');
});

test('TENANCY: a tenant reads its own audit trail and nothing else', async () => {
  const { createWorkspace } = await import('./workspace.ts');
  const { record, list } = await import('../audit/ledger.ts');

  const alice = createWorkspace('Alice2');
  const bob = createWorkspace('Bob2');

  record({ actor: 'a', action: 'quote.created', subjectId: 'a1', outcome: 'ok', workspaceId: alice.id });
  record({ actor: 'b', action: 'quote.created', subjectId: 'b1', outcome: 'ok', workspaceId: bob.id });
  record({ actor: 'system', action: 'sandbox.reset', subjectId: null, outcome: 'ok' });

  const aliceSees = list(50, alice.id).map((r) => r.subjectId);
  assert.ok(aliceSees.includes('a1'), 'own entries');
  assert.ok(!aliceSees.includes('b1'), 'never another tenant’s entries');

  // This assertion used to be the opposite: unowned rows were shown to every
  // tenant so that "system events are shared". Most rows were unowned, because
  // attribution was optional and thirty call sites omitted it -- so the shared
  // feed carried other people's quotes, orders and approvals, and (see the next
  // test) their session cookies. Unowned rows belong to the platform view.
  assert.ok(!list(50, alice.id).some((r) => r.action === 'sandbox.reset'), 'system events are not a tenant’s to read');
  assert.ok(list(50, undefined).some((r) => r.action === 'sandbox.reset'), 'the platform view still sees them');
});

test('SECURITY: a workspace id is never readable out of the audit trail', async () => {
  const { createWorkspace } = await import('./workspace.ts');
  const { record, list } = await import('../audit/ledger.ts');

  const victim = createWorkspace('Victim');
  const snooper = createWorkspace('Snooper');

  // The two shapes that leaked it: the id inside `actor`, and inside `detail`.
  // A workspace id IS the session cookie, so publishing one is publishing the
  // account. Attribution is what a row needs; the raw id is never content.
  record({ actor: `human:console:${victim.id}`, action: 'kill_switch.engaged', subjectId: null, outcome: 'ok' });
  record({ actor: 'console', action: 'ingest.completed', subjectId: 'mch_x', outcome: 'ok', detail: { workspaceId: victim.id } });

  const everything = JSON.stringify([...list(200, snooper.id), ...list(200, undefined)]);
  assert.ok(!everything.includes(victim.id), 'no reader of any scope can recover a session id');
  assert.ok(everything.includes('ws:'), 'a short one-way reference is kept, so rows stay attributable');
});

test('ROLES: a workspace only ever gets its own dashboard', async () => {
  const { createWorkspace, setWorkspaceRole, getWorkspace } = await import('./workspace.ts');

  const w = createWorkspace();
  assert.equal(w.role, null, 'a new visitor has no dashboard until they say who they are');

  assert.equal(setWorkspaceRole(w.id, 'nonsense' as never), null, 'an unknown role is refused');
  assert.equal(getWorkspace(w.id)!.role, null, 'and nothing is assigned');

  const merchant = setWorkspaceRole(w.id, 'merchant')!;
  assert.equal(merchant.role, 'merchant');
  assert.equal(getWorkspace(w.id)!.role, 'merchant', 'the role persists on the account, not in the page');
});
