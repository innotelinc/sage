/**
 * A course, read-only, on a link.
 *
 * Everything up to 4.9 was single-user. A study group is not: the useful thing to
 * hand a classmate is the notes and the documents those notes came from, and the
 * useless thing is a login. A share is a snapshot rather than a window into live
 * state — it cannot be edited, it carries no personal memory, no answers and no
 * settings, and it stops working after thirty days.
 *
 * Documents are stored once, by content hash, and every share that contains one
 * points at that single copy. The same handout shared by two people is one file
 * with two names on it.
 */
import { SESSION_COOKIE, readSession, parseCookies } from './session.mjs';

export const SHARE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
export const MAX_SHARE_DOCS = 12;
export const MAX_SHARE_NOTES = 60;
export const MAX_DOC_CHARS = 400000;
const MAX_BYTES = 3 * 1024 * 1024;
const TOKEN_RE = /^[A-Za-z0-9_-]{16,64}$/;

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });
}

function escapeHtml(value) {
  return String(value == null ? '' : value).replace(/[&<>"']/g, (character) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  })[character]);
}

async function digest(value) {
  const bytes = new TextEncoder().encode(value);
  const hash = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(hash)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** The same identity the workspace uses: a panel session names a person, an
 *  access code names the instance. A share needs one or the other. */
async function identityFor(request, env = {}) {
  const secret = String(env.SAGE_ADMIN_SECRET || '').trim();
  if (secret) {
    const jar = parseCookies(request.headers.get('cookie') || '');
    const session = readSession(jar[SESSION_COOKIE], secret);
    if (session && session.sub) {
      return { key: await digest(`sub:${session.sub}`), label: session.email || 'signed-in operator' };
    }
  }
  const code = String(request.headers.get('x-access-code') || '').trim();
  const expected = String(env.ACCESS_CODE || '').trim();
  if (code && expected && code === expected) {
    return { key: await digest(`code:${code}`), label: 'access code' };
  }
  return null;
}

function newToken() {
  const bytes = new Uint8Array(18);
  crypto.getRandomValues(bytes);
  return [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function openStore(env = {}) {
  let fs;
  let path;
  try {
    [fs, path] = await Promise.all([import('node:fs/promises'), import('node:path')]);
  } catch {
    return null;
  }
  const base =
    String(env.SAGE_DATA_DIR || '').trim() ||
    (typeof process !== 'undefined' ? path.join(process.cwd(), 'data') : '');
  if (!base) return null;
  const dir = path.join(base, 'shares');
  const docs = path.join(dir, 'docs');

  const write = async (target, doc) => {
    await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
    const temporary = `${target}.${Date.now().toString(36)}.tmp`;
    await fs.writeFile(temporary, JSON.stringify(doc), { mode: 0o600 });
    await fs.rename(temporary, target);
  };
  const read = async (target) => {
    try {
      return JSON.parse(await fs.readFile(target, 'utf8'));
    } catch {
      return null;
    }
  };

  return {
    async loadShare(token) {
      return read(path.join(dir, `${token}.json`));
    },
    async saveShare(token, doc) {
      await write(path.join(dir, `${token}.json`), doc);
    },
    async dropShare(token) {
      try {
        await fs.unlink(path.join(dir, `${token}.json`));
        return true;
      } catch {
        return false;
      }
    },
    async loadDoc(hash) {
      return read(path.join(docs, `${hash}.json`));
    },
    async saveDoc(hash, doc) {
      await write(path.join(docs, `${hash}.json`), doc);
    },
  };
}

/** A share stops working when its window closes. */
export function isLiveShare(share, now = Date.now()) {
  if (!share || !share.token) return false;
  const ends = Date.parse(String(share.expiresAt || ''));
  return Number.isFinite(ends) && ends > now;
}

/**
 * What a share may contain. No memory, no answers, no settings — the classmate
 * gets the course name, the notes and the documents, which is what was promised.
 */
export function sanitiseShareBody(body = {}) {
  if (!body || typeof body !== 'object') return null;
  const docs = (Array.isArray(body.docs) ? body.docs : [])
    .filter((doc) => doc && typeof doc.text === 'string' && doc.text.trim())
    .slice(0, MAX_SHARE_DOCS)
    .map((doc) => ({
      name: String(doc.name || 'document').slice(0, 120),
      kind: String(doc.kind || 'text').slice(0, 24),
      text: String(doc.text).slice(0, MAX_DOC_CHARS),
      segments: (Array.isArray(doc.segments) ? doc.segments : [])
        .filter((segment) => segment && String(segment.text || '').trim())
        .slice(0, 120)
        .map((segment) => ({
          locator: String(segment.locator || 'whole document').slice(0, 40),
          text: String(segment.text).slice(0, 8000),
        })),
    }));
  const notes = (Array.isArray(body.notes) ? body.notes : [])
    .map((note) => (typeof note === 'string' ? note : note && note.text))
    .filter((text) => typeof text === 'string' && text.trim())
    .slice(-MAX_SHARE_NOTES)
    .map((text) => String(text).slice(0, 1200));
  if (!docs.length && !notes.length) return null;
  return {
    kind: body.kind === 'document' ? 'document' : 'course',
    courseName: String(body.courseName || 'A course').slice(0, 120),
    sharedBy: String(body.name || '').slice(0, 60),
    notes,
    docs,
  };
}

/** One document's identity: the same words under the same name are one copy. */
export async function shareDocHash(doc = {}) {
  return digest(`${String(doc.name || 'document')}\n${String(doc.text || '')}`);
}

/** The read-only view. Deliberately narrower than the course it came from. */
export function publicShare(share, docs = []) {
  return {
    token: share.token,
    kind: share.kind,
    courseName: share.courseName,
    sharedBy: share.sharedBy,
    createdAt: share.createdAt,
    expiresAt: share.expiresAt,
    views: Number(share.views) || 0,
    notes: Array.isArray(share.notes) ? share.notes : [],
    docs: docs.map((doc) => ({
      name: doc.name,
      kind: doc.kind,
      chars: Number(doc.chars) || String(doc.text || '').length,
      segments: Array.isArray(doc.segments) ? doc.segments : [],
      text: String(doc.text || ''),
      contributedBy: Array.isArray(doc.owners) ? doc.owners.map((owner) => owner.label) : [],
      sharedAt: doc.firstSharedAt || '',
    })),
  };
}

export function renderSharePage(share, docs = []) {
  const notes = (share.notes || [])
    .map((note) => `<li>${escapeHtml(note)}</li>`)
    .join('\n');
  const documents = docs
    .map((doc) => {
      const segments = (Array.isArray(doc.segments) ? doc.segments : []).length
        ? doc.segments
        : [{ locator: 'whole document', text: doc.text }];
      const body = segments
        .map(
          (segment) =>
            `<div class="seg"><span class="loc">${escapeHtml(segment.locator)}</span><pre>${escapeHtml(
              String(segment.text || '').slice(0, 8000)
            )}</pre></div>`
        )
        .join('\n');
      const by = (doc.owners || []).map((owner) => escapeHtml(owner.label)).join(', ');
      return `<details class="doc"><summary>${escapeHtml(doc.name)} · ${escapeHtml(doc.kind)}${
        by ? ` · shared by ${by}` : ''
      }</summary>${body}</details>`;
    })
    .join('\n');

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="robots" content="noindex" />
<title>${escapeHtml(share.courseName)} · shared with Sage</title>
<style>
  :root { color-scheme: dark light; }
  body { margin: 0; padding: 32px 20px 64px; font: 16px/1.55 system-ui, -apple-system, "Segoe UI", sans-serif; background: #0b0f17; color: #e8ecf5; }
  main { max-width: 760px; margin: 0 auto; }
  h1 { font-size: 1.6rem; margin: 4px 0 8px; }
  .by { margin: 0; font-size: .85rem; color: #9aa6bd; }
  .note { margin: 0 0 28px; font-size: .85rem; color: #9aa6bd; }
  h2 { font-size: 1rem; text-transform: uppercase; letter-spacing: .06em; color: #9aa6bd; margin: 32px 0 12px; }
  ul { padding-left: 1.2rem; }
  li { margin: 0 0 8px; }
  .doc { border: 1px solid #232b3b; border-radius: 10px; padding: 12px 14px; margin: 0 0 10px; }
  .doc summary { cursor: pointer; font-weight: 600; }
  .seg { margin: 12px 0 0; }
  .loc { font-size: .78rem; color: #9aa6bd; }
  pre { white-space: pre-wrap; word-break: break-word; margin: 6px 0 0; font: inherit; }
  footer { margin-top: 40px; font-size: .8rem; color: #9aa6bd; }
</style>
</head>
<body>
<main>
  <p class="by">Shared read-only by ${escapeHtml(share.sharedBy || 'someone')} · ${escapeHtml(
    String(share.createdAt || '').slice(0, 10)
  )}</p>
  <h1>${escapeHtml(share.courseName)}</h1>
  <p class="note">This is a read-only copy. Nothing here can be edited, and it carries no personal memory, answers or settings.</p>
  <h2>Notes</h2>
  ${notes ? `<ul>\n${notes}\n</ul>` : '<p class="note">No notes were shared.</p>'}
  <h2>Documents</h2>
  ${documents || '<p class="note">No documents were shared.</p>'}
  <footer>Link expires ${escapeHtml(String(share.expiresAt || '').slice(0, 10))}. Shared from Sage.</footer>
</main>
</body>
</html>`;
}

async function loadDocs(store, share) {
  const docs = [];
  for (const hash of share.docs || []) {
    const doc = await store.loadDoc(hash);
    if (doc) docs.push(doc);
  }
  return docs;
}

function tokenFrom(pathname) {
  const raw = pathname.startsWith('/api/share')
    ? pathname.slice('/api/share'.length)
    : pathname.slice('/share/'.length);
  const token = decodeURIComponent(raw).replace(/^\/+/, '').replace(/\/+$/, '');
  return TOKEN_RE.test(token) ? token : '';
}

export async function handleShare(request, url, env = {}) {
  const isPage = url.pathname.startsWith('/share/');
  const store = await openStore(env);
  if (!store) {
    return isPage
      ? new Response('This build has no storage, so there is nothing to share.', { status: 501 })
      : json({ error: 'no_storage', message: 'This build has no filesystem, so sharing is unavailable.' }, 501);
  }

  const token = tokenFrom(url.pathname);

  // Reading a share needs no identity: the link is the credential, which is the
  // point of handing it to a classmate.
  if (request.method === 'GET' && token) {
    const share = await store.loadShare(token);
    if (!isLiveShare(share)) {
      return isPage
        ? new Response(
            '<!doctype html><meta charset="utf-8"><title>Link expired · Sage</title><p style="font-family:system-ui;padding:32px">This share has expired or never existed.</p>',
            { status: 404, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' } }
          )
        : json({ error: 'not_found', message: 'That share has expired or never existed.' }, 404);
    }
    const docs = await loadDocs(store, share);
    if (isPage) {
      return new Response(renderSharePage(share, docs), {
        headers: {
          'content-type': 'text/html; charset=utf-8',
          'cache-control': 'no-store',
          'x-robots-tag': 'noindex',
          'referrer-policy': 'no-referrer',
        },
      });
    }
    // Counting a view is best effort: failing to write it must not fail the read.
    share.views = (Number(share.views) || 0) + 1;
    store.saveShare(token, share).catch(() => {});
    return json({ share: publicShare(share, docs) });
  }

  const identity = await identityFor(request, env);
  if (!identity) {
    return json(
      {
        error: 'sign_in_required',
        message: 'Set the access code in Settings, or sign in to the panel, to share a course.',
      },
      401
    );
  }

  // A share is a snapshot: the only thing a link can be asked to do is be read.
  if (request.method !== 'POST' && request.method !== 'DELETE') {
    return json({ error: 'method_not_allowed', message: 'A shared course is read-only.' }, 405);
  }
  if (token && request.method !== 'DELETE') {
    return json({ error: 'method_not_allowed', message: 'A shared course is read-only.' }, 405);
  }

  if (request.method === 'DELETE') {
    const share = await store.loadShare(token);
    // Someone else's link is not yours to revoke, and saying which is which would
    // turn the endpoint into a way to probe for tokens.
    if (!share || share.owner !== identity.key) return json({ error: 'not_found' }, 404);
    await store.dropShare(token);
    return json({ revoked: true });
  }

  const origin = String(request.headers.get('origin') || '').trim();
  if (origin && origin !== url.origin) {
    return json({ error: 'bad_origin', message: 'That write came from another origin.' }, 403);
  }

  const raw = await request.text();
  if (raw.length > MAX_BYTES) {
    return json({ error: 'too_large', message: 'That share is over the 3 MB a link can carry.' }, 413);
  }
  let body;
  try {
    body = JSON.parse(raw);
  } catch {
    return json({ error: 'bad_json', message: 'Body must be JSON.' }, 400);
  }
  const clean = sanitiseShareBody(body);
  if (!clean) {
    return json({ error: 'bad_share', message: 'A share needs at least one note or document.' }, 400);
  }

  const sharedBy = clean.sharedBy || identity.label;
  const now = new Date();
  const docs = [];
  for (const doc of clean.docs) {
    const hash = await shareDocHash(doc);
    const existing = await store.loadDoc(hash);
    const owners = Array.isArray(existing?.owners) ? existing.owners : [];
    if (!owners.some((owner) => owner.label === sharedBy)) owners.push({ label: sharedBy, at: now.toISOString() });
    // Same hash means the same words: the copy on the server is the one that
    // counts, and the second sharer is added to its attribution rather than
    // uploading the handout again.
    const docRecord = {
      hash,
      name: doc.name,
      kind: doc.kind,
      chars: doc.text.length,
      text: doc.text,
      segments: doc.segments,
      owners,
      firstSharedAt: existing?.firstSharedAt || now.toISOString(),
    };
    await store.saveDoc(hash, docRecord);
    docs.push(hash);
  }

  const share = {
    token: newToken(),
    owner: identity.key,
    sharedBy,
    kind: clean.kind,
    courseName: clean.courseName,
    notes: clean.notes,
    docs,
    createdAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + SHARE_TTL_MS).toISOString(),
    views: 0,
  };
  await store.saveShare(share.token, share);
  return json({
    token: share.token,
    path: `/share/${share.token}`,
    url: `${url.origin}/share/${share.token}`,
    expiresAt: share.expiresAt,
    docs: docs.length,
    notes: share.notes.length,
  });
}
