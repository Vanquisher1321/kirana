import { useCallback, useEffect, useRef, useState } from 'react';
import {
  api, getToken, setToken, clearToken, Unauthorized,
  type Agent, type Approval, type AuditRow, type Merchant, type Order, type Session, type SystemState, type Verification,
} from './api.ts';
import { timeAgo } from './plain.ts';
import Merchant_ from './personas/Merchant.tsx';
import Shopper from './personas/Shopper.tsx';
import Platform from './personas/Platform.tsx';
import { Mark } from './ui.tsx';
import SignIn from './signin.tsx';

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
    ['start', 'Getting started'], ['overview', 'Overview'], ['catalogue', 'AI Catalogue'], ['orders', 'Orders'],
    ['assistants', 'AI Assistants'], ['div', ''], ['record', 'The Record'],
  ],
  shopper: [
    ['start', 'Getting started'], ['home', 'Home'], ['shops', 'Shops'], ['activity', 'Activity'], ['limits', 'Limits'],
  ],
  platform: [
    ['overview', 'Overview'], ['merchants', 'Merchants'], ['transactions', 'Transactions'],
    ['assistants', 'AI Assistants'], ['div', ''], ['risk', 'Safety & Risk'],
  ],
};

// A first-time visitor lands on the guide, not on an empty dashboard. Once
// setup is done every step reads as complete, so it costs a returning user one
// glance and saves a new one from having to guess.
const FIRST: Record<Persona, string> = { merchant: 'start', shopper: 'start', platform: 'overview' };

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
  const [lastRead, setLastRead] = useState<number | null>(null);
  const [reloading, setReloading] = useState(false);
  const sealAskedAt = useRef(0);

  const refresh = useCallback(async () => {
    // The Razorpay persona reads across every workspace; the merchant and
    // shopper views are confined to this visitor's own.
    const scope = personaRef.current === 'platform' ? 'platform' : 'mine';
    // A shopper browses the whole network of shops -- that is the point of a
    // directory. A merchant sees only the shops they connected.
    const shops = personaRef.current === 'shopper' ? 'directory' : scope;

    /**
     * The seal is asked for on a clock of its own, not once per refresh.
     *
     * verify() re-walks and re-hashes EVERY row in the audit log, so it costs
     * more with every row the instance has ever written -- and the server caps
     * it at 12 a minute for exactly that reason. `wantSeal` was a hardcoded
     * `true` sitting under a comment claiming the opposite, so the 5s poll
     * spent that entire budget on the one endpoint that is O(all history):
     * twelve reads a minute from one tab, and the thirteenth -- a second tab,
     * the mount read, a persona switch, the refresh button -- came back 429.
     *
     * Once a minute is the right cadence for a value that only changes if
     * somebody edits the database underneath us, and it leaves the budget for
     * the deliberate reads. Timestamped BEFORE the call so a failure backs off
     * rather than retrying every five seconds.
     */
    const SEAL_EVERY_MS = 60_000;
    const wantSeal = Date.now() - sealAskedAt.current >= SEAL_EVERY_MS;
    if (wantSeal) sealAskedAt.current = Date.now();

    /**
     * One failed read must not blank the console.
     *
     * These went out under a single Promise.all, which rejects whole: one 429
     * on any of the seven -- and the seal was reliably producing one -- meant
     * setData never ran at all, so the entire dashboard froze on stale numbers
     * behind an error banner. Everything that answered is shown; anything that
     * did not keeps its previous value and says so once.
     */
    let unauthorized = false;
    const failures: string[] = [];
    const soft = async <T,>(p: Promise<T>): Promise<T | null> => {
      try { return await p; } catch (e) {
        if (e instanceof Unauthorized) unauthorized = true;
        else failures.push((e as Error).message);
        return null;
      }
    };

    const [merchants, approvals, audit, orders, agents, system, seal] = await Promise.all([
      soft(api.merchants(shops)), soft(api.approvals(scope)), soft(api.audit(60, scope)),
      soft(api.orders(scope)), soft(api.agents(scope)), soft(api.system()),
      wantSeal ? soft(api.verify()) : Promise.resolve(null),
    ]);

    // A token problem is about the whole console, not about one endpoint.
    if (unauthorized) { setLocked(true); return; }

    const answered = [merchants, approvals, audit, orders, agents, system].some((v) => v !== null);
    setData((prev) => ({
      loaded: prev.loaded || answered,
      merchants: merchants ?? prev.merchants,
      approvals: approvals ?? prev.approvals,
      audit: audit ?? prev.audit,
      orders: orders ?? prev.orders,
      agents: agents ?? prev.agents,
      system: system ?? prev.system,
      seal: seal ?? prev.seal,
    }));
    if (answered) setLastRead(Date.now());
    setErr(failures[0] ?? '');
    setLocked(false);
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
  }, [refresh, session?.role]);

  /**
   * Live only while someone is watching.
   *
   * This used to poll seven endpoints every three seconds from every open tab,
   * which on Render's free tier spends the bandwidth allowance and the 750
   * instance-hours at once -- and a polling tab never lets the service go idle,
   * so the thing most likely to take the site down before it was judged was the
   * site refreshing itself. The fix for that was to stop polling entirely, and
   * it went too far: an approval arrives from an assistant, not from anything
   * you did, so the one screen that must not wait for a click is the one that
   * asks you to approve a payment. Watching a request sit invisible until you
   * press refresh is not a saving, it is a broken product.
   *
   * So it polls, under two conditions that answer the original objection
   * exactly. It stops the moment the tab is hidden -- a backgrounded tab is
   * what actually holds an instance awake, and it is also the tab nobody is
   * reading. And a visible tab left alone stops after ten minutes, restarting
   * when it is looked at again, so a forgotten window cannot keep the service
   * up all night.
   */
  useEffect(() => {
    if (!session?.role) return;
    const EVERY_MS = 5_000;
    const IDLE_STOP_MS = 10 * 60 * 1000;

    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let awakeSince = Date.now();

    const wake = () => {
      if (document.visibilityState === 'visible') {
        awakeSince = Date.now();
        void refresh();
      }
    };
    document.addEventListener('visibilitychange', wake);

    const tick = () => {
      if (cancelled) return;
      const watching = document.visibilityState === 'visible';
      const fresh = Date.now() - awakeSince < IDLE_STOP_MS;
      if (watching && fresh) void refresh();
      timer = setTimeout(tick, EVERY_MS);
    };
    timer = setTimeout(tick, EVERY_MS);

    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
      document.removeEventListener('visibilitychange', wake);
    };
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
    return <SignIn onChosen={async (r) => {
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
          <div className="mark"><Mark /></div>
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
          {/* It refreshes itself while you are watching, and stops when you are
              not. The button stays because the age of the data is worth stating
              either way, and because a stopped tab needs a way back. */}
          <button
            className="reviewbtn"
            title="Updates every few seconds while this tab is visible. Click to read now."
            disabled={reloading}
            onClick={() => { setReloading(true); void refresh().finally(() => setReloading(false)); }}
          >
            {reloading ? 'Reading…' : lastRead ? `Updated ${timeAgo(new Date(lastRead).toISOString())}` : 'Refresh'}
          </button>
          <span className="live">
            <i className={`livedot ${paused ? 'bad' : ''}`} />
            {paused ? 'Spending paused' : 'Accepting AI payments'}
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
          {/* Reading pages get a narrower column than data pages. The guide is
              prose and one input; at 1240px it was a paragraph floating in a
              field of nothing. */}
          <div className={persona === 'shopper' || page === 'start' ? 'page narrow' : 'page'}>
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
          <div className="mark"><Mark /></div>
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
