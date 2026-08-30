import { useState } from 'react';
import { api, type Merchant, type Order } from '../api.ts';
import { Card, Empty, Kpi, Load, PageHead, Pill, Skeleton, statusTone, statusWord } from '../ui.tsx';
import { describe, timeAgo } from '../plain.ts';
import type { PersonaProps } from '../App.tsx';

/** The shop owner. Their questions, in order: am I reachable by AI buyers,
 *  what did they buy, and who exactly am I letting spend? */
export default function MerchantView({ data, page, refresh, onBlocked }: PersonaProps) {
  const shop = data.merchants[0];

  if (page === 'catalogue') return <Catalogue shop={shop} />;
  if (page === 'orders') return <Orders orders={data.orders} loaded={data.loaded} />;
  if (page === 'assistants') return <Assistants data={data} onBlocked={onBlocked} refresh={refresh} />;
  if (page === 'record') return <Record data={data} />;
  return <Overview shop={shop} data={data} refresh={refresh} onBlocked={onBlocked} />;
}

function Overview({ shop, data, refresh, onBlocked }: { shop?: Merchant } & Pick<PersonaProps, 'data' | 'refresh' | 'onBlocked'>) {
  const [url, setUrl] = useState('');
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState('');
  const [problem, setProblem] = useState('');

  const paid = data.orders.filter((o) => o.status === 'paid');
  const revenue = paid.reduce((s, o) => s + o.amountMinor, 0);
  const blocked = data.audit.filter((r) => r.action === 'checkout.blocked').length;

  async function connect() {
    setBusy(true); setNote(''); setProblem('');
    try {
      const r = await api.ingest(url);
      setNote(`${r.merchant.name} is open to AI shoppers — ${r.productCount} products, ${r.variantCount} buying options, in ${r.durationMs}ms. ${r.usedLlm ? 'Some details were interpreted by a model.' : 'Read straight from the shop’s own feed, so no model guessed at any price.'}`);
      setUrl('');
      await refresh();
    } catch (e) {
      if ((e as Error).name === 'Unauthorized') onBlocked();
      else setProblem((e as Error).message);
    } finally { setBusy(false); }
  }

  return (
    <>
      <PageHead
        title="AI Commerce Overview"
        sub={shop ? `${shop.name} · last read ${timeAgo(shop.ingestedAt)}` : 'No shop connected yet'}
        right={shop ? <Pill tone="ok">AI Commerce active</Pill> : undefined}
      />

      <div className="kpis" style={{ marginBottom: 16 }}>
        <Kpi label="Products readable" value={shop?.products ?? 0} sub={`${shop?.variants ?? 0} buying options`} />
        <Kpi label="Orders from AI shoppers" value={data.orders.length} sub={`${paid.length} paid`} />
        <Kpi label="Revenue from AI" value={`₹${(revenue / 100).toLocaleString('en-IN', { minimumFractionDigits: 2 })}`} sub="test mode" />
        <Kpi label="Payments stopped" value={blocked} sub="a guard refused them" />
      </div>

      <Card
        title="Your shop’s AI address"
        sub="Give this to any AI assistant and it can browse your catalogue and buy from you. Nothing to install on your website."
        right={shop ? <button className="btn sm ghost" onClick={() => void navigator.clipboard.writeText(shop.mcpUrl)}>Copy link</button> : undefined}
      >
        {shop ? (
          <>
            <div className="mono" style={{ background: 'var(--card-2)', border: '1px dashed var(--line)', borderRadius: 9, padding: '12px 14px', fontSize: 12.5, color: 'var(--accent)', wordBreak: 'break-all' }}>
              {shop.mcpUrl}
            </div>
            <div className="row" style={{ marginTop: 14, gap: 14 }}>
              <Pill tone="ok">{shop.usedLlm ? 'Model-assisted' : 'Read from the shop’s own feed'}</Pill>
              <span className="tiny">
                {shop.usedLlm
                  ? 'Buying agents are told this catalogue was interpreted by a model.'
                  : 'No model guessed at any price. Buying agents are told this.'}
              </span>
            </div>
            {shop.warnings.length > 0 && (
              <div className="tiny" style={{ marginTop: 14 }}>
                <strong>We skipped {shop.warnings.length} thing{shop.warnings.length === 1 ? '' : 's'} rather than guess:</strong>
                <ul style={{ margin: '6px 0 0 18px', padding: 0 }}>
                  {shop.warnings.map((w, i) => <li key={i}>{w}</li>)}
                </ul>
              </div>
            )}
          </>
        ) : <Empty>Connect a shop below to get your AI address.</Empty>}
      </Card>

      <Card title="Connect a shop" sub="Paste any shop’s website. We read what it sells and hand back one link AI assistants can shop from.">
        <div className="row">
          <input className="field" type="text" placeholder="bluetokaicoffee.com" value={url}
            onChange={(e) => setUrl(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && url && !busy) void connect(); }} />
          <button className="btn" disabled={!url || busy} onClick={() => void connect()}>
            {busy ? <><span className="spin" /> Reading…</> : 'Make it AI-ready'}
          </button>
        </div>
        {note && <div className="banner ok" style={{ marginTop: 16 }}>{note}</div>}
        {problem && <div className="banner bad" style={{ marginTop: 16 }}>{problem}</div>}
      </Card>
    </>
  );
}

