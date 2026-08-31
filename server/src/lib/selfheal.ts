import { db } from './db.ts';
import { config } from './config.ts';
import { record } from '../audit/ledger.ts';
import { listMerchants } from '../catalog/store.ts';
import { releaseKillSwitch, KILL_SWITCH } from '../checkout/guard.ts';

/**
 * Keeping a public sandbox usable without gating anyone.
 *
 * The risk on a demo running test credentials is not theft — no real money can
 * move — it is that one visitor leaves it broken or full of junk for the next.
 * Locking it down would defeat the purpose, so instead the instance repairs
 * itself: it resets on a timer, bounds how many shops can accumulate, and
 * releases a paused kill switch by itself.
 *
 * Nothing here restricts what any individual visitor may do.
 */

const TABLES = ['audit_log', 'orders', 'consents', 'quotes', 'agents', 'variants', 'products', 'ingest_runs', 'merchants'];

export function wipe(): number {
  let removed = 0;
  db.exec('PRAGMA foreign_keys = OFF;');
  for (const t of TABLES) {
    removed += (db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get() as { n: number }).n;
    db.exec(`DELETE FROM ${t};`);
  }
  db.exec("DELETE FROM sqlite_sequence WHERE name = 'audit_log';");
  db.exec('PRAGMA foreign_keys = ON;');
  return removed;
}

/**
 * Keeps the newest N shops. Someone ingesting for fun cannot bury the shop the
 * demo is actually about, and storage stays bounded on a host with no disk.
 */
export function evictOldestMerchants(keep: number): number {
  const doomed = db.prepare(
    `SELECT id, name FROM merchants ORDER BY ingested_at DESC LIMIT -1 OFFSET ?`,
  ).all(keep) as Array<{ id: string; name: string }>;
  for (const m of doomed) {
    db.prepare('DELETE FROM merchants WHERE id = ?').run(m.id);
    record({
      actor: 'system:sandbox', action: 'sandbox.merchant_evicted', subjectId: m.id, outcome: 'ok',
      detail: { name: m.name, keep, note: 'Public sandbox keeps only the most recent shops.' },
    });
  }
  return doomed.length;
}

let timer: NodeJS.Timeout | null = null;

/** Only ever started in demo mode. A real deployment never wipes itself. */
export function startSelfHealing(reseed: () => Promise<unknown>): void {
  if (!config.isDemo || timer) return;

  const everyMs = Math.max(5, config.demoResetMinutes) * 60_000;
  timer = setInterval(() => {
    void (async () => {
      try {
        if (KILL_SWITCH.engaged) releaseKillSwitch();
        const removed = wipe();
        await reseed();
        record({
          actor: 'system:sandbox', action: 'sandbox.reset', subjectId: null, outcome: 'ok',
          detail: { rowsCleared: removed, everyMinutes: config.demoResetMinutes },
        });
      } catch { /* a failed reset must never take the instance down */ }
    })();
  }, everyMs);
  timer.unref();
}

export function stopSelfHealing(): void {
  if (timer) { clearInterval(timer); timer = null; }
}

/** Called after each ingestion so the cap applies as shops arrive. */
export function enforceMerchantCap(): void {
  if (!config.isDemo) return;
  evictOldestMerchants(Math.max(2, config.demoMaxMerchants));
}
