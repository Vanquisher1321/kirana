import { useEffect, useState } from 'react';
import { api, FieldError, type Delivery } from '../api.ts';
import { Card, Empty, Load, PageHead, Pill, Skeleton, statusTone, statusWord } from '../ui.tsx';
import { describe, timeAgo, countdown } from '../plain.ts';
import type { PersonaProps } from '../App.tsx';
import { ShopperStart } from '../onboarding.tsx';

/** The person whose assistant is spending. One decision, made unmissable —
 *  everything else on this screen exists to make that decision informed. */
export default function ShopperView(props: PersonaProps) {
  const { data, page, refresh, onBlocked } = props;
  if (page === 'start') return <ShopperStart {...props} />;
  if (page === 'shops') return <Shops data={data} refresh={refresh} onBlocked={onBlocked} />;
  if (page === 'activity') return <Activity data={data} />;
  if (page === 'limits') return <Limits data={data} />;
  return <Home data={data} refresh={refresh} onBlocked={onBlocked} />;
}

const EMPTY_ADDRESS: Delivery = { name: '', phone: '', line1: '', line2: '', city: '', state: '', pincode: '' };

const ADDRESS_FIELDS: Array<[keyof Delivery, string, string, boolean]> = [
  ['name', 'Full name', 'Who is receiving it', true],
  ['phone', 'Mobile', '10 digits, for the courier', true],
  ['line1', 'Address', 'House or flat, street', true],
  ['line2', 'Landmark', 'Optional', false],
  ['city', 'Town or city', '', true],
  ['state', 'State', '', true],
  ['pincode', 'PIN code', '6 digits', true],
];

/**
 * Where it goes, asked on the same screen as how much.
 *
 * Deliberately part of the approval rather than a step of its own. Approving is
 * one decision with two halves, and the half the assistant must never make is
 * this one: an agent that could name the address would not need to break a cap
 * to steal, it could have you approve a perfectly ordinary basket and quietly
 * ship it somewhere else. So the boxes are here, in front of the person whose
 * money it is, and nothing on the agent's side can reach them.
 */
function AddressForm({ value, onChange, error }: {
  value: Delivery;
  onChange: (d: Delivery) => void;
  error?: { field?: string; message?: string } | null;
}) {
  return (
    <div style={{ marginTop: 18 }}>
      <div className="l" style={{ marginBottom: 8 }}>Deliver to</div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 10 }}>
        {ADDRESS_FIELDS.map(([key, label, hint, required]) => (
          <label key={key} style={{ display: 'grid', gap: 4, gridColumn: key === 'line1' ? '1 / -1' : undefined }}>
            <span className="tiny" style={{ color: 'var(--ink-3)' }}>
              {label}{required ? '' : ' (optional)'}
            </span>
            <input
              className="field"
              value={value[key]}
              placeholder={hint}
              aria-invalid={error?.field === key || undefined}
              onChange={(e) => onChange({ ...value, [key]: e.target.value })}
              style={error?.field === key ? { borderColor: 'var(--bad)' } : undefined}
            />
          </label>
        ))}
      </div>
      {error?.message && (
        <div className="tiny" style={{ color: 'var(--bad)', marginTop: 8 }}>{error.message}</div>
      )}
      <div className="tiny" style={{ color: 'var(--ink-3)', marginTop: 8 }}>
        Saved for next time. Your assistant is never told this address.
      </div>
    </div>
  );
}

const PER_ORDER_CAP_MINOR = 200000;
const DAILY_CAP_MINOR = 1000000;
const inr = (minor: number) => `₹${(minor / 100).toLocaleString('en-IN', { minimumFractionDigits: 2 })}`;

function spentToday(orders: { amountMinor: number; status: string; createdAt: string }[]): number {
  const since = Date.now() - 24 * 60 * 60 * 1000;
  return orders
    .filter((o) => Date.parse(o.createdAt) >= since && (o.status === 'paid' || o.status === 'awaiting_payment'))
    .reduce((s, o) => s + o.amountMinor, 0);
}

