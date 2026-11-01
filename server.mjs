/**
 * Zero-dependency dev/prod server: serves ./public and mounts the shared API
 * handler. Works on localhost and on your LAN (http://<pc-ip>:8787).
 */
import http from 'node:http';
import https from 'node:https';
import { createReadStream } from 'node:fs';
import { stat, readFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { handleRequest } from './src/app.mjs';

const root = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(root, 'public');
// The About page is the landing page from web/landing (the same tree GitHub
// Pages publishes). It is served at /about, not at / — the root is the app.
const aboutDir = path.join(root, 'web', 'landing');

// Minimal .env loader (never overrides real environment variables).
try {
  const raw = await readFile(path.join(root, '.env'), 'utf8');
  for (const line of raw.split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/i);
    if (!match) continue;
    const [, key, rawValue] = match;
    if (process.env[key]) continue;
    process.env[key] = rawValue.replace(/^["']|["']$/g, '').trim();
  }
} catch {
  /* .env is optional */
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
};

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks);
}

function toRequest(req, body) {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (Array.isArray(value)) value.forEach((v) => headers.append(key, v));
    else if (value !== undefined) headers.set(key, value);
  }
  const hasBody = !['GET', 'HEAD'].includes(req.method);
  return new Request(url, {
    method: req.method,
    headers,
    body: hasBody ? body : undefined,
    duplex: hasBody ? 'half' : undefined,
  });
}

async function sendStatic(req, res, pathname, baseDir = publicDir) {
  const relative = decodeURIComponent(pathname).replace(/^\/+/, '');
  const target = path.join(baseDir, relative || 'index.html');
  if (target !== baseDir && !target.startsWith(baseDir + path.sep)) {
    res.writeHead(403).end('Forbidden');
    return;
  }
  let info;
  try {
    info = await stat(target);
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain' }).end('Not found');
    return;
  }
  const file = info.isDirectory() ? path.join(target, 'index.html') : target;
  try {
    const fileInfo = await stat(file);
    res.writeHead(200, {
      'content-type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
      'content-length': fileInfo.size,
      'cache-control': 'no-cache',
    });
    createReadStream(file).pipe(res);
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain' }).end('Not found');
  }
}

// /about and anything under /about/* come out of the landing tree, so the page,
// its stylesheet and its theme script keep working at their own paths.
async function sendAbout(req, res, pathname) {
  const relative = pathname.replace(/^\/about\/?/, '');
  await sendStatic(req, res, relative, aboutDir);
}

// The bundled iOS shell runs on capacitor://localhost (or ionic://), a
// different origin from this server, so API calls need explicit CORS.
const NATIVE_ORIGINS = new Set(['capacitor://localhost', 'ionic://localhost']);

function applyCors(req, res) {
  const origin = req.headers.origin;
  if (!origin || !NATIVE_ORIGINS.has(origin)) return;
  res.setHeader('access-control-allow-origin', origin);
  res.setHeader('vary', 'origin');
  res.setHeader('access-control-allow-methods', 'GET, POST, OPTIONS');
  res.setHeader('access-control-allow-headers', 'content-type, x-access-code, x-ai-key, x-ai-base, x-ai-model');
  res.setHeader('access-control-max-age', '600');
}
async function handler(req, res) {
  const url = new URL(req.url, 'http://localhost');

  if (url.pathname.startsWith('/api/')) {
    applyCors(req, res);
    if (req.method === 'OPTIONS') {
      res.writeHead(204).end();
      return;
    }
    try {
      const body = await readBody(req);
      const response = await handleRequest(toRequest(req, body.length ? body : undefined), process.env);
      res.writeHead(response.status, Object.fromEntries(response.headers.entries()));
      const buffer = Buffer.from(await response.arrayBuffer());
      res.end(buffer);
    } catch (error) {
      console.error('API error:', error);
      res.writeHead(500, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'server_error', message: error.message }));
    }
    return;
  }

  if (url.pathname === '/about' || url.pathname.startsWith('/about/')) {
    await sendAbout(req, res, url.pathname);
    return;
  }

  await sendStatic(req, res, url.pathname);
}

const port = Number(process.env.PORT) || 8787;

// TLS switches on only when both files are supplied, so localhost development
// stays plain HTTP and a certificate can be mounted without touching code.
const tlsCert = process.env.TLS_CERT;
const tlsKey = process.env.TLS_KEY;
const secure = Boolean(tlsCert && tlsKey);
const scheme = secure ? 'https' : 'http';

const server = secure
  ? https.createServer({ cert: await readFile(tlsCert), key: await readFile(tlsKey) }, handler)
  : http.createServer(handler);

server.listen(port, '0.0.0.0', () => {
  const configured = Boolean(process.env.AI_API_KEY || process.env.OPENAI_API_KEY);
  console.log(`\n  Sage · course-taking agent`);
  console.log(`  local:   ${scheme}://localhost:${port}`);
  for (const [name, addresses] of Object.entries(os.networkInterfaces())) {
    for (const address of addresses || []) {
      if (address.family === 'IPv4' && !address.internal) {
        console.log(`  ${name.padEnd(7)} ${scheme}://${address.address}:${port}${secure ? '  (open this on your phone)' : '  (needs HTTPS for mic/screen)'}`);
      }
    }
  }
  console.log(`  model:   ${process.env.AI_CHAT_MODEL || 'gpt-4o-mini'} via ${process.env.AI_BASE_URL || 'https://gateway.innotel.us/v1'}`);
  console.log(`  key:     ${configured ? 'configured' : 'MISSING — set OPENAI_API_KEY or enter a gateway key in the app'}\n`);
});
