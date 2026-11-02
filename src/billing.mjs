/**
 * Subscriptions, checkout, and the gate in front of the model.
 *
 * The self-hosted app sold a timed session: one payment, a key, a clock. A SaaS
 * is the other shape — a subscription that keeps a person's account entitled
 * until they stop paying — so this is Stripe's REST API spoken directly, with no
 * SDK and no dependencies, in keeping with the rest of the server.
 *
 * Three pieces:
 *   1. Checkout. The browser asks this server for a URL, never for a card.
 *   2. Webhooks. Stripe is the only writer of subscription state; a signed event
 *      is verified before it is believed, and a stale one is refused.
 *   3. The gate. Every other `/api` route is refused unless the caller holds a
 *      session cookie for an account whose subscription is live, and answers are
 *      counted against the plan.
 *
 * Nothing here runs unless `STRIPE_SECRET_KEY` is set: without it the instance
 * behaves exactly as the self-hosted build does, guarded by an access code.
 */
import { PLANS, planBySlug, priceIdFor, entitlementFor, publicPlans } from './plans.mjs';
import {
  accountFromRequest,
  accountById,
  accountByEmail,
  allAccounts,
  createAccount,
  authenticate,
  patchAccount,
  recordAnswer,
  issueAccountCookie,
  clearAccountCookie,
  publicAccount,
  monthUsage,
} from './accounts.mjs';

const STRIPE_API = 'https://api.stripe.com/v1';
const SIGNATURE_TOLERANCE = 300;
// Statuses that mean money is (or is about to be) moving and the person should
// be let in. `past_due` is included while the paid period is still running: a
// failed card is not an eviction, it is a retry.
const LIVE_STATUSES = new Set(['active', 'trialing']);

function json(body, status = 200, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers },
  });
}

export function billingConfig(env = {}) {
  return {
    enabled: Boolean(String(env.STRIPE_SECRET_KEY || '').trim()),
    secretKey: String(env.STRIPE_SECRET_KEY || '').trim(),
    webhookSecret: String(env.STRIPE_WEBHOOK_SECRET || '').trim(),
    trialDays: Number.isFinite(Number(env.TRIAL_DAYS)) ? Math.max(0, Math.min(60, Number(env.TRIAL_DAYS))) : 7,
  };
}

function originOf(request) {
  const url = new URL(request.url);
  const proto = String(request.headers.get('x-forwarded-proto') || url.protocol.replace(':', '')).split(',')[0].trim();
  const host = String(request.headers.get('x-forwarded-host') || request.headers.get('host') || url.host).split(',')[0].trim();
  return `${proto}://${host}`;
}

/** Checkout and the portal are POSTs from a page this server owns. */
function sameOrigin(request) {
  const origin = request.headers.get('origin');
  if (!origin) return true; // a form post or curl; the cookie's SameSite still applies
  try {
    return new URL(origin).host === new URL(originOf(request)).host;
  } catch {
    return false;
  }
}

/* ── Stripe over HTTP ─────────────────────────────────────── */
/* Form-encoded, per Stripe's own convention, so an array or a nested key is a
   bracket in a string rather than a JSON body. */

function encode(params, prefix = '', out = new URLSearchParams()) {
  const append = (name, value) => {
    if (value === undefined || value === null) return;
    if (Array.isArray(value)) value.forEach((item, index) => append(`${name}[${index}]`, item));
    else if (typeof value === 'object') encode(value, name, out);
    else out.append(name, String(value));
  };
  for (const [key, value] of Object.entries(params)) {
    append(prefix ? `${prefix}[${key}]` : key, value);
  }
  return out;
}

async function stripe(cfg, method, endpoint, params = {}) {
  const body = method === 'GET' ? null : encode(params).toString();
  const url = method === 'GET' ? `${STRIPE_API}${endpoint}?${encode(params)}` : `${STRIPE_API}${endpoint}`;
  let response;
  try {
    response = await fetch(url, {
      method,
      headers: {
        authorization: `Bearer ${cfg.secretKey}`,
        'content-type': 'application/x-www-form-urlencoded',
        accept: 'application/json',
        // Stripe pins behaviour to a version; asking explicitly means a change
        // on their side cannot silently alter a webhook payload's shape.
        'stripe-version': '2024-06-20',
      },
      body: body === null ? undefined : body,
      signal: AbortSignal.timeout(20000),
    });
  } catch (error) {
    return { ok: false, status: 0, error: `Stripe is unreachable (${error.message}).` };
  }
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    return { ok: false, status: response.status, error: String(data?.error?.message || `Stripe returned ${response.status}.`) };
  }
  return { ok: true, status: response.status, data };
}

