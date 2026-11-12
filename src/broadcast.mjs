/**
 * Screen capture that outlives the app: where an iOS broadcast extension and the
 * app it belongs to meet.
 *
 * An App Group is the tidy answer and it is not available here: an App Group has
 * to exist on the developer portal before it can be signed, and the App Store
 * Connect API has no endpoint for creating one — this project signs in CI with
 * that API and nothing else. So the server holds the meeting point instead. Both
 * sides can compute the same vendor identifier (iOS documents it as shared by an
 * app and its extensions), the app opens a session for its device with its access
 * code, the extension posts frames for that device without a secret because it
 * has nowhere to keep one, and the app reads the notes back.
 *
 * In memory, like the relay: a deployment across several isolates would give each
 * its own map and the notes would land wherever the request happened to go.
 */

const SESSIONS = new Map();
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const LIVE_WINDOW_MS = 45 * 1000;
const MAX_NOTES = 200;
const MAX_DEVICES = 200;

function purge() {
  const now = Date.now();
  for (const [device, session] of SESSIONS) {
    if (now - session.at > SESSION_TTL_MS) SESSIONS.delete(device);
  }
  if (SESSIONS.size > MAX_DEVICES) {
    const oldest = [...SESSIONS.entries()].sort((a, b) => a[1].at - b[1].at);
    for (const [device] of oldest.slice(0, SESSIONS.size - MAX_DEVICES)) SESSIONS.delete(device);
  }
}

function describe(device) {
  const session = SESSIONS.get(device);
  if (!session) return { device, open: false, running: false, audioOnly: false, frames: 0, lastFrameAt: 0, expiry: 0 };
  return {
    device,
    open: Boolean(session.open),
    running: Boolean(session.open) && Date.now() - session.lastFrameAt < LIVE_WINDOW_MS,
    audioOnly: Boolean(session.audioOnly),
    frames: session.frames,
    lastFrameAt: session.lastFrameAt,
    expiry: session.at + SESSION_TTL_MS,
  };
}

/**
 * A session opened for an audiobook wants the microphone and nothing else. The
 * extension asks this before it encodes anything, so the answer has to survive
 * until the app closes the session.
 */
export function openSession(device, options = {}) {
  if (!device) return null;
  purge();
  const session = SESSIONS.get(device) || { notes: [], frames: 0, lastFrameAt: 0, at: 0, open: false };
  session.open = true;
  session.audioOnly = Boolean(options.audioOnly);
  session.at = Date.now();
  SESSIONS.set(device, session);
  return describe(device);
}

/** True while this device's open session asked for sound alone. */
export function isAudioOnly(device) {
  const session = device ? SESSIONS.get(device) : null;
  return Boolean(session?.open && session.audioOnly);
}

export function closeSession(device) {
  const session = SESSIONS.get(device);
  if (!session) return describe(device);
  session.open = false;
  SESSIONS.set(device, session);
  return describe(device);
}

/** Only a device whose session was opened with the access code may post frames. */
export function accepts(device) {
  const session = device ? SESSIONS.get(device) : null;
  if (!session || !session.open) return false;
  if (Date.now() - session.at > SESSION_TTL_MS) {
    SESSIONS.delete(device);
    return false;
  }
  return true;
}

export function recordFrame(device, note) {
  const session = SESSIONS.get(device);
  if (!session) return null;
  session.frames += 1;
  session.lastFrameAt = Date.now();
  session.at = Date.now();
  if (note) {
    session.notes.push({ text: String(note).slice(0, 4000), at: session.lastFrameAt });
    if (session.notes.length > MAX_NOTES) session.notes = session.notes.slice(-MAX_NOTES);
  }
  SESSIONS.set(device, session);
  return describe(device);
}

/**
 * Reading collects: a note that came back on every poll would multiply itself in
 * the feed, so the app takes each one exactly once.
 */
export function readNotes(device) {
  const session = device ? SESSIONS.get(device) : null;
  const state = describe(device);
  if (!session) return { ...state, notes: [] };
  const notes = session.notes;
  session.notes = [];
  SESSIONS.set(device, session);
  return { ...state, notes };
}
