/**
 * The storefront.
 *
 * Magnate sells the sessions and runs the payment, but the decision to buy is
 * made in the app, so the purchase belongs there too. The browser never talks to
 * a billing origin directly — CORS would forbid it, and the plan list would be a
 * second place to keep in step — so both calls go through this server:
 * `GET /api/store` for the catalog, `POST /api/store/checkout` for the Stripe URL.
 *
 * There is no catalog endpoint to ask, so the prices are read from Magnate's own
 * page rather than copied here: a price edited there shows up here within the
 * cache window, and if the page cannot be read the app offers the store link
 * instead of inventing a price or a slug.
 */

import { SESSION_PLANS, sessionPlan } from './plans.mjs';
import { trialRefusal, rememberTrial } from './iap.mjs';

const CACHE_MS = 10 * 60 * 1000;
const MAX_SESSIONS = 10;

// The local catalog is the floor, not a copy: Magnate's page still decides the price
// when it can be read, but a storefront that cannot be reached must not leave the app
// with no idea what a session costs or how long it runs.
let cache = {
  at: 0,
  plans: SESSION_PLANS.map((plan) => ({ slug: plan.slug, priceCents: plan.priceCents, name: plan.name, minutes: plan.minutes })),
  minutes: sessionPlan('sage-session-trial')?.minutes || 5,
};

/** Both the plain and the escaped form appear: one in markup, one in a payload. */
function extractPlans(html) {
  const found = new Map();
  // The window between the slug and the price carries the plan's own wording, so
  // the label comes from Magnate rather than from a slug turned into words.
  const patterns = [
    /"slug"\s*:\s*"([A-Za-z0-9._-]{1,60})"([\s\S]{0,600}?)"pricePerUnitCents"\s*:\s*(\d{1,7})/g,
    /\\"slug\\"\s*:\s*\\"([A-Za-z0-9._-]{1,60})\\"([\s\S]{0,600}?)\\"pricePerUnitCents\\"\s*:\s*(\d{1,7})/g,
  ];
  for (const pattern of patterns) {
    for (const match of html.matchAll(pattern)) {
      const slug = match[1];
      if (found.has(slug)) continue;
      const window = match[2] || '';
      const label =
        (window.match(/"description"\s*:\s*"([^"]{1,80})"/) ||
          window.match(/\\"description\\"\s*:\s*\\"([^\\"]{1,80})\\"/) ||
          window.match(/"name"\s*:\s*"([^"]{1,60})"/) ||
          window.match(/\\"name\\"\s*:\s*\\"([^\\"]{1,60})\\"/) ||
          [])[1] || '';
      found.set(slug, {
        slug,
        priceCents: Number(match[3]),
        name: label || sessionPlan(slug)?.name || slug.replace(/^sage-session-/, '').replace(/-/g, ' '),
        // How long the plan runs is ours, not the storefront's: the trial is short by
        // design and the page carries one `minutes` for every session.
        minutes: sessionPlan(slug)?.minutes || 15,
      });
    }
  }
  return [...found.values()].slice(0, 6);
}

async function refresh(base) {
  try {
    const res = await fetch(`${base}/sage`, {
      headers: { accept: 'text/html' },
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) return;
    const html = await res.text();
    const plans = extractPlans(html);
    const minutes = Number((html.match(/"minutes"\s*:\s*(\d{1,3})/i) || [])[1]) || cache.minutes || 15;
    if (plans.length) cache = { at: Date.now(), plans: plans.map((plan) => ({ ...plan, minutes: plan.minutes || minutes })), minutes };
  } catch {
    // A storefront that cannot be read is not a reason to fail: the app falls back
    // to opening Magnate's own page.
  }
}

export async function handleStore(request, url, cfg, json, context = {}) {
  const base = String(cfg.magnateUrl || 'https://magnate.innotel.us').replace(/\/+$/, '');

  if (url.pathname === '/api/store' && request.method === 'GET') {
    if (!cache.plans.length || Date.now() - cache.at > CACHE_MS) await refresh(base);
    return json({ plans: cache.plans, minutes: cache.minutes, page: `${base}/sage`, cachedAt: cache.at });
  }

  if (url.pathname !== '/api/store/checkout') return json({ error: 'not_found' }, 404);
  if (request.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);

  const body = await request.json().catch(() => null);
  if (!body) return json({ error: 'bad_json', message: 'Body must be JSON.' }, 400);

  const planSlug = String(body.planSlug || '').trim().slice(0, 60);
  const email = String(body.email || '').trim().slice(0, 200);
  const sessions = Math.max(1, Math.min(MAX_SESSIONS, Math.floor(Number(body.sessions) || 1)));
  if (!/^[A-Za-z0-9._-]{1,60}$/.test(planSlug)) {
    return json({ error: 'bad_plan', message: 'Pick a session first.' }, 400);
  }
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    return json({ error: 'bad_email', message: 'The receipt needs an email address — that is where the key is shown.' }, 400);
  }
  // The trial is once per person and once per connection on the web checkout too:
  // the App Store route is not the only door to the same five minutes.
  const trial = planSlug === 'sage-session-trial';
  if (trial) {
    const refusal = trialRefusal({ email, ip: context.ip });
    if (refusal) return json({ error: 'trial_used', message: refusal }, 409);
  }

  let upstream;
  try {
    upstream = await fetch(`${base}/api/sage/checkout`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ planSlug, email, sessions }),
      signal: AbortSignal.timeout(20000),
    });
  } catch (error) {
    return json({ error: 'store_unreachable', message: `Cannot reach ${base} (${error.message}).` }, 502);
  }

  const data = await upstream.json().catch(() => ({}));
  if (!upstream.ok || !data.url) {
    return json(
      { error: 'checkout_refused', message: String(data.error || `The store refused the checkout (${upstream.status}).`) },
      upstream.status === 404 ? 409 : 502,
    );
  }
  if (!/^https:\/\//.test(String(data.url))) {
    return json({ error: 'bad_checkout', message: 'The store returned a checkout link that is not secure.' }, 502);
  }
  if (trial) rememberTrial({ email, ip: context.ip });
  return json({ url: String(data.url), minutes: sessionPlan(planSlug)?.minutes || 0 });
}
