import type { ReactNode } from 'react';

/** Small shared pieces. Every persona is built from these, so the three
 *  dashboards stay one system rather than three lookalikes that drift. */

export type Tone = 'ok' | 'bad' | 'warn' | 'flat';

/**
 * The mark.
 *
 * This used to be a gradient rounded square with a letter K in it — the
 * default logo of every dashboard, and white-on-indigo at 4.3:1, under the
 * contrast floor. It is a drawn shop now: a roof, a front, a door. It
 * inherits currentColor, so it cannot fall below the contrast of the text
 * beside it, and it says what the product is instead of spelling its initial.
 */
export function Mark({ size = 21 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 20 20" fill="none" aria-hidden="true" focusable="false">
      <path
        d="M2.75 8.6h14.5V15a1.6 1.6 0 0 1-1.6 1.6H4.35A1.6 1.6 0 0 1 2.75 15V8.6Z"
        stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round"
      />
      <path
        d="M2.75 8.6 4.2 3.4h11.6l1.45 5.2"
        stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round"
      />
      <path
        d="M7.9 16.6v-4.35h4.2v4.35"
        stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round"
      />
    </svg>
  );
}

/** A drawn check, not the ✓ glyph — a text character standing in for an icon
 *  never matches the stroke weight of anything around it. */
export function Check({ size = 13 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" aria-hidden="true" focusable="false">
      <path d="M3.5 8.4 6.4 11.3 12.5 4.9" stroke="currentColor" strokeWidth="2.1" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

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
        <div className="row" style={{ justifyContent: 'space-between', gap: 16, marginBottom: sub ? 6 : 18 }}>
          {title && <div className="h2">{title}</div>}
          {right}
        </div>
      )}
      {sub && <div className="sub" style={{ marginBottom: 20, marginTop: 0 }}>{sub}</div>}
      {children}
    </div>
  );
}

export function PageHead({ title, sub, right, big }: { title: string; sub?: string; right?: ReactNode; big?: boolean }) {
  return (
    <div className="row" style={{ justifyContent: 'space-between', alignItems: 'flex-start', gap: 20, marginBottom: 26 }}>
      <div style={{ minWidth: 0 }}>
        <h1 className={big ? 'h1 big' : 'h1'} style={{ margin: 0 }}>{title}</h1>
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
    <div aria-hidden style={{ display: 'grid', gap: 11 }}>
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
