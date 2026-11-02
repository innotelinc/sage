/**
 * Course memory on the server.
 *
 * Until 2.5 a workspace lived only in the device's localStorage, so carrying a
 * course between the phone and the browser meant exporting a study pack. This
 * keeps one copy per operator identity instead: sign in to the panel and the
 * Cerulean session decides whose workspace it is, or — with no panel session —
 * the instance's access code does, since that is already the secret that guards
 * the API. Without either, sync is refused rather than dropping every caller
 * into one shared bucket.
 *
 * Files, not a database: one JSON document per identity, written whole and
 * renamed into place so a half-written save can never be read back. The
 * Cloudflare Worker entry has no filesystem, so it answers 501 and the client
 * stays local, which is what it does today.
 */
import { SESSION_COOKIE, readSession, parseCookies } from './session.mjs';

const MAX_BYTES = 2 * 1024 * 1024;

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

/**
 * Who is asking. A panel session wins because it names a person; otherwise the
 * access code identifies the instance, which is the right unit when one operator
 * runs both the phone and the browser.
 */
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

/**
 * A thin filesystem layer that only exists where there is a filesystem. The
 * import is dynamic so a Worker bundle never reaches for node:fs.
 */
async function openStore(env = {}) {
  let fs;
  let path;
  try {
    [fs, path] = await Promise.all([import('node:fs/promises'), import('node:path')]);
  } catch {
    return null;
  }
  const base = String(env.SAGE_DATA_DIR || '').trim() || (typeof process !== 'undefined' ? path.join(process.cwd(), 'data') : '');
  if (!base) return null;
  const dir = path.join(base, 'workspaces');
  return {
    async load(key) {
      try {
        const raw = await fs.readFile(path.join(dir, `${key}.json`), 'utf8');
        const doc = JSON.parse(raw);
        return doc && typeof doc === 'object' && doc.workspace ? doc : null;
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

/** Only the parts of a workspace the server has any business storing. */
function sanitise(workspace) {
  if (!workspace || typeof workspace !== 'object') return null;
  if (!Array.isArray(workspace.courses) || !workspace.courses.length) return null;
  if (!Array.isArray(workspace.timetable)) return null;
  return {
    activeId: String(workspace.activeId || ''),
    courses: workspace.courses.slice(0, 40),
    timetable: workspace.timetable.slice(0, 80),
    savedAt: String(workspace.savedAt || ''),
  };
}

export async function handleWorkspace(request, url, env = {}) {
  const identity = await identityFor(request, env);
  if (!identity) {
    return json(
      { error: 'sign_in_required', message: 'Set the access code in Settings, or sign in to the panel, to keep this workspace on the server.' },
      401,
    );
  }

  const store = await openStore(env);
  if (!store) {
    return json({ error: 'no_storage', message: 'This build has no filesystem, so the workspace stays on the device.' }, 501);
  }

  if (request.method === 'GET') {
    const doc = await store.load(identity.key);
    if (!doc) return json({ rev: '', savedAt: '', storedBy: identity.label, workspace: null });
    return json({ rev: doc.rev, savedAt: doc.savedAt, storedBy: doc.by || identity.label, workspace: doc.workspace });
  }

  if (request.method === 'DELETE') {
    await store.drop(identity.key);
    return json({ deleted: true });
  }

  if (request.method !== 'PUT') return json({ error: 'method_not_allowed' }, 405);

  // A write must come from this origin. Native shells send no Origin at all,
  // which is accepted because they cannot be driven by another page.
  const origin = String(request.headers.get('origin') || '').trim();
  if (origin && origin !== url.origin) {
    return json({ error: 'bad_origin', message: 'That write came from another origin.' }, 403);
  }

  const raw = await request.text();
  if (raw.length > MAX_BYTES) {
    return json({ error: 'too_large', message: 'That workspace is over the 2 MB the server keeps.' }, 413);
  }
  let body;
  try {
    body = JSON.parse(raw);
  } catch {
    return json({ error: 'bad_json', message: 'Body must be JSON.' }, 400);
  }
  const workspace = sanitise(body && body.workspace);
  if (!workspace) {
    return json({ error: 'bad_workspace', message: 'A workspace needs at least one course.' }, 400);
  }

  const current = await store.load(identity.key);
  const baseRev = String((body && body.baseRev) || '');
  if (current && baseRev !== current.rev) {
    // Someone else saved since this client last read. Hand back the newer copy
    // so the client can decide between adopting it and saving over it.
    return json(
      { error: 'conflict', rev: current.rev, savedAt: current.savedAt, workspace: current.workspace },
      409,
    );
  }

  const doc = { rev: newRev(), savedAt: new Date().toISOString(), by: identity.label, workspace };
  try {
    await store.save(identity.key, doc);
  } catch (error) {
    return json({ error: 'write_failed', message: error.message }, 500);
  }
  return json({ rev: doc.rev, savedAt: doc.savedAt, storedBy: doc.by });
}
