import { useCallback, useEffect, useState } from 'react';
import { api, type Agent, type Approval, type AuditRow, type Merchant, type Order, type SystemState, type Verification } from './api.ts';
import { describe, timeAgo, countdown } from './plain.ts';

type Tab = 'shops' | 'approvals' | 'activity' | 'safety';

export default function App() {
  const [tab, setTab] = useState<Tab>('shops');
  const [merchants, setMerchants] = useState<Merchant[]>([]);
  const [approvals, setApprovals] = useState<Approval[]>([]);
  const [audit, setAudit] = useState<AuditRow[]>([]);
  const [orders, setOrders] = useState<Order[]>([]);
  const [agents, setAgents] = useState<Agent[]>([]);
  const [system, setSystem] = useState<SystemState | null>(null);
  const [seal, setSeal] = useState<Verification | null>(null);
  const [err, setErr] = useState('');

  const refresh = useCallback(async () => {
    try {
      const [m, a, l, o, g, s, v] = await Promise.all([
        api.merchants(), api.approvals(), api.audit(), api.orders(), api.agents(), api.system(), api.verify(),
      ]);
      setMerchants(m); setApprovals(a); setAudit(l); setOrders(o); setAgents(g); setSystem(s); setSeal(v);
      setErr('');
    } catch (e) {
      setErr((e as Error).message);
    }
  }, []);

  useEffect(() => {
    void refresh();
    const t = setInterval(() => void refresh(), 3000);
    return () => clearInterval(t);
  }, [refresh]);

  return (
    <div className="shell">
      <header className="masthead">
        <div className="brand">
          <h1>Kirana<span>.</span></h1>
          <p>Any shop, ready for AI shoppers — and every rupee they spend, watched.</p>
        </div>
        <div className="statusstack">
          <span className="chip">
            <i className={`dot ${system?.razorpay.configured ? 'good' : 'bad'}`} />
            {system?.razorpay.configured ? 'Razorpay connected · test mode' : 'Razorpay not connected'}
          </span>
          <span className="chip">
            <i className={`dot ${system?.gateway.open ? 'warn' : 'good'}`} />
            {system?.gateway.open ? 'Payment network struggling' : 'Payment network healthy'}
          </span>
          <span className="chip">
            <i className={`dot ${system?.killSwitch.engaged ? 'bad' : 'good'}`} />
            {system?.killSwitch.engaged ? 'AI spending PAUSED' : 'AI spending allowed'}
          </span>
        </div>
      </header>

      <nav className="tabs" role="tablist">
        <button className="tab" role="tab" aria-selected={tab === 'shops'} onClick={() => setTab('shops')}>Shops<span className="count">{merchants.length}</span></button>
        <button className="tab" role="tab" aria-selected={tab === 'approvals'} onClick={() => setTab('approvals')}>Waiting for you{approvals.length > 0 && <span className="count">{approvals.length}</span>}</button>
        <button className="tab" role="tab" aria-selected={tab === 'activity'} onClick={() => setTab('activity')}>What happened</button>
        <button className="tab" role="tab" aria-selected={tab === 'safety'} onClick={() => setTab('safety')}>Safety</button>
      </nav>

      {err && <div className="banner err">{err}</div>}

      {tab === 'shops' && <Shops merchants={merchants} onDone={refresh} />}
      {tab === 'approvals' && <Approvals approvals={approvals} onDone={refresh} />}
      {tab === 'activity' && <Activity audit={audit} seal={seal} />}
      {tab === 'safety' && <Safety system={system} agents={agents} orders={orders} onDone={refresh} />}
    </div>
  );
}

/* ------------------------------------------------------------------ shops */

