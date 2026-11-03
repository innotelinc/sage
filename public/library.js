/**
 * Documents that work offline.
 *
 * A course's foundation documents live in the workspace, which means a basement
 * tutorial with no connection has nothing to ground an answer on: the upload was
 * read once, on the server, and the device only ever held the copy it happened to
 * save. This module is the device's own copy — a content hash per document, a
 * budget that evicts the least recently used, and a reconciliation step that
 * notices when the copy here is not the copy on the server.
 *
 * Pure and DOM-free, so the rules can be tested without a browser. The IndexedDB
 * plumbing that calls it lives in app.js.
 */

export const CACHE_MAX_CHARS = 900000;
export const CACHE_MAX_DOCS = 24;

/* FNV-1a, 32 bits. The point is telling two versions of a handout apart, not
   resisting an attacker; this runs over a few hundred thousand characters on a
   tap without a pause. */
export function hashText(value) {
  const text = String(value == null ? '' : value);
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

/** The name is part of the identity: two handouts with the same words stay two. */
export function hashDoc(doc = {}) {
  return hashText(`${String(doc.name || 'document')}\n${String(doc.text || '')}`);
}

/** A document as the device keeps it: what it is, its hash, and when it landed. */
export function stampDoc(doc = {}, now = Date.now()) {
  const text = String(doc.text || '');
  return {
    name: String(doc.name || 'document').slice(0, 120),
    kind: String(doc.kind || 'text').slice(0, 24),
    chars: Number(doc.chars) || text.length,
    hash: hashDoc(doc),
    segments: (Array.isArray(doc.segments) ? doc.segments : [])
      .filter((segment) => segment && String(segment.text || '').trim())
      .slice(0, 120)
      .map((segment) => ({
        locator: String(segment.locator || 'whole document').slice(0, 40),
        text: String(segment.text),
      })),
    note: String(doc.note || '').slice(0, 200),
    on: doc.on !== false,
    text,
    cachedAt: Number(now) || Date.now(),
    usedAt: Number(now) || Date.now(),
  };
}

/**
 * What has to leave the device for the cache to fit. Entries are the stored rows
 * reduced to `{id, chars, at}`; the least recently used go first, and the newest
 * document survives even when it alone is over budget, because dropping the thing
 * the user just added is worse than being over it.
 */
export function planCache(entries = [], options = {}) {
  const maxChars = Number(options.maxChars) || CACHE_MAX_CHARS;
  const maxDocs = Number(options.maxDocs) || CACHE_MAX_DOCS;
  const kept = (entries || [])
    .filter((entry) => entry && entry.id != null)
    .map((entry) => ({
      id: String(entry.id),
      chars: Math.max(0, Number(entry.chars) || 0),
      at: Number(entry.at) || 0,
    }))
    .sort((a, b) => a.at - b.at || a.id.localeCompare(b.id));
  let chars = kept.reduce((sum, entry) => sum + entry.chars, 0);
  const dropped = [];
  while (kept.length > 1 && (chars > maxChars || kept.length > maxDocs)) {
    const oldest = kept.shift();
    chars -= oldest.chars;
    dropped.push(oldest.id);
  }
  return { dropped, chars, count: kept.length };
}

/**
 * Compare the device's copy with the course's copy. Same name and same hash is a
 * match; same name and different text is a refresh; a document the course no
 * longer holds leaves the device; a document it holds and the device does not is
 * simply new. Only ever called when the server answered, so a failed pull cannot
 * empty the cache.
 */
export function reconcileDocs(cached = [], live = []) {
  const byName = new Map();
  for (const entry of cached || []) if (entry && entry.name) byName.set(String(entry.name), entry);
  const liveByName = new Map();
  for (const doc of live || []) if (doc && doc.name) liveByName.set(String(doc.name), doc);

  const keep = [];
  const refresh = [];
  const drop = [];
  const added = [];

  for (const [name, doc] of liveByName) {
    const was = byName.get(name);
    if (!was) {
      added.push(name);
      continue;
    }
    const hash = hashDoc(doc);
    // An unstamped copy predates hashing, so it is refreshed rather than trusted.
    if (!was.hash || was.hash !== hash) refresh.push({ name, from: was.hash || '', to: hash });
    else keep.push(name);
  }
  for (const name of byName.keys()) if (!liveByName.has(name)) drop.push(name);

  return { keep, refresh, drop, added };
}

/** The rows this device holds that the course itself no longer has. */
export function cacheOnly(cached = [], live = []) {
  const liveNames = new Set((live || []).map((doc) => String((doc && doc.name) || '')));
  return (cached || []).filter((row) => row && row.text && row.on !== false && !liveNames.has(String(row.name)));
}

/** What the Foundation panel says about the copy on this device. */
export function describeCache(rows = []) {
  const list = (rows || []).filter((row) => row && row.text);
  if (!list.length) return 'No copy on this device yet — add a document once and it grounds answers with no connection.';
  const chars = list.reduce((sum, row) => sum + String(row.text).length, 0);
  const newest = list.reduce((latest, row) => Math.max(latest, Number(row.cachedAt) || 0), 0);
  const when = newest ? new Date(newest).toISOString().slice(0, 10) : '';
  return `${list.length} document${list.length === 1 ? '' : 's'} cached on this device · ${chars.toLocaleString('en-GB')} characters${when ? ` · saved ${when}` : ''}`;
}

/** The clause a reply carries when it was grounded on the cached copy. */
export function cacheNote(names = []) {
  const list = [...new Set((names || []).filter(Boolean).map(String))];
  if (!list.length) return '';
  return `from the copy cached on this device (${list.join(', ')})`;
}
