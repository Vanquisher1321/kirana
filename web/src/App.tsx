import { useCallback, useEffect, useState } from 'react';
import {
  api, getToken, setToken, clearToken, Unauthorized,
  type Agent, type Approval, type AuditRow, type Merchant, type Order, type SystemState, type Verification,
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
    ['home', 'Home'], ['activity', 'Activity'], ['limits', 'Limits'],
  ],
  platform: [
    ['overview', 'Overview'], ['merchants', 'Merchants'], ['transactions', 'Transactions'],
    ['assistants', 'AI Assistants'], ['div', ''], ['risk', 'Safety & Risk'],
  ],
};

const FIRST: Record<Persona, string> = { merchant: 'overview', shopper: 'home', platform: 'overview' };

export default function App() {
  const [persona, setPersona] = useState<Persona>('merchant');
  const [page, setPage] = useState('overview');
  const [data, setData] = useState<Data>({ loaded: false, merchants: [], approvals: [], audit: [], orders: [], agents: [], system: null, seal: null });
  const [locked, setLocked] = useState(false);
  const [needToken, setNeedToken] = useState(false);
  const [err, setErr] = useState('');
  const [shopId, setShopId] = useState('');

  const refresh = useCallback(async () => {
    try {
      const [merchants, approvals, audit, orders, agents, system, seal] = await Promise.all([
        api.merchants(), api.approvals(), api.audit(), api.orders(), api.agents(), api.system(), api.verify(),
      ]);
      setData({ loaded: true, merchants, approvals, audit, orders, agents, system, seal });
      setErr(''); setLocked(false);
    } catch (e) {
      if (e instanceof Unauthorized) setLocked(true);
      else setErr((e as Error).message);
    }
  }, []);

  useEffect(() => {
    void refresh();
    const t = setInterval(() => void refresh(), 3000);
    return () => clearInterval(t);
  }, [refresh]);

  function go(p: Persona) { setPersona(p); setPage(FIRST[p]); }

  if (locked) return <Unlock onUnlocked={() => { setLocked(false); void refresh(); }} />;

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
          <div className="brandsub">Agentic commerce on Razorpay</div>
        </div>

        <div className="personas" role="tablist">
          {(['merchant', 'shopper', 'platform'] as Persona[]).map((p) => (
            <button key={p} role="tab" className="persona" aria-selected={persona === p} onClick={() => go(p)}>
              {p === 'platform' ? 'Razorpay' : p[0]!.toUpperCase() + p.slice(1)}
            </button>
          ))}
        </div>

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

function Unlock({ onUnlocked }: { onUnlocked: () => void }) {
  const [value, setValue] = useState('');
  return (
    <div className="app">
      <header className="topbar">
        <div className="row" style={{ gap: 10 }}>
          <div className="mark">K</div>
          <div className="brandname">Kirana</div>
          <div className="brandsub">Agentic commerce on Razorpay</div>
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
