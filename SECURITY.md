# Security posture

Kirana lets a program spend a person's money. This document states what it
defends against, how, and — just as importantly — what it does not defend
against yet.

## Two modes, and which one you are reading about

`KIRANA_ACCESS` selects between them, defaulting to `demo` on plain localhost
and `locked` as soon as `PUBLIC_ORIGIN` is set — a console does not become
internet-facing and open by accident.

- **`locked`** is what this document describes: reading is open so the console
  stays legible, and every action that spends, approves, connects a shop,
  pauses the system or issues a key requires the operator's token.
- **`demo`** is the public sandbox. Nothing is gated, on purpose. It runs on
  Razorpay **test** credentials, the server refuses to boot on a live key, no
  real money can move, and every spend is still bounded by the same thirteen
  guards and the same ₹2,000 per-order ceiling. A sandbox nobody can drive is
  not a demonstration of anything.

## The two surfaces, and why they have opposite rules

| Surface | Who calls it | Protection |
|---|---|---|
| `/api/*` | the human console | **Bearer token required to act** (in `locked` mode). Reading is open; approving, pausing, connecting and key issuance are not. |
| `/mcp/*` | buyer agents | **Open by design**, protected by caps, consent and rate limits. |

The common mistake is the reverse: authenticate the agent and leave the approve
button open. An ecosystem where any agent can shop any merchant cannot gate
discovery behind a credential — but the button that says *"yes, spend my
money"* absolutely must be gated.

If `KIRANA_CONSOLE_TOKEN` is unset, a token is generated at boot and printed
once. There is no "no authentication" mode.

## Threats and mitigations

### Server-side request forgery — the sharpest edge here
`POST /api/ingest {url}` asks this server to fetch a URL the caller chose. That
is the exact shape of SSRF: someone who cannot reach a private network asks us
to reach it for them. On a cloud host the prize is the instance metadata
endpoint at `169.254.169.254`, which hands credentials to anything that asks
from inside.

Blocking the string `localhost` is not a defence. `127.0.0.1`, `0.0.0.0`,
`[::1]`, `::ffff:127.0.0.1`, `127.1`, a hostname whose DNS record points at
`10.0.0.5`, and a public URL that redirects to any of the above all arrive in
the same place.

So: the hostname is **resolved** and every returned address is checked against
loopback, private, link-local, CGNAT, multicast and reserved ranges; *all*
answers must be public, because which one gets used is not ours to choose; only
`http`/`https` on ports 80/443 are allowed; and redirects are followed
**manually with every hop revalidated**, because auto-following would undo the
check entirely.

### Agent identity is proven, not asserted
`x-kirana-agent` is a name in a header — any caller can send any value. A real
key (`x-kirana-agent-key`) is required to be treated as that agent. Keys are
stored as SHA-256 hashes and shown exactly once; an unrecognised key is
**rejected**, not silently downgraded.

Critically, **whether the caller proved its identity is carried explicitly**
from the HTTP layer into the authorisation decision. An earlier version looked
the claimed id up in the agents table and read its `verified` column — which
answers the wrong question ("is there a verified agent by this name?") and let
an impostor inherit a trusted agent's raised ceilings by typing its name. The
guard now receives `identityProven`, set only when a key matched. An unproven
caller gets the anonymous caps, shares the anonymous daily-spend pool, and
cannot spend an approval issued to a verified agent.

### Authorisation keys on the matched route, not the URL string
`request.url` is the raw, undecoded target, while the router decodes and
normalises before matching. `/%61pi/…`, `/API/…` and `//api/…` all reached the
`/api/` handlers while a raw-string prefix test saw something that did not begin
with `/api/`. All three bypassed the auth hook. It now keys on
`request.routeOptions.url`, the canonical pattern the router actually matched,
and there is a test firing those payloads at the kill switch.

### Price tampering
Quotes are HMAC-signed over their contents and re-derived from live catalog
prices at payment. An agent editing a stored total is caught by the signature;
a price that moved after quoting blocks the charge rather than billing the new
amount.

### Double charging
The idempotency key is claimed in the database *before* the gateway is called,
so concurrent duplicates are resolved by a `UNIQUE` constraint rather than by
timing. Webhook settlement is idempotent, because Razorpay retries by design.

### Spending beyond consent
Thirteen gates run at payment time. Consent is necessary but **not sufficient**:
per-order and rolling 24-hour platform ceilings apply on top, so an
over-enthusiastic human cannot approve past them.

### Webhook forgery
Signatures are verified against the **raw request bytes**, not a
re-serialisation of the parsed body — verifying against `JSON.stringify(body)`
compares our formatting to Razorpay's and rejects genuine webhooks while
proving nothing. If the server is publicly reachable (`PUBLIC_ORIGIN` set) and
no webhook secret is configured, webhooks are **refused**, because accepting
unsigned "payment captured" events from the open internet would let anyone mark
any order paid. The reconciler settles those orders safely instead.

### Path traversal
The built console is loaded into memory at boot and served from an exact-match
map. After startup the process never resolves a request path against the
filesystem, so traversal is structurally impossible rather than filtered.
`@fastify/static` was removed for this reason after it shipped four traversal
advisories.

