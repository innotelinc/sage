/**
 * App Store purchases.
 *
 * Apple requires digital goods sold inside an iOS app to go through in-app
 * purchase, so a session bought on the phone is a StoreKit consumable rather than a
 * Stripe checkout. A confirmed purchase is not a key on its own: StoreKit hands back
 * a signed transaction — a JWS whose certificate chain ends at Apple's root — and
 * that signature is what is checked here.
 *
 * The check runs offline against a pinned anchor, so this server needs no App Store
 * Server API key to know a purchase is real, and it never trusts an id the app read
 * out of the payload: the product and the transaction are taken from Apple's own
 * signed answer once the signature holds.
 *
 * Minting stays where it already lives — Magnate holds the gateway and issues the
 * keys — so a verified transaction is posted to IAP_MINT_URL. If that endpoint is not
 * configured the purchase route answers 501 and the app keeps the store page: it must
 * never take money it cannot hand a key back for.
 */
import { X509Certificate, verify as verifySignature } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sessionMinutes, sessionPlan } from './plans.mjs';
import { verifyGrant } from './grants.mjs';

/**
 * Apple Root CA - G3, the anchor every StoreKit 2 signing chain ends at. Pinned by
 * fingerprint rather than by name, so a chain that carries a different "Apple Root
 * CA" of its own cannot nominate itself as the anchor.
 * https://www.apple.com/certificateauthority/AppleRootCA-G3.cer
 */
const APPLE_ROOT_SHA256 = ['63343ABFB89A6A03EBB57E9B3F5FA7BE7C4F5C756F3017B3A8C488C3653E9179'];

const MAX_SIGNED_LENGTH = 12000;
const MAX_KEY_LENGTH = 200;
const MAX_EMAIL_LENGTH = 200;
const ENVIRONMENTS = new Set(['Production', 'Sandbox']);
const SEEN_LIMIT = 2000;

// Transaction ids already exchanged by this process. The mint route is the real
// authority — it must refuse a transaction it has already paid out — and this is the
// cheap guard in front of it, so a replayed request cannot walk through on the way.
const handedOut = new Set();

/**
 * A trial is once per person and once per connection.
 *
 * Five minutes is enough to show what the app does and not enough to be worth
 * farming, but only if a second attempt is refused: without a record, the same
 * email or the same address mints trial after trial. The ledger is on disk
 * because the process restarts, keyed by the normalised email and by the client
 * address the server actually saw.
 */
function trialFile() {
  const override = String(process.env.TRIAL_LEDGER_FILE || '').trim();
  return override || join(dirname(fileURLToPath(import.meta.url)), '..', 'data', 'trial-claims.json');
}

let trialLedger = null;

function readTrialLedger() {
  if (trialLedger) return trialLedger;
  try {
    const parsed = JSON.parse(readFileSync(trialFile(), 'utf8'));
    trialLedger = { emails: parsed.emails || {}, ips: parsed.ips || {} };
  } catch {
    trialLedger = { emails: {}, ips: {} };
  }
  return trialLedger;
}

function trialKey(value) {
  return String(value || '').trim().toLowerCase();
}

/** Why this trial cannot be given, or '' when it can. */
export function trialRefusal({ email, ip } = {}) {
  const ledger = readTrialLedger();
  const mail = trialKey(email);
  if (mail && ledger.emails[mail]) {
    return 'That email has already used its trial session. A trial is one five-minute session per person.';
  }
  const address = trialKey(ip);
  if (address && ledger.ips[address]) {
    return 'A trial session has already been used from this connection. A trial is one five-minute session per person.';
  }
  return '';
}

export function rememberTrial({ email, ip, transactionId } = {}) {
  const ledger = readTrialLedger();
  const at = new Date().toISOString();
  const mail = trialKey(email);
  const address = trialKey(ip);
  if (mail) ledger.emails[mail] = { at, transactionId: String(transactionId || '') };
  if (address) ledger.ips[address] = { at, transactionId: String(transactionId || '') };
  try {
    mkdirSync(dirname(trialFile()), { recursive: true });
    writeFileSync(trialFile(), `${JSON.stringify(ledger, null, 2)}\n`);
  } catch {
    // A read-only filesystem still refuses a second trial for this process's lifetime.
  }
}

