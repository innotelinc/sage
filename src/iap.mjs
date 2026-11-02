/**
 * App Store purchases.
 *
 * Apple requires digital goods sold inside an iOS app to go through in-app
 * purchase, so a session bought on the phone is a StoreKit consumable rather than
 * a Stripe checkout. A confirmed purchase is not a key on its own: Apple's
 * transaction is checked against the App Store Server API first, and only a
 * verified transaction is exchanged for a session.
 *
 * Minting stays where it already lives — Magnate holds the gateway and issues the
 * keys — so this asks it to mint against a transaction id. If that endpoint is not
 * configured, the purchase endpoint answers 501 and the app keeps the store page
 * instead: it must never take money it cannot hand a key back for.
 */
import { createSign } from 'node:crypto';

const APPLE_API = 'https://api.storekit.itunes.apple.com';
const APPLE_AUD = 'appstoreconnect-v1';

function b64(value) {
  return Buffer.from(value).toString('base64url');
}

/** The App Store Server API wants an ES256 JWT; node signs DER, JOSE wants r||s. */
function appleToken(env = {}) {
  const issuer = String(env.APPLE_ISSUER_ID || env.ASC_ISSUER_ID || '').trim();
  const keyId = String(env.APPLE_KEY_ID || env.ASC_KEY_ID || '').trim();
  const key = String(env.APPLE_PRIVATE_KEY || env.ASC_PRIVATE_KEY || '').replace(/\\n/g, '\n').trim();
  const bundle = String(env.APPLE_BUNDLE_ID || 'us.innotel.sage').trim();
  if (!issuer || !keyId || !key) return '';

  const issued = Math.floor(Date.now() / 1000);
  const head = b64(JSON.stringify({ alg: 'ES256', kid: keyId, typ: 'JWT' }));
  const body = b64(JSON.stringify({ iss: issuer, iat: issued, exp: issued + 300, aud: APPLE_AUD, bid: bundle }));
  const signingInput = `${head}.${body}`;
  try {
    const der = createSign('sha256').update(signingInput).sign(key);
    return `${signingInput}.${derToJose(der)}`;
  } catch {
    // A malformed key is a configuration problem, reported as "not configured"
    // rather than as a failed purchase.
    return '';
  }
}

function readInt(der, start) {
  if (der[start] !== 0x02) throw new Error('expected an INTEGER');
  const length = der[start + 1];
  return { value: der.subarray(start + 2, start + 2 + length), next: start + 2 + length };
}

function stripLeadingZeros(value) {
  let index = 0;
  while (index < value.length - 1 && value[index] === 0) index += 1;
  return value.subarray(index);
}

function derToJose(der) {
  if (der[0] !== 0x30) throw new Error('expected a SEQUENCE');
  let offset = 2;
  if (der[1] & 0x80) offset = 2 + (der[1] & 0x7f);
  const r = readInt(der, offset);
  const s = readInt(der, r.next);
  const out = Buffer.alloc(64);
  const ri = stripLeadingZeros(r.value);
  const si = stripLeadingZeros(s.value);
  ri.copy(out, 32 - ri.length);
  si.copy(out, 64 - si.length);
  return out.toString('base64url');
}

/**
 * Product ids are optional configuration: without them the app does not know what
 * to ask the store for. They map to the plans the store page sells.
 */
export function iapConfig(env = {}) {
  const minted = Boolean(String(env.IAP_MINT_URL || '').trim());
  const bundle = String(env.APPLE_BUNDLE_ID || 'us.innotel.sage').trim();
  const configured = String(env.IAP_PRODUCTS || '')
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      const [productId, planSlug] = entry.split(':');
      return productId && planSlug ? { productId, planSlug } : null;
    })
    .filter(Boolean);
  const products = configured.length
    ? configured
    : ['trial', 'standard', 'intensive'].map((suffix) => ({
        productId: `${bundle}.session.${suffix}`,
        planSlug: `sage-session-${suffix}`,
      }));
  return { enabled: minted, verify: Boolean(appleToken(env)), products };
}

async function verifiedTransaction(transactionId, env) {
  const token = appleToken(env);
  if (!token) return { error: 'Apple server verification is not configured.' };
  const base = String(env.IAP_VERIFY_URL || APPLE_API).replace(/\/+$/, '');
  let res;
  try {
    res = await fetch(`${base}/inApps/v1/transactions/${encodeURIComponent(transactionId)}`, {
      headers: { authorization: `Bearer ${token}`, accept: 'application/json' },
      signal: AbortSignal.timeout(15000),
    });
  } catch (error) {
    return { error: `Cannot reach Apple (${error.message}).` };
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.signedTransactionInfo) {
    return { error: `Apple would not confirm that transaction (${res.status}).` };
  }
  // The signed payload is Apple's answer; the product id in it is what decides
  // which plan was paid for, never the id the app sent.
  const payload = decodePayload(data.signedTransactionInfo);
  if (!payload || !payload.productId) return { error: 'Apple returned a transaction with no product.' };
  return { payload };
}

function decodePayload(jws) {
  const parts = String(jws).split('.');
  if (parts.length < 2) return null;
  try {
    return JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
  } catch {
    return null;
  }
}

async function mintSession({ productId, transactionId, email }, env) {
  const url = String(env.IAP_MINT_URL || '').trim();
  if (!url) return { error: 'in_app_purchase is not enabled on this server', status: 501 };
  const headers = { 'content-type': 'application/json', accept: 'application/json' };
  const token = String(env.IAP_MINT_TOKEN || '').trim();
  if (token) headers.authorization = `Bearer ${token}`;
  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify({ productId, transactionId, email }),
      signal: AbortSignal.timeout(20000),
    });
  } catch (error) {
    return { error: `The key service is unreachable (${error.message}).`, status: 502 };
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.key) {
    return { error: String(data.error || `The key service refused the purchase (${res.status}).`), status: 502 };
  }
  return {
    session: {
      key: String(data.key),
      expiresAt: data.expiresAt || null,
      secondsLeft: Number(data.secondsLeft) || 0,
      planName: String(data.planName || ''),
      baseUrl: String(env.AI_BASE_URL || 'https://gateway.innotel.us/v1').replace(/\/+$/, ''),
    },
  };
}

export async function handleIap(request, url, env, json) {
  if (url.pathname === '/api/iap/config' && request.method === 'GET') {
    return json(iapConfig(env));
  }
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
  const transactionId = String(body.transactionId || '').trim().slice(0, 40);
  const email = String(body.email || '').trim().slice(0, 200);
  if (!/^[0-9]{1,40}$/.test(transactionId)) {
    return json({ error: 'bad_transaction', message: 'A StoreKit transaction id is required.' }, 400);
  }

  const verified = await verifiedTransaction(transactionId, env);
  if (verified.error) return json({ error: 'verify_failed', message: verified.error }, 502);

  const productId = String(verified.payload.productId);
  const quantity = Number(verified.payload.quantity) || 1;
  const revoked = verified.payload.revocationDate ? true : false;
  if (revoked) return json({ error: 'revoked', message: 'Apple reports that purchase as refunded or revoked.' }, 409);
  if (quantity !== 1) {
    return json({ error: 'bad_quantity', message: 'A session purchase must be for one session.' }, 409);
  }

  const minted = await mintSession({ productId, transactionId, email }, env);
  if (minted.error) return json({ error: 'mint_failed', message: minted.error }, minted.status || 502);

  return json({ ...minted.session, productId, transactionId });
}