### Resource exhaustion and brute force
Fixed-window rate limits on the MCP surface, on ingestion (per source address,
not one global bucket), and on **failed console authentication** — which also
writes a `console.auth_failed` entry to the audit chain, so a credential-stuffing
run leaves a trace rather than nothing. Rate-limit buckets key on a *proven*
identity or the source address, never on a header the caller can rotate freely.
Body size, product count, crawl pages, quote lines and item quantities are all
bounded.

### Settlement verifies the amount
An order is marked paid only when the captured amount and currency match what
was charged. Otherwise it records `settlement.amount_mismatch` and stays
unsettled — without this, a webhook or an edited payment link could settle a
large order with a small payment.

### Unsigned webhooks are refused by default
Accepting an unsigned webhook is an explicit opt-in
(`KIRANA_TRUST_LOCAL_WEBHOOKS=true`), never inferred. It previously keyed on
whether `PUBLIC_ORIGIN` happened to be set — a cosmetic variable used for
building links — so forgetting it on a public host silently turned refusal into
acceptance, letting anyone mark any order paid.

### The audit hash is length-prefixed
Fields are length-prefixed before hashing rather than joined by a delimiter.
A space-joined encoding hashes `{actor: "a b", action: "c"}` identically to
`{actor: "a", action: "b c"}`, so content could shift across a field boundary
while the chain still verified.

### Information leakage
Unexpected errors are logged, not returned. Config reporting shows whether a
secret exists, never its value. The server refuses to start with a live
Razorpay key.

### One visitor cannot reach another visitor's records

Every visitor gets a workspace on first contact — a `ws_...` identifier in an
HttpOnly, `SameSite=Lax` cookie, issued silently, no signup. Shops, agents,
orders, approvals and audit rows all carry the workspace that created them, and
every list endpoint filters on it.

Filtering lists is the easy half. The dangerous half is every route that takes
an **ID**, because there the ID *is* the query and there is no list to filter:

    POST /api/approvals/:id/approve

Without a check, any visitor could grant another visitor's spending by supplying
an identifier — the human half of the loop, bypassed entirely. `owns()` guards
approve, reject, revoke, `GET /approvals/:id`, `GET /orders/:id`,
`POST /agents/:id/caps` and `POST /agents/:id/key`. A caller from the wrong
workspace gets **404, not 403**, so the endpoint does not confirm that the ID
exists.

This is *not* relaxed in demo mode. The open sandbox is precisely where
strangers share one instance, so it is precisely where it matters most.

Two things stay deliberately wide:

- **Discovery.** `GET /api/merchants?scope=directory` lists every shop. Hiding
  it would hide nothing — the MCP endpoint is already open to the world — while
  breaking the premise that any agent can shop any merchant. Only the shop
  index is public; everything derived from a shop stays scoped.
- **The platform view.** Reading across tenants is what a platform console *is*.
  It requires the platform role or reviewer mode, and `?scope=platform` alone is
  a request, not a permission.

The operator token is treated as platform reach by default. Whoever holds the
deploy secret is running the instance, not visiting it; requiring them to append
`?scope=platform` to every call would answer `200` with an empty list and look
exactly like data loss.

## Known gaps

Stated plainly, because a security document that claims completeness is not
credible.

- **No TLS of its own.** It expects to sit behind a tunnel or reverse proxy.
- **Rate limits are per-process and in memory.** They do not survive a restart
  and would not hold across multiple instances.
- **The console token is a single shared secret.** No users, roles, rotation or
  expiry.
- **No CSRF tokens.** Cookies now exist, so this claim had to be rewritten:
  the workspace cookie is `SameSite=Lax`, which browsers do not attach to
  cross-site POSTs, and every state-changing route here is a POST. That is the
  whole defence. It is adequate and it is not belt-and-braces — a real
  deployment should add a double-submit token rather than rely on one browser
  behaviour.
- **Ingestion trusts merchant content.** Product text from a shop is stored and
  shown to buyer agents; it is stripped of markup, but a hostile merchant could
  still attempt prompt injection against a buyer agent through a product
  description. Mitigating that properly is unsolved industry-wide.
- **Test mode only.** The server refuses live keys, so no defence here has been
  exercised against real money.
- **DNS rebinding is not mitigated.** The SSRF guard resolves a hostname and
  then `fetch` resolves it again independently, so a zero-TTL zone answering
  public-then-private walks through. Fixing it properly means pinning the
  validated address at connection time.
- **The audit chain head is not externalised.** Anyone with write access to the
  database file can recompute the whole chain and pass verification. The chain
  proves nothing was edited *in place*; it does not defend against an attacker
  who owns the file.
- **The public sandbox is deliberately unauthenticated.** Test credentials only,
  hard caps still enforced, no real money can move. Workspaces mean a visitor
  can only approve their *own* spending, but two things remain open by design:
  anyone may select the Razorpay persona and get the cross-tenant read view
  (judges need it, and there is nothing confidential in a test-mode sandbox),
  and the stop button is global — so on the sandbox it auto-releases after a few
  minutes rather than letting one visitor freeze the demo for everyone after
  them.
- **Workspaces are cookies, not accounts.** Clearing cookies loses the
  workspace, and anyone holding the cookie value is that workspace. This is
  session-shaped tenancy for a sandbox, not authentication.
