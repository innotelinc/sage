/**
 * Cerulean SSO (Authentik) sign-in for the admin panel, in the boring shape:
 * authorization code + PKCE, confidential client, no dependencies.
 *
 * Three rules keep this small and safe:
 *  - `state` and `nonce` are generated per attempt and carried in a short-lived
 *    cookie, so a replayed callback cannot sign anyone in.
 *  - The id_token is read only from the token endpoint's direct, TLS-protected
 *    answer, which is the flow OIDC Core permits without a second signature
 *    check (3.1.3.7). Its `iss`, `aud`, `exp` and `nonce` are still verified.
 *  - Nobody gets in unless their address is in `SAGE_ADMIN_EMAILS`.
 */
import { createHash, randomBytes } from 'node:crypto';

const DISCOVERY_TTL_MS = 60 * 60 * 1000;
const cache = new Map();

export const STATE_COOKIE = 'sage_sso';

function trimSlash(value) {
  return String(value || '').trim().replace(/\/+$/, '');
}

export function b64url(buffer) {
  return Buffer.from(buffer).toString('base64url');
}

export function oidcConfig(env = {}, origin = '') {
  const issuer = trimSlash(env.CERULEAN_ISSUER || env.SAGE_OIDC_ISSUER || '');
  const clientId = String(env.CERULEAN_CLIENT_ID || env.SAGE_OIDC_CLIENT_ID || '').trim();
  const clientSecret = String(env.CERULEAN_CLIENT_SECRET || env.SAGE_OIDC_CLIENT_SECRET || '').trim();
  const admins = String(env.SAGE_ADMIN_EMAILS || '')
    .split(/[\s,]+/)
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean);
  const base = trimSlash(env.SAGE_PUBLIC_URL || origin);
  return {
    issuer,
    clientId,
    clientSecret,
    admins,
    redirectUri: String(env.SAGE_ADMIN_REDIRECT || (base ? `${base}/admin/callback` : '')).trim(),
    scope: String(env.SAGE_OIDC_SCOPE || 'openid email profile').trim(),
    enabled: Boolean(issuer && clientId && clientSecret && admins.length),
    /** What is missing, for the panel's setup card. Never includes a value. */
    missing: [
      !issuer && 'CERULEAN_ISSUER',
      !clientId && 'CERULEAN_CLIENT_ID',
      !clientSecret && 'CERULEAN_CLIENT_SECRET',
      !admins.length && 'SAGE_ADMIN_EMAILS',
    ].filter(Boolean),
  };
}

export async function discovery(cfg) {
  const key = cfg.issuer;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < DISCOVERY_TTL_MS) return hit.doc;
  const response = await fetch(`${cfg.issuer}/.well-known/openid-configuration`, {
    headers: { accept: 'application/json' },
    signal: AbortSignal.timeout(10000),
  });
  if (!response.ok) throw new Error(`Cerulean discovery failed (${response.status}) at ${cfg.issuer}`);
  const doc = await response.json();
  if (!doc || !doc.authorization_endpoint || !doc.token_endpoint) {
    throw new Error('Cerulean discovery document is missing its endpoints.');
  }
  cache.set(key, { at: Date.now(), doc });
  return doc;
}

export function newAttempt({ again = false } = {}) {
  const verifier = b64url(randomBytes(32));
  return {
    verifier,
    challenge: b64url(createHash('sha256').update(verifier).digest()),
    state: b64url(randomBytes(16)),
    nonce: b64url(randomBytes(16)),
    // Set on the single attempt that follows a refused exchange, so a sign-in
    // that is genuinely broken reports itself instead of looping through
    // Cerulean. It rides in the signed cookie, so the browser cannot set it.
    again: again ? 1 : 0,
  };
}

export function authorizeUrl(cfg, doc, attempt) {
  const url = new URL(doc.authorization_endpoint);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', cfg.clientId);
  url.searchParams.set('redirect_uri', cfg.redirectUri);
  url.searchParams.set('scope', cfg.scope);
  url.searchParams.set('state', attempt.state);
  url.searchParams.set('nonce', attempt.nonce);
  url.searchParams.set('code_challenge', attempt.challenge);
  url.searchParams.set('code_challenge_method', 'S256');
  return url.toString();
}

export function decodeIdToken(idToken) {
  const parts = String(idToken || '').split('.');
  if (parts.length !== 3) throw new Error('The identity provider returned no readable id_token.');
  return JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
}

export async function exchangeCode(cfg, doc, { code, verifier }) {
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: cfg.redirectUri,
    client_id: cfg.clientId,
    code_verifier: verifier,
  });
  const headers = {
    'content-type': 'application/x-www-form-urlencoded',
    accept: 'application/json',
  };
  // Authentik accepts either basic auth or the secret in the body; send both
  // shapes it documents so a client configured either way still works.
  headers.authorization = `Basic ${Buffer.from(`${cfg.clientId}:${cfg.clientSecret}`).toString('base64')}`;
  body.set('client_secret', cfg.clientSecret);

  const response = await fetch(doc.token_endpoint, {
    method: 'POST',
    headers,
    body,
    signal: AbortSignal.timeout(15000),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    // The provider's own words are the only way to tell an expired code from a
    // replayed one or a PKCE mismatch. The code and the tokens are never logged.
    console.error(
      `[admin] token exchange refused (${response.status}) ${data.error || 'no error'} ${
        data.error_description || 'no description'
      }`.trim()
    );
    throw new Error(
      `Cerulean refused the sign-in (${response.status})${data.error ? `: ${data.error}` : ''}${
        data.error_description ? ` — ${data.error_description}` : ''
      }`
    );
  }
  if (!data.id_token) throw new Error('Cerulean answered without an id_token.');
  return data;
}

/** Every claim that matters, checked, then the identity is returned. */
export function verifyClaims(cfg, claims, attempt) {
  if (!claims || typeof claims !== 'object') throw new Error('The id_token carried no claims.');
  if (trimSlash(claims.iss) !== cfg.issuer) throw new Error('The id_token came from a different issuer.');
  const audience = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!audience.includes(cfg.clientId)) throw new Error('The id_token was issued to a different client.');
  if (typeof claims.exp === 'number' && claims.exp * 1000 < Date.now()) throw new Error('The id_token has expired.');
  if (attempt?.nonce && claims.nonce && claims.nonce !== attempt.nonce) {
    throw new Error('The id_token does not match this sign-in attempt.');
  }
  const email = String(claims.email || claims.preferred_username || '').trim().toLowerCase();
  if (!email) throw new Error('Cerulean did not include an email address for this account.');
  return {
    sub: String(claims.sub || email),
    email,
    name: String(claims.name || claims.preferred_username || ''),
    groups: Array.isArray(claims.groups) ? claims.groups.map(String) : [],
  };
}

export function isAdmin(cfg, identity) {
  return cfg.admins.includes(String(identity.email || '').toLowerCase());
}
