import { createHash } from 'node:crypto';
import { db, nowIso } from '../lib/db.ts';

/**
 * Append-only, hash-chained audit log.
 *
 * Each row commits to the hash of the row before it, so anyone can re-walk the
 * chain and prove no entry was edited, reordered or removed. The track asks to
 * "show the audit trail" -- a table of rows anybody could UPDATE is a log, not
 * an audit trail. The chain is what turns it into evidence.
 */

export const GENESIS = '0'.repeat(64);

export interface AuditEntry {
  actor: string;
  action: string;
  subjectId?: string | null;
  outcome: 'ok' | 'blocked' | 'failed';
  detail?: Record<string, unknown>;
  /** Null for system events that belong to no tenant. */
  workspaceId?: string | null;
}

export interface AuditRow {
  seq: number;
  ts: string;
  actor: string;
  action: string;
  subjectId: string | null;
  outcome: 'ok' | 'blocked' | 'failed';
  detail: Record<string, unknown>;
  prevHash: string;
  hash: string;
}

interface HashInput {
  ts: string; actor: string; action: string; subjectId: string | null;
  outcome: string; detail: string; prevHash: string;
}

/**
 * Hash over a LENGTH-PREFIXED encoding, not a delimiter-joined string.
 *
 * Joining fields with a space means {actor: "a b", action: "c"} and
 * {actor: "a", action: "b c"} hash identically, so content can be shifted
 * across a field boundary while the chain still verifies. Length-prefixing
 * makes the encoding unambiguous.
 */
function computeHash(i: HashInput): string {
  const parts = [i.prevHash, i.ts, i.actor, i.action, i.subjectId ?? '', i.outcome, i.detail];
  const encoded = parts.map((p) => `${Buffer.byteLength(p, 'utf8')}:${p}`).join('');
  return createHash('sha256').update(encoded, 'utf8').digest('hex');
}

const insertStmt = db.prepare(
  `INSERT INTO audit_log (ts, actor, action, subject_id, outcome, detail, prev_hash, hash, workspace_id)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
);
const lastStmt = db.prepare('SELECT hash FROM audit_log ORDER BY seq DESC LIMIT 1');

export function record(entry: AuditEntry): string {
  const prev = lastStmt.get() as { hash?: string } | undefined;
  const prevHash = prev?.hash ?? GENESIS;
  const ts = nowIso();
  const detail = JSON.stringify(entry.detail ?? {});
  const subjectId = entry.subjectId ?? null;
  const hash = computeHash({ ts, actor: entry.actor, action: entry.action, subjectId, outcome: entry.outcome, detail, prevHash });
  insertStmt.run(ts, entry.actor, entry.action, subjectId, entry.outcome, detail, prevHash, hash, entry.workspaceId ?? null);
  return hash;
}

function toRow(r: Record<string, unknown>): AuditRow {
  return {
    seq: Number(r.seq), ts: String(r.ts), actor: String(r.actor), action: String(r.action),
    subjectId: (r.subject_id as string | null) ?? null, outcome: r.outcome as AuditRow['outcome'],
    detail: JSON.parse(String(r.detail)), prevHash: String(r.prev_hash), hash: String(r.hash),
  };
}

/**
 * Scoped by workspace. The chain itself stays global and append-only — it must,
 * or the hashes would not link — but a tenant only ever READS its own entries
 * plus system events that belong to nobody.
 */
export function list(limit = 200, workspaceId?: string | null): AuditRow[] {
  const rows = workspaceId === undefined
    ? db.prepare('SELECT * FROM audit_log ORDER BY seq DESC LIMIT ?').all(limit)
    : db.prepare('SELECT * FROM audit_log WHERE workspace_id IS ? OR workspace_id IS NULL ORDER BY seq DESC LIMIT ?').all(workspaceId, limit);
  return (rows as Record<string, unknown>[]).map(toRow);
}

export function forSubject(subjectId: string, workspaceId?: string | null): AuditRow[] {
  // `undefined` means every tenant (the platform view). A string -- or an
  // explicit null for the unclaimed rows -- confines the read to one workspace.
  const rows = (workspaceId === undefined
    ? db.prepare('SELECT * FROM audit_log WHERE subject_id = ? ORDER BY seq ASC').all(subjectId)
    : db
        .prepare('SELECT * FROM audit_log WHERE subject_id = ? AND workspace_id IS ? ORDER BY seq ASC')
        .all(subjectId, workspaceId)) as Record<string, unknown>[];
  return rows.map(toRow);
}

export interface VerifyResult {
  ok: boolean;
  checked: number;
  brokenAtSeq?: number;
  reason?: string;
}

/** Re-walks the entire chain. This is the command that gets run on camera. */
export function verify(): VerifyResult {
  const rows = db.prepare('SELECT * FROM audit_log ORDER BY seq ASC').all() as Record<string, unknown>[];
  let prevHash = GENESIS;
  for (const r of rows) {
    if (String(r.prev_hash) !== prevHash) {
      return { ok: false, checked: rows.length, brokenAtSeq: Number(r.seq), reason: 'prev_hash does not match the previous row (a row was removed, reordered or inserted)' };
    }
    const expected = computeHash({
      ts: String(r.ts), actor: String(r.actor), action: String(r.action),
      subjectId: (r.subject_id as string | null) ?? null, outcome: String(r.outcome),
      detail: String(r.detail), prevHash,
    });
    if (expected !== String(r.hash)) {
      return { ok: false, checked: rows.length, brokenAtSeq: Number(r.seq), reason: 'row hash does not match its contents (the row was edited after it was written)' };
    }
    prevHash = expected;
  }
  return { ok: true, checked: rows.length };
}
