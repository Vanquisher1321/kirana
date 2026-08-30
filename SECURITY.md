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
`x-kirana-agent` is a name in a header — any caller can send any value. Agents
sending only a name are registered as **unverified**, pinned to the
conservative default caps, and their caps **cannot be raised**; otherwise
anyone could inherit a trusted identity by copying a header. A real key
(`x-kirana-agent-key`) is required for a verified agent. Keys are stored as
SHA-256 hashes and shown exactly once. An unrecognised key is **rejected**, not
silently downgraded.

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

### Resource exhaustion
Fixed-window rate limits on the MCP surface (per agent) and on ingestion. Body
size, product count, crawl pages, quote lines and item quantities are all
bounded.

### Information leakage
Unexpected errors are logged, not returned. Config reporting shows whether a
secret exists, never its value. The server refuses to start with a live
Razorpay key.

## Known gaps

Stated plainly, because a security document that claims completeness is not
credible.

- **No TLS of its own.** It expects to sit behind a tunnel or reverse proxy.
- **Rate limits are per-process and in memory.** They do not survive a restart
  and would not hold across multiple instances.
- **The console token is a single shared secret.** No users, roles, rotation or
  expiry.
- **No CSRF tokens.** The console is token-authenticated rather than
  cookie-authenticated, so a cross-site request cannot borrow ambient
  credentials — but this would need revisiting if cookies were introduced.
- **Ingestion trusts merchant content.** Product text from a shop is stored and
  shown to buyer agents; it is stripped of markup, but a hostile merchant could
  still attempt prompt injection against a buyer agent through a product
  description. Mitigating that properly is unsolved industry-wide.
- **Test mode only.** The server refuses live keys, so no defence here has been
  exercised against real money.
