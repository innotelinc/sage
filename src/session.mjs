/**
 * Signed cookies, for the admin panel only.
 *
 * Two payloads ride on this: the SSO attempt (`state`, `nonce`, PKCE verifier)
 * and the signed-in session (who, until when, and the CSRF token). Both are
 * HMAC-SHA256 under `SAGE_ADMIN_SECRET`, so the browser can hold them without
 * being able to forge or edit either.
 */
import { createHmac, timingSafeEqual, randomBytes } from 'node:crypto';

export const SESSION_COOKIE = 'sage_admin';
export const SSO_COOKIE = 'sage_sso';

function sign(payload, secret) {
  return createHmac('sha256', secret).update(payload).digest('base64url');
}

export function newToken() {
  return randomBytes(18).toString('base64url');
}

export function signPayload(payload, secret, ttlSeconds = 600) {
  const body = Buffer.from(
    JSON.stringify({ ...payload, exp: Math.floor(Date.now() / 1000) + ttlSeconds }),
  ).toString('base64url');
  return `${body}.${sign(body, secret)}`;
}

export function readPayload(value, secret) {
  if (!value || !secret) return null;
  const [body, signature] = String(value).split('.');
  if (!body || !signature) return null;
  const expected = sign(body, secret);
  const left = Buffer.from(signature);
  const right = Buffer.from(expected);
  if (left.length !== right.length || !timingSafeEqual(left, right)) return null;
  let parsed;
  try {
    parsed = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  if (!parsed || typeof parsed.exp !== 'number' || parsed.exp < Math.floor(Date.now() / 1000)) return null;
  return parsed;
}

export function issueSession(session, secret, maxAgeSeconds = 8 * 60 * 60) {
  return signPayload(
    {
      sub: session.sub,
      email: session.email,
      name: session.name || '',
      csrf: newToken(),
    },
    secret,
    maxAgeSeconds,
  );
}

export function readSession(value, secret) {
  return readPayload(value, secret);
}

export function parseCookies(header = '') {
  const jar = {};
  for (const part of String(header).split(';')) {
    const index = part.indexOf('=');
    if (index < 0) continue;
    const name = part.slice(0, index).trim();
    if (!name) continue;
    try {
      jar[name] = decodeURIComponent(part.slice(index + 1).trim());
    } catch {
      jar[name] = part.slice(index + 1).trim();
    }
  }
  return jar;
}

export function setCookie(name, value, { secure, maxAgeSeconds = 0, sameSite = 'Lax' } = {}) {
  const flags = ['Path=/', 'HttpOnly', `SameSite=${sameSite}`];
  if (maxAgeSeconds) flags.push(`Max-Age=${maxAgeSeconds}`);
  if (secure) flags.push('Secure');
  return `${name}=${encodeURIComponent(value)}; ${flags.join('; ')}`;
}

export function dropCookie(name, { secure } = {}) {
  const flags = ['Path=/', 'HttpOnly', 'SameSite=Lax', 'Max-Age=0'];
  if (secure) flags.push('Secure');
  return `${name}=; ${flags.join('; ')}`;
}
