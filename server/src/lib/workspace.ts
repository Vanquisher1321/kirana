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
  /**
   * Reviewer mode. Off by default, so the default experience is the honest one:
   * you are one kind of account and you see one console, like a real user. A
   * reviewer turns it on deliberately to see all three.
   */
  fullAccess: boolean;
  createdAt: string;
  lastSeenAt: string;
}

function row(r: Record<string, unknown>): Workspace {
  const role = (r.role as string | null) ?? null;
  return {
    id: String(r.id), label: String(r.label),
    role: role && (ROLES as string[]).includes(role) ? role as Role : null,
    fullAccess: Number(r.full_access ?? 0) === 1,
    createdAt: String(r.created_at), lastSeenAt: String(r.last_seen_at),
  };
}

export function createWorkspace(label = 'Workspace'): Workspace {
  const id = `ws_${randomBytes(24).toString('base64url')}`;
  const at = nowIso();
  db.prepare('INSERT INTO workspaces (id, label, created_at, last_seen_at) VALUES (?,?,?,?)').run(id, label, at, at);
  return { id, label, role: null, fullAccess: false, createdAt: at, lastSeenAt: at };
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

export function setFullAccess(id: string, enabled: boolean): Workspace | null {
  db.prepare('UPDATE workspaces SET full_access = ? WHERE id = ?').run(enabled ? 1 : 0, id);
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
    if (k === name) {
      // `Cookie: kirana_ws=%` used to throw URIError out of the onRequest hook
      // and 500 every /api route. A cookie is attacker-supplied text; a
      // malformed one means "no session", not "the server is broken".
      try { return decodeURIComponent(rest.join('=')); } catch { return ''; }
    }
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

/**
 * The last delivery address this person used.
 *
 * Two jobs. It saves them typing seven fields for every order, which is the
 * difference between approving a second purchase and abandoning it. And it is
 * what a STANDING approval delivers to: a rule is the human's answer given in
 * advance, and an answer that cannot say where the parcel goes is not a
 * complete one -- so a standing rule only fires for someone who has already
 * given an address, and otherwise the request waits for a person, which is the
 * fallback the whole module is built on.
 *
 * Stored per workspace and never shared. It is read back only for the person
 * who gave it and the merchant who has to ship to it.
 */
export function rememberDelivery(workspaceId: string, deliveryJson: string): void {
  db.prepare('UPDATE workspaces SET last_delivery = ? WHERE id = ?').run(deliveryJson, workspaceId);
}

export function lastDelivery(workspaceId: string | null): string | null {
  if (!workspaceId) return null;
  const r = db.prepare('SELECT last_delivery AS d FROM workspaces WHERE id = ?').get(workspaceId) as { d?: string | null } | undefined;
  return (r?.d as string | null) ?? null;
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

/**
 * The buyer's own MCP address.
 *
 * One connector, every shop this visitor has connected. Without it a shopper
 * with five shops adds five connectors, which is the friction that stops a
 * buyer agent from being useful across more than one merchant.
 *
 * The key is a SEPARATE secret from the workspace id. The id is the session
 * cookie, and a cookie that becomes a URL is a session anyone can take over by
 * pasting a link into a chat window. This one grants exactly one thing —
 * shopping the shops in that workspace — and can be rotated without signing the
 * visitor out of the console.
 *
 * Minted on demand rather than at workspace creation: most visitors never ask
 * for it, and a secret nobody uses is a secret that can still leak.
 */
export function ensureBuyerKey(workspaceId: string): string | null {
  const row = db.prepare('SELECT mcp_key AS k FROM workspaces WHERE id = ?').get(workspaceId) as { k?: string | null } | undefined;
  if (!row) return null;
  if (row.k) return row.k;
  const key = `bkr_${randomBytes(24).toString('base64url')}`;
  db.prepare('UPDATE workspaces SET mcp_key = ? WHERE id = ?').run(key, workspaceId);
  return key;
}

/** Replaces the key, which instantly breaks every connector using the old one. */
export function rotateBuyerKey(workspaceId: string): string | null {
  const exists = db.prepare('SELECT 1 FROM workspaces WHERE id = ?').get(workspaceId);
  if (!exists) return null;
  const key = `bkr_${randomBytes(24).toString('base64url')}`;
  db.prepare('UPDATE workspaces SET mcp_key = ? WHERE id = ?').run(key, workspaceId);
  return key;
}

/** Resolve a buyer key back to its workspace. Knowing the key IS the capability. */
export function workspaceForBuyerKey(key: string): string | null {
  if (!key || !key.startsWith('bkr_')) return null;
  const r = db.prepare('SELECT id FROM workspaces WHERE mcp_key = ?').get(key) as { id?: string } | undefined;
  return r?.id ?? null;
}
