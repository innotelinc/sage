/**
 * Zero-dependency dev/prod server: serves ./public and mounts the shared API
 * handler. Works on localhost and on your LAN (http://<pc-ip>:8787).
 */
import http from 'node:http';
import { createReadStream } from 'node:fs';
import { stat, readFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { handleRequest } from './src/app.mjs';

const root = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(root, 'public');

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

async function sendStatic(req, res, pathname) {
  const relative = decodeURIComponent(pathname).replace(/^\/+/, '');
  const target = path.join(publicDir, relative || 'index.html');
  if (!target.startsWith(publicDir)) {
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

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');

  if (url.pathname.startsWith('/api/')) {
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

  await sendStatic(req, res, url.pathname);
});

const port = Number(process.env.PORT) || 8787;

server.listen(port, '0.0.0.0', () => {
  const configured = Boolean(process.env.AI_API_KEY || process.env.OPENAI_API_KEY);
  console.log(`\n  Sage · course-taking agent`);
  console.log(`  local:   http://localhost:${port}`);
  for (const [name, addresses] of Object.entries(os.networkInterfaces())) {
    for (const address of addresses || []) {
      if (address.family === 'IPv4' && !address.internal) {
        console.log(`  ${name.padEnd(7)} http://${address.address}:${port}  (open this on your phone — needs HTTPS for mic/screen)`);
      }
    }
  }
  console.log(`  model:   ${process.env.AI_CHAT_MODEL || 'gpt-4o-mini'} via ${process.env.AI_BASE_URL || 'https://api.openai.com/v1'}`);
  console.log(`  key:     ${configured ? 'configured' : 'MISSING — add OPENAI_API_KEY to .env'}\n`);
});
