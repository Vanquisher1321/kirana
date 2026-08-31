# Kirana

**Make any merchant AI-buyable.** Point it at a shop's website and, seconds later,
that shop has a machine-readable catalogue and a gated checkout that an AI agent
can actually buy from — with no plugin, no integration, and nothing for the shop
owner to install.

---

## The gap this fills

In February, Razorpay and NPCI launched **agentic payments on Claude** — an AI
assistant can now complete a UPI transaction inside a conversation. Razorpay also
ships an official MCP server for merchants, with 35+ tools across payments,
orders, refunds and settlements.

Put those two facts side by side and something is missing.

| | Status |
|---|---|
| **Buyer side** — agents that can pay | Shipped. Reserve Pay gives bounded, revocable consent |
| **Merchant operations** — an MCP server | Shipped. Payments, orders, refunds, payouts |
| **Merchant supply side** — a catalogue an agent can shop, and a checkout it can call | **Missing** |

Razorpay's MCP server has no catalogue, no inventory, no discovery and no agentic
checkout. It is for a merchant managing their own account, not for a buyer agent
shopping. And the live agentic pilots run with **Zomato, Swiggy and Zepto** —
three giants who each received a hand-built integration.

Razorpay has millions of merchants. You cannot hand-build integrations for
millions of merchants.

**Kirana is the machine that does that integration automatically.**

---

## What it does

Five stages. Every one of them is written to an audit trail.

1. **Read** — pulls the shop's real catalogue. Shopify serves an unauthenticated
   `/products.json` on essentially every store, so a large share of Indian D2C is
   already machine-readable; it just has nobody reading it.
2. **Publish** — generates a live MCP server for that merchant, so *any* buyer
   agent can discover, search and price its catalogue.
3. **Quote** — issues an HMAC-signed, expiring price the agent cannot alter.
4. **Gate** — a human approves a capped, scoped, revocable spend; thirteen guards
   re-check everything at the moment of payment.
5. **Settle** — creates a real Razorpay order and reconciles it against the
   gateway, so a lost webhook never means a lost payment.

### The ingestion ladder

Structured feeds first, a language model last:

| Tier | Source | Prices are | Built |
|---|---|---|---|
| 1 | Shopify `/products.json` | exact | **yes** |
| 2 | WooCommerce Store API | exact | designed, not built |
| 3 | schema.org product data | exact | designed, not built |
| 4 | Raw HTML read by a model | interpreted, **and flagged to buyers** | designed, not built |

That ordering is the engineering opinion of this project. Reaching for a model
first gives you a catalogue that is 95% right, which in a payments context is
another way of saying wrong.

---

## Proof it works

Not a mock. A real Indian storefront, a real Razorpay order, a real payment.

- **Blue Tokai Coffee Roasters** — a shop that has never heard of this project —
  was made AI-shoppable in under two seconds: **188 products, 997 buying
  options**, read from their own feed. Nobody at Blue Tokai did anything.
- An AI agent connected over MCP, searched within a budget, and was quoted
  **₹998.00** for two bags of Attikan Estate.
- It tried to pay **before** the human approved. **Refused** — six guards green,
  the seventh stopped it.
- After approval, thirteen guards ran and a real Razorpay order was created. The
  payment settled through a signature-verified webhook: `pay_TVwFLyLkAszbkQ`.

Then the interesting one:

> A ₹3,798.20 basket, with a human-approved cap of **₹4,000** — more than
> enough — was **still refused**, by a per-order ceiling the human cannot raise.
>
> `✓ consent_exists`  ·  `✓ within_consent_cap  ₹3,798.20 against a cap of ₹4,000.00`
> `✗ within_per_order_cap  ₹3,798.20 against ₹2,000.00 for unregistered agent`

**Consent is necessary but not sufficient.** "The human approved it" is exactly
what happens when someone is rushed, distracted or socially engineered, and it is
about to become a common failure mode. A ceiling that cannot be raised from
inside the flow is the only thing that holds at that moment.