/* ── webhook signatures ───────────────────────────────────── */
/* Stripe's own scheme: an HMAC over `<timestamp>.<raw body>`, under the endpoint
   secret, with every `v1` candidate compared in constant time. */

export async function verifySignature(rawBody, header, secret, tolerance = SIGNATURE_TOLERANCE) {
  if (!secret) return { ok: false, error: 'no_webhook_secret' };
  const parts = String(header || '').split(',').map((part) => part.trim());
  let timestamp = '';
  const candidates = [];
  for (const part of parts) {
    const [key, value] = part.split('=');
    if (key === 't') timestamp = value;
    else if (key === 'v1' && value) candidates.push(value);
  }
  if (!timestamp || !candidates.length) return { ok: false, error: 'malformed_header' };
  const age = Math.abs(Math.floor(Date.now() / 1000) - Number(timestamp));
  if (!Number.isFinite(age) || age > tolerance) return { ok: false, error: 'stale' };

  const { createHmac, timingSafeEqual } = await import('node:crypto');
  const expected = createHmac('sha256', secret).update(`${timestamp}.${rawBody}`).digest('hex');
  const left = Buffer.from(expected, 'utf8');
  for (const candidate of candidates) {
    const right = Buffer.from(candidate, 'utf8');
    if (left.length === right.length && timingSafeEqual(left, right)) return { ok: true };
  }
  return { ok: false, error: 'bad_signature' };
}

/* ── subscription state ───────────────────────────────────── */

function periodEndOf(subscription) {
  // `current_period_end` moved under the items in newer API versions; read both
  // so the pay-through date is never blank.
  const direct = Number(subscription?.current_period_end) || 0;
  const item = Number(subscription?.items?.data?.[0]?.current_period_end) || 0;
  const seconds = direct || item;
  return seconds ? new Date(seconds * 1000).toISOString() : null;
}

function planForSubscription(subscription, env) {
  const slug = String(subscription?.metadata?.plan || '').trim();
  if (planBySlug(slug)) return slug;
  const priceId = String(subscription?.items?.data?.[0]?.price?.id || '');
  if (priceId) {
    for (const plan of PLANS) {
      if (priceIdFor(plan.slug, env) === priceId) return plan.slug;
    }
  }
  return '';
}

/**
 * Who an event is about. `client_reference_id` names the account directly; a
 * later subscription event carries only the customer, so the index is consulted.
 */
function accountForEvent(event, env) {
  const object = event?.data?.object || {};
  const direct = String(object?.client_reference_id || object?.metadata?.account || '').trim();
  if (direct && accountById(direct)) return accountById(direct);
  const customerId = String(
    typeof object?.customer === 'string' ? object.customer : object?.customer?.id || '',
  ).trim();
  if (!customerId) return null;
  const email = String(object?.customer_email || object?.customer_details?.email || '').trim();
  if (email) {
    const byMail = accountByEmail(email);
    if (byMail) return byMail;
  }
  return findByCustomer(customerId);
}

// Scanning accounts is fine: a single instance holds subscribers, not millions.
function findByCustomer(customerId) {
  if (!customerId) return null;
  return allAccounts().find((account) => account.stripeCustomerId === customerId) || null;
}

/**
 * Apply one verified event. Returns a short description for the webhook log and
 * for the tests; it never throws on an event it does not care about.
 */
