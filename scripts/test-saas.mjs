/**
 * What the SaaS layer promises, checked without a Stripe account.
 *
 * Run with: node --test scripts/test-saas.mjs
 *
 * The interesting cases are the ones that decide whether money and access line
 * up: an unsigned webhook must not grant a subscription, a signed one must, a
 * cancelled subscription must close the gate, and a spent answer quota must say
 * so rather than quietly spending the operator's gateway key.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const dir = await mkdtemp(path.join(tmpdir(), 'sage-saas-'));
process.env.SAGE_DATA_DIR = dir;

const { createSaaS, verifySignature } = await import('../src/billing.mjs');
const { PLANS, entitlementFor, publicPlans } = await import('../src/plans.mjs');

const env = {
  STRIPE_SECRET_KEY: 'sk_test_000',
  STRIPE_WEBHOOK_SECRET: 'whsec_test_secret',
  SAGE_SESSION_SECRET: 'a-test-session-secret-that-is-long-enough',
  APP_ORIGIN: 'http://localhost:8787',
  TRIAL_DAYS: '7',
};

const saas = createSaaS(env);
const base = 'http://localhost:8787';

function post(pathname, body, cookie) {
  const headers = { 'content-type': 'application/json' };
  if (cookie) headers.cookie = cookie;
  return new Request(`${base}${pathname}`, { method: 'POST', headers, body: JSON.stringify(body) });
}

function get(pathname, cookie) {
  const headers = cookie ? { cookie } : {};
  return new Request(`${base}${pathname}`, { method: 'GET', headers });
}

function cookieOf(response) {
  const header = response.headers.get('set-cookie') || '';
  const pair = header.split(';')[0];
  return pair.includes('sage_account=') ? pair : '';
}

function sign(payload, secret = env.STRIPE_WEBHOOK_SECRET, at = Math.floor(Date.now() / 1000)) {
  return `t=${at},v1=${createHmac('sha256', secret).update(`${at}.${payload}`).digest('hex')}`;
}

async function webhook(event, { signature, payload } = {}) {
  const body = payload ?? JSON.stringify(event);
  const request = new Request(`${base}/api/billing/webhook`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'stripe-signature': signature ?? sign(body) },
    body,
  });
  const response = await saas.handle(request, new URL(request.url), body);
  return { status: response.status, data: await response.json() };
}

test('the catalog is priced and the limits agree', () => {
  assert.ok(PLANS.length >= 2);
  for (const plan of PLANS) {
    assert.match(plan.slug, /^sage-/);
    assert.ok(plan.priceCents >= 400, `${plan.slug} must cost something real`);
  }
  const publicList = publicPlans();
  assert.equal(publicList.length, PLANS.length);
  // Infinity does not survive JSON, so the browser is told `null` = no cap.
  assert.equal(publicList.find((plan) => plan.slug === 'sage-scholar').limits.answers, null);
  assert.equal(entitlementFor('sage-starter').answers, 250);
  assert.equal(entitlementFor('nonsense').answers, 0);
});

test('an unsigned or stale webhook is refused', async () => {
  const body = JSON.stringify({ type: 'customer.subscription.updated', data: { object: { id: 'sub_1', status: 'active' } } });
  const wrongSecret = await webhook(null, { payload: body, signature: sign(body, 'whsec_wrong') });
  assert.equal(wrongSecret.status, 400);
  assert.equal(wrongSecret.data.error, 'bad_signature');

  const stale = Math.floor(Date.now() / 1000) - 4000;
  const old = await webhook(null, { payload: body, signature: sign(body, env.STRIPE_WEBHOOK_SECRET, stale) });
  assert.equal(old.status, 400);
  assert.equal(old.data.message.includes('stale'), true);

  const malformed = await verifySignature(body, 'nonsense', env.STRIPE_WEBHOOK_SECRET);
  assert.equal(malformed.ok, false);
});

test('an account is needed before any model call', async () => {
  const response = await saas.handle(get('/api/chat'), new URL(`${base}/api/chat`), Buffer.from(''));
  assert.equal(response.status, 401);
  const data = await response.json();
  assert.equal(data.error, 'sign_in_required');
  assert.equal(data.signIn, '/account');
});

test('sign-up, sign-in and the subscription gate', async () => {
  const signup = await saas.handle(
    post('/api/auth/signup', { email: 'Student@Example.com', password: 'correct horse battery' }),
    new URL(`${base}/api/auth/signup`),
    Buffer.from('{}'),
  );
  assert.equal(signup.status, 201);
  const created = await signup.json();
  assert.equal(created.account.email, 'student@example.com');
  const cookie = cookieOf(signup);
  assert.ok(cookie, 'sign-up must set a session cookie');

  // Signed in, but not paying: the product is closed.
  const beforePlan = await saas.handle(post('/api/chat', { text: 'hi' }, cookie), new URL(`${base}/api/chat`), Buffer.from('{}'));
  assert.equal(beforePlan.status, 402);
  assert.equal((await beforePlan.json()).error, 'subscription_required');

  const dup = await saas.handle(
    post('/api/auth/signup', { email: 'student@example.com', password: 'another password' }),
    new URL(`${base}/api/auth/signup`),
    Buffer.from('{}'),
  );
  assert.equal(dup.status, 409);

  const wrong = await saas.handle(
    post('/api/auth/signin', { email: 'student@example.com', password: 'not the password' }),
    new URL(`${base}/api/auth/signin`),
    Buffer.from('{}'),
  );
  assert.equal(wrong.status, 401);

  const signin = await saas.handle(
    post('/api/auth/signin', { email: 'student@example.com', password: 'correct horse battery' }),
    new URL(`${base}/api/auth/signin`),
    Buffer.from('{}'),
  );
  assert.equal(signin.status, 200);

  // The webhook is the only thing that grants access.
  const event = {
    id: 'evt_1',
    type: 'customer.subscription.updated',
    data: {
      object: {
        id: 'sub_test_1',
        status: 'active',
        customer: 'cus_test_1',
        metadata: { account: created.account.id, plan: 'sage-scholar' },
        current_period_end: Math.floor(Date.now() / 1000) + 30 * 86400,
        cancel_at_period_end: false,
      },
    },
  };
  const hook = await webhook(event);
  assert.equal(hook.status, 200);
  assert.equal(hook.data.handled, true);

  const allowed = await saas.handle(post('/api/chat', { text: 'hi' }, cookie), new URL(`${base}/api/chat`), Buffer.from('{}'));
  assert.equal(allowed, null, 'a live subscriber must reach the app handler');

  const me = await saas.handle(get('/api/auth/me', cookie), new URL(`${base}/api/auth/me`), Buffer.from(''));
  const meData = await me.json();
  assert.equal(meData.signedIn, true);
  assert.equal(meData.entitlement.active, true);
  assert.equal(meData.entitlement.plan, 'sage-scholar');
  assert.equal(meData.entitlement.remaining, null);

  // Cancelling closes it again, immediately.
  await webhook({ type: 'customer.subscription.deleted', data: { object: { id: 'sub_test_1', customer: 'cus_test_1', status: 'canceled', metadata: { account: created.account.id, plan: 'sage-scholar' } } } });
  const afterCancel = await saas.handle(post('/api/chat', { text: 'hi' }, cookie), new URL(`${base}/api/chat`), Buffer.from('{}'));
  assert.equal(afterCancel.status, 402);
});

test('a spent quota answers 429 instead of spending the key', async () => {
  const signup = await saas.handle(
    post('/api/auth/signup', { email: 'capped@example.com', password: 'a long enough password' }),
    new URL(`${base}/api/auth/signup`),
    Buffer.from('{}'),
  );
  const created = await signup.json();
  const cookie = cookieOf(signup);

  await webhook({
    type: 'customer.subscription.updated',
    data: {
      object: {
        id: 'sub_capped',
        status: 'active',
        customer: 'cus_capped',
        metadata: { account: created.account.id, plan: 'sage-starter' },
        current_period_end: Math.floor(Date.now() / 1000) + 30 * 86400,
      },
    },
  });

  const { recordAnswer } = await import('../src/accounts.mjs');
  for (let index = 0; index < 250; index += 1) await recordAnswer(created.account.id);

  const blocked = await saas.handle(post('/api/chat', { text: 'hi' }, cookie), new URL(`${base}/api/chat`), Buffer.from('{}'));
  assert.equal(blocked.status, 429);
  const data = await blocked.json();
  assert.equal(data.error, 'quota_reached');
  assert.equal(data.limit, 250);

  // A non-chat route is not quota-bound.
  const other = await saas.handle(get('/api/models', cookie), new URL(`${base}/api/models`), Buffer.from(''));
  assert.equal(other, null);
});

test('checkout needs a session and a real plan', async () => {
  const anonymous = await saas.handle(post('/api/billing/checkout', { plan: 'sage-scholar' }), new URL(`${base}/api/billing/checkout`), Buffer.from('{}'));
  assert.equal(anonymous.status, 401);

  const signin = await saas.handle(
    post('/api/auth/signin', { email: 'capped@example.com', password: 'a long enough password' }),
    new URL(`${base}/api/auth/signin`),
    Buffer.from('{}'),
  );
  const cookie = cookieOf(signin);

  const badPlan = await saas.handle(post('/api/billing/checkout', { plan: 'free-forever' }, cookie), new URL(`${base}/api/billing/checkout`), Buffer.from('{}'));
  assert.equal(badPlan.status, 400);
  assert.equal((await badPlan.json()).error, 'bad_plan');

  // With a fake key Stripe refuses, and the refusal is reported rather than hidden.
  const attempted = await saas.handle(post('/api/billing/checkout', { plan: 'sage-scholar' }, cookie), new URL(`${base}/api/billing/checkout`), Buffer.from('{}'));
  assert.equal(attempted.status, 502);
  const data = await attempted.json();
  assert.equal(data.error, 'checkout_failed');
  assert.ok(data.message.length > 5);
});

test('an instance without Stripe keeps the self-hosted path', async () => {
  const selfHosted = createSaaS({ SAGE_SESSION_SECRET: 'x' });
  assert.equal(selfHosted.enabled, false);
  const response = await selfHosted.handle(get('/api/chat'), new URL(`${base}/api/chat`), Buffer.from(''));
  assert.equal(response, null, 'no gate means the app handler decides');
  assert.equal(selfHosted.authorise(), undefined);
});
