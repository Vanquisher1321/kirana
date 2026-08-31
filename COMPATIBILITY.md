# What Kirana can read

Every row here was produced by pasting the address into the live sandbox and
keeping whatever came back. Nothing is aspirational, and the failures are listed
because a compatibility table without them is marketing.

Measured 31 August 2026 against `https://kirana-6cv8.onrender.com`.

## Works today — 17 of 29 tested

No cooperation from the shop, no code on their site, no API key. Kirana reads
the product feed the storefront already publishes.

| Shop | Products | Buying options | Read in |
|---|---:|---:|---:|
| Heads Up For Tails | 500* | 889 | 2.6s |
| Chumbak | 500* | 588 | 20.4s |
| Nicobar | 500* | 1,187 | 2.4s |
| boAt Lifestyle | 500* | 1,421 | 4.8s |
| Gymshark | 500* | 3,146 | 3.2s |
| Zouk | 495 | 501 | 3.4s |
| SUGAR Cosmetics | 374 | 1,017 | 2.9s |
| Allbirds | 293 | 2,855 | 1.7s |
| Bombay Shaving Company | 208 | 208 | 1.6s |
| Plum Goodness | 192 | 205 | 2.1s |
| mCaffeine | 192 | 192 | 1.9s |
| The Indus Valley | 181 | 290 | 2.0s |
| Blue Tokai Coffee Roasters | 179 | 952 | 1.7s |
| Arata | 85 | 85 | 1.3s |
| Minimalist | 76 | 103 | 1.3s |
| Sleepy Owl Coffee | 74 | 146 | 1.2s |
| Rage Coffee | 36 | 109 | 1.1s |

\* capped at 500 products by `maxProducts`, not by the shop.

**4,846 products and 13,894 buying options** became agent-purchasable across
seventeen brands, in under a minute of total wall-clock, and not one of those
brands did anything or knows about it.

Every one used the Shopify adapter with **no model involved** — prices are read,
never inferred. That matters more than the count: an agent is told, per shop,
whether a price came from a feed or from a guess.

## Does not work yet — and why

| Shop | Reason |
|---|---|
| Nykaa, Myntra, Amazon.in | Marketplaces on custom platforms, no public product feed |
| The Whole Truth Foods | Custom storefront |
| Forest Essentials, Kama Ayurveda | Custom storefront |
| WOW Skin Science, Pilgrim, Sirona | Custom storefront |
| Bewakoof, The Souled Store | Custom platform |
| Slay Coffee | Custom storefront |

The refusal is explicit — *"No ingestion adapter could read X. Supported today:
shopify."* — rather than a silent empty catalogue. A shop that cannot be read is
told so, immediately, with the reason.

## What would widen this

Roughly **a quarter of Indian D2C brands run on Shopify**, which is why that
adapter came first: it is the largest single group reachable with one adapter and
zero merchant effort.

The ingestion ladder in `ARCHITECTURE.md` has three more rungs designed and not
built, in the order they are worth building:

1. **WooCommerce Store API** — the next largest group, and exact like Shopify.
2. **JSON-LD `Product` markup** — most custom storefronts publish it for Google,
   so it is already there on sites that have no API at all.
3. **A model reading the HTML** — last resort, and the only rung that guesses.
   Anything it produces is flagged to buying agents as interpreted rather than
   read, so an agent can treat those prices with suspicion.

Rungs 1 and 2 are the difference between "a quarter of D2C" and "most of it".
Neither needs the merchant to do anything either.

## Reproducing this

The sandbox is open. Paste any address into **Getting started** on the merchant
console, or:

```bash
curl -X POST https://kirana-6cv8.onrender.com/api/ingest \
  -H 'content-type: application/json' \
  -d '{"url":"sleepyowl.co"}'
```

The response is the same report the console renders: product count, variant
count, which adapter matched, whether a model was involved, and every item that
was skipped with the reason it was skipped.
