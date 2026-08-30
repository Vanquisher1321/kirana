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

export async function seedDemoStore() {
  return ingestStorefront('bluehill.example', { fetchImpl: fixtureFetch });
}

/** Only runs when invoked directly, so importing this module is side-effect free. */
const invokedDirectly = process.argv[1]?.endsWith('seed.ts') ?? false;
if (!invokedDirectly) {
  // imported for seedDemoStore() only
} else {
await (async () => {
const report = await seedDemoStore();
console.log(`Seeded ${report.merchant ?? ''}`.trim());
console.log(`  merchant     ${report.merchantId}`);
console.log(`  adapter      ${report.adapter} (llm: ${report.usedLlm})`);
console.log(`  products     ${report.productCount}`);
console.log(`  variants     ${report.variantCount}`);
console.log(`  warnings     ${report.warnings.length}`);
for (const w of report.warnings) console.log(`    - ${w}`);
console.log(`  mcp endpoint /mcp/bluehill-example`);
})();
}
