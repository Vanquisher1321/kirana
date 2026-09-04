import { useState } from 'react';
import type { Persona } from './App.tsx';
import { Mark } from './ui.tsx';

/**
 * The front door.
 *
 * This screen decides which of the three consoles a visitor gets, and it is
 * the first thing a judge sees. The version before it was an honest list of
 * three buttons, which read as a configuration step rather than a product.
 * This one is shaped like the sign-in every SaaS has, because that is what
 * makes the three consoles legible as one product with three audiences.
 *
 * It checks nothing, and it says so.
 *
 * A password box that silently accepts anything is theatre, and on a
 * submission that argues about key hashing three files away it would be a
 * credibility problem, not a nice touch. So the fields are here for shape and
 * are labelled optional, the sandbox note says plainly that nothing is
 * verified, and the button works with both boxes empty — a judge is never
 * made to invent a password to get in. The role still goes through
 * POST /api/session/role exactly as it did from the old list; nothing about
 * the server's idea of identity changed.
 */

const CONSOLES: Array<{ key: Persona; tab: string; title: string; blurb: string }> = [
  {
    key: 'merchant',
    tab: 'Merchant',
    title: 'the merchant console',
    blurb: 'Make your storefront buyable by AI assistants, decide which ones you trust, and see what they bought.',
  },
  {
    key: 'shopper',
    tab: 'Shopper',
    title: 'the shopper console',
    blurb: 'Approve or decline what your assistant wants to spend, set its limits, and see everything it did.',
  },
  {
    key: 'platform',
    tab: 'Razorpay',
    title: 'the Razorpay console',
    blurb: 'Merchants onboarded, transactions across every workspace, and what the guards stopped.',
  },
];

/** Four claims, each one a thing the console can actually be asked to prove. */
const PROOF: Array<{ icon: 'feed' | 'hand' | 'shield' | 'plug'; title: string; body: string }> = [
  { icon: 'feed', title: 'AI-readable catalogue', body: 'Read straight from the shop’s own feed. Nothing installed on their site.' },
  { icon: 'hand', title: 'Human in the loop', body: 'An assistant can ask. Only a person can approve the spend.' },
  { icon: 'shield', title: 'Guarded payments', body: 'Ceilings, duplicate catches and a kill switch that stops everything at once.' },
  { icon: 'plug', title: 'Works on shops as they are', body: 'No plugin, no integration, no cooperation needed from the merchant.' },
];

function Glyph({ name }: { name: 'feed' | 'hand' | 'shield' | 'plug' }) {
  const common = { stroke: 'currentColor', strokeWidth: 1.5, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const, fill: 'none' };
  return (
    <svg width="18" height="18" viewBox="0 0 20 20" aria-hidden="true" focusable="false">
      {name === 'feed' && <><path d="M4 5.5h12M4 10h12M4 14.5h7" {...common} /></>}
      {/* A person, not a gesture. At 18px a hand reads as an upload arrow —
          which is exactly what the first version of this icon looked like. */}
      {name === 'hand' && <><circle cx="10" cy="7" r="2.6" {...common} /><path d="M4.6 16.4a5.4 5.4 0 0 1 10.8 0" {...common} /></>}
      {name === 'shield' && <><path d="M10 2.9 4.4 5.1v4.4c0 3.2 2.3 6.1 5.6 7.6 3.3-1.5 5.6-4.4 5.6-7.6V5.1L10 2.9Z" {...common} /><path d="M7.6 9.7 9.4 11.5l3.2-3.4" {...common} /></>}
      {/* The shop itself, echoing the wordmark's mark — the claim is that an
          ordinary storefront needs no change, so the storefront is the icon. */}
      {name === 'plug' && <><path d="M4 8.6h12V15a1.4 1.4 0 0 1-1.4 1.4H5.4A1.4 1.4 0 0 1 4 15V8.6Z" {...common} /><path d="M4 8.6 5.3 4.2h9.4L16 8.6" {...common} /></>}
    </svg>
  );
}

export default function SignIn({ onChosen }: { onChosen: (r: Persona) => Promise<void> }) {
  const [role, setRole] = useState<Persona>('merchant');
  const [email, setEmail] = useState('');
  const [busy, setBusy] = useState(false);
  const chosen = CONSOLES.find((c) => c.key === role) ?? CONSOLES[0];

  function submit(e: React.FormEvent) {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    void onChosen(role).finally(() => setBusy(false));
  }

  return (
    <div className="app">
      <header className="topbar">
        <div className="row" style={{ gap: 10 }}>
          <div className="mark"><Mark /></div>
          <div className="brandname">Kirana</div>
          <div className="brandsub">Make any merchant AI-buyable</div>
        </div>
        <span className="live sandbox" style={{ marginLeft: 'auto' }}>Sandbox · test mode</span>
      </header>

      <div className="body skin-merchant signin-body">
        <div className="signin">
          {/* The claim, and the four things behind it. Hidden on narrow
              screens: on a phone the form is the whole job, and a column of
              marketing above it just pushes the thing you came for offscreen. */}
          <section className="signin-tell">
            <div className="eyebrow">AI commerce infrastructure</div>
            <h1 className="signin-claim">Make any merchant AI-buyable.</h1>
            <p className="signin-lede">
              The layer that lets an AI assistant search a real shop, get a real price and
              pay for it — with a person approving every rupee.
            </p>
            <ul className="proof">
              {PROOF.map((p) => (
                <li key={p.title}>
                  <span className="proof-i"><Glyph name={p.icon} /></span>
                  <span>
                    <b>{p.title}</b>
                    <span className="proof-b">{p.body}</span>
                  </span>
                </li>
              ))}
            </ul>
          </section>

          <section className="signin-form">
            <form className="card signin-card" onSubmit={submit}>
              <h2 className="signin-h">Sign in</h2>
              <p className="sub" style={{ marginTop: 6, marginBottom: 20 }}>
                Pick the console you want to see. You can only see your own.
              </p>

              <div className="fieldlabel" id="console-label">Console</div>
              <div className="segmented" role="radiogroup" aria-labelledby="console-label">
                {CONSOLES.map((c) => (
                  <button
                    key={c.key} type="button" role="radio" aria-checked={role === c.key}
                    className="seg" onClick={() => setRole(c.key)}
                  >
                    {c.tab}
                  </button>
                ))}
              </div>
              <p className="seg-blurb">{chosen.blurb}</p>

              <label className="fieldlabel" htmlFor="signin-email">
                Email <span className="opt">optional</span>
              </label>
              <input
                id="signin-email" className="field signin-field" type="email" autoComplete="off"
                placeholder="you@example.com" value={email} onChange={(e) => setEmail(e.target.value)}
              />

              <label className="fieldlabel" htmlFor="signin-pass">
                Password <span className="opt">optional</span>
              </label>
              <input
                id="signin-pass" className="field signin-field" type="password"
                autoComplete="new-password" placeholder="not checked in the sandbox"
              />

              <p className="signin-note">
                <b>Nothing here is verified.</b> This is the public sandbox: any details sign you in,
                and so does leaving both boxes empty. No account is created and no password is stored.
              </p>

              <button className="btn lg signin-go" type="submit" disabled={busy}>
                {busy ? <>Opening<span className="spin" style={{ marginLeft: 9 }} /></> : `Continue to ${chosen.title}`}
              </button>

              <p className="tiny signin-foot">
                Running on Razorpay test credentials. No real money can move.
              </p>
            </form>
          </section>
        </div>
      </div>
    </div>
  );
}
