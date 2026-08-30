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
