/**
 * robots.txt: the file that almost never changes the answer.
 *
 * On a default Shopify store nothing here refuses anything, so the tests that
 * matter are the ones where it SHOULD refuse and the ones where a sloppy
 * implementation would refuse by accident. A checker that fails closed on a
 * missing file would break ingestion for most of the web; one that parses a
 * storefront's HTML shell as rules would refuse at random.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

const { parseRobots, verdictFor, robotsAllows } = await import('./robots.ts');

const SHOPIFY_DEFAULT = `
User-agent: *
Disallow: /admin
Disallow: /cart
Disallow: /checkout
Disallow: /search
Disallow: /collections/*sort_by*
Sitemap: https://example.com/sitemap.xml
`;

function res(body: string, ok = true, type = 'text/plain') {
  return Promise.resolve(new Response(body, { status: ok ? 200 : 404, headers: { 'content-type': type } }));
}

test('a default Shopify robots.txt does not disallow the product feed', () => {
  const v = verdictFor(parseRobots(SHOPIFY_DEFAULT), '/products.json', 'KiranaBot');
  assert.equal(v.allowed, true);
});

test('but it does still disallow the paths it names', () => {
  const g = parseRobots(SHOPIFY_DEFAULT);
  assert.equal(verdictFor(g, '/checkout', 'KiranaBot').allowed, false);
  assert.equal(verdictFor(g, '/admin/orders', 'KiranaBot').allowed, false);
});

test('a shop that disallows the feed is refused, and the rule is named', () => {
  const v = verdictFor(parseRobots('User-agent: *\nDisallow: /products.json'), '/products.json', 'KiranaBot');
  assert.equal(v.allowed, false);
  assert.match(v.rule ?? '', /products\.json/);
});

test('a blanket disallow covers everything', () => {
  assert.equal(verdictFor(parseRobots('User-agent: *\nDisallow: /'), '/products.json', 'KiranaBot').allowed, false);
});

test('"Disallow:" with no value allows everything, as the standard says', () => {
  assert.equal(verdictFor(parseRobots('User-agent: *\nDisallow:'), '/products.json', 'KiranaBot').allowed, true);
});

test('a rule naming us beats the wildcard group', () => {
  const txt = 'User-agent: *\nDisallow: /\n\nUser-agent: KiranaBot\nAllow: /products.json\nDisallow: /admin';
  const g = parseRobots(txt);
  assert.equal(verdictFor(g, '/products.json', 'KiranaBot').allowed, true, 'our own group is used, not the wildcard');
  assert.equal(verdictFor(g, '/admin', 'KiranaBot').allowed, false);
});

test('the more specific rule wins, and Allow breaks a tie', () => {
  const g = parseRobots('User-agent: *\nDisallow: /products\nAllow: /products.json');
  assert.equal(verdictFor(g, '/products.json', 'KiranaBot').allowed, true);
});

test('wildcards and end-anchors are honoured', () => {
  const g = parseRobots('User-agent: *\nDisallow: /*.json$');
  assert.equal(verdictFor(g, '/products.json', 'KiranaBot').allowed, false);
  assert.equal(verdictFor(g, '/products.json?page=2', 'KiranaBot').allowed, true, 'the anchor means what it says');
});

test('comments and blank lines do not become rules', () => {
  const g = parseRobots('# a comment\n\nUser-agent: *  # trailing\nDisallow: /admin # why\n');
  assert.equal(verdictFor(g, '/products.json', 'KiranaBot').allowed, true);
  assert.equal(verdictFor(g, '/admin', 'KiranaBot').allowed, false);
});

test('a missing robots.txt is no preference stated, not a refusal', async () => {
  const v = await robotsAllows('https://shop.example', '/products.json', () => res('Not found', false));
  assert.equal(v.allowed, true);
});

test('an unreachable robots.txt does not block ingestion', async () => {
  const v = await robotsAllows('https://shop.example', '/products.json', () => Promise.reject(new Error('ETIMEDOUT')));
  assert.equal(v.allowed, true);
});

test("a storefront's HTML shell is not parsed as rules", async () => {
  const v = await robotsAllows(
    'https://shop.example', '/products.json',
    () => res('<html><body>Disallow: /</body></html>', true, 'text/html'),
  );
  assert.equal(v.allowed, true, 'content-type is checked before the body is trusted');
});

test('a real refusal comes back through the fetching path too', async () => {
  const v = await robotsAllows('https://shop.example', '/products.json', () => res('User-agent: *\nDisallow: /'));
  assert.equal(v.allowed, false);
});