export async function applyEvent(event, env = {}) {
  const type = String(event?.type || '');
  const object = event?.data?.object || {};

  if (type === 'checkout.session.completed') {
    const account = accountForEvent(event, env);
    if (!account) return { handled: false, reason: 'no_account' };
    const subscriptionId = String(
      typeof object.subscription === 'string' ? object.subscription : object.subscription?.id || '',
    );
    await patchAccount(account.id, {
      stripeCustomerId: typeof object.customer === 'string' ? object.customer : account.stripeCustomerId,
      stripeSubscriptionId: subscriptionId || account.stripeSubscriptionId,
      // A completed checkout is not yet an active subscription; the subscription
      // event that follows carries the status, the plan and the period end.
      status: account.status === 'none' ? 'incomplete' : account.status,
    });
    return { handled: true, type, account: account.id };
  }

  if (type.startsWith('customer.subscription.')) {
    const account = accountForEvent(event, env);
    if (!account) return { handled: false, reason: 'no_account' };
    const status = String(object.status || '');
    const planSlug = planForSubscription(object, env) || account.plan || null;
    const canceled = type === 'customer.subscription.deleted' || status === 'canceled';
    await patchAccount(account.id, {
      plan: canceled ? account.plan : planSlug,
      status: canceled ? 'canceled' : status,
      stripeCustomerId: typeof object.customer === 'string' ? object.customer : account.stripeCustomerId,
      stripeSubscriptionId: object.id || account.stripeSubscriptionId,
      currentPeriodEnd: periodEndOf(object) || account.currentPeriodEnd,
      cancelAtPeriodEnd: Boolean(object.cancel_at_period_end),
    });
    return { handled: true, type, account: account.id, status };
  }

  if (type === 'invoice.payment_failed' || type === 'invoice.paid') {
    const account = accountForEvent(event, env);
    if (!account) return { handled: false, reason: 'no_account' };
    // The subscription event that accompanies an invoice usually arrives too, so
    // this only moves the status; the plan and the period come from the
    // subscription itself.
    await patchAccount(account.id, { status: type === 'invoice.paid' ? 'active' : 'past_due' });
    return { handled: true, type, account: account.id };
  }

  return { handled: false, reason: 'ignored' };
}

/* ── entitlement ──────────────────────────────────────────── */

/** What this account may do right now, and whether it may do anything at all. */
export function entitlement(account) {
  if (!account) return { active: false, reason: 'no_account', plan: null, limits: entitlementFor(''), used: 0 };
  const limits = entitlementFor(account.plan);
  const status = String(account.status || 'none');
  const periodEnd = account.currentPeriodEnd ? Date.parse(account.currentPeriodEnd) : 0;
  const withinPeriod = periodEnd > Date.now();
  const active =
    (LIVE_STATUSES.has(status) && Boolean(account.plan)) ||
    (status === 'past_due' && withinPeriod && Boolean(account.plan));
  const usage = monthUsage(account);
  return {
    active,
    status,
    plan: account.plan,
    limits,
    used: usage.used,
    month: usage.month,
    remaining: Number.isFinite(limits.answers) ? Math.max(0, limits.answers - usage.used) : null,
    currentPeriodEnd: account.currentPeriodEnd,
    cancelAtPeriodEnd: Boolean(account.cancelAtPeriodEnd),
    reason: active ? 'ok' : status === 'none' || !account.plan ? 'no_subscription' : 'subscription_inactive',
  };
}

/* ── request handling ─────────────────────────────────────── */

const PUBLIC_PATHS = new Set([
  '/api/health',
  '/api/plans',
  '/api/store',
  '/api/iap/config',
  '/api/auth/signup',
  '/api/auth/signin',
  '/api/auth/signout',
  '/api/auth/me',
  '/api/billing/checkout',
  '/api/billing/portal',
  '/api/billing/webhook',
  '/api/billing/status',
]);

function readJson(request) {
  return request.json().catch(() => null);
}

/**
 * One object per process: it owns the account cookie secret, the gate, and the
 * answer counter. `enabled` is false on an instance with no Stripe key, and then
 * every call through it is a no-op so the self-hosted path is untouched.
 */
