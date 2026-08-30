import { normaliseOrigin, makeFetch } from '../lib/http.ts';
import { shopifyAdapter } from '../adapters/shopify.ts';
import type { StorefrontAdapter } from '../types.ts';

// Imported directly rather than via the ingest orchestrator: probing only reads
// the web, so it must not pull in (or lock) the database.
const LADDER: StorefrontAdapter[] = [shopifyAdapter];

/**
 * Which real shops can we make AI-shoppable right now?
 *
 * Answers it empirically instead of by reputation: probes each candidate with
 * the same adapters ingestion uses, reports what is reachable, and says nothing
 * about the ones that are not. Run it before a demo so the storefront you point
 * at on camera is one you have actually verified today.
 *
 *   npm run probe                  # the built-in candidate list
 *   npm run probe -- a.com b.com   # your own candidates
 */

const CANDIDATES = [
  // Indian D2C brands commonly reported to run on Shopify. Reputation is a
  // hypothesis; this script is the test.
  'bluetokaicoffee.com',
  'thewholetruthfoods.com',
  'sleepyowl.co',
  'bummer.in',
  'suta.in',
  'vahdam.com',
  'twobrothersindia.com',
  'bombayshavingcompany.com',
  'headsupfortails.com',
  'nurserylive.com',
  'beardo.in',
  'chumbak.com',
  'boat-lifestyle.com',
  'thesouledstore.com',
  'nicobar.com',
  'vedix.com',
  'store.royalenfield.com',
  'mcaffeine.com',
  'plumgoodness.com',
  'thegoodbug.com',
];

const targets = process.argv.slice(2).length ? process.argv.slice(2) : CANDIDATES;
const fetchImpl = makeFetch(9000);

interface Row { origin: string; adapter: string | null; products: number | null; note: string; ms: number; }

async function probe(raw: string): Promise<Row> {
  const t0 = performance.now();
  let origin: string;
  try {
    origin = normaliseOrigin(raw);
  } catch {
    return { origin: raw, adapter: null, products: null, note: 'not a valid address', ms: 0 };
  }

  for (const adapter of LADDER) {
    try {
      if (!(await adapter.detect(origin, fetchImpl))) continue;
      // Detected. Pull a single page to confirm the catalog is really readable
      // rather than merely present -- a password-protected store answers the
      // probe but yields nothing.
      const result = await adapter.ingest(origin, fetchImpl, { maxProducts: 5 });
      const ms = Math.round(performance.now() - t0);
      return {
        origin, adapter: adapter.platform, products: result.products.length,
        note: result.products.length === 0 ? 'reachable but empty (password-protected?)' : 'READY',
        ms,
      };
    } catch (err) {
      return { origin, adapter: adapter.platform, products: null, note: `error: ${(err as Error).message.slice(0, 60)}`, ms: Math.round(performance.now() - t0) };
    }
  }
  return { origin, adapter: null, products: null, note: 'no adapter matched (not Shopify, or blocked)', ms: Math.round(performance.now() - t0) };
}

console.log(`Probing ${targets.length} storefronts…\n`);

const rows: Row[] = [];
// Small concurrency: polite to the shops, still finishes in seconds.
const queue = [...targets];
async function worker() {
  for (;;) {
    const next = queue.shift();
    if (!next) return;
    const row = await probe(next);
    rows.push(row);
    const mark = row.note === 'READY' ? '  READY' : row.note.startsWith('reachable') ? '  empty' : '      -';
    console.log(`${mark}  ${row.origin.replace('https://', '').padEnd(34)} ${(row.adapter ?? '').padEnd(12)} ${row.note === 'READY' ? `${row.products}+ products` : row.note}  ${row.ms}ms`);
  }
}
await Promise.all([worker(), worker(), worker(), worker()]);

const ready = rows.filter((r) => r.note === 'READY');
console.log(`\n${ready.length} of ${rows.length} storefronts can be made AI-shoppable right now.`);
if (ready.length) {
  console.log('\nIngest one with:');
  console.log(`  curl -X POST http://localhost:3000/api/ingest -H "content-type: application/json" -d "{\\"url\\":\\"${ready[0]!.origin}\\"}"`);
  console.log('…or just paste it into the console at http://localhost:3000');
}
