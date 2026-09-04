import { useEffect, useState } from 'react';
import { api } from './api.ts';
import { Card, Check, PageHead } from './ui.tsx';
import type { PersonaProps } from './App.tsx';

/**
 * Getting started, for someone who has never heard of MCP.
 *
 * Both consoles used to open on an empty state: a merchant saw a dashboard with
 * nothing in it, a shopper saw an approvals queue for spending that could not
 * happen yet. Everything worked, and nothing told you where to begin - which is
 * fine if you built it and useless if you did not.
 *
 * Each step reports whether it is already done by reading real state rather
 * than a checkbox, so this doubles as a status page once setup is finished.
 */

function Step({ n, title, done, last, children }: {
  n: number; title: string; done: boolean; last?: boolean; children: React.ReactNode;
}) {
  return (
    <div style={{ display: 'flex', gap: 16, alignItems: 'stretch' }}>
      {/* The rail is the sequence. Three numbered circles floating in space
          read as three unrelated things; a line joining them reads as one
          path with a beginning and an end. */}
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', flex: '0 0 30px' }}>
        <div
          aria-hidden
          style={{
            width: 30, height: 30, borderRadius: 999, display: 'grid', placeItems: 'center',
            fontSize: 13.5, fontWeight: 600, fontVariantNumeric: 'tabular-nums', flex: '0 0 30px',
            background: done ? 'var(--accent)' : 'var(--card)',
            color: done ? '#fff' : 'var(--muted)',
            border: done ? '1px solid var(--accent)' : '1px solid var(--line)',
            boxShadow: done ? 'var(--sh-1)' : 'none',
          }}
        >
          {done ? <Check /> : n}
        </div>
        {!last && (
          <div aria-hidden style={{ flex: 1, width: 1, background: 'var(--line)', margin: '6px 0' }} />
        )}
      </div>
      <div className="prose" style={{ flex: 1, minWidth: 0, paddingBottom: last ? 0 : 30 }}>
        <div className="h2" style={{ marginTop: 5, opacity: done ? 0.7 : 1 }}>{title}</div>
        <div style={{ marginTop: 10 }}>{children}</div>
      </div>
    </div>
  );
}

/** The one instruction nobody else spells out: what to DO with the link. */
function UseThisLink({ url, covers }: { url: string; covers?: number }) {
  const [copied, setCopied] = useState(false);
  return (
    <>
      <div
        className="mono"
        style={{
          wordBreak: 'break-all', marginBottom: 12, padding: '11px 13px', fontSize: 13,
          background: 'var(--card-2)', border: '1px solid var(--line)', borderRadius: 'var(--r-sm)',
          color: 'var(--ink-2)', userSelect: 'all',
        }}
      >{url}</div>
      <button
        className="btn"
        onClick={() => { void navigator.clipboard?.writeText(url); setCopied(true); setTimeout(() => setCopied(false), 1600); }}
      >
        {copied ? 'Copied' : 'Copy the link'}
      </button>
      <div className="tiny dim" style={{ marginTop: 12, lineHeight: 1.6 }}>
        This is a <strong>remote MCP server</strong> - the standard way an AI assistant
        connects to an outside service. Paste it wherever your assistant accepts a custom
        connector. In Claude that is <strong>Customize -&gt; Connectors -&gt; Add custom
        connector</strong>: paste the link, click Add. Nothing to install, no API key, no code.
        {covers !== undefined && (
          <> This one link covers {covers === 1 ? 'your shop' : `all ${covers} of your shops`}, and any
          you add later — you only ever add it once.</>
        )}
      </div>
      <div className="tiny dim" style={{ marginTop: 8 }}>
        Then just ask it to buy something, in words: "find me a coffee under 800 rupees and buy it".
      </div>
    </>
  );
}

