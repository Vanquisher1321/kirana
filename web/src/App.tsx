import { useCallback, useEffect, useRef, useState } from 'react';
import {
  api, getToken, setToken, clearToken, Unauthorized,
  type Agent, type Approval, type AuditRow, type Merchant, type Order, type Session, type SystemState, type Verification,
} from './api.ts';
import Merchant_ from './personas/Merchant.tsx';
import Shopper from './personas/Shopper.tsx';
import Platform from './personas/Platform.tsx';

export type Persona = 'merchant' | 'shopper' | 'platform';

export interface Data {
  loaded: boolean;
  merchants: Merchant[];
  approvals: Approval[];
  audit: AuditRow[];
  orders: Order[];
  agents: Agent[];
  system: SystemState | null;
  seal: Verification | null;
}

export interface PersonaProps {
  data: Data;
  shopId: string;
  setShopId: (id: string) => void;
  page: string;
  refresh: () => Promise<void>;
  onBlocked: () => void;
  watching: boolean;
}

const NAV: Record<Persona, Array<[string, string] | ['div', '']>> = {
  merchant: [
    ['overview', 'Overview'], ['catalogue', 'AI Catalogue'], ['orders', 'Orders'],
    ['assistants', 'AI Assistants'], ['div', ''], ['record', 'The Record'],
  ],
  shopper: [
    ['home', 'Home'], ['shops', 'Shops'], ['activity', 'Activity'], ['limits', 'Limits'],
  ],
  platform: [
    ['overview', 'Overview'], ['merchants', 'Merchants'], ['transactions', 'Transactions'],
    ['assistants', 'AI Assistants'], ['div', ''], ['risk', 'Safety & Risk'],
  ],
};

const FIRST: Record<Persona, string> = { merchant: 'overview', shopper: 'home', platform: 'overview' };

