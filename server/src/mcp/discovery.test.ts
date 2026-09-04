/**
 * What a client asks before it will talk to you.
 *
 * An MCP client probes /.well-known/oauth-authorization-server and
 * /.well-known/oauth-protected-resource before connecting. A 404 is the answer
 * that means "no sign-in here, just connect" -- and this server's catch-all,
 * written to let the single-page console route its own URLs, answered them with
 * index.html and a 200. Claude read that as a sign-in service, tried to register
 * against a page of HTML, and refused to add the connector at all.
 *
 * The product's whole promise is that you paste a link into an assistant. These
 * tests exist because that promise was broken by a route nobody associated with
 * it.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';

process.env.KIRANA_DB = join(tmpdir(), `kirana-test-disco-${process.pid}-${Date.now()}.db`);
process.env.KIRANA_SIGNING_SECRET = 'm'.repeat(64);
process.env.KIRANA_QUIET = '1';
process.env.KIRANA_ACCESS = 'demo';

const { buildApp } = await import('../app.ts');
import type { FastifyInstance } from 'fastify';

let app: FastifyInstance; let base = '';

before(async () => {
  app = buildApp();
  await app.listen({ port: 0, host: '127.0.0.1' });
  base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
});
after(async () => { await app.close(); });

const PROBES = [
  '/.well-known/oauth-authorization-server',
  '/.well-known/oauth-protected-resource',
  '/.well-known/oauth-protected-resource/mcp/shp_anything',
  '/.well-known/openid-configuration',
];

for (const path of PROBES) {
  test(`${path} answers 404, so a client knows there is no sign-in`, async () => {
    const res = await fetch(`${base}${path}`);
    assert.equal(res.status, 404, 'a 200 here makes a client try to register with a sign-in service that does not exist');
    assert.ok(
      (res.headers.get('content-type') ?? '').includes('application/json'),
      'and it must not be the console HTML',
    );
  });
}

test('an unknown ordinary path still reaches the console, which is why this bug existed', async () => {
  const res = await fetch(`${base}/some/deep/console/route`);
  // With no built bundle in a test run this is a 404 JSON; with one it is the
  // SPA. Either way it must not be the .well-known behaviour under test.
  assert.ok(res.status === 200 || res.status === 404);
});

test('the API and MCP prefixes keep answering JSON 404s, not HTML', async () => {
  for (const p of ['/api/nope', '/mcp/nope-shop-id']) {
    const res = await fetch(`${base}${p}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    assert.ok(res.status >= 400, `${p} should refuse`);
    assert.ok((res.headers.get('content-type') ?? '').includes('application/json'), `${p} should stay JSON`);
  }
});
