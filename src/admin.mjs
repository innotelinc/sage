/**
 * The operator panel: one page, behind Cerulean SSO, that owns the things you
 * would otherwise edit `.env` and restart a container to change.
 *
 * Right now that is the access code — the only thing standing between a public
 * host and your gateway credits — plus the state of the instance around it.
 * Nothing here is reachable without a Cerulean sign-in whose email is listed in
 * `SAGE_ADMIN_EMAILS`, and every write is same-origin and CSRF-checked.
 */
import { setAccessCode, clearAccessCode, settingsStatus, accessRequired } from './settings.mjs';
import { usageSummary } from './usage.mjs';
import {
  oidcConfig,
  discovery,
  newAttempt,
  authorizeUrl,
  exchangeCode,
  decodeIdToken,
  verifyClaims,
  isAdmin,
  STATE_COOKIE,
} from './oidc.mjs';
import {
  SESSION_COOKIE,
  SSO_COOKIE,
  signPayload,
  readPayload,
  issueSession,
  readSession,
  parseCookies,
  setCookie,
  dropCookie,
} from './session.mjs';

function originOf(request) {
  const url = new URL(request.url);
  const proto = String(request.headers.get('x-forwarded-proto') || url.protocol.replace(':', '')).split(',')[0].trim();
  const host = String(request.headers.get('x-forwarded-host') || request.headers.get('host') || url.host).split(',')[0].trim();
  return `${proto}://${host}`;
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (char) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  }[char]));
}

const BASE_CSS = `
  :root{--bg:#080b12;--panel:#0e1420;--panel-2:#131b2a;--line:#1e283a;--text:#e7edf7;--muted:#8b98ad;--accent:#6ee7b7;--accent-2:#38bdf8;--danger:#f87171;--radius:14px}
  *{box-sizing:border-box}
  body{margin:0 auto;max-width:760px;padding:24px 16px 64px;background:var(--bg);color:var(--text);
    font:15px/1.55 -apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;
    background-image:radial-gradient(900px 400px at 50% -20%,rgba(56,189,248,.14),transparent 70%);background-repeat:no-repeat}
  h1{font-size:20px;margin:0 0 2px;letter-spacing:-.01em}
  h2{font-size:13px;text-transform:uppercase;letter-spacing:.08em;color:var(--muted);margin:0 0 12px;font-weight:600}
  .sub{color:var(--muted);font-size:13px;margin:0 0 22px}
  .card{background:var(--panel);border:1px solid var(--line);border-radius:var(--radius);padding:18px;margin:0 0 16px}
  .row{display:flex;gap:10px;flex-wrap:wrap;align-items:center}
  .spread{display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap}
  label{display:block;font-size:13px;color:var(--muted);margin:0 0 6px}
  input[type=password],input[type=text]{width:100%;padding:11px 12px;border-radius:10px;border:1px solid var(--line);
    background:var(--panel-2);color:var(--text);font:inherit}
  button{padding:10px 16px;border-radius:10px;border:1px solid var(--line);background:var(--panel-2);color:var(--text);
    font:inherit;font-weight:600;cursor:pointer}
  button.primary{background:var(--accent);border-color:transparent;color:#062018}
  button.danger{color:var(--danger);border-color:rgba(248,113,113,.4);background:transparent}
  .pill{display:inline-flex;align-items:center;gap:6px;font-size:12px;padding:3px 10px;border-radius:999px;
    border:1px solid var(--line);color:var(--muted)}
  .pill.on{border-color:rgba(110,231,183,.45);color:var(--accent)}
  .pill.off{border-color:rgba(248,113,113,.45);color:var(--danger)}
  .mini{font-size:12.5px;color:var(--muted)}
  code{background:var(--panel-2);border:1px solid var(--line);border-radius:6px;padding:1px 5px;font-size:12.5px}
  .note{border-left:3px solid var(--accent-2);padding:2px 0 2px 12px;margin:14px 0 0;color:var(--muted);font-size:13px}
  .err{border-left-color:var(--danger);color:var(--danger)}
  .ok{border-left-color:var(--accent)}
  form{margin:0}
  .mt{margin-top:14px}
  a{color:var(--accent-2)}
`;

