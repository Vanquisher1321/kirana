import { db } from '../lib/db.ts';
import { seedDemoStore } from './seed.ts';

/**
 * Wipe everything and reseed, for a clean take.
 *
 * Deletes rows rather than the database file, so this works while the server
 * is running — which is the whole point when you are between takes and do not
 * want to stop and restart the stack on camera. Order follows the foreign keys.
 */

const TABLES = ['audit_log', 'orders', 'consents', 'quotes', 'agents', 'variants', 'products', 'ingest_runs', 'merchants'];

let removed = 0;
db.exec('PRAGMA foreign_keys = OFF;');
for (const t of TABLES) {
  const before = (db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get() as { n: number }).n;
  db.exec(`DELETE FROM ${t};`);
  removed += before;
}
db.exec("DELETE FROM sqlite_sequence WHERE name = 'audit_log';");
db.exec('PRAGMA foreign_keys = ON;');

console.log(`Cleared ${removed} rows across ${TABLES.length} tables.`);

const report = await seedDemoStore();
console.log(`Reseeded the demo shop: ${report.productCount} products, ${report.variantCount} buying options.`);
console.log('');
console.log('Ready for a take. The console will pick it up within 3 seconds — no restart needed.');
