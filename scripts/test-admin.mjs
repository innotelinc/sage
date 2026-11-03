/**
 * End-to-end proof of the operator panel against a stub Authentik: sign-in,
 * session, access-code write, enforcement, CSRF and origin refusal, and the
 * non-operator rejection. Throwaway harness, not shipped.
 */
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { readFileSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const SSO_PORT = 4711;
const APP_PORT = 8799;
const SECRET = 'test-secret-0123456789';
const ISSUER = `http://127.0.0.1:${SSO_PORT}`;
const ORIGIN = `http://127.0.0.1:${APP_PORT}`;
const ADMIN_EMAIL = 'operator@innotel.us';

const b64 = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
let issuedNonce = '';
let tokenCalls = 0;

const sso = createServer(async (req, res) => {
  const url = new URL(req.url, ISSUER);
  if (url.pathname === '/.well-known/openid-configuration') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify({
        issuer: ISSUER,
        authorization_endpoint: `${ISSUER}/application/o/authorize/`,
        token_endpoint: `${ISSUER}/application/o/token/`,
      }),
    );
    return;
  }
  if (url.pathname === '/application/o/token/') {
    let body = '';
    for await (const chunk of req) body += chunk;
    const form = new URLSearchParams(body);
    tokenCalls += 1;
    const spent = form.get('code') === 'spent';
    const ok = form.get('grant_type') === 'authorization_code' && form.get('code_verifier') && !spent;
    const email = form.get('code') === 'nonadmin' ? 'stranger@example.com' : ADMIN_EMAIL;
    res.writeHead(ok ? 200 : 400, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify(
        spent
          ? { error: 'invalid_grant', error_description: 'The code has already been used.' }
          : ok
          ? {
              id_token: [
                b64({ alg: 'none', typ: 'JWT' }),
                b64({
                  iss: ISSUER,
                  aud: 'sage-admin',
                  sub: `user-${email}`,
                  email,
                  name: 'Operator',
                  nonce: issuedNonce,
                  exp: Math.floor(Date.now() / 1000) + 300,
                }),
                'signature-not-checked-here',
              ].join('.'),
              access_token: 'stub',
            }
          : { error: 'invalid_request' },
      ),
    );
    return;
  }
  res.writeHead(404).end();
});

await new Promise((resolve) => sso.listen(SSO_PORT, '127.0.0.1', resolve));
const dataDir = await mkdtemp(path.join(os.tmpdir(), 'sage-panel-'));

