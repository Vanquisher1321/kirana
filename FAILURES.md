# What broke, and what it taught us

The buildathon asks for a written explanation of the technical failures we hit
and how we solved them. This is that document, written honestly — including the
ones we caused ourselves.

A theme runs through the worst of them, so it is worth stating first:

> **The dangerous bugs were the ones our tests could not catch, because the tests
> encoded the same misunderstanding as the code.**

Every one of those was found by doing the real thing against the real API. None
were found by writing more tests against our own assumptions.

---

## 1. The system would have said "unpaid" for a customer who had paid

**Severity: the worst class of payments bug.**

### What happened

Checkout created a Razorpay **Order** and, separately, a Razorpay **Payment
Link**. We never connected them. The reconciler then polled the *order's* payment
list to decide whether money had arrived.

A customer paying the link produces a payment against the **link**. The order's
payment list stays empty. Forever.

So the failure mode was: the customer pays, the money is really taken, and our
system reports `awaiting_payment` indefinitely. The merchant sees an unpaid
order. The customer sees a debit.

### Why our tests missed it

We had eight passing tests for the reconciler. Every one of them mocked a gateway
in which paying produced a payment on the order — because that is what we
believed. **The tests asserted our misunderstanding back to us.**

Worse, the mock returned the *same* payment list for every order it was asked
about. A mock that ignores its input does not model a gateway, it models a global
variable — and it hides precisely the cross-order bugs a reconciliation sweep is
most likely to have.

### How it was found

By paying a real ₹998 order with real Razorpay test-mode netbanking, on a real
tunnel, and watching the order sit at `awaiting_payment`.

### The fix

- Orders now store `razorpay_payment_link_id` alongside `razorpay_order_id`.
- The reconciler checks **the payment link first**, then falls back to the order.
- The fake gateway now answers **per order id**, so a sweep cannot be fooled by
  leakage between orders.

### What changed in how we work

We stopped treating a green test suite as evidence about the outside world. Tests
prove the code does what we think; only the real API proves what we think is
right.

---

## 2. Every genuine Razorpay webhook would have been rejected as a forgery

### What happened

Webhook signature verification computed the HMAC over
`JSON.stringify(request.body)` — our re-serialisation of Razorpay's JSON, not the
bytes Razorpay actually signed.

Any difference in key order, spacing or unicode escaping produces a different
digest. Razorpay would have sent a perfectly valid `payment.captured`, and we
would have answered `400 invalid signature` and left the order unsettled.

The bug is quiet in the worst way: it fails **closed**, so nothing looks broken
until you notice payments never settle.

### The fix

A custom content-type parser preserves the raw request body, and the signature is
verified against those exact bytes. There is now a test that posts the same
payload with the keys in a **different order** and asserts it still verifies —
that test fails against the old code.

### Confirmation

The first real webhook Razorpay ever sent us settled the order correctly. Until
that moment the fix was an argument; afterwards it was a fact.

---

## 3. We introduced a dependency that shipped four path-traversal advisories

### What happened

To serve three built files, we added `@fastify/static`. `npm audit` then reported
a high-severity finding: four separate path-traversal and route-guard-bypass
advisories against that package.

### The fix, and why it was not an upgrade

A patched version existed. We removed the dependency instead.

The console is now read into memory once at boot and served from a `Map` keyed by
exact URL path. **After startup the process never resolves a request path against
the filesystem**, so traversal is not filtered — it is structurally impossible.

There is a test that fires twelve classic payloads at it — `/../secrets/.env`,
`/%2e%2e%2fsecrets%2f.env`, `/....//`, backslash variants, and a symlink pointing
at a directory holding a fake `RAZORPAY_KEY_SECRET` — and asserts every one
returns the app shell and none leaks the secret.

### What it taught us

Four advisories against one library is not evidence the authors were careless. It
is evidence that *"resolve a user-supplied string to a filesystem path"* is a
hazardous operation. We did not need it, so we stopped needing it.