export function bundleId(env = {}) {
  return String(env.APPLE_BUNDLE_ID || 'us.innotel.sage').trim();
}

/**
 * Product ids are optional configuration: without them the built-in mapping between
 * the three consumables and the plans the store page sells is used.
 */
export function productList(env = {}) {
  const configured = String(env.IAP_PRODUCTS || '')
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      const [productId, planSlug] = entry.split(':').map((part) => String(part || '').trim());
      return productId && planSlug ? { productId, planSlug } : null;
    })
    .filter(Boolean);
  if (configured.length) return configured;
  // These have to match App Store Connect character for character: StoreKit
  // answers nothing for an id that is not registered, so a single transposed
  // letter makes every session look unavailable in the app.
  return [
    { productId: 'us.innotel.sage.session.trial', planSlug: 'sage-session-trial' },
    { productId: 'us.innotel.sage.session.standard', planSlug: 'sage-session-standard' },
    { productId: 'us.innotel.sage.session.intensive', planSlug: 'sage-session-intensive' },
  ];
}

export function iapConfig(env = {}) {
  return {
    // The button only appears when a verified purchase can actually become a key.
    enabled: Boolean(String(env.IAP_MINT_URL || '').trim()),
    // Verification needs no credentials: the App Store signs the transaction and the
    // signature is checked against a pinned root.
    verify: true,
    products: productList(env),
  };
}

function trustAnchors(env = {}) {
  const override = String(env.IAP_TRUST_ANCHORS || '')
    .split(',')
    .map((entry) => entry.replace(/[^0-9a-fA-F]/g, '').toUpperCase())
    .filter(Boolean);
  return override.length ? override : APPLE_ROOT_SHA256;
}

function decodePart(part) {
  try {
    return JSON.parse(Buffer.from(String(part), 'base64url').toString('utf8'));
  } catch {
    return null;
  }
}

function validBetween(cert, now) {
  const from = cert.validFromDate ? cert.validFromDate.getTime() : Date.parse(cert.validFrom);
  const to = cert.validToDate ? cert.validToDate.getTime() : Date.parse(cert.validTo);
  if (!Number.isFinite(from) || !Number.isFinite(to)) return true;
  return now >= from && now <= to;
}

/**
 * Leaf → intermediate → anchor, each certificate checked against the one that issued
 * it. The last certificate in the header has to be an anchor we already trust; its
 * key is what proves the certificate below it, so no part of the chain is taken on
 * the chain's own word.
 */
function verifyChain(x5c, anchors, now) {
  if (!Array.isArray(x5c) || x5c.length < 2) return { error: 'the signature carries no certificate chain.' };
  let certs;
  try {
    certs = x5c.map((entry) => new X509Certificate(Buffer.from(String(entry), 'base64')));
  } catch {
    return { error: 'the certificate chain is not readable.' };
  }
  const root = certs[certs.length - 1];
  const fingerprint = root.fingerprint256.replace(/:/g, '').toUpperCase();
  if (!anchors.includes(fingerprint)) return { error: 'the signing chain does not end at a trusted anchor.' };
  if (!certs.every((cert) => validBetween(cert, now))) return { error: 'a certificate in the chain is outside its valid dates.' };
  for (let index = 0; index < certs.length - 1; index += 1) {
    const child = certs[index];
    const issuer = certs[index + 1];
    if (!child.checkIssued(issuer)) return { error: 'the certificate chain is not contiguous.' };
    if (!child.verify(issuer.publicKey)) return { error: 'a certificate in the chain was not signed by its issuer.' };
  }
  return { leaf: certs[0] };
}

/**
 * Checks a StoreKit 2 signed transaction and returns the payload it protects.
 *
 * `options.anchors` exists for tests and for a private trust store; production calls
 * it with nothing and gets Apple's root.
 */