function Home({ data, refresh, onBlocked }: Pick<PersonaProps, 'data' | 'refresh' | 'onBlocked'>) {
  const [busy, setBusy] = useState('');
  const [address, setAddress] = useState<Delivery>(EMPTY_ADDRESS);
  const [addressError, setAddressError] = useState<{ field?: string; message?: string } | null>(null);
  const spent = spentToday(data.orders);
  const remaining = Math.max(0, DAILY_CAP_MINOR - spent);
  const pct = Math.min(100, (spent / DAILY_CAP_MINOR) * 100);

  // Whatever they used last, so a second order is one click rather than seven
  // fields. Read from their own session; there is no id to pass and therefore
  // no way to point it at somebody else's address.
  useEffect(() => {
    void api.lastDelivery()
      .then((r) => { if (r.delivery) setAddress(r.delivery); })
      .catch(() => { /* an empty form is a fine fallback */ });
  }, []);

  async function act(id: string, yes: boolean) {
    setBusy(id);
    setAddressError(null);
    try {
      if (yes) await api.approve(id, address);
      else await api.reject(id);
      await refresh();
    } catch (e) {
      // The server names the field it refused, so the person can fix the one
      // box that is wrong instead of re-reading the whole form. Taken from the
      // response rather than guessed out of the message: the copy says "mobile"
      // where the field is called "phone", and a heuristic on the prose gets
      // that wrong the first time anyone rewords an error.
      if (yes && e instanceof FieldError && e.field) {
        setAddressError({ field: e.field, message: e.message });
      } else if (yes && e instanceof FieldError && /address|delivery/i.test(e.message)) {
        setAddressError({ message: e.message });
      } else {
        onBlocked();
      }
    } finally { setBusy(''); }
  }

  return (
    <>
      <PageHead big title="Your AI shopping assistant" sub="It can find things and ask. It cannot spend without you." right={<Pill tone="ok">Active</Pill>} />

      <div className="budget">
        <div className="row" style={{ gap: 20 }}>
          <div>
            <div className="l">Spending today</div>
            <div className="num big">{inr(spent)}</div>
            <div className="l" style={{ marginTop: 6 }}>of a {inr(DAILY_CAP_MINOR)} daily budget</div>
          </div>
          <div style={{ flex: 1 }} />
          <div className="row" style={{ gap: 30 }}>
            <div>
              <div className="l">Remaining</div>
              <div className="num n left">{inr(remaining)}</div>
            </div>
            <div>
              <div className="l">Orders</div>
              <div className="num n">{data.orders.length}</div>
            </div>
          </div>
        </div>

        <div className="track"><i style={{ width: `${pct}%` }} /></div>

        <div className="foot">
          <div className="shield">
            <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor"
              strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10Z" />
            </svg>
          </div>
          <div>
            <div className="cap">Per-order limit {inr(PER_ORDER_CAP_MINOR)}</div>
            <div className="l" style={{ marginTop: 3 }}>
              A hard limit the platform enforces — you cannot raise it, and neither can your assistant
            </div>
          </div>
        </div>
      </div>

      {/* The step after approving.
          Approving is not paying: the assistant is told to go to checkout, an
          order is created, and Razorpay issues a link. That link used to go to
          the ASSISTANT and nowhere else, so the person who had just approved
          was left on a screen that said nothing had happened. It appears here
          now, for as long as it can still be used. */}
      {data.orders.filter((o) => o.status === 'awaiting_payment' && o.payUrl).map((o) => (
        <div className="card enter" key={`pay-${o.id}`} style={{ marginBottom: 16 }}>
          <div className="row" style={{ justifyContent: 'space-between' }}>
            <div className="h2">Approved — now finish the payment</div>
            <Pill tone="warn">{statusWord(o.status)}</Pill>
          </div>
          <div className="sub" style={{ marginTop: 4 }}>
            {o.amount} to pay. Razorpay handles the payment itself; Kirana never sees a card.
          </div>
          <div className="row" style={{ marginTop: 14 }}>
            <a className="btn lg" href={o.payUrl ?? '#'} target="_blank" rel="noopener noreferrer"
               style={{ textDecoration: 'none' }}>
              Pay {o.amount} on Razorpay
            </a>
            <span className="tiny dim">Opens Razorpay in a new tab · test mode, so no real money moves.</span>
          </div>
        </div>
      ))}

      {!data.loaded ? <Card><Skeleton rows={3} /></Card> : data.approvals.length === 0 ? (
        <Card>
          <Empty>
            Nothing is waiting for you.<br />
            <span className="tiny">When your assistant wants to spend, the request appears here first.</span>
          </Empty>
        </Card>
      ) : data.approvals.map((a) => (
        <div className="card approval enter" key={a.id}>
          <div className="row" style={{ justifyContent: 'space-between' }}>
            <div className="h2">Your assistant is asking to spend</div>
            <Pill tone="warn">Awaiting your approval</Pill>
          </div>
          <div className="num" style={{ fontSize: 38, fontWeight: 600, letterSpacing: '-1px', marginTop: 12 }}>Up to {a.capFormatted}</div>
          <div className="sub" style={{ marginTop: 4 }}>
            The basket comes to <strong>{a.quote?.total ?? '—'}</strong> · {countdown(a.expiresAt)}
          </div>

          {a.quote && (
            <div style={{ marginTop: 16, border: '1px solid var(--line-2)', borderRadius: 10, overflow: 'hidden' }}>
              {a.quote.lines.map((l, i) => (
                <div key={i} className="row" style={{ padding: '12px 14px', borderBottom: '1px solid var(--line-3)', background: 'var(--card)' }}>
                  <div style={{ flex: 1, fontWeight: 500 }}>{l.quantity} × {l.item}</div>
                  <div className="num" style={{ fontWeight: 600 }}>{l.lineTotal}</div>
                </div>
              ))}
              <div className="row" style={{ padding: '12px 14px', background: 'var(--card-2)' }}>
                <div style={{ flex: 1, fontWeight: 600 }}>Basket total</div>
                <div className="num" style={{ fontSize: 18, fontWeight: 600 }}>{a.quote.total}</div>
              </div>
            </div>
          )}

          <ul style={{ listStyle: 'none', padding: 0, margin: '16px 0 0', display: 'grid', gap: 7 }}>
            {[
              'It can spend up to this amount on this basket only',
              'It cannot raise the limit or reuse it for anything else',
              'You can cancel at any moment, even mid-payment',
              'The price is locked — if it changes, nothing is charged',
            ].map((t) => (
              <li key={t} className="row" style={{ gap: 9, alignItems: 'flex-start' }}>
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="var(--ok)" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0, marginTop: 2 }}><path d="M20 6 9 17l-5-5" /></svg>
                <span className="tiny" style={{ color: 'var(--ink-3)' }}>{t}</span>
              </li>
            ))}
          </ul>

          <AddressForm value={address} onChange={setAddress} error={addressError} />

          <div className="row" style={{ marginTop: 18 }}>
            <button className="btn lg" disabled={busy === a.id} onClick={() => void act(a.id, true)}>Approve {a.capFormatted} and ship here</button>
            <button className="btn lg ghost" disabled={busy === a.id} onClick={() => void act(a.id, false)}>Decline</button>
          </div>
        </div>
      ))}
    </>
  );
}

