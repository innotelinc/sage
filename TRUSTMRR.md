# Listing SAGE on TrustMRR

TrustMRR is a verified-revenue database and acquisition marketplace. It does not
take a description and a screenshot: it reads your revenue from a payment
provider and publishes that number. So the product has to be a SaaS that actually
charges people before the listing means anything — which is what the billing layer
in this repo is for.

Everything below is either done in this repo or a copy-paste for the dashboard.

---

## 1. What the billing layer gives you

| Piece | Where | What it does |
| --- | --- | --- |
| Plan catalog | `src/plans.mjs` | Starter $9/mo, Scholar $19/mo, Scholar year $190/yr — one source for prices, features and limits |
| Accounts | `src/accounts.mjs` | Email + password (scrypt), signed 30-day cookie, per-account monthly answer counter |
| Checkout | `src/billing.mjs` → `POST /api/billing/checkout` | Creates a Stripe subscription checkout; inline recurring price, so no dashboard setup |
| Portal | `src/billing.mjs` → `POST /api/billing/portal` | Stripe customer portal: card, invoices, cancel |
| Webhooks | `POST /api/billing/webhook` | Signed events are the only writer of subscription state |
| The gate | `src/billing.mjs` → `handle()` | No session → 401. No live subscription → 402. Quota spent → 429 |
| Account page | `public/account.html` at `/account` | Sign up, sign in, pick a plan, manage billing |

If `STRIPE_SECRET_KEY` is unset, the instance behaves exactly as the self-hosted
build did: access code, no accounts. Nothing else changes.

---

## 2. Turn it on

```bash
# .env
STRIPE_SECRET_KEY=sk_live_…            # server only, never in the browser
STRIPE_WEBHOOK_SECRET=whsec_…          # from the webhook endpoint below
SAGE_SESSION_SECRET=$(openssl rand -base64 48)
APP_ORIGIN=https://sage.innotel.tech   # where checkout returns to
TRIAL_DAYS=7

# Everything the subscriber spends. Without this, each visitor would need their
# own gateway key — which is a self-hosted product, not a SaaS.
AI_API_KEY=…                           # your OmniRoute key
```

Then in Stripe → Developers → Webhooks, add an endpoint:

```
https://sage.innotel.tech/api/billing/webhook
events: checkout.session.completed
        customer.subscription.created
        customer.subscription.updated
        customer.subscription.deleted
        invoice.paid
        invoice.payment_failed
```

Copy that endpoint's signing secret into `STRIPE_WEBHOOK_SECRET`. Run one
container: the account file and the relay both live in the process's volume.

Optionally pin prices that must never move by setting
`STRIPE_PRICE_SAGE_STARTER`, `STRIPE_PRICE_SAGE_SCHOLAR`,
`STRIPE_PRICE_SAGE_SCHOLAR_YEAR` to price ids created in the dashboard. Without
them, checkout sends the catalog price inline.

Verify locally before trusting any of it:

```bash
node --test scripts/test-saas.mjs          # accounts, gate, signatures, quota
stripe listen --forward-to localhost:8787/api/billing/webhook
stripe trigger customer.subscription.updated
```

---

## 3. Before you connect Stripe to TrustMRR

TrustMRR reads aggregates only (MRR, total revenue, last 30 days, customer and
subscription counts). It never sees customer PII. Two conditions decide whether
the listing is worth making:

1. **Stripe is the primary provider.** Use the same Stripe account the app
   charges through. A listing's primary provider cannot be changed later, and a
   secondary provider can only be added afterwards.
2. **The revenue is real.** A listing with $0 verified MRR is allowed but ranks at
   the bottom, and the whole point of the marketplace is the number. One or two
   real subscribers is the difference between a listing and a placeholder.

Create the key as a **restricted, read-only** key (`rk_live_…`): read access to
Charges, Subscriptions, Customers, Invoices, Balance — nothing else.

---

## 4. The listing itself

Go to **trustmrr.com → Add startup** (the header button; there is no `/submit`
page), confirm your email, paste the restricted key, pick the Stripe account, and
wait for the import. Then fill the profile in the dashboard with the following.

**Name**
```
SAGE
```

**Website**
```
https://innotelinc.github.io/sage
```

**Category**
```
Artificial Intelligence
```

**Tagline / one-line**
```
The course-taking agent: it listens to the lecture, watches the slides, reads the material, and answers in your voice.
```

**Description** (one paragraph, factual — the audience is buyers and other founders)
```
SAGE is a subscription web app for students that turns a live class into usable
work. It transcribes the lecture on-device, samples the shared screen or camera
so a whiteboard becomes notes while it is being written, and reads slides,
worksheets and photographs into structured study material. From that same memory
it answers a question with the working shown and a confidence score, works
through a photographed quiz one decision at a time, and writes an essay in the
student's own register — citing only the material supplied, never inventing a
reference. Between classes it reviews its own notes and rewrites the behaviour
traits that carried marks. Ships as an installable PWA with Android screen
capture, a cross-device relay for mirrored phones, and per-task model routing
across an OpenAI-compatible gateway. Built on a zero-dependency Node server with
no npm install step; billing is Stripe subscriptions.
```

**Problem solved**
```
A student splits every class across a transcript app, a notes app, a camera and a
chatbot, and none of them share what they saw. Generic AI answers also read like
an assistant, not like the person being graded. SAGE folds listening, watching
and reading into one memory and answers as a capable student in the user's voice.
```

**Value proposition**
```
One subscription replaces four tools and the copy-paste between them: notes while
the lecture is still running, answers with the reasoning, quizzes in order, essays
that cite only what was supplied.
```

**Audience**
```
University and college students taking marked coursework; also tutors and
accessibility services that need lecture material captured live.
```

**Business type**
```
SaaS
```

**Pricing**
```
Starter $9/mo (250 answers), Scholar $19/mo (unlimited), Scholar annual $190/yr.
7-day trial, cancel any time.
```

**Tech stack**
```
Node.js (zero dependencies), vanilla JS PWA, Stripe, OpenAI-compatible gateway,
Docker, Cloudflare Worker entry
```

**Founder X handle** — set this on the startup, not on your account; the public
founder page at `trustmrr.com/founder/<handle>` reads it from the startup record.

**Optional, worth it**
- Dofollow authority link — $19 one-time. The base link is nofollow.
- Skip the $79 AI-visibility boost and the $399 sponsor slot until the numbers
  justify them.

**Do not** turn on Anonymous mode: the listing's value is the brand and the link.

---

## 5. What still has to be true before this is a real SaaS

Named honestly, because the listing will be read by people who check.

- **Deploy the account gate.** `/account` and `/api/auth/*` only exist on the Node
  server (`server.mjs`). The Cloudflare Worker entry serves the app and the public
  price list but has no filesystem for accounts — run the Node container behind a
  proxy, which is what the Dockerfile and `TLS_CERT`/`TLS_KEY` path are for.
- **One key for everyone.** Set `AI_API_KEY` server-side so a subscriber does not
  need their own gateway key, and watch the quota: 250 answers of a cheap model is
  a few cents, 250 of the strongest is not. The Starter cap exists for that
  reason.
- **Terms and refunds.** Stripe subscriptions need a refund policy and a way to
  cancel. The portal covers cancelling; the policy is a page you have to write.
- **Academic-integrity risk is a business risk.** SAGE answers graded work. Before
  listing a "course-taking agent" on a marketplace with due diligence, decide
  what the product claims and what the terms say. A listing is a published
  statement about what you sell.
