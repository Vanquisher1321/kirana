import type { ReactNode } from 'react';

/** Small shared pieces. Every persona is built from these, so the three
 *  dashboards stay one system rather than three lookalikes that drift. */

export type Tone = 'ok' | 'bad' | 'warn' | 'flat';

export function Pill({ tone = 'flat', children }: { tone?: Tone; children: ReactNode }) {
  return <span className={`pill ${tone}`}><i className="d" />{children}</span>;
}

export function Kpi({ label, value, delta, sub }: { label: string; value: ReactNode; delta?: string; sub?: string }) {
  return (
    <div className="kpi">
      <div className="l">{label}</div>
      <div className="v num">{value}{delta && <span className="delta">{delta}</span>}</div>
      {sub && <div className="s">{sub}</div>}
    </div>
  );
}

export function Card({ title, sub, right, children }: { title?: string; sub?: string; right?: ReactNode; children: ReactNode }) {
  return (
    <div className="card">
      {(title || right) && (
        <div className="row" style={{ justifyContent: 'space-between', marginBottom: sub ? 4 : 16 }}>
          {title && <div className="h2">{title}</div>}
          {right}
        </div>
      )}
      {sub && <div className="sub" style={{ marginBottom: 16, marginTop: 0 }}>{sub}</div>}
      {children}
    </div>
  );
}

export function PageHead({ title, sub, right, big }: { title: string; sub?: string; right?: ReactNode; big?: boolean }) {
  return (
    <div className="row" style={{ justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 20 }}>
      <div>
        <div className={big ? 'h1 big' : 'h1'}>{title}</div>
        {sub && <div className="sub">{sub}</div>}
      </div>
      {right}
    </div>
  );
}

export function Bar({ pct, color }: { pct: number; color?: string }) {
  return <div className="bar"><i style={{ width: `${Math.max(0, Math.min(100, pct))}%`, background: color }} /></div>;
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="empty">{children}</div>;
}

/**
 * Loading and empty are different states.
 *
 * Rendering "No orders yet" before the first fetch returns tells someone their
 * data is missing when we simply have not looked. Skeleton rows hold the shape
 * instead, so nothing claims to be empty until it is known to be.
 */
export function Skeleton({ rows = 3 }: { rows?: number }) {
  return (
    <div aria-hidden style={{ display: 'grid', gap: 10 }}>
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="skel" style={{ width: `${100 - i * 12}%` }} />
      ))}
    </div>
  );
}

/** Renders a skeleton until loaded, an empty state when there is nothing. */
export function Load<T>({ loaded, items, empty, children, rows }: {
  loaded: boolean; items: T[]; empty: ReactNode; rows?: number; children: (items: T[]) => ReactNode;
}) {
  if (!loaded) return <Skeleton rows={rows} />;
  if (items.length === 0) return <Empty>{empty}</Empty>;
  return <>{children(items)}</>;
}

/** Status word -> tone, in one place so the three dashboards agree. */
export function statusTone(status: string): Tone {
  if (status === 'paid' || status === 'granted' || status === 'ok') return 'ok';
  if (status === 'failed' || status === 'revoked' || status === 'rejected') return 'bad';
  if (status === 'awaiting_payment' || status === 'pending' || status === 'blocked') return 'warn';
  return 'flat';
}

export function statusWord(status: string): string {
  switch (status) {
    case 'awaiting_payment': return 'Awaiting payment';
    case 'paid': return 'Paid';
    case 'failed': return 'Failed';
    case 'created': return 'Created';
    case 'pending': return 'Awaiting approval';
    case 'granted': return 'Approved';
    case 'consumed': return 'Used';
    case 'revoked': return 'Cancelled';
    case 'rejected': return 'Declined';
    default: return status;
  }
}
