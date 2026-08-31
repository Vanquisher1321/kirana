import { useState } from 'react';
import { api, type Merchant, type Order } from '../api.ts';
import { Card, Empty, Kpi, Load, PageHead, Pill, Skeleton, statusTone, statusWord } from '../ui.tsx';
import { describe, timeAgo } from '../plain.ts';
import type { PersonaProps } from '../App.tsx';

/** The shop owner. Their questions, in order: am I reachable by AI buyers,
 *  what did they buy, and who exactly am I letting spend? */
export default function MerchantView({ data, page, refresh, onBlocked, shopId, setShopId }: PersonaProps) {
  const shop = data.merchants.find((m) => m.id === shopId) ?? data.merchants[0];
  const picker = data.merchants.length > 1 ? (
    <select className="shopsel" value={shop?.id ?? ''} onChange={(e) => setShopId(e.target.value)}>
      {data.merchants.map((m) => <option key={m.id} value={m.id}>{m.name} · {m.products} products</option>)}
    </select>
  ) : undefined;

  if (page === 'catalogue') return <Catalogue shop={shop} picker={picker} />;
  if (page === 'orders') return <Orders orders={data.orders} loaded={data.loaded} />;
  if (page === 'assistants') return <Assistants data={data} onBlocked={onBlocked} refresh={refresh} />;
  if (page === 'record') return <Record data={data} />;
  return <Overview shop={shop} picker={picker} data={data} refresh={refresh} onBlocked={onBlocked} />;
}

