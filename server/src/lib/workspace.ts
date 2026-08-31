import { randomBytes } from 'node:crypto';
import { db, nowIso } from './db.ts';

/**
 * Workspaces: one tenant per visitor.
 *
 * A visitor gets a workspace silently on first request — no signup, no login,
 * the way any normal site issues a session. Everything they create belongs to
 * it, so two people on the same instance never see each other's shops,
 * approvals or orders.
 *
 * The id is 32 bytes of randomness carried in an HttpOnly cookie. It is a
 * bearer capability, so it is never rendered into a page and never logged.
 * Adding real accounts later means pointing a workspace at a user row; nothing
 * else in the model has to change.
 */

export const COOKIE = 'kirana_ws';
const COOKIE_MAX_AGE = 60 * 60 * 24 * 30;

/**
 * A workspace is one of three kinds of account, and it only ever sees its own
 * dashboard. A merchant does not get a platform console; a shopper does not get
 * a merchant console. The role is chosen once, at first use, the way any
 * product asks what kind of account you are opening.
 */
export type Role = 'merchant' | 'shopper' | 'platform';
export const ROLES: Role[] = ['merchant', 'shopper', 'platform'];

export interface Workspace {
  id: string;
  label: string;
  role: Role | null;
  createdAt: string;
  lastSeenAt: string;
}

function row(r: Record<string, unknown>): Workspace {
  const role = (r.role as string | null) ?? null;
  return {
    id: String(r.id), label: String(r.label),
    role: role && (ROLES as string[]).includes(role) ? role as Role : null,
    createdAt: String(r.created_at), lastSeenAt: String(r.last_seen_at),
  };
}

export function createWorkspace(label = 'Workspace'): Workspace {
  const id = `ws_${randomBytes(24).toString('base64url')}`;
  const at = nowIso();
  db.prepare('INSERT INTO workspaces (id, label, created_at, last_seen_at) VALUES (?,?,?,?)').run(id, label, at, at);
  return { id, label, role: null, createdAt: at, lastSeenAt: at };
}

export function getWorkspace(id: string): Workspace | null {
  if (!id) return null;
  const r = db.prepare('SELECT * FROM workspaces WHERE id = ?').get(id) as Record<string, unknown> | undefined;
  return r ? row(r) : null;
}

export function setWorkspaceRole(id: string, role: Role): Workspace | null {
  if (!(ROLES as string[]).includes(role)) return null;
  db.prepare('UPDATE workspaces SET role = ?, label = ? WHERE id = ?')
    .run(role, role === 'platform' ? 'Razorpay' : role === 'merchant' ? 'Merchant' : 'Shopper', id);
  return getWorkspace(id);
}

export function touchWorkspace(id: string): void {
  db.prepare('UPDATE workspaces SET last_seen_at = ? WHERE id = ?').run(nowIso(), id);
}

/** Parses one cookie value without pulling in a cookie library. */
export function readCookie(header: string | undefined, name: string): string {
  if (!header) return '';
  for (const part of header.split(';')) {
    const [k, ...rest] = part.trim().split('=');
    if (k === name) return decodeURIComponent(rest.join('='));
  }
  return '';
}

export function cookieHeader(id: string, secure: boolean): string {
  // HttpOnly so page scripts cannot read it; SameSite=Lax so it survives a
  // normal navigation but is not sent on cross-site form posts.
  const bits = [`${COOKIE}=${encodeURIComponent(id)}`, 'Path=/', `Max-Age=${COOKIE_MAX_AGE}`, 'HttpOnly', 'SameSite=Lax'];
  if (secure) bits.push('Secure');
  return bits.join('; ');
}

/** Housekeeping for the public sandbox: forget workspaces nobody has used. */
export function pruneIdleWorkspaces(olderThanHours = 48): number {
  const cutoff = new Date(Date.now() - olderThanHours * 3600_000).toISOString();
  const doomed = db.prepare('SELECT id FROM workspaces WHERE last_seen_at < ?').all(cutoff) as Array<{ id: string }>;
  for (const w of doomed) {
    db.prepare('DELETE FROM merchants WHERE workspace_id = ?').run(w.id);
    db.prepare('DELETE FROM workspaces WHERE id = ?').run(w.id);
  }
  return doomed.length;
}