export default function App() {
  const [session, setSession] = useState<Session | null>(null);
  const [persona, setPersona] = useState<Persona>('merchant');
  const personaRef = useRef<Persona>('merchant');
  const [page, setPage] = useState('overview');
  const [data, setData] = useState<Data>({ loaded: false, merchants: [], approvals: [], audit: [], orders: [], agents: [], system: null, seal: null });
  const [locked, setLocked] = useState(false);
  const [needToken, setNeedToken] = useState(false);
  const [err, setErr] = useState('');
  const [shopId, setShopId] = useState('');

  const refresh = useCallback(async () => {
    try {
      // The Razorpay persona reads across every workspace; the merchant and
      // shopper views are confined to this visitor's own.
      const scope = personaRef.current === 'platform' ? 'platform' : 'mine';
      // A shopper browses the whole network of shops -- that is the point of a
      // directory. A merchant sees only the shops they connected.
      const shops = personaRef.current === 'shopper' ? 'directory' : scope;
      const [merchants, approvals, audit, orders, agents, system, seal] = await Promise.all([
        api.merchants(shops), api.approvals(scope), api.audit(60, scope), api.orders(scope), api.agents(scope), api.system(), api.verify(),
      ]);
      setData({ loaded: true, merchants, approvals, audit, orders, agents, system, seal });
      setErr(''); setLocked(false);
    } catch (e) {
      if (e instanceof Unauthorized) setLocked(true);
      else setErr((e as Error).message);
    }
  }, []);

  useEffect(() => {
    void (async () => {
      try {
        const s = await api.session();
        setSession(s);
        if (s.role) { personaRef.current = s.role; setPersona(s.role); setPage(FIRST[s.role]); }
      } catch { /* handled by refresh */ }
    })();
  }, []);

  useEffect(() => {
    if (!session?.role) return;
    void refresh();
    const t = setInterval(() => void refresh(), 3000);
    return () => clearInterval(t);
  }, [refresh, session?.role]);

  function go(p: Persona) {
    personaRef.current = p;
    setPersona(p);
    setPage(FIRST[p]);
    void refresh();
  }

  if (locked) return <Unlock onUnlocked={() => { setLocked(false); void refresh(); }} />;

  // Until a visitor says who they are, there is no dashboard to show. A
  // merchant does not get a platform console and a shopper does not get a
  // merchant one — role is a property of the account, not a tab.
  if (session && !session.role) {
    return <ChooseRole onChosen={async (r) => {
      await api.chooseRole(r);
      const s = await api.session();
      setSession(s);
      personaRef.current = r; setPersona(r); setPage(FIRST[r]);
      void refresh();
    }} />;
  }

  const demo = Boolean(data.system?.demo);
  const watching = !demo && !getToken();
  const paused = data.system?.killSwitch.engaged ?? false;
  const pending = data.approvals.length;

  // Default to the largest catalogue: a demo that opens on a 2-product fixture
  // undersells a system that read 188 products from a real shop.
  const shops = [...data.merchants].sort((a, b) => b.products - a.products);
  const activeShop = shops.find((m) => m.id === shopId) ?? shops[0];

  const shared: PersonaProps = {
    data, page, refresh, onBlocked: () => setNeedToken(true), watching,
    shopId: activeShop?.id ?? '', setShopId,
  };

  return (
    <div className="app">
      <header className="topbar">
        <div className="row" style={{ gap: 10 }}>
          <div className="mark">K</div>
          <div className="brandname">Kirana</div>
          <div className="brandsub">Make any merchant AI-buyable</div>
        </div>

        {session?.fullAccess ? (
          <div className="personas" role="tablist" title="Reviewer mode — a real account only ever sees its own console">
            <span className="demoswitch">Reviewing as</span>
            {(['merchant', 'shopper', 'platform'] as Persona[]).map((p) => (
              <button key={p} role="tab" className="persona" aria-selected={persona === p}
                onClick={() => { void api.chooseRole(p).catch(() => {}); go(p); }}>
                {p === 'platform' ? 'Razorpay' : p[0]!.toUpperCase() + p.slice(1)}
              </button>
            ))}
          </div>
        ) : (
          <span className="rolechip">
            {persona === 'platform' ? 'Razorpay · platform' : persona === 'merchant' ? 'Merchant' : 'Shopper'}
          </span>
        )}

        {session?.canEnableFullAccess && !session.fullAccess && (
          <button className="reviewbtn" title="See all three consoles at once"
            onClick={() => { void api.setFullAccess(true).then(setSession).then(() => refresh()); }}>
            Reviewing this? See all three
          </button>
        )}
        {session?.fullAccess && (
          <button className="reviewbtn off" title="Go back to a single console, as a real account would see it"
            onClick={() => { void api.setFullAccess(false).then(setSession).then(() => refresh()); }}>
            Exit reviewer mode
          </button>
        )}

        <div style={{ flex: 1 }} />

        <div className="row" style={{ gap: 8 }}>
          <span className="live">
            <i className={`livedot ${paused ? 'bad' : ''}`} />
            {paused ? 'Spending paused' : 'Live'}
          </span>
          {demo && <span className="live sandbox">Sandbox · test mode</span>}
          {!demo && getToken() && (
            <button className="persona" onClick={() => { clearToken(); setLocked(true); }}>Lock</button>
          )}
        </div>
      </header>

      <div className={`body skin-${persona}`}>
        <nav className="side">
          <div className="sidehead">
            <div className="t">{persona === 'merchant' ? (activeShop?.name ?? 'Your shop') : persona === 'shopper' ? 'AI Shopper' : 'Razorpay'}</div>
            <div className="s">{persona === 'merchant' ? 'Merchant console' : persona === 'shopper' ? 'Your assistant' : 'AI Commerce · Platform'}</div>
          </div>

          <div className="nav">
            {NAV[persona].map(([key, label], i) =>
              key === 'div'
                ? <div className="navdiv" key={`d${i}`} />
                : (
                  <button key={key} className="navitem" aria-selected={page === key} onClick={() => setPage(key)}>
                    <span>{label}</span>
                    {persona === 'shopper' && key === 'home' && pending > 0 && <span className="navbadge">{pending}</span>}
                    {persona === 'merchant' && key === 'orders' && data.orders.length > 0 && <span className="navbadge">{data.orders.length}</span>}
                  </button>
                ),
            )}
          </div>

          <div style={{ flex: 1 }} />

          <div className="sidefoot">
            {persona === 'shopper' ? (
              <>
                <div className="tiny">Pending approvals</div>
                <div className="num" style={{ fontSize: 20, fontWeight: 600, marginTop: 3 }}>{pending}</div>
              </>
            ) : (
              <>
                <div className="row" style={{ gap: 6, fontSize: 12, fontWeight: 600, color: paused ? 'var(--bad-deep)' : 'var(--ok-deep)' }}>
                  <i className={`livedot ${paused ? 'bad' : ''}`} />
                  {paused ? 'Spending paused' : 'AI commerce active'}
                </div>
                <div className="tiny" style={{ marginTop: 6, lineHeight: 1.45 }}>
                  {persona === 'merchant'
                    ? 'Your shop is AI-ready. No integration code required.'
                    : `${data.merchants.length} merchant${data.merchants.length === 1 ? '' : 's'} reachable by AI buyers.`}
                </div>
              </>
            )}
          </div>
        </nav>

        <main className="main">
          <div className={persona === 'shopper' ? 'page narrow' : 'page'}>
            {demo && !needToken && (
              <div className="banner warn" style={{ marginBottom: 20 }}>
                <span>
                  <strong>Sandbox.</strong> Everything here works and everything you see is real — but it runs on
                  Razorpay <strong>test</strong> credentials, so no real money can move. Go ahead and approve something.
                </span>
              </div>
            )}

            {watching && !needToken && (
              <div className="banner warn" style={{ marginBottom: 20 }}>
                <span>Approving, connecting a shop and pausing need the operator's token.</span>
                <button className="btn sm ghost" style={{ marginLeft: 'auto' }} onClick={() => setNeedToken(true)}>I have the token</button>
              </div>
            )}

            {needToken && (
              <div className="card" style={{ marginBottom: 20 }}>
                <div className="h2">That action needs the operator's token</div>
                <div className="sub" style={{ marginBottom: 14 }}>Reading is open on this demo. Anything that spends money or changes the system is not.</div>
                <div className="row">
                  <input className="field" type="text" placeholder="paste the console token" autoFocus
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        setToken((e.target as HTMLInputElement).value);
                        setNeedToken(false);
                        void refresh();
                      }
                    }} />
                  <button className="btn ghost" onClick={() => setNeedToken(false)}>Cancel</button>
                </div>
              </div>
            )}

            {err && <div className="banner bad" style={{ marginBottom: 20 }}>{err}</div>}

            {persona === 'merchant' && <Merchant_ {...shared} />}
            {persona === 'shopper' && <Shopper {...shared} />}
            {persona === 'platform' && <Platform {...shared} />}
          </div>
        </main>
      </div>
    </div>
  );
}