function Catalogue({ shop }: { shop?: Merchant }) {
  return (
    <>
      <PageHead title="AI Catalogue" sub={shop ? `What AI buyers can see at ${shop.name}` : 'No shop connected'} />
      <Card>
        {!shop ? <Empty>Connect a shop first.</Empty> : (
          <div className="kpis">
            <Kpi label="Products" value={shop.products} />
            <Kpi label="Buying options" value={shop.variants} sub="variants detected automatically" />
            <Kpi label="Read in" value={`${shop.durationMs}ms`} sub={`via ${shop.adapter ?? 'unknown'}`} />
            <Kpi label="Currency" value={shop.currency} />
          </div>
        )}
      </Card>
    </>
  );
}

function Orders({ orders, loaded }: { orders: Order[]; loaded: boolean }) {
  return (
    <>
      <PageHead title="Orders" sub="What AI assistants tried to buy, and how each one ended." />
      <Card>
        <Load loaded={loaded} items={orders} rows={4} empty="No AI orders yet.">{(rows) => (
          <table>
            <thead><tr><th>Order</th><th>Amount</th><th>Status</th><th>Razorpay</th><th>When</th></tr></thead>
            <tbody>
              {rows.map((o) => (
                <tr key={o.id}>
                  <td className="mono" style={{ fontSize: 12 }}>{o.id}</td>
                  <td className="num" style={{ fontWeight: 600 }}>{o.amount}</td>
                  <td>
                    <Pill tone={statusTone(o.status)}>{statusWord(o.status)}</Pill>
                    {o.failureReason && <div className="tiny" style={{ marginTop: 4 }}>{o.failureReason}</div>}
                  </td>
                  <td className="mono dim" style={{ fontSize: 12 }}>{o.razorpayPaymentId ?? o.razorpayOrderId ?? '—'}</td>
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

function Assistants({ data, onBlocked, refresh }: Pick<PersonaProps, 'data' | 'onBlocked' | 'refresh'>) {
  const [busy, setBusy] = useState('');
  const [issued, setIssued] = useState<{ id: string; key: string } | null>(null);

  async function issue(id: string) {
    setBusy(id);
    try {
      const r = await api.issueKey(id);
      setIssued({ id, key: r.apiKey });
      await refresh();
    } catch { onBlocked(); } finally { setBusy(''); }
  }

  return (
    <>
      <PageHead title="AI Assistants" sub="Each one starts on a low ceiling it cannot lift by itself. Raising it is your decision." />

      {issued && (
        <div className="banner ok" style={{ marginBottom: 16, display: 'block' }}>
          <strong>Key issued for {issued.id}.</strong> Copy it now — only its hash is stored, so it cannot be shown again.
          <div className="mono" style={{ marginTop: 8, wordBreak: 'break-all' }}>{issued.key}</div>
        </div>
      )}

      <Card>
        <Load loaded={data.loaded} items={data.agents} rows={3} empty="No AI assistant has visited yet.">{(rows) => (
          <table>
            <thead><tr><th>Assistant</th><th>Identity</th><th>Per order</th><th>Per day</th><th /></tr></thead>
            <tbody>
              {rows.map((a) => (
                <tr key={a.id}>
                  <td style={{ fontWeight: 600 }}>{a.label}<div className="tiny">first seen {timeAgo(a.createdAt)}</div></td>
                  <td>
                    {a.verified
                      ? <Pill tone="ok">Verified</Pill>
                      : <Pill tone="warn">Name only</Pill>}
                    <div className="tiny" style={{ marginTop: 4 }}>
                      {a.verified ? 'Proved its identity with a key' : 'Told us a name but never proved it'}
                    </div>
                  </td>
                  <td className="num">{a.perOrderCap}</td>
                  <td className="num">{a.dailyCap}</td>
                  <td style={{ textAlign: 'right' }}>
                    {!a.verified && (
                      <button className="btn sm ghost" disabled={busy === a.id} onClick={() => void issue(a.id)}>
                        {busy === a.id ? <span className="spin" /> : 'Issue a key'}
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}</Load>
        <div className="banner warn" style={{ marginTop: 16 }}>
          An assistant that only tells you its name can’t have its limit raised — anyone could claim the same name. Issue it a key first.
        </div>
      </Card>
    </>
  );
}

function Record({ data }: Pick<PersonaProps, 'data'>) {
  const seal = data.seal;
  return (
    <>
      <PageHead title="The Record" sub="Every step, in order, sealed against the one before it. If a line were edited or removed, this would say so." />
      {seal && (
        <div className={`banner ${seal.ok ? 'ok' : 'bad'}`} style={{ marginBottom: 16 }}>
          {seal.ok
            ? <span><strong>All {seal.checked} entries check out.</strong> Nothing has been altered or removed.</span>
            : <span><strong>Tampering detected at entry {seal.brokenAtSeq}.</strong> {seal.reason}</span>}
        </div>
      )}
      <Card>
        {!data.loaded ? <Skeleton rows={5} /> : data.audit.length === 0 ? <Empty>Nothing has happened yet.</Empty> : data.audit.map((row) => {
          const p = describe(row);
          return (
            <div key={row.seq} style={{ display: 'grid', gridTemplateColumns: '80px minmax(0,1fr)', gap: 14, padding: '12px 0', borderTop: '1px solid var(--line-2)' }}>
              <div className="tiny num">{timeAgo(row.ts)}</div>
              <div>
                <div style={{ fontWeight: 600 }}>
                  {p.title}
                  {row.outcome !== 'ok' && <span style={{ marginLeft: 8 }}><Pill tone={row.outcome === 'blocked' ? 'warn' : 'bad'}>{row.outcome === 'blocked' ? 'stopped' : 'failed'}</Pill></span>}
                </div>
                {p.body && <div className="tiny" style={{ marginTop: 3 }}>{p.body}</div>}
              </div>
            </div>
          );
        })}
      </Card>
    </>
  );
}
