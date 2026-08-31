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
  outcome: string; detail: string; prevHash: string; workspaceId: string | null;
}

/**
 * A workspace id is a BEARER TOKEN -- it is the whole content of the session
 * cookie, so anyone who reads one becomes that visitor. It must never reach a
 * field that another tenant can read back.
 *
 * Two call sites used to interpolate it into `actor` and into `detail`, and
 * because unowned rows were shown to everybody, `GET /api/audit` handed out
 * other people's sessions. Rather than fixing those two sites and trusting the
 * next thirty, every value written here is scrubbed: an id becomes a short
 * one-way reference that is stable, readable in the console, and useless as a
 * credential.
 */
const WS_TOKEN = /ws_[A-Za-z0-9_-]{16,}/g;

export function workspaceRef(id: string): string {
  return `ws:${createHash('sha256').update(id).digest('hex').slice(0, 8)}`;
}

const scrub = (text: string): string => text.replace(WS_TOKEN, (m) => workspaceRef(m));

/**
 * Which tenant does this row belong to?
 *
 * Derived from the subject rather than passed in by each of the thirty-odd
 * call sites, because attribution that can be forgotten will be forgotten --
 * and a row that forgets is a row every tenant can read.
 */
function workspaceForSubject(subjectId: string | null): string | null {
  if (!subjectId) return null;
  const q = (sql: string): string | null => {
    const r = db.prepare(sql).get(subjectId) as { ws?: string | null } | undefined;
    return (r?.ws as string | null) ?? null;
  };
  if (subjectId.startsWith('mch_')) return q('SELECT workspace_id AS ws FROM merchants WHERE id = ?');
  if (subjectId.startsWith('qte_')) {
    return q(`SELECT m.workspace_id AS ws FROM quotes q JOIN merchants m ON m.id = q.merchant_id WHERE q.id = ?`);
  }
  if (subjectId.startsWith('csnt_')) {
    return q(`SELECT m.workspace_id AS ws FROM consents c
              JOIN quotes q ON q.id = c.quote_id
              JOIN merchants m ON m.id = q.merchant_id WHERE c.id = ?`);
  }
  if (subjectId.startsWith('ord_')) {
    return q(`SELECT m.workspace_id AS ws FROM orders o JOIN merchants m ON m.id = o.merchant_id WHERE o.id = ?`);
  }
  return null;
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
  // workspace_id is inside the hash: leaving it out would let the tenancy
  // column be rewritten row by row while verify() still reported "ok".
  const parts = [i.prevHash, i.ts, i.actor, i.action, i.subjectId ?? '', i.outcome, i.detail, i.workspaceId ?? ''];
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
  const actor = scrub(entry.actor);
  const detail = scrub(JSON.stringify(entry.detail ?? {}));
  const subjectId = entry.subjectId ?? null;
  // Explicit attribution wins; otherwise derive it from the subject. A row that
  // belongs to nobody is a genuine system event and only the platform view
  // reads those.
  const workspaceId = entry.workspaceId ?? workspaceForSubject(subjectId);
  const hash = computeHash({
    ts, actor, action: entry.action, subjectId, outcome: entry.outcome, detail, prevHash, workspaceId,
  });
  insertStmt.run(ts, actor, entry.action, subjectId, entry.outcome, detail, prevHash, hash, workspaceId);
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
  // `OR workspace_id IS NULL` used to be here, to keep system events visible.
  // It meant every unattributed row -- which was most of them -- was readable
  // by every tenant, so one visitor could read another's orders, quotes and
  // approvals straight out of the feed. Unowned rows are the platform's.
  const rows = workspaceId === undefined
    ? db.prepare('SELECT * FROM audit_log ORDER BY seq DESC LIMIT ?').all(limit)
    : db.prepare('SELECT * FROM audit_log WHERE workspace_id IS ? ORDER BY seq DESC LIMIT ?').all(workspaceId, limit);
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
      detail: String(r.detail), prevHash, workspaceId: (r.workspace_id as string | null) ?? null,
    });
    if (expected !== String(r.hash)) {
      return { ok: false, checked: rows.length, brokenAtSeq: Number(r.seq), reason: 'row hash does not match its contents (the row was edited after it was written)' };
    }
    prevHash = expected;
  }
  return { ok: true, checked: rows.length };
}
