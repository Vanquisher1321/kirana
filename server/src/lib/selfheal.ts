import { db } from './db.ts';
import { config } from './config.ts';
import { record } from '../audit/ledger.ts';
import { pruneIdleWorkspaces } from './workspace.ts';
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
 * Keeps the newest N shops BELONGING TO ONE VISITOR.
 *
 * This used to be global: `ORDER BY ingested_at DESC LIMIT -1 OFFSET keep`
 * across the whole table, run after every ingestion. So a visitor who ingested
 * twelve shops deleted everyone else's -- and `ON DELETE CASCADE` took their
 * products, quotes, approvals and orders with them. Twelve requests, about two
 * minutes under the rate limit, and a judge's catalogue vanishes mid-demo. The
 * seeded shop is the OLDEST row, so it died first: the comment here used to
 * claim the opposite of what the code did.
 *
 * Scoped by workspace, the cap does what it was meant to do -- bound one
 * visitor's own footprint -- and one visitor's enthusiasm cannot reach another
 * visitor's data.
 */
export function evictOldestMerchants(keep: number, workspaceId: string | null): number {
  // `workspace_id IS ?` matches NULL correctly, but the seeded shops are the
  // instance's own and are never evicted by a visitor's cap.
  if (workspaceId === null) return 0;
  const doomed = db.prepare(
    `SELECT id, name FROM merchants WHERE workspace_id IS ? ORDER BY ingested_at DESC LIMIT -1 OFFSET ?`,
  ).all(workspaceId, keep) as Array<{ id: string; name: string }>;
  for (const m of doomed) {
    db.prepare('DELETE FROM merchants WHERE id = ?').run(m.id);
    record({
      actor: 'system:sandbox', action: 'sandbox.merchant_evicted', subjectId: m.id, outcome: 'ok',
      workspaceId,
      detail: { name: m.name, keep, note: 'The sandbox keeps only your most recent shops.' },
    });
  }
  return doomed.length;
}

/**
 * A storage backstop, separate from the per-visitor cap.
 *
 * Many visitors each staying under their own cap can still fill a free-tier
 * disk, so the oldest OWNED shops go once the instance as a whole is over its
 * ceiling. Unowned rows -- the seeded demo shops -- are never touched, because
 * they are the thing the public link exists to show.
 */
export function enforceGlobalMerchantCap(): number {
  if (!config.isDemo) return 0;
  const ceiling = Math.max(20, config.demoMaxMerchants * 10);
  const doomed = db.prepare(
    `SELECT id, name, workspace_id AS ws FROM merchants
     WHERE workspace_id IS NOT NULL ORDER BY ingested_at DESC LIMIT -1 OFFSET ?`,
  ).all(ceiling) as Array<{ id: string; name: string; ws: string }>;
  for (const m of doomed) {
    db.prepare('DELETE FROM merchants WHERE id = ?').run(m.id);
    record({
      actor: 'system:sandbox', action: 'sandbox.merchant_evicted', subjectId: m.id, outcome: 'ok',
      workspaceId: m.ws, detail: { name: m.name, ceiling, note: 'Instance storage ceiling reached.' },
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
        // Workspaces are the one table wipe() leaves alone -- clearing them
        // would sign every live visitor out mid-session. They still have to be
        // reclaimed, or a row per visitor accumulates until the disk is full,
        // so idle ones are pruned here. pruneIdleWorkspaces existed and was
        // never called from anywhere.
        const staleWorkspaces = pruneIdleWorkspaces();
        const removed = wipe();
        await reseed();
        record({
          actor: 'system:sandbox', action: 'sandbox.reset', subjectId: null, outcome: 'ok',
          detail: { rowsCleared: removed, staleWorkspaces, everyMinutes: config.demoResetMinutes },
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
export function enforceMerchantCap(workspaceId: string | null): void {
  if (!config.isDemo) return;
  evictOldestMerchants(Math.max(2, config.demoMaxMerchants), workspaceId);
  enforceGlobalMerchantCap();
}