We also stopped treating `npm audit fix --force` as a fix. It was offering a
major-version jump to make a warning disappear. Read the advisory, then decide
whether you need the thing at all.

---

## 4. An edit of ours silently deleted the entire MCP endpoint

**Self-inflicted, and the most instructive.**

### What happened

While rewriting the webhook handler with a scripted edit, the replaced span
reached further than intended and removed the `app.all('/mcp/:slug')` route
outright. The server still started. Health checks still passed. **No buyer agent
could reach any merchant** — which is the entire product.

### How it was caught

Every MCP test went red simultaneously, about ninety seconds later. The suite
drives real JSON-RPC over real HTTP against a listening server rather than
mocking the transport, so "the route does not exist" is indistinguishable from
"the handshake fails" — and both fail loudly.

Had those tests been shallower — asserting on handler functions instead of the
wire — we would have shipped a repo whose central feature was absent.

### What changed

Broad scripted edits are now anchored on both ends and verified by a route
inventory afterwards, not just by a typecheck.

---

## 5. SQL parameters bound in the wrong order returned silently wrong rows

### What happened

Catalogue search assembled its bound parameters in the order the *options* were
read, but the SQL text put JOIN conditions before the WHERE clause. As soon as a
price filter introduced a JOIN, the parameters mismatched.

SQLite did not error. It returned **the wrong rows**.

For a shopping catalogue that is exactly the failure that reaches a buyer agent
as a wrong price.

### The fix

Parameters are now assembled in SQL-text order — JOIN parameters, then WHERE
parameters, then the limit — with a comment explaining why. Caught by a
price-ceiling test asserting specific counts rather than "some results".

---

## 6. A foreign key caught that agents were never really registered

Consent rows referenced an `agents` table that nothing ever wrote to. The
constraint failed, which was the database telling us the identity model was
incomplete.

Fixing it forced a decision we had been avoiding: **what do you do with an agent
that has never introduced itself?** Refusing unknown agents makes the system
useless in an ecosystem whose whole premise is that any agent can walk up to any
shop. Letting them in uncapped is reckless.

So: let them in, cap them low, record the moment they first appeared, and refuse
to raise the cap until they prove an identity with a key. A name in a header
proves nothing — anyone can send the same header.

A second correction followed: agents were registering on their first *purchase*
rather than their first *contact*. An agent that has only browsed is still an
agent the merchant should be able to see and cap.

---

## 7. A failed payment attempt was closing the order

Discovered in the same incident as failure #1. The customer's first attempt
failed 3-D Secure authentication — the single most common outcome in Indian card
payments — and the reconciler marked the order dead.

But a human fixes that by paying the same link again. Closing the order on the
first failure strands a buyer who is one retry away from paying.

A failed attempt now leaves the order open and is counted, not fatal. There is a
test named after this incident: it fails, retries on the same link, and settles.

---

## 8. Environment failures worth recording

**SQLite WAL mode threw a bare `disk I/O error`.** WAL needs a shared-memory
sidecar file that some filesystems — network shares, virtualised mounts, certain
Windows setups — refuse. The error names none of that. Journal mode is now
attempted and quietly abandoned rather than being a hard dependency; throughput
is irrelevant at this scale, portability is not.

**Node's strip-only TypeScript rejects parameter properties.** `constructor(readonly x)`
fails with `ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX`, because the mode erases types
rather than transforming code — the same applies to enums and namespaces. This is
the price of having no build step, and we decided it was worth paying so that a
reviewer can clone and run with no toolchain.

**`node_modules` is not portable across operating systems.** Installing from a
Linux environment into a Windows-mounted folder produced Linux binaries for
`rollup` and `esbuild`, and the Windows build then failed with `MODULE_NOT_FOUND`.
The server has zero native dependencies specifically so it does not have this
problem; only the web build does.

---

## 9. Interface failures we found by looking, not by testing

Typechecks and unit tests pass happily on an interface that is wrong. These were
found by rendering it and inspecting it.

