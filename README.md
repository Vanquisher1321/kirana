# Kirana

**Make any merchant AI-buyable.** Point it at a shop's website and, seconds later,
that shop has a machine-readable catalogue and a gated checkout that an AI agent
can actually buy from — with no plugin, no integration, and nothing for the shop
owner to install.

**Try it now — nothing to install:** **<https://kirana-6cv8.onrender.com>**

Paste any Shopify storefront (`bluetokaicoffee.com` works) and you get a live MCP
address about eight seconds later. Hand that address to any AI assistant — in
Claude, *Customize → Connectors → Add custom connector* — and ask it to buy
something.

As a shopper you get **one** link covering every shop you have added, so an
assistant wired up once keeps working as you add more. It runs on Razorpay **test** credentials, so no real money can move,
and the server refuses to start on a live key.

The sandbox is a free instance: a cold visit takes about a minute to wake, and it
re-seeds itself so nobody can leave it broken for the next person.

---

## Track 01, clause by clause

The bar for **AI Growth & Agentic Commerce** is one sentence:

> Every money action explainable, bounded and gated. Show the audit trail and one
> failure handled gracefully.

Everything below is in this repo and running at the live sandbox. This table is
here so you do not have to go looking.

| The bar | Where it is | What you will find |
|---|---|---|
| **Explainable** | [`server/src/checkout/guard.ts`](server/src/checkout/guard.ts) — `authorise()` | One choke point every rupee passes through. It returns the **full check list, pass or fail** — 13 named gates, each carrying a plain-English sentence: *"The same request can never charge twice."* *"Approval is tied to one specific basket."* A guard that returned a bare boolean could not explain itself, so this one never does. |
| **Bounded** | `guard.ts` — `agentCaps()`, `spentTodayMinor()`<br>[`checkout/standing.ts`](server/src/checkout/standing.ts) | A per-order ceiling and a rolling 24-hour ceiling on every agent. ₹2,000 / ₹10,000 for anyone who has not proven an identity, and no way to raise them from the agent side. Standing approvals add two more ceilings and a hard expiry. |
| **Gated** | [`checkout/consent.ts`](server/src/checkout/consent.ts) | An agent may **request** approval and can never **grant** it — the two paths are separate functions and only the console reaches the second. Consent is scoped to one basket, one agent, and a clock. A kill switch stops every agent mid-flight. |
| **Show the audit trail** | [`server/src/audit/ledger.ts`](server/src/audit/ledger.ts)<br>`GET /api/audit/verify`<br>Merchant console → **The Record** | Append-only and hash-chained: each line seals the one before it, so an edited, reordered or deleted entry is detectable rather than merely discouraged. The verify endpoint re-reads and re-hashes every row and answers whether the chain still holds. 35 distinct action types are recorded. |
| **One failure handled gracefully** | [`server/src/razorpay/client.ts`](server/src/razorpay/client.ts) — circuit breaker<br>`checkout.deduplicated`, `checkout.blocked`, `settlement.amount_mismatch` | Four consecutive gateway failures open a breaker for 30 seconds and the next attempt is refused **before** a request is sent, with the reason named. A replayed checkout is deduplicated rather than charged twice. A settlement whose amount does not match the quote is recorded as a mismatch, not accepted. |
| **Transactable end to end** | Live sandbox | Paste a storefront, get an MCP address, hand it to any assistant. Measured: **30 of 44** real Indian storefronts work today ([COMPATIBILITY.md](COMPATIBILITY.md)) — including 183 products and 956 buying options from Blue Tokai in about eight seconds. |

Two things the bar asks for that are easy to claim and hard to prove, so here is
the proof rather than the claim:

- **The audit trail is evidence, not logging.** Hashing is length-prefixed, so no
  value can be shifted across a field boundary while the chain still verifies.
  Open **The Record** and the banner tells you whether the seal holds.
- **The failure is handled where it happens, not swallowed.** Every refusal names
  its gate and lands in the ledger, which is why the Razorpay console can show
  *why* payments were stopped rather than only how many.

