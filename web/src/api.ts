// Shapes taken from the live response, not from memory: the stock flag is
// `available`, and there is no `sku` on the wire. Guessing these would have
// shipped a catalogue that reported every product out of stock.
export interface CatalogVariant {
  id: string; title: string; externalId: string;
  priceMinor: number; priceFormatted: string; compareAtMinor?: number;
  currency: string; available: boolean;
  options?: Record<string, string>; weightGrams?: number;
}
export interface CatalogProduct {
  id: string; title: string; description?: string;
  vendor?: string; productType?: string;
  tags: string[]; url: string; imageUrl?: string;
  variants: CatalogVariant[];
}

export interface Merchant {
  // No workspaceId. The server stopped sending it after the public shop
  // directory published every merchant's session id; a type that still says
  // it might arrive is a standing invitation for that to come back unnoticed.
  id: string; slug: string; publicId: string;
  name: string; originUrl: string; platform: string;
  currency: string; ingestedAt: string; products: number; variants: number;
  adapter: string | null; usedLlm: boolean; warnings: string[]; durationMs: number; mcpUrl: string;
  /** Whether this shop has a Route account of its own to be paid into. */
  payoutConfigured: boolean;
}
export interface QuoteLine { item: string; quantity: number; unitPrice: string; lineTotal: string; }
/**
 * Where the goods go. Given by the person approving, on the same screen and in
 * the same action as the amount -- the agent can neither supply one nor read
 * one back.
 */
export interface Delivery {
  name: string; phone: string; line1: string; line2: string;
  city: string; state: string; pincode: string;
}
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
  failureReason: string | null; agentId: string | null; payUrl: string | null; createdAt: string;
  /** Null unless you sold this order or placed it. Never sent to an agent. */
  delivery: Delivery | null;
  /** Paid is not the same fact as "the shop has the money". */
  settledToMerchant: boolean;
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

/**
 * A refusal that names the box it is about.
 *
 * The server already says which field it rejected; throwing a bare Error threw
 * that away and left the console guessing the field back out of the prose --
 * which got it wrong the moment the message said "mobile" and the field was
 * called "phone". Carry the answer instead of re-deriving it.
 */
export class FieldError extends Error {
  field?: string;
  constructor(message: string, field?: string) {
    super(message);
    this.name = 'FieldError';
    this.field = field;
  }
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
  if (!res.ok) {
    const b = body as { error?: string; message?: string; field?: string };
    throw new FieldError(b.message ?? b.error ?? `Request failed (${res.status})`, b.field);
  }
  return body as T;
}

/** `platform` reads across every workspace; anything else is this visitor's own. */
export type Scope = 'mine' | 'platform';
const q = (scope: Scope) => (scope === 'platform' ? '?scope=platform' : '');

export const api = {
  products: (slug: string, q = '') =>
    req<CatalogProduct[]>(`/api/merchants/${encodeURIComponent(slug)}/products${q ? `?q=${encodeURIComponent(q)}` : ''}`),
  merchants: (scope: Scope | 'directory' = 'mine') =>
    req<Merchant[]>(`/api/merchants${scope === 'directory' ? '?scope=directory' : q(scope as Scope)}`),
  ingest: (url: string) => req<{ merchant: Merchant; productCount: number; variantCount: number; adapter: string; usedLlm: boolean; warnings: string[]; durationMs: number; mcpUrl: string }>(
    '/api/ingest', { method: 'POST', body: JSON.stringify({ url }) }),
  approvals: (scope: Scope = 'mine') => req<Approval[]>(`/api/approvals${q(scope)}`),
  // No `by` field: the server attributes an approval to the session that made
  // it. A name the caller supplies is not evidence of who approved.
  approve: (id: string, delivery: Delivery) =>
    req<Approval>(`/api/approvals/${id}/approve`, { method: 'POST', body: JSON.stringify({ delivery }) }),
  lastDelivery: () => req<{ delivery: Delivery | null }>('/api/session/delivery'),
  setPayout: (merchantId: string, accountId: string) =>
    req<{ merchant: Merchant }>(`/api/merchants/${merchantId}/payout`, {
      method: 'POST', body: JSON.stringify({ accountId }),
    }),
  reject: (id: string) => req<Approval>(`/api/approvals/${id}/reject`, { method: 'POST', body: '{}' }),
  audit: (limit = 60, scope: Scope = 'mine') => req<AuditRow[]>(`/api/audit?limit=${limit}${scope === 'platform' ? '&scope=platform' : ''}`),
  verify: () => req<Verification>('/api/audit/verify'),
  orders: (scope: Scope = 'mine') => req<Order[]>(`/api/orders${q(scope)}`),
  agents: (scope: Scope = 'mine') => req<Agent[]>(`/api/agents${q(scope)}`),
  system: () => req<SystemState>('/api/system'),
  session: () => req<Session>('/api/session'),
  buyerLink: () => req<{ url: string | null; shops: number }>('/api/session/buyer-link'),
  rotateBuyerLink: () => req<{ url: string | null }>('/api/session/buyer-link/rotate', { method: 'POST', body: '{}' }),
  chooseRole: (role: Role) => req<{ role: Role }>('/api/session/role', { method: 'POST', body: JSON.stringify({ role }) }),
  setFullAccess: (enabled: boolean) => req<Session>('/api/session/full-access', { method: 'POST', body: JSON.stringify({ enabled }) }),
  issueKey: (agentId: string, label?: string) =>
    req<{ apiKey: string; agent: Agent; note: string }>(`/api/agents/${agentId}/key`, {
      method: 'POST', body: JSON.stringify({ label }),
    }),
  killSwitch: (engage: boolean, reason?: string) =>
    req<{ engaged: boolean; reason: string }>('/api/system/kill-switch', { method: 'POST', body: JSON.stringify({ engage, reason }) }),
};