**Tables claimed to be empty before we had looked.** Every list rendered "No
orders yet" during the first fetch. Loading and empty are different states, and
saying "you have nothing" when the truthful answer is "we don't know yet" is a
lie the interface tells. Skeletons now hold the shape until the data is known.

**A role confusion put "Connect a shop" on the merchant's own dashboard.** The
merchant *is* the shop; offering them a box to attach a different one implies a
model we do not have. Connecting is now an onboarding empty state for a merchant,
and a bulk action on the Razorpay console where it belongs.

**The demo defaulted to a 2-product fixture while a 188-product real shop sat one
row away.** "Products readable: 2" makes a system look like a toy no matter how
good the typography is. The console now defaults to the largest catalogue.

That last one is the most transferable lesson in this document: **a demo's data
does more for perceived quality than its design does.**

---

## 10. Adding multi-tenancy opened a hole bigger than the one it closed

The sandbox was open by design, and that felt wrong once it was real: any
visitor could see any other visitor's shops and orders. So workspaces went in —
a silent cookie per visitor, a `workspace_id` on every table, and scoped list
queries.

An hour later, running a final sweep before committing, we counted how many
`/api` routes actually applied the scope.

**Seven out of twenty-one.**

The list endpoints were all fine, because scoping a list is the change you
naturally make: you are already writing the query, so you add the column. What
we had not touched was every route that takes an **ID** — and those are the ones
that matter, because an ID-addressed route has no list to filter. The ID *is*
the query.

The worst of them:

```
POST /api/approvals/:id/approve
```

No workspace check. Any visitor could approve any other visitor's spending by
supplying its identifier. The entire premise of this project is that a human
approves before an agent spends; we had just built a way to be that human for
a stranger.

Two things about how this happened are worth stating plainly:

- **We introduced it ourselves, in the change meant to improve safety.** Adding
  isolation to a system that had none creates a new invariant, and every
  existing route silently fails to hold it. The change is not "add a column";
  it is "audit every caller".
- **All 109 tests still passed.** They were written when there was one shared
  tenant, so not one of them had two visitors in it. A test suite cannot fail on
  a distinction it has never expressed.

The fix is an `owns()` check on all seven ID-addressed routes, returning **404
rather than 403** so the endpoint does not confirm that an unreachable ID
exists — and, deliberately, *not* relaxed in demo mode, since the open sandbox
is exactly where strangers share one instance. Ten tenancy tests now put two
cookie jars against one server and assert that Mallory cannot approve, reject,
revoke, read, re-cap or re-key anything of Alice's.

Two smaller things fell out of the same sweep. Scoping had quietly broken
discovery — a shopper could no longer see any shop, which is the whole product —
so the shop index is now explicitly public (`?scope=directory`), matching the
MCP endpoint that was already open to the world. And `SECURITY.md` contained a
sentence that had become false: *"the console is token-authenticated rather than
cookie-authenticated, so a cross-site request cannot borrow ambient
credentials."* Cookies had been introduced two hours earlier. The defence is now
`SameSite=Lax` plus POST-only mutations, and the document says so.

**The lesson:** when you add an isolation boundary to a system that did not have
one, the work is not writing the boundary. It is enumerating every route and
proving each one is on the right side of it. We found this by counting, not by
testing — `grep -c` on the route list, against the number of routes.

---

## 11. The second review found more than the first, and the worst of it was ours

After §10 we ran a second pass — two independent adversarial reviewers over
distinct areas, plus live probing. It found more than the first pass did, and
the three most serious findings were all introduced by fixes.

**The audit trail was handing out session cookies.** A workspace id *is* the
session: anyone who reads one becomes that visitor. Two audit call sites
interpolated it into the row — one of them added by us an hour earlier, while
fixing something else — and the feed showed unattributed rows to every tenant,
which was most rows, because attribution was an optional parameter that thirty
of thirty-five call sites omitted. So `GET /api/audit` returned a list of other
people's sessions, no token needed, in locked mode too.

