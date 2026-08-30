import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyAddress, assertPublicHost, assertFetchableUrl, BlockedHostError, secretEquals, rateLimit, resetRateLimits } from './security.ts';

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
    () => assertPublicHost('this-domain-should-not-exist-nexus-test.invalid'),
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