function ChooseRole({ onChosen }: { onChosen: (r: Persona) => Promise<void> }) {
  const [busy, setBusy] = useState('');
  const options: Array<[Persona, string, string]> = [
    ['merchant', 'I run a shop', 'Make your storefront buyable by AI assistants, decide which ones you trust, and see what they bought.'],
    ['shopper', 'I have an AI assistant', 'Approve or decline what it wants to spend, set your limits, and see everything it did.'],
    ['platform', 'I work at Razorpay', 'Merchants onboarded, transactions across every workspace, and what the guards stopped.'],
  ];
  return (
    <div className="app">
      <header className="topbar">
        <div className="row" style={{ gap: 10 }}>
          <div className="mark">K</div>
          <div className="brandname">Kirana</div>
          <div className="brandsub">Make any merchant AI-buyable</div>
        </div>
      </header>
      <div className="body skin-merchant">
        <main className="main">
          <div className="page narrow">
            <PageHeadLite title="Who are you here as?" sub="This decides which console you get. You can only see your own." />
            <div style={{ display: 'grid', gap: 12 }}>
              {options.map(([key, title, blurb]) => (
                <button key={key} className="rolecard" disabled={Boolean(busy)}
                  onClick={() => { setBusy(key); void onChosen(key).finally(() => setBusy('')); }}>
                  <div className="h2">{title}{busy === key && <span className="spin" style={{ marginLeft: 10 }} />}</div>
                  <div className="sub" style={{ margin: '4px 0 0' }}>{blurb}</div>
                </button>
              ))}
            </div>
          </div>
        </main>
      </div>
    </div>
  );
}

function PageHeadLite({ title, sub }: { title: string; sub: string }) {
  return (
    <div style={{ marginBottom: 22 }}>
      <div className="h1 big">{title}</div>
      <div className="sub">{sub}</div>
    </div>
  );
}

function Unlock({ onUnlocked }: { onUnlocked: () => void }) {
  const [value, setValue] = useState('');
  return (
    <div className="app">
      <header className="topbar">
        <div className="row" style={{ gap: 10 }}>
          <div className="mark">K</div>
          <div className="brandname">Kirana</div>
          <div className="brandsub">Make any merchant AI-buyable</div>
        </div>
      </header>
      <div className="body skin-merchant">
        <main className="main">
          <div className="page narrow">
            <div className="card" style={{ maxWidth: 560 }}>
              <div className="h2">Unlock the console</div>
              <div className="sub" style={{ marginBottom: 16 }}>
                This console can approve spending, pause every AI assistant and read the full record, so it is locked.
                Your token is printed in the server log when it starts.
              </div>
              <div className="row">
                <input className="field" type="text" placeholder="paste the console token" value={value} autoFocus
                  onChange={(e) => setValue(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter' && value.trim()) { setToken(value); onUnlocked(); } }} />
                <button className="btn" disabled={!value.trim()} onClick={() => { setToken(value); onUnlocked(); }}>Unlock</button>
              </div>
              <div className="tiny" style={{ marginTop: 16 }}>
                Set <code className="mono">KIRANA_CONSOLE_TOKEN</code> in <code className="mono">.env</code> to keep the same token across restarts.
              </div>
            </div>
          </div>
        </main>
      </div>
    </div>
  );
}
