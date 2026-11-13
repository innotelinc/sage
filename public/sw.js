/* Shell cache only. API traffic is never cached.
 *
 * Neither is a page that is not part of the shell. Caching every GET meant a reader who
 * had opened /about once kept being handed that copy whenever the origin hiccuped — and
 * a marketing page served out of the cache is how someone came to read a roadmap that had
 * stopped months earlier. A document now always goes to the network, and the cache is
 * only a fallback for the app itself while the copy in it is young.
 */
const CACHE = 'sage-shell-v40';
const SHELL = ['/', '/index.html', '/styles.css', '/app.js', '/shell.js', '/profile.js', '/icon.svg', '/manifest.webmanifest', '/search.js', '/understand.js', '/review.js', '/handoff.js', '/library.js', '/a11y.js'];

/** A copy older than this is not served: an app shell from last month is a bug report. */
const MAX_AGE = 7 * 24 * 60 * 60 * 1000;
/** Long enough for a slow phone on a train, short enough that a dead origin is noticed. */
const NETWORK_TIMEOUT = 5000;
const APP = new Set(['/', '/index.html']);

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key))))
      .then(() => self.clients.claim())
  );
});

/** A navigation or an .html file: the kind of response that goes stale in public. */
function isDocument(request, url) {
  if (request.mode === 'navigate') return true;
  return /\.html?$/i.test(url.pathname);
}

/** The cached copy of `request`, or null when there is none or it is too old to trust. */
async function freshCopy(request) {
  const hit = await caches.match(request);
  if (!hit) return null;
  const dated = Date.parse(hit.headers.get('date') || '');
  if (Number.isFinite(dated) && Date.now() - dated > MAX_AGE) {
    await caches.open(CACHE).then((cache) => cache.delete(request)).catch(() => {});
    return null;
  }
  return hit;
}

/** What a reader sees when there is nothing honest to show: no page, no stale page. */
function offlinePage(missing) {
  const body = missing
    ? '<h1>Not available offline</h1><p>This page is not cached. Reconnect and reload.</p>'
    : '<h1>SAGE is offline</h1><p>The copy on this device is more than a week old. Reconnect once to refresh it.</p>';
  return new Response(
    '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">' +
      '<title>Offline — SAGE</title>' +
      '<body style="margin:0;display:grid;place-items:center;min-height:100vh;background:#0b0d10;color:#e6e8ee;' +
      'font:15px/1.6 system-ui,sans-serif;text-align:center;padding:24px">' +
      '<div style="max-width:34ch">' +
      body +
      '</div></body>',
    { status: 503, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' } }
  );
}

async function networkFirst(request, url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), NETWORK_TIMEOUT);
  try {
    const response = await fetch(request, { signal: controller.signal });
    // The shell is kept so the app still opens with no connection. A page is not: it is
    // read once, from the origin, and never served back from here.
    if (response.ok && !isDocument(request, url)) {
      caches.open(CACHE).then((cache) => cache.put(request, response.clone())).catch(() => {});
    }
    return response;
  } catch (error) {
    const app = APP.has(url.pathname);
    if (isDocument(request, url)) {
      if (!app) return offlinePage(true);
      const shell = (await freshCopy(request)) || (await freshCopy('/index.html'));
      return shell || offlinePage(false);
    }
    const hit = await freshCopy(request);
    if (hit) return hit;
    return new Response('', { status: 504, statusText: 'Offline' });
  } finally {
    clearTimeout(timer);
  }
}

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'GET' || url.pathname.startsWith('/api/')) return;
  if (url.origin !== self.location.origin) return;
  event.respondWith(networkFirst(event.request, url));
});
