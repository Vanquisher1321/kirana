export interface Merchant {
  id: string; slug: string; publicId: string; workspaceId: string | null;
  name: string; originUrl: string; platform: string;
  currency: string; ingestedAt: string; products: number; variants: number;
  adapter: string | null; usedLlm: boolean; warnings: string[]; durationMs: number; mcpUrl: string;
}
export interface QuoteLine { item: string; quantity: number; unitPrice: string; lineTotal: string; }
export interface Approval {
  id: string; quoteId: string; agentId: string | null; capMinor: number; capFormatted: string;
  scope: string; status: string; expiresAt: string;
  quote?: { id: string; total: string; totalMinor: number; lines: QuoteLine[] } | null;
}
export interface AuditRow {
  seq: number; ts: string; actor: string; action: string; subjectId: string | null;
  outcome: 'ok' | 'blocked' | 'failed'; detail: Record<string, unknown>; hash: string;
}
export interface Order {
  id: string; status: string; amount: string; amountMinor: number; currency: string;
  razorpayOrderId: string | null; razorpayPaymentId: string | null;
  failureReason: string | null; agentId: string | null; createdAt: string;
}
export interface Agent {
  id: string; label: string; perOrderCap: string; dailyCap: string;
  active: boolean; verified: boolean; createdAt: string;
}
export interface SystemState {
  demo: boolean;
  killSwitch: { engaged: boolean; reason: string };
  gateway: { open: boolean; failures: number; openUntil: string | null };
  razorpay: { configured: boolean; mode: string };
}
export type Role = 'merchant' | 'shopper' | 'platform';
export interface Session {
  workspaceId: string;
  role: Role | null;
  fullAccess: boolean;
  canEnableFullAccess: boolean;
}

export interface Verification { ok: boolean; checked: number; brokenAtSeq?: number; reason?: string; }

/**
 * The console token. Kept in localStorage because this console is a
 * single-operator tool on the operator's own machine -- there is no session
 * server to hold it and no second user to leak it to.
 */
const TOKEN_KEY = 'kirana.console.token';

export function getToken(): string {
  try { return localStorage.getItem(TOKEN_KEY) ?? ''; } catch { return ''; }
}
export function setToken(t: string): void {
  try { localStorage.setItem(TOKEN_KEY, t.trim()); } catch { /* private mode */ }
}
export function clearToken(): void {
  try { localStorage.removeItem(TOKEN_KEY); } catch { /* private mode */ }
}

export class Unauthorized extends Error {
  constructor() { super('A console token is required.'); this.name = 'Unauthorized'; }
}

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    ...init,
    // Same-origin by default, so the workspace cookie rides along and each
    // visitor sees only their own shops, approvals and orders.
    credentials: 'same-origin',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${getToken()}`,
      ...(init?.headers ?? {}),
    },
  });
  if (res.status === 401) throw new Unauthorized();
  const text = await res.text();
  const body = text ? JSON.parse(text) : {};
  if (!res.ok) throw new Error((body as { error?: string; message?: string }).message ?? (body as { error?: string }).error ?? `Request failed (${res.status})`);
  return body as T;
}

/** `platform` reads across every workspace; anything else is this visitor's own. */
export type Scope = 'mine' | 'platform';
const q = (scope: Scope) => (scope === 'platform' ? '?scope=platform' : '');

export const api = {
  merchants: (scope: Scope | 'directory' = 'mine') =>
    req<Merchant[]>(`/api/merchants${scope === 'directory' ? '?scope=directory' : q(scope as Scope)}`),
  ingest: (url: string) => req<{ merchant: Merchant; productCount: number; variantCount: number; adapter: string; usedLlm: boolean; warnings: string[]; durationMs: number; mcpUrl: string }>(
    '/api/ingest', { method: 'POST', body: JSON.stringify({ url }) }),
  approvals: (scope: Scope = 'mine') => req<Approval[]>(`/api/approvals${q(scope)}`),
  approve: (id: string) => req<Approval>(`/api/approvals/${id}/approve`, { method: 'POST', body: JSON.stringify({ by: 'om' }) }),
  reject: (id: string) => req<Approval>(`/api/approvals/${id}/reject`, { method: 'POST', body: JSON.stringify({ by: 'om' }) }),
  audit: (limit = 60, scope: Scope = 'mine') => req<AuditRow[]>(`/api/audit?limit=${limit}${scope === 'platform' ? '&scope=platform' : ''}`),
  verify: () => req<Verification>('/api/audit/verify'),
  orders: (scope: Scope = 'mine') => req<Order[]>(`/api/orders${q(scope)}`),
  agents: (scope: Scope = 'mine') => req<Agent[]>(`/api/agents${q(scope)}`),
  system: () => req<SystemState>('/api/system'),
  session: () => req<Session>('/api/session'),
  chooseRole: (role: Role) => req<{ role: Role }>('/api/session/role', { method: 'POST', body: JSON.stringify({ role }) }),
  setFullAccess: (enabled: boolean) => req<Session>('/api/session/full-access', { method: 'POST', body: JSON.stringify({ enabled }) }),
  issueKey: (agentId: string, label?: string) =>
    req<{ apiKey: string; agent: Agent; note: string }>(`/api/agents/${agentId}/key`, {
      method: 'POST', body: JSON.stringify({ label }),
    }),
  killSwitch: (engage: boolean, reason?: string) =>
    req<{ engaged: boolean; reason: string }>('/api/system/kill-switch', { method: 'POST', body: JSON.stringify({ engage, reason }) }),
};
