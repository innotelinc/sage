/**
 * The subscription catalog.
 *
 * Deliberately a pure module with no filesystem or network access: the browser
 * asks for it (`GET /api/plans`), the checkout builds Stripe line items from it,
 * and the entitlement check reads the limits out of it — one place, so a price
 * and a limit can never drift apart between the page and the gate.
 *
 * Prices are in cents and are the source of truth for Stripe too: checkout sends
 * an inline recurring price, so a new plan needs no dashboard work. A plan with
 * `STRIPE_PRICE_<SLUG>` set in the environment uses that price instead, which is
 * what you want once a plan has subscribers whose price must not move.
 */

export const PLANS = [
  {
    slug: 'sage-starter',
    name: 'Starter',
    priceCents: 900,
    interval: 'month',
    blurb: 'One course load, every surface, capped answers.',
    features: [
      '250 answers a month',
      'All six surfaces — notes, answer, quiz, essay, read, evolve',
      'Live lecture notes and screen reading',
      'Installable on a phone (PWA)',
      'Gateway included: no key of your own to buy',
    ],
    limits: { answers: 250, studyMode: false, relay: false },
  },
  {
    slug: 'sage-scholar',
    name: 'Scholar',
    priceCents: 1900,
    interval: 'month',
    blurb: 'Unlimited answers, hands-free study mode, the relay.',
    features: [
      'Unlimited answers',
      'Study mode: mic and screen together, answers unprompted',
      'Cross-device relay for a mirrored phone or a cast window',
      'Strongest model the gateway can serve on answers and essays',
      'Memory that survives between classes',
    ],
    limits: { answers: Infinity, studyMode: true, relay: true },
  },
  {
    slug: 'sage-scholar-year',
    name: 'Scholar · year',
    priceCents: 19000,
    interval: 'year',
    blurb: 'Everything in Scholar, paid for a year — two months free.',
    features: [
      'Everything in Scholar',
      'One payment for the academic year',
      'Two months cheaper than paying monthly',
      'Cancel any time; access runs to the period end',
    ],
    limits: { answers: Infinity, studyMode: true, relay: true },
  },
];

export function planBySlug(slug) {
  return PLANS.find((plan) => plan.slug === String(slug || '')) || null;
}

/** The Stripe price id for a plan, when the operator pinned one. */
export function priceIdFor(slug, env = {}) {
  const key = `STRIPE_PRICE_${String(slug).toUpperCase().replace(/[^A-Z0-9]+/g, '_')}`;
  return String(env[key] || '').trim();
}

/** What a plan slug actually grants. An unknown slug grants nothing. */
export function entitlementFor(slug) {
  const plan = planBySlug(slug);
  if (!plan) return { plan: null, answers: 0, studyMode: false, relay: false };
  return { plan: plan.slug, ...plan.limits };
}

/** The catalog as the browser may see it: prices, features, no secrets. */
export function publicPlans() {
  return PLANS.map((plan) => ({
    slug: plan.slug,
    name: plan.name,
    priceCents: plan.priceCents,
    interval: plan.interval,
    blurb: plan.blurb,
    features: plan.features,
    limits: { answers: plan.limits.answers === Infinity ? null : plan.limits.answers, studyMode: plan.limits.studyMode, relay: plan.limits.relay },
  }));
}
