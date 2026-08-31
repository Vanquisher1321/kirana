import { useState } from 'react';
import { api } from './api.ts';
import { Card, PageHead } from './ui.tsx';
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

function Step({ n, title, done, children }: {
  n: number; title: string; done: boolean; children: React.ReactNode;
}) {
  return (
    <div style={{ display: 'flex', gap: 14, alignItems: 'flex-start', marginBottom: 22 }}>
      <div
        aria-hidden
        style={{
          flex: '0 0 28px', height: 28, borderRadius: 999, display: 'grid', placeItems: 'center',
          fontSize: 13, fontWeight: 600, marginTop: 2,
          background: done ? '#0F766E' : 'rgba(127,127,127,0.16)',
          color: done ? '#fff' : 'inherit',
        }}
      >
        {done ? '\u2713' : n}
      </div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div className="h2" style={{ margin: 0, opacity: done ? 0.65 : 1 }}>{title}</div>
        <div style={{ marginTop: 8 }}>{children}</div>
      </div>
    </div>
  );
}

/** The one instruction nobody else spells out: what to DO with the link. */
function UseThisLink({ url }: { url: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <>
      <div className="mono tiny" style={{ wordBreak: 'break-all', marginBottom: 8 }}>{url}</div>
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
                Works with Shopify and WooCommerce shops today. Not sure? Try it - we tell you
                exactly what we could and could not read.
              </div>
            </>
          )}
        </Step>

        <Step n={2} title="Take your shop's AI address" done={Boolean(shop)}>
          {shop
            ? <UseThisLink url={shop.mcpUrl} />
            : <div className="tiny dim">Appears here once your shop is connected.</div>}
        </Step>

        <Step n={3} title="An assistant shops, you stay in control" done={visited}>
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
            Want a shop that is not listed? Add any Shopify or WooCommerce store and it becomes
            buyable in about two seconds.
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

        <Step n={2} title="Give the shop's link to your assistant" done={hasAsked}>
          {chosen
            ? <UseThisLink url={chosen.mcpUrl} />
            : <div className="tiny dim">Appears here once there is a shop to buy from.</div>}
        </Step>

        <Step n={3} title="Approve what it asks for" done={data.orders.length > 0}>
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
