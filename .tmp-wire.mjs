import { readFileSync, writeFileSync } from 'node:fs';

function edit(file, pairs) {
  const raw = readFileSync(file, 'utf8');
  const crlf = raw.includes('\r\n');
  let text = crlf ? raw.replace(/\r\n/g, '\n') : raw;
  let changed = 0;
  for (const [from, to] of pairs) {
    if (!text.includes(from)) {
      console.error(`MISS in ${file}: ${from.slice(0, 70).replace(/\n/g, '\\n')}`);
      process.exitCode = 1;
      continue;
    }
    text = text.replace(from, to);
    changed += 1;
  }
  writeFileSync(file, crlf ? text.replace(/\n/g, '\r\n') : text, 'utf8');
  console.log(`edited ${file} (${changed}/${pairs.length})`);
}

edit('server.mjs', [
  [
    `import { handleRequest } from './src/app.mjs';`,
    `import { handleRequest } from './src/app.mjs';
import { handleAdmin } from './src/admin.mjs';
import { loadSettings, accessRequired, accessAccepted } from './src/settings.mjs';

// The operator panel can replace the access code without a restart, so the
// shared handler asks this store instead of reading the environment itself.
const runtimeSettings = { accessRequired, accessAccepted };`,
  ],
  [
    `  if (url.pathname.startsWith('/api/')) {`,
    `  if (url.pathname === '/admin' || url.pathname.startsWith('/admin/')) {
    const adminBody = await readBody(req);
    try {
      const response = await handleAdmin(toRequest(req, adminBody.length ? adminBody : undefined), process.env);
      const headers = {};
      for (const [key, value] of response.headers.entries()) {
        if (key !== 'set-cookie') headers[key] = value;
      }
      const cookies = typeof response.headers.getSetCookie === 'function' ? response.headers.getSetCookie() : [];
      res.writeHead(response.status, headers);
      if (cookies.length) res.setHeader('set-cookie', cookies);
      res.end(Buffer.from(await response.arrayBuffer()));
    } catch (error) {
      console.error('Admin error:', error);
      res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' }).end('Panel error: ' + error.message);
    }
    return;
  }

  if (url.pathname.startsWith('/api/')) {`,
  ],
  [
    `      const response = await handleRequest(toRequest(req, body.length ? body : undefined), process.env);`,
    `      const response = await handleRequest(toRequest(req, body.length ? body : undefined), process.env, runtimeSettings);`,
  ],
  [
    `const port = Number(process.env.PORT) || 8787;`,
    `// The panel's settings file decides the access code, so it is read before the
// first request: a fresh instance follows ACCESS_CODE, an edited one follows
// what the operator saved.
const settingsState = await loadSettings();
if (settingsState.error) console.error('Settings file unreadable:', settingsState.error);

const port = Number(process.env.PORT) || 8787;`,
  ],
  [
    `  console.log(\`  key:     \${configured ? 'configured' : 'MISSING — set OPENAI_API_KEY or enter a gateway key in the app'}\\n\`);`,
    `  console.log(\`  key:     \${configured ? 'configured' : 'MISSING — set OPENAI_API_KEY or enter a gateway key in the app'}\`);
  console.log(\`  access:  \${accessRequired(process.env.ACCESS_CODE) ? 'code required (panel or ACCESS_CODE)' : 'open'}\`);
  console.log(\`  panel:   \${scheme}://localhost:\${port}/admin\${process.env.SAGE_ADMIN_SECRET ? '' : '  (needs SAGE_ADMIN_SECRET)'}\\n\`);`,
  ],
]);

edit('src/app.mjs', [
  [
    `function authorised(request, cfg) {`,
    `// Without the panel the environment decides, exactly as before; the Node server
// injects a store instead so the code can be replaced while it runs.
const environmentOnly = {
  accessRequired: (envCode) => Boolean(envCode),
  accessAccepted: (candidate, envCode) => Boolean(envCode) && String(candidate || '') === envCode,
};

function authorised(request, cfg, runtime) {`,
  ],
  [
    `  if (!cfg.accessCode) return true;
  const provided = request.headers.get('x-access-code') || '';
  return provided && provided === cfg.accessCode;`,
    `  if (!runtime.accessRequired(cfg.accessCode)) return true;
  const provided = request.headers.get('x-access-code') || '';
  return provided && runtime.accessAccepted(provided, cfg.accessCode);`,
  ],
  [
    `export async function handleRequest(request, env = {}) {`,
    `export async function handleRequest(request, env = {}, runtime = environmentOnly) {`,
  ],
  [
    `      authRequired: Boolean(cfg.accessCode),`,
    `      authRequired: Boolean(runtime.accessRequired(cfg.accessCode)),`,
  ],
  [
    `  if (!authorised(request, cfg)) {`,
    `  if (!authorised(request, cfg, runtime)) {`,
  ],
]);

edit('docker-compose.yml', [
  [
    `    volumes:
      - sage-threads:/app/threads
      - ./certs:/app/certs:ro`,
    `    volumes:
      - sage-threads:/app/threads
      # Operator-panel settings, including the access code. A named volume is
      # seeded from the image, so it arrives owned by node (uid 1000).
      - sage-data:/app/data
      - ./certs:/app/certs:ro`,
  ],
  [
    `volumes:
  sage-threads:`,
    `volumes:
  sage-threads:
  sage-data:`,
  ],
]);

edit('Dockerfile', [
  [
    `# Transcripts live under /app/threads; the relay keeps frames in memory only.
RUN mkdir -p /app/threads && chown -R node:node /app`,
    `# Transcripts live under /app/threads; the relay keeps frames in memory only.
# /app/data holds the operator panel's settings, so it has to exist in the image
# for the volume to inherit node's ownership.
RUN mkdir -p /app/threads /app/data && chown -R node:node /app`,
  ],
]);

edit('.env.example', [
  [
    `# Where bought Sage session keys are claimed from.
MAGNATE_URL=https://magnate.innotel.us
`,
    `# Where bought Sage session keys are claimed from.
MAGNATE_URL=https://magnate.innotel.us

# ── Operator panel (/admin) ────────────────────────────────────────────────
# Sign-in is Cerulean SSO (Authentik): register a confidential OIDC provider
# there with the redirect URI https://<your-host>/admin/callback, then set these.
CERULEAN_ISSUER=
CERULEAN_CLIENT_ID=
CERULEAN_CLIENT_SECRET=

# Signs the panel's session cookie. Any long random string; the panel refuses to
# open without it. Generate one with: openssl rand -base64 48
SAGE_ADMIN_SECRET=

# Comma-separated Cerulean addresses allowed to operate this instance.
SAGE_ADMIN_EMAILS=

# Where the panel keeps its settings; must be writable by uid 1000.
SAGE_DATA_DIR=/app/data
`,
  ],
]);