function Activity({ data }: Pick<PersonaProps, 'data'>) {
  return (
    <>
      <PageHead title="Activity" sub="Everything your assistant did, in order. Nothing happens without a record." />
      <Card>
        {!data.loaded ? <Skeleton rows={5} /> : data.audit.length === 0 ? <Empty>Nothing yet.</Empty> : data.audit.map((row, i) => {
          const p = describe(row);
          const tone = row.outcome === 'ok' ? 'var(--ok)' : row.outcome === 'blocked' ? 'var(--warn)' : 'var(--bad)';
          return (
            <div key={row.seq} style={{ display: 'grid', gridTemplateColumns: '74px 24px minmax(0,1fr)', gap: 12 }}>
              <div className="tiny num" style={{ paddingTop: 1 }}>{timeAgo(row.ts)}</div>
              <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
                <div style={{ width: 9, height: 9, borderRadius: '50%', background: tone, marginTop: 4 }} />
                {i < data.audit.length - 1 && <div style={{ flex: 1, width: 1, background: 'var(--line)' }} />}
              </div>
              <div style={{ paddingBottom: 22 }}>
                <div style={{ fontWeight: 600 }}>{p.title}</div>
                {p.body && <div className="tiny" style={{ marginTop: 3 }}>{p.body}</div>}
              </div>
            </div>
          );
        })}
      </Card>
    </>
  );
}

