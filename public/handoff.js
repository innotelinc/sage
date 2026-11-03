/* Handoff between devices — the rules, with no clock and no storage of their own
   so they can be proven in Node.

   A record is one live session: which device holds it, which course it belongs
   to, the notes written so far, and whether a microphone is open. Two devices
   read the same record; these functions decide what each one should do about
   it. */

export const TTL_MS = 4 * 60 * 60 * 1000;
export const MAX_NOTES = 60;

/** How old a record is, in ms, or -1 when it is absent, unparseable or stale. */
export function freshness(record, now = Date.now()) {
  if (!record || typeof record !== 'object') return -1;
  const at = Date.parse(String(record.at || ''));
  if (!Number.isFinite(at)) return -1;
  const age = now - at;
  return age >= 0 && age < TTL_MS ? age : -1;
}

export function isLive(record, now = Date.now()) {
  return freshness(record, now) >= 0;
}

export function ageLabel(ms) {
  if (!(ms >= 0)) return 'just now';
  const mins = Math.floor(ms / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.round(mins / 60);
  return `${hours} h ago`;
}

const normalise = (text) => String(text || '').toLowerCase().replace(/\s+/g, ' ').trim();

/** Both sets of notes, deduplicated by what they say, oldest first. */
export function mergeNotes(mine = [], theirs = []) {
  const out = [];
  const seen = new Set();
  const all = [...(Array.isArray(mine) ? mine : []), ...(Array.isArray(theirs) ? theirs : [])];
  for (const note of all) {
    if (!note || typeof note.text !== 'string' || !note.text.trim()) continue;
    const key = normalise(note.text);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push({ text: String(note.text), at: String(note.at || ''), kind: String(note.kind || 'note') });
  }
  out.sort((a, b) => String(a.at).localeCompare(String(b.at)));
  return out.slice(-MAX_NOTES);
}

/** The notes on the other device that this one does not have already. */
export function notesToAdopt(mine = [], record) {
  const theirs = record && Array.isArray(record.notes) ? record.notes : [];
  const known = new Set((Array.isArray(mine) ? mine : []).map((note) => normalise(note && note.text)));
  return theirs.filter((note) => note && typeof note.text === 'string' && note.text.trim() && !known.has(normalise(note.text)));
}

/**
 * Offer to continue: another device's session, still live, with notes to carry.
 * A record this device wrote is not an offer — it is this device's own work.
 */
export function shouldOffer(record, me, now = Date.now()) {
  if (!isLive(record, now)) return false;
  if (!record.device || record.device === me) return false;
  return Array.isArray(record.notes) && record.notes.length > 0;
}

/**
 * The microphone is one thing, so only one device may hold it. When another
 * device is capturing and its heartbeat is fresh, this one stops.
 */
export function captureConflict(record, me, now = Date.now()) {
  if (!record || !record.device || record.device === me) return false;
  if (!isLive(record, now)) return false;
  return Boolean(record.capturing);
}

/** The sentence the banner shows, so the wording is testable too. */
export function describe(record, mine = [], now = Date.now()) {
  const age = freshness(record, now);
  const adopt = notesToAdopt(mine, record);
  const notes = record && Array.isArray(record.notes) ? record.notes.length : 0;
  return {
    live: age >= 0,
    age: age >= 0 ? age : 0,
    adopt: adopt.length,
    notes,
    label: (record && record.label) || 'Another device',
    course: (record && record.courseName) || 'this course',
    text: `${(record && record.label) || 'Another device'} was in the middle of ${(record && record.courseName) || 'this course'} ${ageLabel(age)} — ${notes} note${notes === 1 ? '' : 's'}, ${adopt.length} you do not have here.`,
  };
}