function Shops({ merchants, onDone }: { merchants: Merchant[]; onDone: () => Promise<void> }) {
  const [url, setUrl] = useState('');
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState('');
  const [problem, setProblem] = useState('');

  async function go() {
    setBusy(true); setNote(''); setProblem('');
    try {
      const r = await api.ingest(url);
      setNote(
        `${r.merchant.name} is now open to AI shoppers — ${r.productCount} products, ${r.variantCount} buyable options, in ${r.durationMs}ms. ` +
        (r.usedLlm ? 'Some details were interpreted by an AI model.' : 'Read straight from the shop’s own product feed, so no AI guessed at any price.'),
      );
      setUrl('');
      await onDone();
    } catch (e) {
      setProblem((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <section className="card hi">
        <h2>Make a shop ready for AI shoppers</h2>
        <p className="sub">
          Paste any shop’s website. We read what they sell and hand back one link that AI assistants can shop from.
          The shop owner does nothing and installs nothing.
        </p>
        <div className="row">
          <input
            type="text" placeholder="bluetokaicoffee.com" value={url}
            onChange={(e) => setUrl(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && url && !busy) void go(); }}
          />
          <button className="btn" disabled={!url || busy} onClick={() => void go()}>
            {busy ? <><span className="spin" /> Reading the shop…</> : 'Make it AI-ready'}
          </button>
        </div>
        {note && <div className="banner ok" style={{ marginTop: 16 }}>{note}</div>}
        {problem && <div className="banner err" style={{ marginTop: 16 }}>{problem}</div>}
      </section>

      <section className="card">
        <h2>Shops that are ready</h2>
        <p className="sub">Give an AI assistant the link below and it can browse and buy from that shop.</p>
        {merchants.length === 0 && <div className="empty">No shops yet. Paste one above to see this work.</div>}
        {merchants.map((m) => (
          <div key={m.id}>
            <div className="shop">
              <div>
                <h3>{m.name}</h3>
                <div className="facts">
                  {m.products} products · {m.variants} buyable options · read {timeAgo(m.ingestedAt)} in {m.durationMs}ms
                </div>
                <div className="facts">
                  {m.usedLlm
                    ? 'Some details were interpreted by an AI model.'
                    : `Read from the shop’s own ${m.adapter} product feed — no AI guessed at any price.`}
                </div>
                {m.warnings.length > 0 && (
                  <div className="facts" style={{ marginTop: 6 }}>
                    <strong className="muted">We skipped {m.warnings.length} thing(s) rather than guess:</strong>
                    <ul style={{ margin: '4px 0 0 18px', padding: 0 }}>
                      {m.warnings.map((w, i) => <li key={i} className="faint">{w}</li>)}
                    </ul>
                  </div>
                )}
              </div>
            </div>
            <div className="linkbox">
              <code>{m.mcpUrl}</code>
              <button className="btn ghost small" onClick={() => void navigator.clipboard.writeText(m.mcpUrl)}>Copy</button>
            </div>
          </div>
        ))}
      </section>
    </>
  );
}

/* -------------------------------------------------------------- approvals */

function Approvals({ approvals, onDone }: { approvals: Approval[]; onDone: () => Promise<void> }) {
  const [busy, setBusy] = useState('');

  async function act(id: string, yes: boolean) {
    setBusy(id);
    try { yes ? await api.approve(id) : await api.reject(id); await onDone(); }
    finally { setBusy(''); }
  }

  if (approvals.length === 0) {
    return (
      <section className="card">
        <div className="empty">
          Nothing is waiting for you.<br />
          <span className="faint">When an AI assistant wants to spend money, the request appears here first.</span>
        </div>
      </section>
    );
  }

  return (
    <>
      {approvals.map((a) => (
        <div className="ask" key={a.id}>
          <div className="who">An AI assistant wants to spend your money</div>
          <p className="amount">Up to {a.capFormatted}</p>
          <p className="muted" style={{ margin: 0 }}>
            {a.quote ? <>The basket comes to <strong>{a.quote.total}</strong>.</> : 'Basket details unavailable.'}{' '}
            {countdown(a.expiresAt)}.
          </p>
          {a.quote && (
            <ul>
              {a.quote.lines.map((l, i) => (
                <li key={i}><span>{l.quantity} × {l.item}</span><span className="mono">{l.lineTotal}</span></li>
              ))}
            </ul>
          )}
          <p className="faint" style={{ fontSize: 13, margin: '10px 0 0' }}>
            If you approve, the assistant may spend up to this amount on <em>this basket only</em>. It cannot raise
            the limit, reuse it for anything else, or charge you twice. You can cancel it at any time.
          </p>
          <div className="actions">
            <button className="btn" disabled={busy === a.id} onClick={() => void act(a.id, true)}>Approve {a.capFormatted}</button>
            <button className="btn ghost" disabled={busy === a.id} onClick={() => void act(a.id, false)}>Decline</button>
          </div>
        </div>
      ))}
    </>
  );
}

/* --------------------------------------------------------------- activity */

function Activity({ audit, seal }: { audit: AuditRow[]; seal: Verification | null }) {
  return (
    <>
      <section className="card">
        <h2>The record</h2>
        <p className="sub">
          Every step, in order, written down as it happened. Each entry is sealed against the one before it,
          so if anyone edited or deleted a line afterwards, it would show.
        </p>
        {seal && (
          <div className={`seal ${seal.ok ? 'good' : 'bad'}`}>
            <span className="big">{seal.ok ? '🔒' : '⚠️'}</span>
            <div>
              {seal.ok
                ? <><strong>All {seal.checked} entries check out.</strong> <span className="faint">Nothing has been altered or removed.</span></>
                : <><strong>The record has been tampered with at entry {seal.brokenAtSeq}.</strong> <span className="faint">{seal.reason}</span></>}
            </div>
          </div>
        )}
      </section>

      <section className="card">
        {audit.length === 0 && <div className="empty">Nothing has happened yet.</div>}
        {audit.map((row) => {
          const p = describe(row);
          return (
            <div className="event" key={row.seq}>
              <time>{timeAgo(row.ts)}</time>
              <div>
                <div className="what">
                  {p.title}
                  {row.outcome !== 'ok' && <span className={`tag ${row.outcome}`}>{row.outcome === 'blocked' ? 'stopped' : 'failed'}</span>}
                </div>
                {p.body && <div className="why">{p.body}</div>}
              </div>
            </div>
          );
        })}
      </section>
    </>
  );
}

/* ----------------------------------------------------------------- safety */

function Safety({ system, agents, orders, onDone }: {
  system: SystemState | null; agents: Agent[]; orders: Order[]; onDone: () => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const engaged = system?.killSwitch.engaged ?? false;

  async function toggle() {
    setBusy(true);
    try { await api.killSwitch(!engaged, 'stopped from the console'); await onDone(); }
    finally { setBusy(false); }
  }

  return (
    <>
      <section className="card hi">
        <h2>Stop everything</h2>
        <p className="sub">
          One button that immediately prevents any AI assistant from spending a rupee, whatever it is
          in the middle of. Approvals already given stop working too.
        </p>
        {engaged && <div className="banner err">AI spending is paused right now. Nothing can be charged.</div>}
        <button className={`btn ${engaged ? '' : 'danger'}`} disabled={busy} onClick={() => void toggle()}>
          {engaged ? 'Allow AI spending again' : 'Pause all AI spending'}
        </button>
      </section>

      <section className="card">
        <h2>Limits on each assistant</h2>
        <p className="sub">
          Every assistant starts with a low ceiling it cannot lift by itself. Raising it is your decision, not its.
        </p>
        {agents.length === 0 && <div className="empty">No AI assistant has visited yet.</div>}
        {agents.map((a) => (
          <div className="shop" key={a.id}>
            <div>
              <h3>{a.label}</h3>
              <div className="facts">First seen {timeAgo(a.createdAt)}</div>
            </div>
            <dl className="kv">
              <dt>Per order</dt><dd>{a.perOrderCap}</dd>
              <dt>Per day</dt><dd>{a.dailyCap}</dd>
            </dl>
          </div>
        ))}
      </section>

      <section className="card">
        <h2>Orders</h2>
        <p className="sub">Everything an assistant has tried to buy, and how it ended.</p>
        {orders.length === 0 && <div className="empty">No orders yet.</div>}
        {orders.map((o) => (
          <div className="shop" key={o.id}>
            <div>
              <h3>{o.amount} <span className="faint mono">{o.id}</span></h3>
              <div className="facts">
                {o.status === 'paid' && 'Paid in full.'}
                {o.status === 'awaiting_payment' && 'Approved and waiting for the customer to pay.'}
                {o.status === 'failed' && `Did not go through — ${o.failureReason ?? 'unknown reason'}. Nothing was charged.`}
                {o.status === 'created' && 'Just created.'}
                {' '}{timeAgo(o.createdAt)}
              </div>
              {o.razorpayPaymentId && <div className="facts mono">{o.razorpayPaymentId}</div>}
            </div>
          </div>
        ))}
      </section>
    </>
  );
}
