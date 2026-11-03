/**
 * A session in progress, on the server.
 *
 * The workspace is saved when something is finished: a lecture ends, a note is
 * written, a course is renamed. That is the wrong shape for a session you start
 * on the phone and want to continue on the laptop ten minutes later. This keeps a
 * second, small document per identity — the course, the notes so far, and which
 * device holds the microphone — written while the lecture is running.
 *
 * Newer wins, but a write cannot rewind the record: a heartbeat that arrives out
 * of order loses to the copy already stored, and the caller is handed that copy
 * so it can decide for itself. A record with no heartbeat for four hours is gone;
 * a lecture that long is over.
 */
import { SESSION_COOKIE, readSession, parseCookies } from './session.mjs';

const MAX_BYTES = 64 * 1024;
export const TTL_MS = 4 * 60 * 60 * 1000;
export const MAX_NOTES = 60;

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });
}

async function digest(value) {
  const bytes = new TextEncoder().encode(value);
  const hash = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(hash)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** The same identity the workspace uses: the panel session names a person, the
 *  access code names the instance. */
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
  const dir = path.join(base, 'live');
  return {
    async load(key) {
      try {
        const raw = await fs.readFile(path.join(dir, `${key}.json`), 'utf8');
        const doc = JSON.parse(raw);
        return doc && typeof doc === 'object' && doc.session ? doc : null;
      } catch {
        return null;
      }
    },
    async save(key, doc) {
      await fs.mkdir(dir, { recursive: true, mode: 0o700 });
      const target = path.join(dir, `${key}.json`);
      const temporary = `${target}.${Date.now().toString(36)}.tmp`;
      await fs.writeFile(temporary, JSON.stringify(doc), { mode: 0o600 });
      await fs.rename(temporary, target);
      return target;
    },
    async drop(key) {
      try {
        await fs.unlink(path.join(dir, `${key}.json`));
        return true;
      } catch {
        return false;
      }
    },
  };
}

function newRev() {
  const bytes = new Uint8Array(9);
  crypto.getRandomValues(bytes);
  return [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** Only what a live session needs. The notes carry no images and no answers. */
export function sanitiseSession(session) {
  if (!session || typeof session !== 'object') return null;
  const device = String(session.device || '').trim().slice(0, 64);
  if (!device) return null;
  return {
    device,
    label: String(session.label || 'a device').slice(0, 40),
    courseId: String(session.courseId || '').slice(0, 64),
    courseName: String(session.courseName || '').slice(0, 120),
    capturing: Boolean(session.capturing),
    notes: (Array.isArray(session.notes) ? session.notes : [])
      .filter((note) => note && typeof note.text === 'string' && note.text.trim())
      .slice(-MAX_NOTES)
      .map((note) => ({
        text: String(note.text).slice(0, 1200),
        at: String(note.at || '').slice(0, 40),
        kind: String(note.kind || 'note').slice(0, 20),
      })),
    at: String(session.at || '').slice(0, 40),
  };
}

export function isFresh(session, now = Date.now()) {
  const at = Date.parse(String((session && session.at) || ''));
  return Number.isFinite(at) && now - at < TTL_MS;
}

export async function handleLiveSession(request, url, env = {}) {
  const identity = await identityFor(request, env);
  if (!identity) {
    return json(
      {
        error: 'sign_in_required',
        message: 'Set the access code in Settings, or sign in to the panel, to carry a session between devices.',
      },
      401,
    );
  }

  const store = await openStore(env);
  if (!store) {
    return json({ error: 'no_storage', message: 'This build has no filesystem, so a session stays on its device.' }, 501);
  }

  if (request.method === 'GET') {
    const doc = await store.load(identity.key);
    if (!doc || !isFresh(doc.session)) return json({ session: null, storedBy: identity.label });
    return json({ session: doc.session, rev: doc.rev, storedBy: identity.label });
  }

  if (request.method === 'DELETE') {
    await store.drop(identity.key);
    return json({ cleared: true });
  }

  if (request.method !== 'PUT') return json({ error: 'method_not_allowed' }, 405);

  const origin = String(request.headers.get('origin') || '').trim();
  if (origin && origin !== url.origin) {
    return json({ error: 'bad_origin', message: 'That write came from another origin.' }, 403);
  }

  const raw = await request.text();
  if (raw.length > MAX_BYTES) {
    return json({ error: 'too_large', message: 'A live session is capped at 64 KB.' }, 413);
  }
  let body;
  try {
    body = JSON.parse(raw);
  } catch {
    return json({ error: 'bad_json', message: 'Body must be JSON.' }, 400);
  }
  const session = sanitiseSession(body && body.session);
  if (!session) {
    return json({ error: 'bad_session', message: 'A live session needs a device and a course.' }, 400);
  }

  const current = await store.load(identity.key);
  // A heartbeat that arrives late must not rewind the record, and it must not
  // overwrite notes another device has already written.
  if (current && isFresh(current.session) && String(current.session.at || '') > String(session.at || '')) {
    return json({ error: 'stale', session: current.session, rev: current.rev }, 409);
  }

  const doc = { rev: newRev(), session };
  try {
    await store.save(identity.key, doc);
  } catch (error) {
    return json({ error: 'write_failed', message: error.message }, 500);
  }
  return json({ saved: true, rev: doc.rev, session: doc.session, storedBy: identity.label });
}