Also in the repo because the submission asks for it: [ARCHITECTURE.md](ARCHITECTURE.md),
[SECURITY.md](SECURITY.md), [COMPATIBILITY.md](COMPATIBILITY.md), and
[FAILURES.md](FAILURES.md) — 11 write-ups of things that broke, how each was
found, and what changed afterwards. 146 tests, 0 failing.

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

| Tier | Source | Prices are | Merchant does | Built |
|---|---|---|---|---|
| 0 | **A feed the merchant hands us** | exact, authoritative | pastes one URL | designed, not built |
| 1 | Shopify `/products.json` | exact | nothing | **yes** |
| 2 | WooCommerce Store API | exact | nothing | designed, not built |
| 3 | schema.org / JSON-LD product data | exact | nothing | designed, not built |
| 4 | Raw HTML read by a model | interpreted, **and flagged to buyers** | nothing | designed, not built |

Tier 0 sits above Shopify on purpose. Every other rung is Kirana working out what
a shop sells; tier 0 is the shop telling us, from the product feed it already
maintains for Google Shopping. It is more accurate than any adapter can be, it
works on platforms no adapter will ever cover, and a merchant who pastes that URL
has consented — which crawling cannot establish at all. See
[Who Kirana is for](#who-kirana-is-for-and-who-it-deliberately-leaves-alone).

Tier 1 alone reaches further than it sounds. **Thirty real brands** — Blue Tokai,
Sleepy Owl, Subko, boAt, SUGAR, Snitch, Nicobar, Chumbak, Mokobara, Suta,
Allbirds, Gymshark, ColourPop and eighteen more — were made agent-purchasable
straight from the live sandbox: **over 9,000 products and 26,000 buying
options**, no model involved, none of those shops asked or told. Fourteen more
were refused, explicitly and with a reason. The measured list, wins and failures
both, is in [COMPATIBILITY.md](COMPATIBILITY.md).

To check any shop in five seconds, open `https://<the-shop>/products.json`. JSON
means it works. That is the same request Kirana makes.

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

## Who Kirana is for, and who it deliberately leaves alone

The most common question about this project is "what about Amazon?" — so here is
the answer, because the scope is a design decision rather than a limitation we
have not got around to.

### Marketplaces are not the target, and should not be

Amazon, Flipkart, Nykaa and Myntra are not blocked by anything technical. They
are excluded because **reading a catalogue is the easy half; the right to take
the payment is the hard half.**

Kirana works by creating a Razorpay payment link. That is legitimate exactly
when the shop being read is the party being paid. A marketplace never agreed to
that, cannot fulfil an order raised outside its own checkout, and would be
perfectly right to treat it as fraud. Scraping one would mean fighting anti-bot
systems and terms of service in order to produce a payment link that nobody will
honour — a very sophisticated way to take money for an order that does not
exist.

There is a business reason on top of the technical one. **Amazon does not need
Razorpay, and Razorpay does not earn on Amazon.** Amazon has its own agentic
commerce roadmap and the engineers to build it. The merchants who cannot build
this themselves — and who are already Razorpay's customers — are the entire
point. Building for Amazon would make this a scraping project. Building for the
merchant base makes it infrastructure.

If a marketplace ever *should* be reachable, the route is its own partner API
under a commercial agreement, not extraction. That is a business development
problem, not an engineering one.

### Own-brand storefronts are the target, including the ones that fail today

Wakefit, The Souled Store, Bewakoof, Forest Essentials, Kama Ayurveda, Ustraa
and the rest of [COMPATIBILITY.md](COMPATIBILITY.md)'s failures are a completely
different case from a marketplace. They **own their inventory and their
checkout**, so a Razorpay link is exactly right for them. They fail today only
because they are not on Shopify, and that is an adapter away.

Three of the four routes to them need nothing from the merchant at all:

| Route | Prices are | Needs the merchant to | Reaches |
|---|---|---|---|
| **Shopify `/products.json`** | exact | nothing | ~a quarter of Indian D2C — **built** |
| **WooCommerce Store API** | exact | nothing | most WordPress shops |
| **JSON-LD `Product` markup** | exact | nothing | almost any storefront with SEO |
| **A feed the merchant hands us** | exact | one URL, once | anything at all |

**JSON-LD is the big one.** Custom storefronts already embed schema.org `Product`
data — name, price, currency, availability — on every product page, deliberately,
so Google Shopping can read it. It is structured data published *for machines to
consume*, it is exact, and it cuts straight across platforms: Magento, a bespoke
React storefront, an in-house PHP monolith. A shop that ranks on Google is
usually already publishing everything Kirana needs.

### The fourth route: the merchant just tells us

The three adapters above are Kirana meeting a storefront where it stands. The
fourth turns the problem around, and it is the one that actually scales.

A shop that sells online almost certainly already generates a **product feed** —
a Google Merchant Center XML or TSV file, or a Meta catalogue — because that is
how it advertises. It is a complete, authoritative, machine-readable list of
everything it sells, with prices and stock, maintained by the merchant because
their ad spend depends on it being right.

So the highest tier of the ladder is not a cleverer scraper. It is a text box
that says *"paste your product feed URL"*:

- **It is exact and authoritative.** The merchant's own numbers, not our reading
  of their HTML. No adapter can be more correct than this.
- **It works on every platform**, including the in-house ones no adapter will
  ever cover.
- **It is consent.** A merchant who pastes a feed URL has said yes — which is the
  thing crawling can never establish, and which a real Razorpay deployment would
  want anyway.
- **It is five minutes of their existing dev team's time**, because the file
  already exists.

That inverts the onboarding story for the shops adapters cannot reach: instead of
"we could not read your site", the merchant gets "paste the feed you already give
Google". In a real Razorpay deployment this becomes a field in merchant
onboarding, and the crawler becomes the fallback rather than the front door.

**Ranked by what they would actually unlock:** the merchant feed first, because
it is the only route that is both universal and consented; JSON-LD second,
because it needs nothing from anyone and covers most custom storefronts;
WooCommerce third. A model reading raw HTML stays last, and anything it produces
is flagged to buying agents as interpreted rather than read.

---

## What it does not do

Stated here rather than discovered by a reviewer.

- **Shopify only.** The other ingestion routes are designed, not built. A
  WooCommerce or hand-rolled store fails with an explicit "no adapter matched"
  rather than an empty catalogue. Thirty real shops work today; fourteen tested
  do not, and both lists are in [COMPATIBILITY.md](COMPATIBILITY.md).
- **Marketplaces are out of scope by design, not by accident.** See above: the
  blocker is the right to take the payment, not the ability to read a catalogue.
- **Test mode only.** No defence here has been exercised against real money.
- **Ingestion reads without asking.** It only ever reads data a shop already
  publishes, and identifies itself honestly — but in a real deployment consent
  would come through Razorpay merchant onboarding, not through crawling.
- **A hostile merchant could attempt prompt injection** against a buyer agent
  through a product description. Product text is stripped of markup, but this is
  unsolved industry-wide and is not solved here.
- **A buyer link is a bearer key.** One link covers every shop its owner has
  connected, which is the point — but anyone holding it can shop those shops
  within the owner's limits. There is no second factor. Rotating it from the
  console kills the old one instantly, and that is the whole revocation story.

- **Rate limits are in memory** and do not survive a restart or span instances.
- **UAP is not implemented.** It is not publicly specified and still needs RBI
  approval. Kirana models the *consent shape* — bounded, scoped, expiring,
  revocable — and claims protocol-readiness, not protocol-compliance.

---

## Licence

All rights reserved. Built for the Razorpay AI Buildathon, 2026.

Public so it can be read, cloned and run for review. No licence is granted for
commercial use — get in touch if you want one.