export function createSaaS(env = {}) {
  const config = billingConfig(env);
  const enabled = config.enabled;

  async function me(request) {
    const account = await accountFromRequest(request, env);
    if (!account) return json({ signedIn: false, enabled, plans: publicPlans() });
    const state = entitlement(account);
    return json({
      signedIn: true,
      enabled,
      account: publicAccount(account),
      entitlement: state,
      plans: publicPlans(),
    });
  }

  async function signup(request) {
    if (!sameOrigin(request)) return json({ error: 'bad_origin', message: 'Cross-origin request refused.' }, 403);
    const body = await readJson(request);
    if (!body) return json({ error: 'bad_json', message: 'Body must be JSON.' }, 400);
    try {
      const account = await createAccount({ email: body.email, password: body.password });
      const cookie = issueAccountCookie(account, env, new URL(request.url));
      const record = accountById(account.id);
      return json(
        { ok: true, account, entitlement: entitlement(record) },
        201,
        cookie ? { 'set-cookie': cookie } : {},
      );
    } catch (error) {
      return json({ error: 'signup_failed', message: error.message }, error.status || 400);
    }
  }

  async function signin(request) {
    if (!sameOrigin(request)) return json({ error: 'bad_origin', message: 'Cross-origin request refused.' }, 403);
    const body = await readJson(request);
    if (!body) return json({ error: 'bad_json', message: 'Body must be JSON.' }, 400);
    try {
      const account = await authenticate({ email: body.email, password: body.password });
      const cookie = issueAccountCookie(account, env, new URL(request.url));
      const record = accountById(account.id);
      return json({ ok: true, account, entitlement: entitlement(record) }, 200, cookie ? { 'set-cookie': cookie } : {});
    } catch (error) {
      return json({ error: 'signin_failed', message: error.message }, error.status || 401);
    }
  }

  function signout(request) {
    const cookie = clearAccountCookie(env, new URL(request.url));
    return json({ ok: true }, 200, cookie ? { 'set-cookie': cookie } : {});
  }

  async function checkout(request) {
    if (!enabled) {
      return json(
        { error: 'billing_disabled', message: 'Subscriptions are not configured on this instance (no STRIPE_SECRET_KEY).' },
        503,
      );
    }
    if (!sameOrigin(request)) return json({ error: 'bad_origin', message: 'Cross-origin request refused.' }, 403);
    const account = await accountFromRequest(request, env);
    if (!account) return json({ error: 'sign_in_required', message: 'Sign in first, so the subscription has somewhere to live.' }, 401);

    const body = await readJson(request);
    const plan = planBySlug(body?.plan);
    if (!plan) return json({ error: 'bad_plan', message: 'Pick one of the listed plans.' }, 400);

    const origin = String(env.APP_ORIGIN || '').trim() || originOf(request);
    const priceId = priceIdFor(plan.slug, env);
    const lineItem = { quantity: 1 };
    if (priceId) lineItem.price = priceId;
    else {
      lineItem.price_data = {
        currency: String(env.STRIPE_CURRENCY || 'usd'),
        unit_amount: plan.priceCents,
        recurring: { interval: plan.interval },
        product_data: { name: `SAGE ${plan.name}` },
      };
    }

    const params = {
      mode: 'subscription',
      success_url: `${origin}/account?checkout=done`,
      cancel_url: `${origin}/account?checkout=cancelled`,
      client_reference_id: account.id,
      allow_promotion_codes: 'true',
      line_items: [lineItem],
      metadata: { account: account.id, plan: plan.slug },
      subscription_data: { metadata: { account: account.id, plan: plan.slug } },
    };
    if (account.stripeCustomerId) params.customer = account.stripeCustomerId;
    else params.customer_email = account.email;
    // A trial is offered once per account, never on a plan change.
    if (config.trialDays > 0 && account.status === 'none' && !account.stripeSubscriptionId) {
      params.subscription_data.trial_period_days = config.trialDays;
    }

    const result = await stripe(config, 'POST', '/checkout/sessions', params);
    if (!result.ok) return json({ error: 'checkout_failed', message: result.error }, 502);
    if (!/^https:\/\//.test(String(result.data.url || ''))) {
      return json({ error: 'bad_checkout', message: 'Stripe returned a checkout link that is not secure.' }, 502);
    }
    return json({ url: result.data.url });
  }

  async function portal(request) {
    if (!enabled) return json({ error: 'billing_disabled', message: 'Subscriptions are not configured on this instance.' }, 503);
    if (!sameOrigin(request)) return json({ error: 'bad_origin', message: 'Cross-origin request refused.' }, 403);
    const account = await accountFromRequest(request, env);
    if (!account) return json({ error: 'sign_in_required', message: 'Sign in first.' }, 401);
    if (!account.stripeCustomerId) {
      return json({ error: 'no_customer', message: 'There is no billing account yet — pick a plan first.' }, 409);
    }
    const origin = String(env.APP_ORIGIN || '').trim() || originOf(request);
    const result = await stripe(config, 'POST', '/billing_portal/sessions', {
      customer: account.stripeCustomerId,
      return_url: `${origin}/account`,
    });
    if (!result.ok) return json({ error: 'portal_failed', message: result.error }, 502);
    return json({ url: result.data.url });
  }

  async function webhook(request, rawBody) {
    if (!config.webhookSecret) {
      return json({ error: 'webhook_unconfigured', message: 'STRIPE_WEBHOOK_SECRET is not set.' }, 503);
    }
    const payload = typeof rawBody === 'string' ? rawBody : Buffer.isBuffer(rawBody) ? rawBody.toString('utf8') : Buffer.from(rawBody || '').toString('utf8');
    if (!payload) return json({ error: 'empty', message: 'The webhook body was empty.' }, 400);
    const verdict = await verifySignature(payload, request.headers.get('stripe-signature'), config.webhookSecret);
    if (!verdict.ok) {
      // Never process an unverified event: it is the only thing that can grant
      // access without money having moved.
      return json({ error: 'bad_signature', message: `Signature refused (${verdict.error}).` }, 400);
    }
    let event;
    try {
      event = JSON.parse(payload);
    } catch {
      return json({ error: 'bad_json', message: 'Event body is not JSON.' }, 400);
    }
    const outcome = await applyEvent(event, env);
    return json({ received: true, ...outcome });
  }

  /**
   * Every `/api` request on a SaaS instance passes here first.
   *
   * Returns a Response for anything it owns (auth, billing, a refusal) and null
   * when the request should continue to the app handler.
   */
  async function handle(request, url, rawBody) {
    if (!enabled) return null;
    const path = url.pathname;

    if (path === '/api/plans' && request.method === 'GET') return json({ plans: publicPlans() });
    if (path === '/api/auth/me' && request.method === 'GET') return me(request);
    if (path === '/api/auth/signup' && request.method === 'POST') return signup(request);
    if (path === '/api/auth/signin' && request.method === 'POST') return signin(request);
    if (path === '/api/auth/signout' && request.method === 'POST') return signout(request);
    if (path === '/api/billing/checkout' && request.method === 'POST') return checkout(request);
    if (path === '/api/billing/portal' && request.method === 'POST') return portal(request);
    if (path === '/api/billing/webhook' && request.method === 'POST') return webhook(request, rawBody);
    if (path === '/api/billing/status' && request.method === 'GET') {
      const account = await accountFromRequest(request, env);
      return json({ enabled, webhookSecret: Boolean(config.webhookSecret), trialDays: config.trialDays, entitlement: entitlement(account) });
    }

    if (PUBLIC_PATHS.has(path)) return null;

    // Everything left is the product: model calls, transcription, the relay,
    // workspaces. It needs a subscriber.
    const account = await accountFromRequest(request, env);
    if (!account) {
      return json(
        {
          error: 'sign_in_required',
          message: 'Sign in to use SAGE — subscriptions are per account.',
          signIn: '/account',
        },
        401,
      );
    }
    const state = entitlement(account);
    if (!state.active) {
      return json(
        {
          error: 'subscription_required',
          message: 'That subscription is not active. Pick a plan to keep using SAGE.',
          manage: '/account',
          status: state.status,
        },
        402,
      );
    }
    if (path === '/api/chat' && request.method === 'POST' && state.remaining !== null && state.remaining <= 0) {
      return json(
        {
          error: 'quota_reached',
          message: `This month's ${state.limits.answers} answers are spent. Scholar lifts the cap.`,
          used: state.used,
          limit: state.limits.answers,
          upgrade: '/account',
        },
        429,
      );
    }
    return null;
  }

  /** One answered turn, counted after the fact. Never blocks a response. */
  async function countAnswer(request) {
    if (!enabled) return null;
    const account = await accountFromRequest(request, env);
    if (!account) return null;
    return recordAnswer(account.id);
  }

  /** The app handler asks this instead of the access code on a SaaS instance. */
  function authorise() {
    // The gate above already decided; reaching the handler means it said yes.
    return enabled ? true : undefined;
  }

  async function meFromCookie(request) {
    const account = await accountFromRequest(request, env);
    return account ? { account: publicAccount(account), entitlement: entitlement(account) } : null;
  }

  return { enabled, handle, countAnswer, authorise, meFromCookie, config };
}