function page(title, body) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<meta name="robots" content="noindex,nofollow" />
<title>${escapeHtml(title)} · Sage</title><style>${BASE_CSS}</style></head>
<body>${body}</body></html>`;
}

function setupPage(missing, detail = '') {
  return page(
    'Setup needed',
    `<h1>Sage operator panel</h1>
     <p class="sub">This panel signs you in with Cerulean SSO, and it is not configured yet.</p>
     <div class="card">
       <h2>Set these on the container</h2>
       <p class="mini">${missing.map((name) => `<code>${escapeHtml(name)}</code>`).join(' ')}</p>
       <ul class="mini">
         <li><code>CERULEAN_ISSUER</code> — the Authentik application URL, e.g. <code>https://auth.cerulean.innotel.us/application/o/sage/</code></li>
         <li><code>CERULEAN_CLIENT_ID</code> / <code>CERULEAN_CLIENT_SECRET</code> — the OIDC provider in Authentik</li>
         <li><code>SAGE_ADMIN_SECRET</code> — any long random string; it signs the session cookie</li>
         <li><code>SAGE_ADMIN_EMAILS</code> — comma-separated addresses allowed in</li>
       </ul>
       <p class="mini">Redirect URI to register in Authentik: <code>https://sage.innotel.tech/admin/callback</code></p>
       ${detail ? `<p class="note err">${escapeHtml(detail)}</p>` : ''}
     </div>`
  );
}

function statusPill(required) {
  return required
    ? '<span class="pill on">code required</span>'
    : '<span class="pill off">open instance</span>';
}

function panelPage({ identity, status, notice, error, csrf, models, usage }) {
  const source =
    status.source === 'panel'
      ? 'set in this panel'
      : status.source === 'environment'
        ? 'inherited from ACCESS_CODE'
        : 'no code, anyone who finds the URL can spend your credits';
  return page(
    'Operator',
    `<div class="spread">
       <div>
         <h1>Sage operator</h1>
         <p class="sub">${escapeHtml(identity.email)}${identity.name ? ` · ${escapeHtml(identity.name)}` : ''}</p>
       </div>
       <form method="post" action="/admin/logout">
         <input type="hidden" name="csrf" value="${escapeHtml(csrf)}" />
         <button class="danger" type="submit">Sign out</button>
       </form>
     </div>

     ${notice ? `<p class="note ok">${escapeHtml(notice)}</p>` : ''}
     ${error ? `<p class="note err">${escapeHtml(error)}</p>` : ''}

     <div class="card">
       <div class="spread">
         <h2>Access code</h2>
         ${statusPill(status.required)}
       </div>
       <p class="mini">${escapeHtml(source)}${
         status.updatedAt ? ` · updated ${escapeHtml(status.updatedAt)}${status.updatedBy ? ` by ${escapeHtml(status.updatedBy)}` : ''}` : ''
       }</p>
       <form method="post" action="/admin/access-code" class="mt">
         <input type="hidden" name="csrf" value="${escapeHtml(csrf)}" />
         <label for="code">${status.required ? 'Replace the current code' : 'Set a code'}</label>
         <input id="code" name="code" type="password" minlength="6" maxlength="200" required
                autocomplete="new-password" autocapitalize="off" spellcheck="false" placeholder="at least 6 characters" />
         <div class="row mt">
           <button class="primary" type="submit">Save code</button>
           ${status.required ? '<span class="mini">Every device already signed in has to enter the new code once.</span>' : ''}
         </div>
       </form>
       ${
         status.required
           ? `<form method="post" action="/admin/access-code/clear" class="mt">
                <input type="hidden" name="csrf" value="${escapeHtml(csrf)}" />
                <button class="danger" type="submit">Remove the code</button>
                <span class="mini">Leaves the instance open to anyone with the URL.</span>
              </form>`
           : ''
       }
       <p class="note">The code is stored as a salted digest in <code>${escapeHtml(status.file)}</code>, never in plain text,
       and it beats <code>ACCESS_CODE</code> from the environment once set here.</p>
     </div>

     <div class="card">
       <h2>Usage, last seven days</h2>
       <p class="mini">${usage.total.chat} answers drafted · ${usage.total.other} other API calls · ${usage.total.refused} refused at the door</p>
       <p class="mini">Counts and status codes only — no prompts, no transcripts, no keys. Since ${escapeHtml(usage.since)}.</p>
     </div>

     <div class="card">
       <h2>Instance</h2>
       <p class="mini">Gateway host <code>${escapeHtml(models.provider)}</code> ·
         chat <code>${escapeHtml(models.chatModel)}</code> ·
         vision <code>${escapeHtml(models.visionModel)}</code> ·
         transcription <code>${escapeHtml(models.transcribeModel)}</code></p>
       <p class="mini">Model choice is automatic: the best model the key in use can call, per task.</p>
       <p class="mini">Panel settings file <code>${escapeHtml(status.file)}</code> · written ${status.source === 'panel' ? 'by the panel' : 'not yet'}.</p>
     </div>`
  );
}

function htmlResponse(body, status = 200, headers = {}) {
  return new Response(body, {
    status,
    headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', ...headers },
  });
}

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });
}

function redirect(location, cookies = []) {
  const headers = new Headers({ location, 'cache-control': 'no-store' });
  for (const cookie of cookies) headers.append('set-cookie', cookie);
  return new Response(null, { status: 302, headers });
}

function modelsSummary(env) {
  return {
    provider: (() => {
      try {
        return new URL(String(env.AI_BASE_URL || 'https://gateway.innotel.us/v1')).host;
      } catch {
        return String(env.AI_BASE_URL || 'gateway.innotel.us');
      }
    })(),
    chatModel: String(env.AI_CHAT_MODEL || 'auto — best the key can call'),
    visionModel: String(env.AI_VISION_MODEL || 'same as chat'),
    transcribeModel: String(env.AI_TRANSCRIBE_MODEL || 'whisper-1'),
  };
}

export async function handleAdmin(request, env = {}) {
  const url = new URL(request.url);
  const origin = originOf(request);
  const secure = origin.startsWith('https://');
  const cfg = oidcConfig(env, origin);
  const secret = String(env.SAGE_ADMIN_SECRET || '').trim();
  const jar = parseCookies(request.headers.get('cookie') || '');

  if (!secret) {
    return htmlResponse(
      setupPage(['SAGE_ADMIN_SECRET'], 'Without it the session cookie could not be signed.'),
      503,
    );
  }
  if (!cfg.enabled) return htmlResponse(setupPage(cfg.missing), 503);

  const cookies = [];
  const cookieOptions = { secure, maxAgeSeconds: 8 * 60 * 60 };

  // ── sign-in ────────────────────────────────────────────────────────────────
  if (url.pathname === '/admin/callback') {
    const attempt = readPayload(jar[SSO_COOKIE], secret);
    const state = url.searchParams.get('state') || '';
    const code = url.searchParams.get('code') || '';
    cookies.push(dropCookie(SSO_COOKIE, { secure }));
    if (!attempt || attempt.state !== state) {
      return htmlResponse(page('Sign-in expired', '<h1>That sign-in expired</h1><p class="sub">Start again from <a href="/admin">/admin</a>.</p>'), 400, {
        'set-cookie': dropCookie(SSO_COOKIE, { secure }),
      });
    }
    try {
      const doc = await discovery(cfg);
      const tokens = await exchangeCode(cfg, doc, { code, verifier: attempt.verifier });
      const identity = verifyClaims(cfg, decodeIdToken(tokens.id_token), attempt);
      if (!isAdmin(cfg, identity)) {
        return htmlResponse(
          page('Not an operator', `<h1>Not an operator</h1><p class="sub">${escapeHtml(identity.email)} is signed in to Cerulean but is not on this instance's operator list.</p>`),
          403,
        );
      }
      cookies.push(setCookie(SESSION_COOKIE, issueSession(identity, secret), cookieOptions));
      return redirect('/admin', cookies);
    } catch (error) {
      return htmlResponse(
        page('Sign-in failed', `<h1>Sign-in failed</h1><p class="sub">${escapeHtml(error.message)}</p><p class="mini"><a href="/admin">Try again</a></p>`),
        400,
      );
    }
  }

  const session = readSession(jar[SESSION_COOKIE], secret);

  if (!session) {
    try {
      const doc = await discovery(cfg);
      const attempt = newAttempt();
      cookies.push(setCookie(SSO_COOKIE, signPayload(attempt, secret, 600), { secure, maxAgeSeconds: 600 }));
      return redirect(authorizeUrl(cfg, doc, attempt), cookies);
    } catch (error) {
      return htmlResponse(
        setupPage(['CERULEAN_ISSUER'], `Cerulean could not be reached: ${error.message}`),
        502,
      );
    }
  }

  // Every write below is a same-origin, CSRF-checked form post.
  const guard = (body) => {
    const from = String(request.headers.get('origin') || '').trim();
    if (from && from !== origin) return 'That request came from another origin.';
    const submitted = String(body.get('csrf') || '');
    if (!submitted || submitted !== session.csrf) return 'That form had expired. Reload the panel and try again.';
    return '';
  };

  if (request.method === 'POST') {
    const body = new URLSearchParams(await request.text());
    const problem = guard(body);
    if (problem) return htmlResponse(page('Refused', `<h1>Refused</h1><p class="sub">${escapeHtml(problem)}</p>`), 403);

    if (url.pathname === '/admin/logout') {
      return redirect('/', [dropCookie(SESSION_COOKIE, { secure })]);
    }

    if (url.pathname === '/admin/access-code') {
      try {
        await setAccessCode(body.get('code') || '', session.email);
        return redirect('/admin?ok=code');
      } catch (error) {
        return redirect(`/admin?error=${encodeURIComponent(error.message)}`);
      }
    }

    if (url.pathname === '/admin/access-code/clear') {
      await clearAccessCode(session.email);
      return redirect('/admin?ok=cleared');
    }
  }

  const status = settingsStatus(env.ACCESS_CODE);
  const notice =
    url.searchParams.get('ok') === 'code'
      ? 'Access code saved. Devices will be asked for it on their next request.'
      : url.searchParams.get('ok') === 'cleared'
        ? 'Access code removed — the instance is open again.'
        : '';
  const error = url.searchParams.get('error') || '';

  if (url.pathname === '/admin/status') {
    return jsonResponse({
      ok: true,
      identity: { email: session.email, sub: session.sub },
      settings: status,
      authRequired: accessRequired(env.ACCESS_CODE),
      models: modelsSummary(env),
      usage: usageSummary(7),
    });
  }

  return htmlResponse(
    panelPage({
      identity: session,
      status,
      notice,
      error,
      csrf: session.csrf,
      models: modelsSummary(env),
      usage: usageSummary(7),
    }),
  );
}

export { originOf };
