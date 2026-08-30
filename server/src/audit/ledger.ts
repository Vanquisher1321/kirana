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

function computeHash(i: HashInput): string {
  return createHash('sha256')
    .update([i.prevHash, i.ts, i.actor, i.action, i.subjectId ?? '', i.outcome, i.detail].join(' '))
    .digest('hex');
}

const insertStmt = db.prepare(
  `INSERT INTO audit_log (ts, actor, action, subject_id, outcome, detail, prev_hash, hash)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
);
const lastStmt = db.prepare('SELECT hash FROM audit_log ORDER BY seq DESC LIMIT 1');

export function record(entry: AuditEntry): string {
  const prev = lastStmt.get() as { hash?: string } | undefined;
  const prevHash = prev?.hash ?? GENESIS;
  const ts = nowIso();
  const detail = JSON.stringify(entry.detail ?? {});
  const subjectId = entry.subjectId ?? null;
  const hash = computeHash({ ts, actor: entry.actor, action: entry.action, subjectId, outcome: entry.outcome, detail, prevHash });
  insertStmt.run(ts, entry.actor, entry.action, subjectId, entry.outcome, detail, prevHash, hash);
  return hash;
}

function toRow(r: Record<string, unknown>): AuditRow {
  return {
    seq: Number(r.seq), ts: String(r.ts), actor: String(r.actor), action: String(r.action),
    subjectId: (r.subject_id as string | null) ?? null, outcome: r.outcome as AuditRow['outcome'],
    detail: JSON.parse(String(r.detail)), prevHash: String(r.prev_hash), hash: String(r.hash),
  };
}

export function list(limit = 200): AuditRow[] {
  const rows = db.prepare('SELECT * FROM audit_log ORDER BY seq DESC LIMIT ?').all(limit) as Record<string, unknown>[];
  return rows.map(toRow);
}

export function forSubject(subjectId: string): AuditRow[] {
  const rows = db.prepare('SELECT * FROM audit_log WHERE subject_id = ? ORDER BY seq ASC').all(subjectId) as Record<string, unknown>[];
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
