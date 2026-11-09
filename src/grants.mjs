/**
 * Session grants without the App Store.
 *
 * While a paid agreement is pending — or missing from the account altogether — the
 * only way to sell a session is through StoreKit, and StoreKit answers with nothing.
 * This is the operator's way round it: a signed code, minted offline with a secret the
 * server also holds, redeemed once through the same mint route a purchase uses, so a
 * granted session is a real session and not a second kind of key.
 *
 * The code carries its own expiry and a nonce; the server keeps no table of pending
 * grants. What it does keep is the nonce it has already paid out, which is what makes
 * a code single-use.
 *
 * HMAC-SHA256 over a base64url payload, deliberately simple enough to read: the only
 * thing standing between a code and a free session is the secret, so nothing about it
 * may be clever.
 */

const VERSION = 'sage1';
const DEFAULT_TTL_MINUTES = 7 * 24 * 60;

function b64url(bytes) {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromB64url(text) {
  const padded = String(text || '').replace(/-/g, '+').replace(/_/g, '/');
  const binary = atob(padded + '='.repeat((4 - (padded.length % 4)) % 4));
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

async function sign(secret, body) {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const signature = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(body));
  return b64url(new Uint8Array(signature));
}

/** A code for one session of one plan, valid until it is used or it expires. */
export async function signGrant({ planSlug, email = '', ttlMinutes = DEFAULT_TTL_MINUTES, now = Date.now(), nonce }, secret) {
  if (!secret) throw new Error('a grant needs a secret');
  const random = new Uint8Array(9);
  crypto.getRandomValues(random);
  const payload = {
    v: 1,
    plan: String(planSlug || ''),
    email: String(email || '').slice(0, 160),
    // No floor: a caller asking for a lifetime of zero or less gets a code that is
    // already expired, which is the honest result and what the test checks.
    exp: Number(now) + (Number.isFinite(Number(ttlMinutes)) ? Number(ttlMinutes) : DEFAULT_TTL_MINUTES) * 60000,
    n: String(nonce || [...random].map((byte) => byte.toString(16).padStart(2, '0')).join('')),
  };
  const body = b64url(new TextEncoder().encode(JSON.stringify(payload)));
  return `${VERSION}.${body}.${await sign(secret, body)}`;
}

/**
 * Check a code. Every failure says what is wrong without saying whether the secret
 * matched, except the one case where it has to: a forged signature.
 */
export async function verifyGrant(code, secret, now = Date.now()) {
  if (!secret) return { error: 'session grants are not enabled on this server' };
  const parts = String(code || '').trim().split('.');
  if (parts.length !== 3 || parts[0] !== VERSION) return { error: 'that is not a session code' };
  const [, body, signature] = parts;
  const expected = await sign(secret, body);
  if (signature.length !== expected.length) return { error: 'that session code is not genuine' };
  let difference = 0;
  for (let index = 0; index < expected.length; index += 1) {
    difference |= signature.charCodeAt(index) ^ expected.charCodeAt(index);
  }
  if (difference !== 0) return { error: 'that session code is not genuine' };

  let payload = null;
  try {
    payload = JSON.parse(new TextDecoder().decode(fromB64url(body)));
  } catch {
    return { error: 'that session code is damaged' };
  }
  if (!payload || payload.v !== 1) return { error: 'that session code is from another version' };
  if (!(Number(payload.exp) > now)) return { error: 'that session code has expired' };
  if (!payload.plan) return { error: 'that session code names no plan' };
  return {
    grant: {
      planSlug: String(payload.plan),
      email: String(payload.email || ''),
      nonce: String(payload.n || ''),
      expiresAt: new Date(Number(payload.exp)).toISOString(),
    },
  };
}