function Limits({ data }: Pick<PersonaProps, 'data'>) {
  const spent = spentToday(data.orders);
  const biggest = data.orders.reduce((m, o) => Math.max(m, o.amountMinor), 0);
  return (
    <>
      <PageHead title="Limits" sub="What your assistant is allowed to spend, and who decides." />
      <Card title="Ceilings your assistant can never cross">
        <div style={{ display: 'grid', gap: 20 }}>
          <Limit label="Most it can spend at once" value={inr(PER_ORDER_CAP_MINOR)} pct={(biggest / PER_ORDER_CAP_MINOR) * 100} note={`Largest order so far: ${inr(biggest)}`} />
          <Limit label="Most it can spend in a day" value={inr(DAILY_CAP_MINOR)} pct={(spent / DAILY_CAP_MINOR) * 100} note={`${inr(spent)} in the last 24 hours`} />
        </div>
        <div className="banner warn" style={{ marginTop: 20 }}>
          Shops set their own ceilings too. Whichever is lower wins — and neither you nor your assistant can raise the platform’s.
        </div>
      </Card>

      <Card title="Orders" sub="Everything your assistant has bought or tried to buy.">
        <Load loaded={data.loaded} items={data.orders} rows={3} empty="No orders yet.">{(rows) => (
          <table>
            <thead><tr><th>Amount</th><th>Status</th><th>When</th></tr></thead>
            <tbody>
              {rows.map((o) => (
                <tr key={o.id}>
                  <td className="num" style={{ fontWeight: 600 }}>{o.amount}</td>
                  <td>
                    <Pill tone={statusTone(o.status)}>{statusWord(o.status)}</Pill>
                    {o.status === 'awaiting_payment' && o.payUrl && (
                      <a className="btn ghost sm" href={o.payUrl} target="_blank" rel="noopener noreferrer"
                         style={{ marginLeft: 8, textDecoration: 'none' }}>Pay now</a>
                    )}
                  </td>
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

function Limit({ label, value, pct, note }: { label: string; value: string; pct: number; note: string }) {
  return (
    <div>
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <span className="dim">{label}</span>
        <span className="num" style={{ fontWeight: 600 }}>{value}</span>
      </div>
      <div className="bar" style={{ marginTop: 7 }}><i style={{ width: `${Math.max(0, Math.min(100, pct))}%` }} /></div>
      <div className="tiny" style={{ marginTop: 6 }}>{note}</div>
    </div>
  );
}

/**
 * Where a shopper actually starts.
 *
 * The console had no way to find a shop at all: the shopper landed on an
 * approvals queue for spending that could not happen yet, because nothing told
 * them which shops exist or how to point an assistant at one. The directory
 * endpoint was built for exactly this and then never surfaced.
 *
 * Two things belong here. The list of shops on the network, each with the link
 * you paste into your assistant — that is the whole handoff between "here is a
 * console" and "here is my assistant buying something". And a box to add a shop
 * that is not on the list yet, because the honest answer to "can it shop THIS
 * store?" is to try it in front of the person asking.
 */
function Shops({ data, refresh, onBlocked }: Pick<PersonaProps, 'data' | 'refresh' | 'onBlocked'>) {
  const [url, setUrl] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [copied, setCopied] = useState('');
  const [link, setLink] = useState<string | null>(null);
  const [rotating, setRotating] = useState(false);

  // Fetched once the visitor is actually on this page, not on every console
  // load: the key is minted on first ask, and a secret nobody wanted is a
  // secret that can still leak.
  useEffect(() => {
    void api.buyerLink().then((r) => setLink(r.url)).catch(() => {});
  }, [data.merchants.length]);

  const rotate = async () => {
    setRotating(true);
    try {
      const r = await api.rotateBuyerLink();
      setLink(r.url);
    } catch { /* the old link keeps working; nothing was lost */ }
    setRotating(false);
  };

  async function add() {
    setBusy(true); setErr('');
    try { await api.ingest(url); setUrl(''); await refresh(); }
    catch (e) {
      const msg = (e as Error).message;
      if (/unauthor/i.test(msg)) onBlocked(); else setErr(msg);
    } finally { setBusy(false); }
  }

  const copy = (link: string) => {
    void navigator.clipboard?.writeText(link);
    setCopied(link);
    setTimeout(() => setCopied(''), 1500);
  };

  return (
    <>
      <PageHead
        big
        title="Shops your assistant can buy from"
        sub="One link covers all of them. Give it to your assistant and it can browse and buy — within the limits you set."
      />

      {/* The one link, first. Per-shop links still exist below, because a
          merchant handing out their own shop's address is a different job --
          but a shopper wiring up their assistant should only ever need this. */}
      <Card
        title="Your assistant's link"
        sub="One link for every shop below. Add it to your assistant once; shops you add later are covered automatically."
        right={link ? (
          <button className="btn ghost sm" onClick={() => void rotate()} disabled={rotating}>
            {rotating ? 'Replacing…' : 'Replace link'}
          </button>
        ) : undefined}
      >
        {link ? (
          <>
            <div className="mono tiny" style={{ wordBreak: 'break-all' }}>{link}</div>
            <div className="row" style={{ marginTop: 10 }}>
              <button className="btn" onClick={() => copy(link)}>
                {copied === link ? 'Copied' : 'Copy link'}
              </button>
              <span className="tiny dim">
                In Claude: Customize → Connectors → Add custom connector.
              </span>
            </div>
            <div className="tiny dim" style={{ marginTop: 12 }}>
              Anyone holding this link can shop your shops, within your limits — it is a key, not a
              username. Replacing it stops every assistant currently using the old one.
            </div>
          </>
        ) : (
          <div className="tiny dim">Add a shop below and your link appears here.</div>
        )}
      </Card>

      <Card title="Add a shop" sub="Any Shopify store. We read the catalogue it already publishes; nothing is installed on their site.">
        <div className="row">
          <input
            className="field" type="text" placeholder="bluetokaicoffee.com" value={url}
            onChange={(e) => setUrl(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && url && !busy) void add(); }}
          />
          <button className="btn" disabled={!url || busy} onClick={() => void add()}>
            {busy ? 'Reading the shop…' : 'Add shop'}
          </button>
        </div>
        {err && <div className="tiny" style={{ marginTop: 8 }}>{err}</div>}
      </Card>

      <Card title="On the network now" sub="Each shop also has its own link, for handing to someone who should reach only that shop.">
        <Load loaded={data.loaded} items={data.merchants} rows={3} empty="No shops yet — add one above.">
          {(shops) => (
            <table>
              <thead><tr><th>Shop</th><th>Products</th><th>Link for your assistant</th></tr></thead>
              <tbody>
                {shops.map((m) => (
                  <tr key={m.id}>
                    <td>
                      <div style={{ fontWeight: 600 }}>{m.name}</div>
                      <div className="tiny dim">{m.currency} · read {timeAgo(m.ingestedAt)}</div>
                    </td>
                    <td className="num">{m.products}<div className="tiny dim">{m.variants} options</div></td>
                    <td>
                      <div className="mono tiny" style={{ wordBreak: 'break-all' }}>{m.mcpUrl}</div>
                      <button
                        className="btn ghost" style={{ marginTop: 6 }}
                        onClick={() => copy(m.mcpUrl)}
                      >
                        {copied === m.mcpUrl ? 'Copied' : 'Copy link'}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Load>
      </Card>
    </>
  );
}
