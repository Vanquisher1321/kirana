# What Kirana can read

Every row here was produced by pasting the address into the live sandbox and
keeping whatever came back. Nothing is aspirational, and the failures are listed
because a compatibility table without them is marketing.

Measured 31 August 2026 against `https://kirana-6cv8.onrender.com`.

## Works today — 30 of 44 tested

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
| Snitch | 500* | 2,644 | 2.7s |
| SuperBottoms | 498 | 1,974 | 3.2s |
| Beardo India | 496 | 512 | 4.6s |
| Nestasia | 500* | 500 | 2.2s |
| Suta | 500* | 818 | 3.1s |
| Okhai | 500* | 741 | 2.2s |
| ColourPop | 500* | 500 | 3.1s |
| Bombay Sweet Shop | 183 | 236 | 1.6s |
| VAHDAM | 181 | 198 | 2.0s |
| Earth Rhythm | 152 | 229 | 1.6s |
| Dot & Key | 151 | 207 | 2.0s |
| Death Wish Coffee | 150 | 440 | 1.4s |
| Mokobara | 102 | 463 | 1.8s |
| Sleepycat | 85 | 1,111 | 2.3s |
| Subko Coffee Roasters | 63 | 223 | 1.0s |
| Naagin | 34 | 51 | 1.2s |
| Rage Coffee | 36 | 109 | 1.1s |

\* capped at 500 products by `maxProducts`, not by the shop.

**Over 9,000 products and 26,000 buying options** became agent-purchasable
across thirty brands — coffee, skincare, luggage, menswear, pet supplies, sarees,
mattresses, hot sauce — in about a minute of total wall-clock, and not one of
those brands did anything or knows about it.

Two of those rows were bugs before they were rows: Dot & Key arrived as
`Dot &amp; Key` and Gymshark as `gymshark.com`, because the shop name is scraped
from a stranger's HTML. Both are fixed and both have a test. That is the real
argument for testing thirty shops instead of one — the thirty-first will still
break something, and the failure will be in the part that meets a website you
have never seen.

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
| Ustraa, Yogabar, Wakefit | Custom storefront |

The refusal is explicit — *"No ingestion adapter could read X. Supported today:
shopify."* — rather than a silent empty catalogue. A shop that cannot be read is
told so, immediately, with the reason.

## Marketplaces are not on either list

Amazon, Flipkart, Nykaa and Myntra were tested and refused, but they do not
belong in the table above as "not supported yet", because they are not a target.
Reading a catalogue is the easy half; **the right to take the payment is the hard
half**, and a marketplace never granted it. A Razorpay link raised against an
Amazon order is a link nobody will honour.

The shops in the failure table are a different case entirely: Wakefit, The Souled
Store, Bewakoof, Forest Essentials, Kama Ayurveda and Ustraa own their inventory
and their checkout, so a Razorpay link is exactly right for them. They fail only
because they are not on Shopify. That is an adapter away, and the README's
[scope section](README.md#who-kirana-is-for-and-who-it-deliberately-leaves-alone)
sets out the four routes to them.

## What would widen this

Roughly **a quarter of Indian D2C brands run on Shopify**, which is why that
adapter came first: it is the largest single group reachable with one adapter and
zero merchant effort.

The ingestion ladder in `ARCHITECTURE.md` has three more rungs designed and not
built, in the order they are worth building:

1. **A feed the merchant hands us** — the shop pastes the Google Merchant Center
   or Meta catalogue URL it already maintains for its own ads. Exact,
   authoritative, works on every platform including in-house ones, and it is
   consent rather than crawling. Five minutes of a dev team's time, because the
   file already exists.
2. **JSON-LD `Product` markup** — most custom storefronts embed it for Google
   Shopping, so it is already sitting on sites with no API at all. Needs nothing
   from anyone and cuts across Magento, bespoke React and PHP monoliths alike.
3. **WooCommerce Store API** — exact like Shopify, and the largest single group
   after it.
4. **A model reading the HTML** — last resort, and the only rung that guesses.
   Anything it produces is flagged to buying agents as interpreted rather than
   read, so an agent can treat those prices with suspicion.

The first two are the difference between "a quarter of D2C" and "most of it".

## Checking a shop yourself, in five seconds

Open `https://<the-shop>/products.json` in a browser tab. JSON means Kirana can
read it. A 404 or an HTML page means it cannot, yet.

That is the whole test, and it is the same request Kirana makes.

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