---

## Run it

Node 22.18 or newer. Nothing else — no Docker, no database server, no build
toolchain.

```bash
git clone <this repo> && cd kirana
npm start
```

That installs both dependency sets, builds the console, seeds a demo shop, boots
the server and opens your browser. First run takes a minute; after that, seconds.

To take payments, copy `server/.env.example` to `server/.env` and add Razorpay
**test** keys. The server refuses to start on a live key — not a warning, a crash.

If you are going to commit to this repo, run `npm run hooks:install` once. It
installs a pre-commit hook that reads staged *content* and refuses anything that
looks like a key, a session id or an archive — the cases `.gitignore` cannot see
because it only knows filenames.

| Command | Does |
|---|---|
| `npm start` | Everything above |
| `npm run start:tunnel` | Same, plus a public HTTPS tunnel via Docker |
| `npm run agent -- --url <mcp-url> --want "coffee" --budget 1500` | A buyer agent in your terminal, driving the real protocol |
| `npm run probe` | Which real Indian storefronts are ingestable right now |
| `npm run reset` | Wipe and reseed for a clean demo take, without restarting |
| `npm test` | 127 tests |
| `npm run hooks:install` | Pre-commit secret scanning (do this once) |

### Try it as an AI agent

Connect the generated MCP URL (the console shows it, with a copy button) to any
MCP client, then ask it to buy something within a budget. It will search, quote,
request your approval — and stop until you give it.

No MCP client to hand? `npm run agent` does the same thing from the terminal and
prints every guard as it passes. That also proves the endpoint is a genuine
protocol surface rather than something that only works with one client.

---

## The three consoles

One system, three people, on a persona switcher.

- **Merchant** — connect once, get your AI address, decide which assistants you
  trust and how much, watch what they bought.
- **Shopper** — approve or decline what your assistant wants to spend, see your
  ceilings, read everything it did in plain English.
- **Razorpay** — merchants onboarded, transactions, assistants, and the number
  that matters most on a platform view: **what was stopped, and why.**

---

## How it is built

- **Node 22 + TypeScript, run directly.** Node strips types natively, so there is
  no build step, no bundler and no transpiler for the server.
- **Four dependencies:** `fastify`, `zod`, `@modelcontextprotocol/sdk`,
  `pino-pretty`. **Zero native modules**, so it installs and runs identically on
  Windows, macOS and Linux.
- **SQLite via `node:sqlite`**, built into Node. No database server.
- **~5,400 lines** of server source, and **127 tests**.

Money is an integer number of paise everywhere. `parseFloat("499.10") * 100`
returns `49909.999999999993`, and there is a test asserting we never do that.

See **[ARCHITECTURE.md](ARCHITECTURE.md)** for the design and its trade-offs,
**[SECURITY.md](SECURITY.md)** for the threat model — including a plainly stated
list of what it does *not* defend against — and **[FAILURES.md](FAILURES.md)**
for what broke along the way, including the bug that would have told a paying
customer they had not paid.

---

## What it does not do

Stated here rather than discovered by a reviewer.

- **Shopify only.** The other three ingestion tiers are designed, not built. A
  WooCommerce or hand-rolled store fails with "no adapter matched".
- **Test mode only.** No defence here has been exercised against real money.
- **Ingestion reads without asking.** It only ever reads data a shop already
  publishes, and identifies itself honestly — but in a real deployment consent
  would come through Razorpay merchant onboarding, not through crawling.
- **A hostile merchant could attempt prompt injection** against a buyer agent
  through a product description. Product text is stripped of markup, but this is
  unsolved industry-wide and is not solved here.
- **Rate limits are in memory** and do not survive a restart or span instances.
- **UAP is not implemented.** It is not publicly specified and still needs RBI
  approval. Kirana models the *consent shape* — bounded, scoped, expiring,
  revocable — and claims protocol-readiness, not protocol-compliance.

---

## Licence

MIT. Built for the Razorpay AI Buildathon, 2026.