export function verifySignedTransaction(signed, options = {}) {
  const env = options.env || {};
  const text = String(signed || '').trim();
  if (!text) return { error: 'the purchase carried no signed transaction.' };
  if (text.length > MAX_SIGNED_LENGTH) return { error: 'the signed transaction is not a StoreKit one.' };

  const parts = text.split('.');
  if (parts.length !== 3) return { error: 'the signed transaction is not a JWS.' };
  const header = decodePart(parts[0]);
  if (!header || header.alg !== 'ES256') return { error: 'the transaction is not signed with ES256.' };

  const now = Number(options.now) || Date.now();
  const chain = verifyChain(header.x5c, options.anchors || trustAnchors(env), now);
  if (chain.error) return { error: chain.error };

  let signatureOk = false;
  try {
    signatureOk = verifySignature(
      'sha256',
      Buffer.from(`${parts[0]}.${parts[1]}`),
      { key: chain.leaf.publicKey, dsaEncoding: 'ieee-p1363' },
      Buffer.from(parts[2], 'base64url'),
    );
  } catch {
    signatureOk = false;
  }
  if (!signatureOk) return { error: 'the transaction signature does not match its payload.' };

  const payload = decodePart(parts[1]);
  if (!payload) return { error: 'the transaction payload is not JSON.' };

  const expectedBundle = bundleId(env);
  if (String(payload.bundleId || '') !== expectedBundle) {
    return { error: `the transaction is for ${payload.bundleId || 'another app'}, not ${expectedBundle}.` };
  }
  if (!ENVIRONMENTS.has(String(payload.environment || ''))) {
    return { error: `the transaction environment (${payload.environment || 'unknown'}) is not a store one.` };
  }
  if (payload.revocationDate) return { error: 'Apple reports that purchase as refunded or revoked.' };
  if (Number(payload.quantity || 1) !== 1) return { error: 'a session purchase must be for one session.' };
  if (payload.type && payload.type !== 'Consumable') {
    return { error: `the transaction is a ${payload.type}, not a session.` };
  }
  const products = options.products || productList(env);
  const entry = products.find((item) => item.productId === payload.productId);
  if (!entry) return { error: `that product (${payload.productId || 'none'}) is not a session this server sells.` };
  if (!payload.transactionId) return { error: 'the transaction has no id.' };
  return { payload, entry };
}

function remember(transactionId) {
  handedOut.add(String(transactionId));
  if (handedOut.size > SEEN_LIMIT) handedOut.delete(handedOut.values().next().value);
}

/**
 * Asks Magnate for the key.
 *
 * The body is the verified transaction, not a claim about it: the plan is named so
 * the route does not have to know this app's product ids, and the transaction id is
 * the idempotency key the route pays out against exactly once.
 */
async function mintSession({ productId, planSlug, transactionId, email, payload, minutes }, env) {
  const url = String(env.IAP_MINT_URL || '').trim();
  if (!url) return { error: 'in_app_purchase is not enabled on this server', status: 501 };
  const headers = { 'content-type': 'application/json', accept: 'application/json' };
  const token = String(env.IAP_MINT_TOKEN || '').trim();
  if (token) headers.authorization = `Bearer ${token}`;

  const purchasedAt = Number(payload.purchaseDate)
    ? new Date(Number(payload.purchaseDate)).toISOString()
    : null;

  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        productId,
        planSlug,
        // How long the session runs is the catalog's answer, not the store's: the
        // trial is five minutes by design and the mint service is told so.
        minutes,
        transactionId: String(transactionId),
        email,
        bundleId: payload.bundleId,
        environment: payload.environment,
        purchasedAt,
      }),
      signal: AbortSignal.timeout(20000),
    });
  } catch (error) {
    return { error: `The key service is unreachable (${error.message}).`, status: 502 };
  }

  const data = await res.json().catch(() => ({}));
  const key = String(data.key || '').trim();
  if (!res.ok || !key) {
    return {
      error: String(data.error || `The key service refused the purchase (${res.status}).`),
      status: 502,
    };
  }
  if (key.length > MAX_KEY_LENGTH || /\s/.test(key)) {
    return { error: 'The key service issued a key the gateway will not accept.', status: 502 };
  }
  return {
    session: {
      key,
      planName: String(data.planName || ''),
      expiresAt: data.expiresAt || null,
      secondsLeft: Number(data.secondsLeft) || 0,
      baseUrl: String(env.AI_BASE_URL || 'https://gateway.innotel.us/v1').replace(/\/+$/, ''),
    },
  };
}

