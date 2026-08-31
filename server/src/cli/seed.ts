import { readFileSync } from 'node:fs';
import { ingestStorefront } from '../catalog/ingest.ts';
import type { FetchLike } from '../types.ts';

/**
 * Seeds a controlled demo storefront with no network access at all.
 *
 * This exists so the demo has a floor: if a real store is slow, rate-limits or
 * changes its theme five minutes before recording, there is still a working
 * catalog to buy from. It is the same ingestion path as a real store -- only
 * the transport is swapped -- so it proves the pipeline rather than faking it.
 */

const FIXTURE = readFileSync(new URL('../adapters/__fixtures__/shopify-store.json', import.meta.url), 'utf8');

const fixtureFetch: FetchLike = async (url) => {
  const u = String(url);
  if (u.includes('/meta.json')) {
    return new Response(JSON.stringify({ currency: 'INR' }), { headers: { 'content-type': 'application/json' } });
  }
  if (u.includes('/products.json')) {
    const page = Number(new URL(u).searchParams.get('page') ?? '1');
    return new Response(page > 1 ? '{"products":[]}' : FIXTURE, { headers: { 'content-type': 'application/json' } });
  }
  return new Response('<html><head><title>Blue Hill Coffee | Specialty Roasters</title></head></html>', {
    headers: { 'content-type': 'text/html' },
  });
};

/**
 * A REAL storefront first, the fixture only if the network says no.
 *
 * Render's free tier keeps the database in /tmp and spins the instance down
 * after 15 idle minutes, so a cold visitor always lands on whatever this
 * function produced. For a long time that was the two-product test fixture,
 * complete with its deliberately broken price -- a judge's first impression of
 * a project about real commerce was a fake shop throwing parse warnings.
 *
 * Ingesting a live store takes about two seconds and reads only its public
 * product feed. If it is slow, rate-limited or reachable-but-changed, the
 * fixture is still there: the demo has a floor, it just no longer starts on it.
 */
const DEMO_STORE = process.env.KIRANA_DEMO_STORE || 'bluetokaicoffee.com';

export async function seedDemoStore() {
  try {
    // Default transport: the SSRF guard stays on and the 15s fetch timeout
    // applies. Passing our own fetchImpl would disable the guard, which is
    // exactly the wrong trade for the one call that reads a real website.
    const real = await ingestStorefront(DEMO_STORE);
    if (real.productCount > 0) return real;
  } catch { /* fall through to the offline fixture */ }
  return ingestStorefront('bluehill.example', { fetchImpl: fixtureFetch });
}

/** Only runs when invoked directly, so importing this module is side-effect free. */
const invokedDirectly = process.argv[1]?.endsWith('seed.ts') ?? false;
if (!invokedDirectly) {
  // imported for seedDemoStore() only
} else {
await (async () => {
const report = await seedDemoStore();
console.log('Seeded the demo shop.');
console.log(`  merchant     ${report.merchantId}`);
console.log(`  adapter      ${report.adapter} (llm: ${report.usedLlm})`);
console.log(`  products     ${report.productCount}`);
console.log(`  variants     ${report.variantCount}`);
console.log(`  warnings     ${report.warnings.length}`);
for (const w of report.warnings) console.log(`    - ${w}`);
console.log(`  mcp endpoint /mcp/bluehill-example`);
})();
}