export function MerchantStart({ data, refresh, onBlocked }: PersonaProps) {
  const [url, setUrl] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  const shop = [...data.merchants].sort((a, b) => b.products - a.products)[0];
  const visited = data.agents.length > 0;

  async function connect() {
    setBusy(true); setErr('');
    try { await api.ingest(url); setUrl(''); await refresh(); }
    catch (e) {
      const m = (e as Error).message;
      if (/unauthor/i.test(m)) onBlocked(); else setErr(m);
    } finally { setBusy(false); }
  }

  return (
    <>
      <PageHead
        big
        title="Make your shop AI-buyable"
        sub="Three steps, about two minutes. You will not touch your website's code."
      />

      <Card>
        <Step n={1} title="Connect your shop" done={Boolean(shop)}>
          {shop ? (
            <div className="tiny">
              <strong>{shop.name}</strong> - {shop.products} products, {shop.variants} buying
              options, read straight from your shop's own product feed.
            </div>
          ) : (
            <>
              <div className="tiny dim" style={{ marginBottom: 8 }}>
                Paste your shop's web address. We read the catalogue it already publishes -
                the same feed your own website uses - so there is nothing to install and
                nothing to change.
              </div>
              <div className="row">
                <input
                  className="field" type="text" placeholder="yourshop.com" value={url}
                  onChange={(e) => setUrl(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter' && url && !busy) void connect(); }}
                />
                <button className="btn" disabled={!url || busy} onClick={() => void connect()}>
                  {busy ? 'Reading your shop...' : 'Connect'}
                </button>
              </div>
              {err && <div className="tiny" style={{ marginTop: 8 }}>{err}</div>}
              <div className="tiny dim" style={{ marginTop: 8 }}>
                Works with any Shopify shop today - about a quarter of Indian D2C brands, and
                no cooperation needed from them. Not sure what yours runs on? Try it: we tell
                you exactly what we could and could not read.
              </div>
            </>
          )}
        </Step>

        <Step n={2} title="Take your shop's AI address" done={Boolean(shop)}>
          {shop
            ? <UseThisLink url={shop.mcpUrl} />
            : <div className="tiny dim">Appears here once your shop is connected.</div>}
        </Step>

        <Step n={3} last title="An assistant shops, you stay in control" done={visited}>
          <div className="tiny dim" style={{ lineHeight: 1.6 }}>
            {visited
              ? `${data.agents.length} assistant${data.agents.length === 1 ? ' has' : 's have'} visited your shop. Each one starts on a low spending ceiling that only you can raise.`
              : 'When an assistant arrives it gets a low spending ceiling it cannot lift by itself. Prices come from your feed, never from a guess, and a payment that does not match your price is refused rather than charged.'}
          </div>
        </Step>
      </Card>
    </>
  );
}

export function ShopperStart({ data, refresh, onBlocked }: PersonaProps) {
  const [url, setUrl] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  // The guide used to teach the per-shop link while the Shops page offered the
  // buyer link, so the two screens disagreed about the single most important
  // instruction in the product. A shopper wants the one that covers every shop.
  const [buyerLink, setBuyerLink] = useState<string | null>(null);
  useEffect(() => {
    void api.buyerLink().then((r) => setBuyerLink(r.url)).catch(() => {});
  }, [data.merchants.length]);

  const shops = [...data.merchants].sort((a, b) => b.products - a.products);
  const chosen = shops[0];
  const hasAsked = data.approvals.length > 0 || data.orders.length > 0;

  async function add() {
    setBusy(true); setErr('');
    try { await api.ingest(url); setUrl(''); await refresh(); }
    catch (e) {
      const m = (e as Error).message;
      if (/unauthor/i.test(m)) onBlocked(); else setErr(m);
    } finally { setBusy(false); }
  }

  return (
    <>
      <PageHead
        big
        title="Let your assistant shop for you"
        sub="You set the ceiling. It asks before every payment. You decide here."
      />

      <Card>
        <Step n={1} title="Pick a shop" done={Boolean(chosen)}>
          {chosen && (
            <div className="tiny" style={{ marginBottom: 10 }}>
              {shops.length} shop{shops.length === 1 ? '' : 's'} ready to buy from - the largest
              is <strong>{chosen.name}</strong> with {chosen.products} products.
            </div>
          )}
          <div className="tiny dim" style={{ marginBottom: 8 }}>
            Want a shop that is not listed? Add any Shopify store and it becomes buyable in
            about two seconds.
          </div>
          <div className="row">
            <input
              className="field" type="text" placeholder="bluetokaicoffee.com" value={url}
              onChange={(e) => setUrl(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter' && url && !busy) void add(); }}
            />
            <button className="btn" disabled={!url || busy} onClick={() => void add()}>
              {busy ? 'Reading the shop...' : 'Add shop'}
            </button>
          </div>
          {err && <div className="tiny" style={{ marginTop: 8 }}>{err}</div>}
        </Step>

        <Step n={2} title="Give your assistant one link" done={hasAsked}>
          {buyerLink
            ? <UseThisLink url={buyerLink} covers={shops.length} />
            : <div className="tiny dim">Appears here once there is a shop to buy from.</div>}
        </Step>

        <Step n={3} last title="Approve what it asks for" done={data.orders.length > 0}>
          <div className="tiny dim" style={{ lineHeight: 1.6 }}>
            Your assistant can search and price anything, but it cannot pay. When it wants to
            spend, the request appears on your Home screen with the exact basket, the exact
            total, and a ceiling you approve. It cannot raise that ceiling, reuse it for
            anything else, or charge a different price than the one you saw - and you can
            cancel at any moment, even mid-payment.
          </div>
          {data.approvals.length > 0 && (
            <div className="tiny" style={{ marginTop: 10 }}>
              <strong>{data.approvals.length} request{data.approvals.length === 1 ? '' : 's'} waiting for you</strong> on Home.
            </div>
          )}
        </Step>
      </Card>
    </>
  );
}