/**
 * Redeem a signed session code.
 *
 * Deliberately the same mint the purchase path uses, with a synthetic transaction id
 * built from the code's nonce: a granted session is a session, not a parallel kind of
 * key that would drift from the one StoreKit installs. Without the secret the route is
 * closed rather than open, and a code is paid out once.
 */
async function handleGrant(request, env, json) {
  if (request.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);
  const secret = String(env.SESSION_GRANT_SECRET || env.SAGE_ADMIN_SECRET || '').trim();
  if (!secret) {
    return json(
      {
        error: 'grants_disabled',
        message: 'Session codes are off on this server: set SESSION_GRANT_SECRET, then mint one with scripts/grant-session.mjs.',
      },
      501,
    );
  }
  const body = await request.json().catch(() => null);
  if (!body) return json({ error: 'bad_json', message: 'Body must be JSON.' }, 400);

  const verified = await verifyGrant(body.code, secret);
  if (verified.error) return json({ error: 'grant_refused', message: verified.error }, 400);

  const { planSlug, email, nonce } = verified.grant;
  const plan = sessionPlan(planSlug);
  if (!plan) {
    return json({ error: 'grant_refused', message: `that code names a plan this server does not sell (${planSlug})` }, 400);
  }
  const transactionId = `grant:${nonce || planSlug}`;
  if (handedOut.has(transactionId)) {
    return json({ error: 'already_redeemed', message: 'That session code has already been used.' }, 409);
  }

  const minted = await mintSession(
    {
      productId: `grant.${planSlug}`,
      planSlug,
      transactionId,
      email,
      payload: { bundleId: bundleId(env), environment: 'Grant' },
      minutes: plan.minutes || sessionMinutes(planSlug),
    },
    env,
  );
  if (minted.error) return json({ error: 'mint_failed', message: minted.error }, minted.status || 502);

  remember(transactionId);
  return json({
    ...minted.session,
    productId: `grant.${planSlug}`,
    transactionId,
    minutes: plan.minutes || 0,
    granted: true,
  });
}

export async function handleIap(request, url, env, json, context = {}) {
  if (url.pathname === '/api/iap/config' && request.method === 'GET') {
    return json(iapConfig(env));
  }
  // A session granted by the operator instead of bought. The paid agreement can be
  // missing from an account for weeks; that must not stop the product working.
  if (url.pathname === '/api/iap/grant') return handleGrant(request, env, json);
  if (url.pathname !== '/api/iap/purchase') return json({ error: 'not_found' }, 404);
  if (request.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);

  const config = iapConfig(env);
  if (!config.enabled) {
    return json(
      { error: 'iap_disabled', message: 'In-app purchase is not enabled on this server; buy from the store page instead.' },
      501,
    );
  }

  const body = await request.json().catch(() => null);
  if (!body) return json({ error: 'bad_json', message: 'Body must be JSON.' }, 400);

  const email = String(body.email || '').trim().slice(0, MAX_EMAIL_LENGTH);
  const verified = verifySignedTransaction(body.signedTransaction, { env, products: config.products });
  if (verified.error) {
    return json({ error: 'verify_failed', message: verified.error }, 400);
  }

  const { payload, entry } = verified;
  const transactionId = String(payload.transactionId);
  const plan = sessionPlan(entry.planSlug);
  const trial = entry.planSlug === 'sage-session-trial';
  if (trial) {
    const refusal = trialRefusal({ email, ip: context.ip });
    if (refusal) return json({ error: 'trial_used', message: refusal }, 409);
  }
  if (handedOut.has(transactionId)) {
    return json({ error: 'already_redeemed', message: 'That purchase has already been exchanged for a session.' }, 409);
  }

  const minted = await mintSession(
    {
      productId: String(payload.productId),
      planSlug: entry.planSlug,
      transactionId,
      email,
      payload,
      minutes: plan?.minutes || sessionMinutes(entry.planSlug),
    },
    env,
  );
  if (minted.error) return json({ error: 'mint_failed', message: minted.error }, minted.status || 502);

  remember(transactionId);
  // Recorded only after the key exists: a refused mint must not spend the trial.
  if (trial) rememberTrial({ email, ip: context.ip, transactionId });
  return json({
    ...minted.session,
    productId: String(payload.productId),
    transactionId,
    minutes: plan?.minutes || 0,
  });
}