function Overview({ shop, picker, data, refresh, onBlocked }: { shop?: Merchant; picker?: React.ReactNode } & Pick<PersonaProps, 'data' | 'refresh' | 'onBlocked'>) {
  const [url, setUrl] = useState('');
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState('');
  const [problem, setProblem] = useState('');

  const paid = data.orders.filter((o) => o.status === 'paid');
  const revenue = paid.reduce((s, o) => s + o.amountMinor, 0);
  const blocked = data.audit.filter((r) => r.action === 'checkout.blocked').length;

  async function connect(target?: string) {
    const which = target ?? url;
    setBusy(true); setNote(''); setProblem('');
    try {
      const r = await api.ingest(which);
      setNote(`${r.merchant.name} is open to AI shoppers — ${r.productCount} products, ${r.variantCount} buying options, in ${r.durationMs}ms. ${r.usedLlm ? 'Some details were interpreted by a model.' : 'Read straight from the shop’s own feed, so no model guessed at any price.'}`);
      if (!target) setUrl('');
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
        right={<div className="row" style={{ gap: 10 }}>{picker}{shop && <Pill tone="ok">AI Commerce active</Pill>}</div>}
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
        right={shop ? (
          <div className="row" style={{ gap: 8 }}>
            <button className="btn sm ghost" disabled={busy} onClick={() => void connect(shop.originUrl)}>
              {busy ? <><span className="spin" /> Re-reading…</> : 'Re-sync catalogue'}
            </button>
            <button className="btn sm ghost" onClick={() => void navigator.clipboard.writeText(shop.mcpUrl)}>Copy link</button>
          </div>
        ) : undefined}
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
            {shop.warnings.length > 0 && <SkipSummary warnings={shop.warnings} />}
          </>
        ) : <Empty>Connect a shop below to get your AI address.</Empty>}
      </Card>

      {!shop && (
      <Card title="Connect your shop" sub="Paste your website. We read what you sell and hand back one link AI assistants can shop from. Nothing to install.">
        <div className="row">
          <input className="field" type="text" placeholder="bluetokaicoffee.com" value={url}
            onChange={(e) => setUrl(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && url && !busy) void connect(); }} />
          <button className="btn" disabled={!url || busy} onClick={() => void connect()}>
            {busy ? <><span className="spin" /> Reading…</> : 'Make it AI-ready'}
          </button>
        </div>
        {problem && <div className="banner bad" style={{ marginTop: 16 }}>{problem}</div>}
      </Card>
      )}

      {note && <div className="banner ok" style={{ marginBottom: 16 }}>{note}</div>}
      {shop && problem && <div className="banner bad" style={{ marginBottom: 16 }}>{problem}</div>}

      <div className="sechead">Latest AI orders</div>
      <Card>
        <Load loaded={data.loaded} items={data.orders.slice(0, 5)} rows={3} empty="No AI orders yet. Point an assistant at the link above.">{(rows) => (
          <table>
            <thead><tr><th>Amount</th><th>Status</th><th>Assistant</th><th>When</th></tr></thead>
            <tbody>
              {rows.map((o) => (
                <tr key={o.id}>
                  <td className="num" style={{ fontWeight: 600 }}>{o.amount}</td>
                  <td>
                    <Pill tone={statusTone(o.status)}>{statusWord(o.status)}</Pill>
                    {o.failureReason && <div className="tiny" style={{ marginTop: 4 }}>{o.failureReason}</div>}
                  </td>
                  <td className="dim">{o.agentId ?? 'unregistered'}</td>
                  <td className="dim">{timeAgo(o.createdAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}</Load>
      </Card>

      <div className="sechead">Who is shopping here</div>
      <Card>
        <Load loaded={data.loaded} items={data.agents} rows={2} empty="No AI assistant has visited yet.">{(rows) => (
          <table>
            <thead><tr><th>Assistant</th><th>Identity</th><th>Per order</th><th>Per day</th></tr></thead>
            <tbody>
              {rows.map((a) => (
                <tr key={a.id}>
                  <td style={{ fontWeight: 600 }}>{a.label}</td>
                  <td>{a.verified ? <Pill tone="ok">Verified</Pill> : <Pill tone="warn">Name only</Pill>}</td>
                  <td className="num">{a.perOrderCap}</td>
                  <td className="num">{a.dailyCap}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}</Load>
      </Card>

      <div className="sechead">Latest activity</div>
      <Card>
        {!data.loaded ? <Skeleton rows={4} /> : data.audit.slice(0, 6).map((row) => {
          const p = describe(row);
          return (
            <div key={row.seq} style={{ display: 'grid', gridTemplateColumns: '80px minmax(0,1fr)', gap: 14, padding: '10px 0', borderTop: '1px solid var(--line-2)' }}>
              <div className="tiny num">{timeAgo(row.ts)}</div>
              <div>
                <span style={{ fontWeight: 600 }}>{p.title}</span>
                {row.outcome !== 'ok' && <span style={{ marginLeft: 8 }}><Pill tone={row.outcome === 'blocked' ? 'warn' : 'bad'}>{row.outcome === 'blocked' ? 'stopped' : 'failed'}</Pill></span>}
              </div>
            </div>
          );
        })}
      </Card>
    </>
  );
}

function Catalogue({ shop, picker }: { shop?: Merchant; picker?: React.ReactNode }) {
  return (
    <>
      <PageHead title="AI Catalogue" sub={shop ? `What AI buyers can see at ${shop.name}` : 'No shop connected'} right={picker} />
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

/**
 * "We skipped 52 things rather than guess" is the honest line. Printing all 52
 * underneath it is not honesty, it is a wall: a real catalogue has dozens of
 * zero-priced placeholder variants, and on Blue Tokai the list buried the
 * entire dashboard under one repeated sentence. Group by reason, show the
 * shape, and put the detail behind a click for anyone who wants it.
 */
function SkipSummary({ warnings }: { warnings: string[] }) {
  const [open, setOpen] = useState(false);
  const groups = new Map<string, number>();
  for (const w of warnings) {
    const reason = /price is not a positive amount/i.test(w) ? 'no usable price'
      : /no usable variants/i.test(w) ? 'no buyable options'
      : /unparseable price/i.test(w) ? 'price we could not read'
      : 'other';
    groups.set(reason, (groups.get(reason) ?? 0) + 1);
  }
  const summary = [...groups.entries()].sort((a, b) => b[1] - a[1]).map(([r, n]) => `${n} ${r}`).join(' · ');
  return (
    <div className="tiny" style={{ marginTop: 14 }}>
      <strong>We skipped {warnings.length} thing{warnings.length === 1 ? '' : 's'} rather than guess</strong>
      <div style={{ marginTop: 4, opacity: 0.75 }}>{summary}</div>
      <button
        onClick={() => setOpen(!open)}
        style={{ background: 'none', border: 0, padding: '6px 0 0', cursor: 'pointer', color: 'inherit', textDecoration: 'underline', font: 'inherit', opacity: 0.7 }}
      >
        {open ? 'Hide details' : 'Show each one'}
      </button>
      {open && (
        <ul style={{ margin: '6px 0 0 18px', padding: 0, maxHeight: 200, overflowY: 'auto' }}>
          {warnings.map((w, i) => <li key={i}>{w}</li>)}
        </ul>
      )}
    </div>
  );
}
