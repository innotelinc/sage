/**
 * Relay hub: one device captures (a computer watching a mirrored phone, a TV
 * cast window, an Android tablet), another device does the thinking.
 *
 * Frames live in process memory only, expire after ten idle minutes, and are
 * never written to disk. That makes this Node-server only: a multi-isolate
 * Worker deployment would give each request its own memory, so the direct
 * capture path is the right one there.
 */

const SESSIONS = new Map();
const IDLE_TTL_MS = 10 * 60 * 1000;
const MAX_FRAME_CHARS = 4_500_000;
const MAX_SESSIONS = 200;

function purge() {
  const now = Date.now();
  for (const [code, session] of SESSIONS) {
    if (now - session.at > IDLE_TTL_MS) SESSIONS.delete(code);
  }
  if (SESSIONS.size > MAX_SESSIONS) {
    const oldest = [...SESSIONS.entries()].sort((a, b) => a[1].at - b[1].at).slice(0, SESSIONS.size - MAX_SESSIONS);
    for (const [code] of oldest) SESSIONS.delete(code);
  }
}

export async function handleRelay(request, url, json) {
  const match = url.pathname.match(/^\/api\/relay\/([a-z0-9]{4,12})\/(frame|latest)$/i);
  if (!match) return json({ error: 'not_found', message: 'Relay routes are /api/relay/:code/frame and /latest.' }, 404);

  const code = match[1].toLowerCase();
  const action = match[2];
  purge();

  if (action === 'frame') {
    if (request.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);
    const body = await request.json().catch(() => null);
    const image = body?.image;
    if (typeof image !== 'string' || !image.startsWith('data:image/')) {
      return json({ error: 'bad_frame', message: 'image must be an image data URL.' }, 400);
    }
    if (image.length > MAX_FRAME_CHARS) {
      return json({ error: 'frame_too_large', message: 'Frame is too large; shrink it before sending.' }, 413);
    }
    const session = SESSIONS.get(code) || { frames: 0, at: 0, image: null };
    session.image = image;
    session.at = Date.now();
    session.frames += 1;
    SESSIONS.set(code, session);
    return json({ ok: true, code, frames: session.frames, at: session.at });
  }

  if (request.method !== 'GET') return json({ error: 'method_not_allowed' }, 405);
  const session = SESSIONS.get(code);
  if (!session) {
    return json({ error: 'no_session', message: 'Nothing is sharing that code.' }, 404);
  }
  const since = Number(url.searchParams.get('since') || 0);
  const fresh = session.at > since;
  return json({
    code,
    at: session.at,
    frames: session.frames,
    image: fresh ? session.image : null,
    stale: !fresh,
  });
}
