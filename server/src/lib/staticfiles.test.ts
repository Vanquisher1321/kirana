import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadBundle, lookup, type StaticBundle } from './staticfiles.ts';

let root = '';
let secretDir = '';
let bundle: StaticBundle;

before(() => {
  const base = mkdtempSync(join(tmpdir(), 'nexus-static-'));
  root = join(base, 'dist');
  secretDir = join(base, 'secrets');
  mkdirSync(join(root, 'assets'), { recursive: true });
  mkdirSync(secretDir, { recursive: true });

  writeFileSync(join(root, 'index.html'), '<!doctype html><title>console</title>');
  writeFileSync(join(root, 'assets', 'app-abc123.js'), 'console.log(1)');
  writeFileSync(join(root, 'assets', 'app-abc123.css'), 'body{}');
  // The file an attacker would want. It lives OUTSIDE the bundle.
  writeFileSync(join(secretDir, '.env'), 'RAZORPAY_KEY_SECRET=supersecret');

  try { symlinkSync(secretDir, join(root, 'linked-secrets'), 'dir'); } catch { /* not permitted on some systems */ }

  bundle = loadBundle(root);
});

after(() => { try { rmSync(join(root, '..'), { recursive: true, force: true }); } catch { /* best effort */ } });

test('the bundle loads exactly the built files', () => {
  assert.ok(bundle.index, 'index.html found');
  assert.equal(bundle.assets.has('/index.html'), true);
  assert.equal(bundle.assets.has('/assets/app-abc123.js'), true);
  assert.equal(bundle.assets.get('/assets/app-abc123.js')!.contentType, 'text/javascript; charset=utf-8');
});

test('hashed assets are marked immutable, the shell is not', () => {
  assert.equal(bundle.assets.get('/assets/app-abc123.css')!.immutable, true);
  assert.equal(bundle.assets.get('/index.html')!.immutable, false);
});

test('symlinks out of the bundle are not followed', () => {
  for (const key of bundle.assets.keys()) {
    assert.ok(!key.startsWith('/linked-secrets'), `symlinked path leaked into the bundle: ${key}`);
  }
});

test('PATH TRAVERSAL: every classic escape returns the app shell, never a file outside', () => {
  const attacks = [
    '/../secrets/.env',
    '/../../secrets/.env',
    '/assets/../../secrets/.env',
    '/%2e%2e/secrets/.env',
    '/%2e%2e%2fsecrets%2f.env',
    '/..%2fsecrets%2f.env',
    '/....//secrets/.env',
    '/assets/..%5c..%5csecrets%5c.env',
    '/linked-secrets/.env',
    '/index.html/../../secrets/.env',
    '//secrets/.env',
    '/./././../secrets/.env',
  ];
  for (const path of attacks) {
    const asset = lookup(bundle, path) ?? bundle.index!;
    const body = asset.body.toString('utf8');
    assert.ok(!body.includes('supersecret'), `traversal succeeded for ${path}`);
    assert.equal(asset, bundle.index, `${path} should fall through to the app shell`);
  }
});

test('query strings and fragments do not change which file is served', () => {
  assert.equal(lookup(bundle, '/assets/app-abc123.js?v=2'), bundle.assets.get('/assets/app-abc123.js'));
  assert.equal(lookup(bundle, '/')!, bundle.index);
});

test('an unbuilt console yields an empty bundle rather than throwing', () => {
  const empty = loadBundle(join(root, 'does-not-exist'));
  assert.equal(empty.index, null);
  assert.equal(empty.count, 0);
});