The lesson is about the *shape* of the mistake, not the leak. Optional
attribution on a security boundary is not a boundary. It is now derived from the
row's subject, so no call site can forget it; unowned rows belong to the
platform view; and every value written is scrubbed, so an id that slips through
anyway becomes a one-way reference rather than a credential.

**A self-selected role could approve a stranger's spending.** §10 added `owns()`
so one tenant could not approve another's. It granted an exception to the
platform role and to reviewer mode — which, on the sandbox, any visitor may
hand themselves with one unauthenticated POST, deliberately, so judges can see
all three consoles. Two requests and the human-in-the-loop guarantee belonged to
whoever asked for it last. Reading across tenants and acting across tenants are
different powers and needed different predicates; only the deploy secret acts.

**Ten concurrent checkouts on one approval produced ten payable links.** Every
single-use guarantee was enforced by reading a status in the guard and writing
it *after* the gateway call, with two awaited round-trips in between. Node hands
the event loop to every other in-flight request inside that window: all of them
read `open`, all of them passed, all of them got an order. Each cap was
satisfied individually and none in aggregate — and the MCP tool mints a fresh
idempotency key whenever an agent omits one, so a merely *retrying* agent does
this by accident.

We measured it before fixing it: **ten calls, ten orders, ₹9,980 of live links
against a ₹2,000 approval.** Then we made the check and the write the same
statement, and measured again: one order, nine refusals. Then we put the fix
back to broken and re-ran the new test, to be sure the test could actually see
it. It could.

Also found and fixed: a captured payment could be flipped to `failed` by a late
or replayed `payment.failed` and never recovered; one visitor's twelve
ingestions deleted every other visitor's shops through an unscoped eviction
query; a 550 KB gzip bomb decompressed to 92 MB inside an ingest because the
request deadline was cleared when the headers arrived and no size cap existed;
the reconciler's 25-row window never drained, so a customer who paid sat behind
25 abandoned baskets forever; writes to Razorpay were retried without an
idempotency key; five IPv6 spellings of `169.254.169.254` were classified
public; and — not a security bug but worse for the product — a first-time
visitor to a *locked* deployment got 401 from the onboarding screen and could
never choose a dashboard at all.

**Three lessons, in order of how much they cost us.**

1. **The tests encoded the vulnerable behaviour as a requirement.** One asserted
   that "system events are shared" — the exact property that leaked the
   sessions. Deleting an assertion to fix a bug should always be suspicious; it
   was right here, and we had to say why in the test itself.
2. **A mock that answers the same thing regardless of what it is asked models a
   global variable, not a dependency.** We had already written that sentence in
   §1 of this document, and the checkout mock still returned `order_TEST123` for
   every order in the file — so a settlement test was matching a different
   order than the one it had just created, and passing. Writing the lesson down
   did not apply it.
3. **A fix is a change, and changes get reviewed.** Every one of the three worst
   findings arrived with a repair. Reviewing only the original code would have
   missed all of them.

---

## What we would tell someone starting this

1. **Test the seam you do not control, against the real thing, early.** Our worst
   bug lived exactly where our assumptions met Razorpay's actual object model,
   and no amount of internal testing would have found it.
2. **Make mocks answer their inputs.** A mock that returns the same thing
   regardless of what it is asked models a global variable, not a dependency.
3. **Fail loudly, not closed.** The webhook bug was dangerous because rejecting
   valid webhooks looks like silence, not like an error.
4. **Prefer deleting a dependency to patching it** when you barely needed it.
5. **Look at the interface.** Half the defects in this document are invisible to
   a test suite and obvious in a screenshot.
6. **Count, do not trust.** One of the worst bugs here was found by counting how
   many routes applied a rule and comparing it to how many routes exist. A green
   suite tells you the cases you thought of still pass.
7. **Break the fix to test the test.** After repairing the concurrency bug we
   reverted the repair and re-ran the new test to watch it fail. A regression
   test you have never seen fail is a hypothesis, not a test.
8. **Review the repairs hardest.** Our three most serious findings were all
   introduced by earlier fixes, in the same sitting, while making the system
   safer.
