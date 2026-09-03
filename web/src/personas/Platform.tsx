import { useState } from 'react';
import { api } from '../api.ts';
import { Card, Empty, Kpi, Load, PageHead, Pill, Skeleton, statusTone, statusWord } from '../ui.tsx';
import { GATE_PLAIN, timeAgo } from '../plain.ts';
import type { PersonaProps } from '../App.tsx';

/**
 * Razorpay's view. Deliberately the odd one out: a platform view of agentic
 * commerce is mostly a view of REFUSALS. The interesting number is not what was
 * paid, it is what was stopped and why.
 */
export default function PlatformView({ data, page, refresh, onBlocked }: PersonaProps) {
  if (page === 'merchants') return <Merchants data={data} refresh={refresh} onBlocked={onBlocked} />;
  if (page === 'transactions') return <Transactions data={data} />;
  if (page === 'assistants') return <Assistants data={data} />;
  if (page === 'risk') return <Risk data={data} refresh={refresh} onBlocked={onBlocked} />;
  return <Overview data={data} />;
}

function blockedReasons(audit: PersonaProps['data']['audit']) {
  const counts = new Map<string, number>();
  for (const row of audit) {
    if (row.action !== 'checkout.blocked') continue;
    const gate = String(row.detail.blockedBy ?? 'unknown');
    counts.set(gate, (counts.get(gate) ?? 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1]);
}

function Overview({ data }: Pick<PersonaProps, 'data'>) {
  const paid = data.orders.filter((o) => o.status === 'paid');
  const revenue = paid.reduce((s, o) => s + o.amountMinor, 0);
  const reasons = blockedReasons(data.audit);
  const stoppedCount = reasons.reduce((s, [, n]) => s + n, 0);
  const dupes = data.audit.filter((r) => r.action === 'checkout.deduplicated' || r.action === 'webhook.duplicate').length;
  const max = Math.max(1, ...reasons.map(([, n]) => n));

  return (
    <>
      <PageHead title="Overview" sub="Agentic commerce across every merchant." right={<Pill tone="ok">Network healthy</Pill>} />

      <div className="kpis" style={{ marginBottom: 16 }}>
        <Kpi label="Merchants made agent-ready" value={data.merchants.length} sub="none needed an integration" />
        <Kpi label="Paid by AI shoppers" value={`₹${(revenue / 100).toLocaleString('en-IN')}`} sub={`${paid.length} orders`} />
        <Kpi label="Stopped before charging" value={stoppedCount} sub="a guard refused them" />
        <Kpi label="Charged twice" value={0} sub={`${dupes} duplicate attempts caught`} />
      </div>

      <Card title="Why payments were stopped" sub="Each of these is a charge that did not happen. The reason matters more than the count.">
        {!data.loaded ? <Skeleton rows={4} /> : reasons.length === 0 ? <Empty>No payment has been refused yet.</Empty> : (
          <div style={{ display: 'grid', gap: 15 }}>
            {reasons.map(([gate, n]) => (
              <div key={gate}>
                <div className="row" style={{ justifyContent: 'space-between' }}>
                  <span>{GATE_PLAIN[gate] ? GATE_PLAIN[gate]![0]!.toUpperCase() + GATE_PLAIN[gate]!.slice(1) : gate}</span>
                  <span className="mono dim">{n}</span>
                </div>
                <div className="bar" style={{ marginTop: 6 }}>
                  <i style={{ width: `${(n / max) * 100}%`, background: gate === 'within_per_order_cap' ? 'var(--warn)' : 'var(--accent)' }} />
                </div>
              </div>
            ))}
          </div>
        )}
      </Card>

      <Card title="How catalogues were read" sub="Straight from the shop's own feed, or interpreted by a model when there wasn't one.">
        <div className="kpis">
          <Kpi label="From a real feed" value={data.merchants.filter((m) => !m.usedLlm).length} sub="prices are exact" />
          <Kpi label="Read by a model" value={data.merchants.filter((m) => m.usedLlm).length} sub="flagged to buying agents" />
        </div>
        <div className="banner ok" style={{ marginTop: 16 }}>
          Buying agents are told which catalogues a model interpreted, so they can treat those prices with suspicion.
        </div>
      </Card>
    </>
  );
}

function Merchants({ data, refresh, onBlocked }: Pick<PersonaProps, 'data' | 'refresh' | 'onBlocked'>) {
  const [url, setUrl] = useState('');
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState('');
  const [problem, setProblem] = useState('');

  // Onboarding merchants at scale is the platform's job, not something a shop
  // owner does from inside their own dashboard.
  async function onboard() {
    setBusy(true); setNote(''); setProblem('');
    try {
      const r = await api.ingest(url);
      setNote(`${r.merchant.name} is now reachable by AI buyers — ${r.productCount} products, ${r.variantCount} buying options, read in ${r.durationMs}ms. ${r.usedLlm ? 'Some details were interpreted by a model.' : 'Read from the shop’s own feed; no model guessed at a price.'}`);
      setUrl('');
      await refresh();
    } catch (e) {
      if ((e as Error).name === 'Unauthorized') onBlocked();
      else setProblem((e as Error).message);
    } finally { setBusy(false); }
  }

  return (
    <>
      <PageHead title="Merchants" sub="Shops reachable by AI buyers. None of them wrote a line of code." />

      <Card title="Onboard a merchant" sub="Paste a storefront. No integration, no plugin, no cooperation needed from the merchant.">
        <div className="row">
          <input className="field" type="text" placeholder="bluetokaicoffee.com" value={url}
            onChange={(e) => setUrl(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && url && !busy) void onboard(); }} />
          <button className="btn" disabled={!url || busy} onClick={() => void onboard()}>
            {busy ? <><span className="spin" /> Reading…</> : 'Make it AI-ready'}
          </button>
        </div>
        {note && <div className="banner ok" style={{ marginTop: 16 }}>{note}</div>}
        {problem && <div className="banner bad" style={{ marginTop: 16 }}>{problem}</div>}
      </Card>

      <div className="sechead">Onboarded</div>
      <Card>
        <Load loaded={data.loaded} items={data.merchants} rows={3} empty="No merchants onboarded yet.">{(rows) => (
          <table>
            <thead><tr><th>Merchant</th><th>Products</th><th>Options</th><th>Source</th><th>Read in</th><th>Last read</th></tr></thead>
            <tbody>
              {rows.map((m) => (
                <tr key={m.id}>
                  <td style={{ fontWeight: 600 }}>{m.name}<div className="tiny mono">{m.slug}</div></td>
                  <td className="num">{m.products}</td>
                  <td className="num">{m.variants}</td>
                  <td>{m.usedLlm ? <Pill tone="warn">Model-read</Pill> : <Pill tone="ok">{m.adapter ?? 'feed'}</Pill>}</td>
                  <td className="num dim">{m.durationMs}ms</td>
                  <td className="dim">{timeAgo(m.ingestedAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}</Load>
      </Card>
    </>
  );
}

function Transactions({ data }: Pick<PersonaProps, 'data'>) {
  return (
    <>
      <PageHead title="Transactions" sub="Every AI order across the platform." />
      <Card>
        <Load loaded={data.loaded} items={data.orders} rows={3} empty="No transactions yet.">{(rows) => (
          <table>
            <thead><tr><th>Order</th><th>Assistant</th><th>Amount</th><th>Status</th><th>When</th></tr></thead>
            <tbody>
              {rows.map((o) => (
                <tr key={o.id}>
                  <td className="mono" style={{ fontSize: 12 }}>{o.id}</td>
                  <td className="dim">{o.agentId ?? 'unregistered'}</td>
                  <td className="num" style={{ fontWeight: 600 }}>{o.amount}</td>
                  <td><Pill tone={statusTone(o.status)}>{statusWord(o.status)}</Pill></td>
                  <td className="dim">{timeAgo(o.createdAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}</Load>
      </Card>
    </>
  );
}

function Assistants({ data }: Pick<PersonaProps, 'data'>) {
  const unverified = data.agents.filter((a) => !a.verified).length;
  const pct = data.agents.length ? Math.round((unverified / data.agents.length) * 100) : 0;
  return (
    <>
      <PageHead title="AI Assistants" sub="Every agent that has approached a merchant on this platform." />
      <div className="kpis" style={{ marginBottom: 16 }}>
        <Kpi label="Assistants seen" value={data.agents.length} />
        <Kpi label="Unverified" value={`${pct}%`} sub="pinned to the low default ceiling" />
      </div>
      <Card>
        <Load loaded={data.loaded} items={data.agents} rows={3} empty="No assistant has visited yet.">{(rows) => (
          <table>
            <thead><tr><th>Assistant</th><th>Identity</th><th>Per order</th><th>Per day</th><th>First seen</th></tr></thead>
            <tbody>
              {rows.map((a) => (
                <tr key={a.id}>
                  <td style={{ fontWeight: 600 }}>{a.label}</td>
                  <td>{a.verified ? <Pill tone="ok">Verified</Pill> : <Pill tone="warn">Name only</Pill>}</td>
                  <td className="num">{a.perOrderCap}</td>
                  <td className="num">{a.dailyCap}</td>
                  <td className="dim">{timeAgo(a.createdAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}</Load>
      </Card>
    </>
  );
}

function Risk({ data, refresh, onBlocked }: Pick<PersonaProps, 'data' | 'refresh' | 'onBlocked'>) {
  const [busy, setBusy] = useState(false);
  const paused = data.system?.killSwitch.engaged ?? false;
  const unverified = data.agents.filter((a) => !a.verified).length;
  const capHits = data.audit.filter((r) => r.action === 'checkout.blocked' && r.detail.blockedBy === 'within_per_order_cap').length;
  const drift = data.audit.filter((r) => r.action === 'checkout.blocked' && r.detail.blockedBy === 'quote_integrity').length;

  async function toggle() {
    setBusy(true);
    try { await api.killSwitch(!paused, 'stopped from the platform console'); await refresh(); }
    catch { onBlocked(); } finally { setBusy(false); }
  }

  return (
    <>
      <PageHead title="Safety & Risk" sub="Patterns that are not yet a problem, but would be if they continued." />

      <Card title="Stop everything" sub="Immediately prevents any AI assistant from spending, whatever it is in the middle of. Approvals already given stop working too.">
        {paused && <div className="banner bad" style={{ marginBottom: 14 }}>AI spending is paused platform-wide. Nothing can be charged.</div>}
        <button className={paused ? 'btn lg' : 'btn lg danger'} disabled={busy} onClick={() => void toggle()}>
          {paused ? 'Allow AI spending again' : 'Pause all AI spending'}
        </button>
      </Card>

      <Card title="Signals">
        {[
          [unverified > 0, `${unverified} assistant${unverified === 1 ? '' : 's'} still unverified`, 'They only tell us a name, so they stay on the low default ceiling. Working as intended, but worth watching.'],
          [capHits > 0, `${capHits} payment${capHits === 1 ? '' : 's'} hit the per-order ceiling`, 'A human had approved these. The platform limit is not overridable, so no money moved.'],
          [drift > 0, `${drift} quote${drift === 1 ? '' : 's'} went stale before payment`, 'Price or stock changed after quoting. No money at risk, but shoppers see failures.'],
        ].filter(([show]) => show).map(([, title, body], i) => (
          <div key={i} className="row" style={{ gap: 13, alignItems: 'flex-start', padding: '14px 0', borderTop: i ? '1px solid var(--line-2)' : 'none' }}>
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="var(--warn)" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0, marginTop: 2 }}>
              <circle cx="12" cy="12" r="10" /><path d="M12 16v-4M12 8h.01" />
            </svg>
            <div>
              <div style={{ fontWeight: 600 }}>{title as string}</div>
              <div className="tiny" style={{ marginTop: 3 }}>{body as string}</div>
            </div>
          </div>
        ))}
        {unverified === 0 && capHits === 0 && drift === 0 && <Empty>Nothing worth flagging right now.</Empty>}
      </Card>
    </>
  );
}