const app = spawn(process.execPath, ['server.mjs'], {
  env: {
    ...process.env,
    PORT: String(APP_PORT),
    SAGE_DATA_DIR: dataDir,
    SAGE_ADMIN_SECRET: SECRET,
    CERULEAN_ISSUER: ISSUER,
    CERULEAN_CLIENT_ID: 'sage-admin',
    CERULEAN_CLIENT_SECRET: 'stub-secret',
    SAGE_ADMIN_EMAILS: ADMIN_EMAIL,
    SAGE_PUBLIC_URL: ORIGIN,
    ACCESS_CODE: 'from-environment',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let serverLog = '';
app.stdout.on('data', (chunk) => (serverLog += chunk));
app.stderr.on('data', (chunk) => (serverLog += chunk));

async function waitForApp() {
  for (let i = 0; i < 60; i += 1) {
    try {
      const response = await fetch(`${ORIGIN}/api/health`);
      if (response.ok) return;
    } catch {
      /* not up yet */
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`server never answered:\n${serverLog}`);
}

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
}

function cookiesFrom(response) {
  const raw = typeof response.headers.getSetCookie === 'function' ? response.headers.getSetCookie() : [];
  const jar = {};
  for (const entry of raw) {
    const [pair] = entry.split(';');
    const index = pair.indexOf('=');
    jar[pair.slice(0, index).trim()] = decodeURIComponent(pair.slice(index + 1).trim());
  }
  return { jar, raw };
}

function cookieHeader(jar) {
  return Object.entries(jar)
    .filter(([, value]) => value)
    .map(([name, value]) => `${name}=${encodeURIComponent(value)}`)
    .join('; ');
}

function decodePayload(value) {
  const [body] = String(value).split('.');
  return JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
}

try {
  await waitForApp();

  // 1. Anonymous visit redirects to Cerulean with PKCE + state.
  const first = await fetch(`${ORIGIN}/admin`, { redirect: 'manual' });
  const location = first.headers.get('location') || '';
  const { jar } = cookiesFrom(first);
  issuedNonce = decodePayload(jar.sage_sso || '').nonce;
  const authorize = new URL(location);
  check('anonymous /admin redirects to Cerulean SSO', first.status === 302 && authorize.host.startsWith('127.0.0.1'), location.slice(0, 48));
  check('redirect carries state, nonce and PKCE', Boolean(authorize.searchParams.get('state')) && Boolean(authorize.searchParams.get('nonce')) && authorize.searchParams.get('code_challenge_method') === 'S256');
  check('redirect URI is the panel callback', authorize.searchParams.get('redirect_uri') === `${ORIGIN}/admin/callback`);

  // 2. Callback with a matching state signs in.
  const state = authorize.searchParams.get('state');
  const callback = await fetch(`${ORIGIN}/admin/callback?code=good&state=${encodeURIComponent(state)}`, {
    redirect: 'manual',
    headers: { cookie: cookieHeader(jar) },
  });
  const afterSignIn = cookiesFrom(callback);
  const sessionCookie = afterSignIn.jar.sage_admin || '';
  check('callback sets a signed session and returns to the panel', callback.status === 302 && callback.headers.get('location') === '/admin' && Boolean(sessionCookie));
  check('token endpoint was called once', tokenCalls === 1, `calls=${tokenCalls}`);

  // A code Cerulean has already spent restarts the sign-in once, then reports.
  const staleFirst = await fetch(`${ORIGIN}/admin`, { redirect: 'manual' });
  const staleJar = cookiesFrom(staleFirst).jar;
  issuedNonce = decodePayload(staleJar.sage_sso || '').nonce;
  const staleState = new URL(staleFirst.headers.get('location') || '').searchParams.get('state');
  const stale = await fetch(`${ORIGIN}/admin/callback?code=spent&state=${encodeURIComponent(staleState)}`, {
    redirect: 'manual',
    headers: { cookie: cookieHeader(staleJar) },
  });
  check(
    'a spent code restarts the sign-in instead of dead-ending',
    stale.status === 302 && stale.headers.get('location') === '/admin?again=1',
    `${stale.status} ${stale.headers.get('location')}`,
  );

  const againFirst = await fetch(`${ORIGIN}/admin?again=1`, { redirect: 'manual' });
  const againJar = cookiesFrom(againFirst).jar;
  const againAttempt = decodePayload(againJar.sage_sso || '');
  check('the retry attempt is marked so it cannot loop', againAttempt.again === 1, `again=${againAttempt.again}`);
  issuedNonce = againAttempt.nonce;
  const againState = new URL(againFirst.headers.get('location') || '').searchParams.get('state');
  const againStale = await fetch(`${ORIGIN}/admin/callback?code=spent&state=${encodeURIComponent(againState)}`, {
    redirect: 'manual',
    headers: { cookie: cookieHeader(againJar) },
  });
  const againHtml = await againStale.text();
  check(
    'a second refusal reports the reason instead of looping',
    againStale.status === 400 && againHtml.includes('invalid_grant'),
    `status=${againStale.status}`,
  );

  // A refusal before any code exists must name itself, not fake a spent code.
  const refuseFirst = await fetch(`${ORIGIN}/admin`, { redirect: 'manual' });
  const refuseJar = cookiesFrom(refuseFirst).jar;
  const refuseState = new URL(refuseFirst.headers.get('location') || '').searchParams.get('state');
  const beforeRefusal = tokenCalls;
  const refused = await fetch(
    `${ORIGIN}/admin/callback?error=invalid_scope&error_description=Bad%20scope&state=${encodeURIComponent(refuseState)}`,
    { redirect: 'manual', headers: { cookie: cookieHeader(refuseJar) } },
  );
  const refusedHtml = await refused.text();
  check('a refusal before the exchange names the reason', refused.status === 400 && refusedHtml.includes('invalid_scope'), `status=${refused.status}`);
  check('a refused authorize is never exchanged', tokenCalls === beforeRefusal, `calls=${tokenCalls - beforeRefusal}`);

  const noCodeFirst = await fetch(`${ORIGIN}/admin`, { redirect: 'manual' });
  const noCodeJar = cookiesFrom(noCodeFirst).jar;
  const noCodeState = new URL(noCodeFirst.headers.get('location') || '').searchParams.get('state');
  const noCode = await fetch(`${ORIGIN}/admin/callback?state=${encodeURIComponent(noCodeState)}`, {
    redirect: 'manual',
    headers: { cookie: cookieHeader(noCodeJar) },
  });
  check('a callback without a code is not exchanged either', noCode.status === 400 && tokenCalls === beforeRefusal, `status=${noCode.status}`);

  // 3. Tampering with the session is refused.
  const tampered = await fetch(`${ORIGIN}/admin`, {
    redirect: 'manual',
    headers: { cookie: 'sage_admin=' + encodeURIComponent(sessionCookie.slice(0, -2) + 'aa') },
  });
  check('a tampered session cookie is refused', tampered.status === 302);

  // 4. The panel renders for the operator.
  const panel = await fetch(`${ORIGIN}/admin`, { headers: { cookie: cookieHeader(afterSignIn.jar) } });
  const panelHtml = await panel.text();
  const csrf = (panelHtml.match(/name="csrf" value="([^"]+)"/) || [])[1] || '';
  check('panel renders with the access-code form', panel.status === 200 && panelHtml.includes('Access code'), `length=${panelHtml.length}`);
  check('panel shows the inherited code as required', panelHtml.includes('code required') && panelHtml.includes('inherited from ACCESS_CODE'));
  check('panel carries a CSRF token', Boolean(csrf));

  // 5. Non-operator identity is rejected.
  const outsiderFirst = await fetch(`${ORIGIN}/admin`, { redirect: 'manual' });
  const outsiderJar = cookiesFrom(outsiderFirst).jar;
  issuedNonce = decodePayload(outsiderJar.sage_sso || '').nonce;
  const outsiderState = new URL(outsiderFirst.headers.get('location') || '').searchParams.get('state');
  const outsider = await fetch(`${ORIGIN}/admin/callback?code=nonadmin&state=${encodeURIComponent(outsiderState)}`, {
    redirect: 'manual',
    headers: { cookie: cookieHeader(outsiderJar) },
  });
  check('a signed-in stranger is not an operator', outsider.status === 403, `status=${outsider.status}`);

  // 6. Before the panel writes anything, the environment code is enforced.
  const locked = await fetch(`${ORIGIN}/api/chat`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"mode":"note","text":"hi"}' });
  check('API is closed without a code', locked.status === 401, `status=${locked.status}`);
  const unlocked = await fetch(`${ORIGIN}/api/chat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-access-code': 'from-environment' },
    body: '{"mode":"note","text":"hi"}',
  });
  check('the environment code still opens the API', unlocked.status !== 401, `status=${unlocked.status}`);

  // 7. CSRF and origin guards.
  const noCsrf = await fetch(`${ORIGIN}/admin/access-code`, {
    method: 'POST',
    headers: { cookie: cookieHeader(afterSignIn.jar), 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ code: 'panel-code-1' }).toString(),
  });
  check('a write without a CSRF token is refused', noCsrf.status === 403, `status=${noCsrf.status}`);
  const foreign = await fetch(`${ORIGIN}/admin/access-code`, {
    method: 'POST',
    headers: { cookie: cookieHeader(afterSignIn.jar), origin: 'https://evil.example', 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ csrf, code: 'panel-code-1' }).toString(),
  });
  check('a cross-origin write is refused', foreign.status === 403, `status=${foreign.status}`);

  // 8. A short code is rejected with a reason, not silently stored.
  const shortCode = await fetch(`${ORIGIN}/admin/access-code`, {
    method: 'POST',
    redirect: 'manual',
    headers: { cookie: cookieHeader(afterSignIn.jar), origin: ORIGIN, 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ csrf, code: 'abc' }).toString(),
  });
  check('a too-short code is refused with a reason', shortCode.status === 302 && String(shortCode.headers.get('location')).includes('error='), String(shortCode.headers.get('location')));

  // 9. Setting a code from the panel takes effect immediately.
  const saved = await fetch(`${ORIGIN}/admin/access-code`, {
    method: 'POST',
    redirect: 'manual',
    headers: { cookie: cookieHeader(afterSignIn.jar), origin: ORIGIN, 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ csrf, code: 'panel-code-1' }).toString(),
  });
  check('panel stores a new code', saved.status === 302 && saved.headers.get('location') === '/admin?ok=code', String(saved.headers.get('location')));
  const oldCode = await fetch(`${ORIGIN}/api/chat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-access-code': 'from-environment' },
    body: '{"mode":"note","text":"hi"}',
  });
  check('the old environment code stops working', oldCode.status === 401, `status=${oldCode.status}`);
  const newCode = await fetch(`${ORIGIN}/api/chat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-access-code': 'panel-code-1' },
    body: '{"mode":"note","text":"hi"}',
  });
  check('the panel code opens the API', newCode.status !== 401, `status=${newCode.status}`);

  // 10. The status endpoint agrees, and never returns the code.
  const status = await fetch(`${ORIGIN}/admin/status`, { headers: { cookie: cookieHeader(afterSignIn.jar) } });
  const statusJson = await status.json();
  check('status reports the panel as the source', statusJson.settings?.source === 'panel' && statusJson.authRequired === true, JSON.stringify(statusJson.settings?.source));
  check('status never echoes the code', !JSON.stringify(statusJson).includes('panel-code-1'));
  const settingsPath = path.join(dataDir, 'settings.json');
  const settingsInfo = statSync(settingsPath);
  check(
    'the settings file exists and is not world-readable',
    settingsInfo.isFile() && (process.platform === 'win32' || (settingsInfo.mode & 0o777) === 0o600),
    `mode=${(settingsInfo.mode & 0o777).toString(8)}`,
  );
  check('the settings file holds a digest, not the code', !readFileSync(settingsPath, 'utf8').includes('panel-code-1'));

  // 11. Clearing the code reopens the instance even with ACCESS_CODE set.
  const cleared = await fetch(`${ORIGIN}/admin/access-code/clear`, {
    method: 'POST',
    redirect: 'manual',
    headers: { cookie: cookieHeader(afterSignIn.jar), origin: ORIGIN, 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ csrf }).toString(),
  });
  check('panel clears the code', cleared.status === 302 && cleared.headers.get('location') === '/admin?ok=cleared');
  const openNow = await fetch(`${ORIGIN}/api/chat`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"mode":"note","text":"hi"}' });
  check('the instance is open again after clearing', openNow.status !== 401, `status=${openNow.status}`);
  const health = await (await fetch(`${ORIGIN}/api/health`)).json();
  check('health reports no code required', health.authRequired === false);

  // 12. Signing out drops the session.
  const logout = await fetch(`${ORIGIN}/admin/logout`, {
    method: 'POST',
    redirect: 'manual',
    headers: { cookie: cookieHeader(afterSignIn.jar), origin: ORIGIN, 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ csrf }).toString(),
  });
  check('sign out clears the session', logout.status === 302 && String(logout.headers.getSetCookie?.() || []).includes('Max-Age=0'));
} finally {
  app.kill();
  sso.close();
  await rm(dataDir, { recursive: true, force: true });
}

const failed = results.filter((entry) => !entry.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
if (failed.length) {
  console.log('\nserver log:\n' + serverLog.split('\n').slice(-25).join('\n'));
  process.exitCode = 1;
}
