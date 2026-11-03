/**
 * The photos that belong to a turn kept on the device.
 *
 * A phone photo is megabytes, and localStorage's few megabytes are already shared
 * with everything else the app remembers, so the queue's words stay where they are
 * and the images live here. The store is capped by total bytes and evicts oldest
 * first, so a run of queued photos cannot fill the origin and wedge the app.
 * Every entry point degrades to a no-op when IndexedDB is unavailable: the queue
 * still works, it just keeps the words.
 */

const DB_NAME = 'sage-pending-photos';
const STORE = 'photos';
const VERSION = 1;

export const MAX_TOTAL_BYTES = 6 * 1024 * 1024;
export const MAX_PHOTOS_PER_TURN = 4;

/** Rough byte size of a data URL, without decoding it. */
export function photoBytes(dataUrl) {
  const text = String(dataUrl || '');
  const comma = text.indexOf(',');
  if (comma < 0) return 0;
  return Math.max(0, Math.round(((text.length - comma - 1) * 3) / 4));
}

/**
 * Which stored photos have to go for the store to fit, oldest first, and what is
 * left. Pure, so the budget can be tested without a browser.
 */
export function planEviction(entries, maxBytes = MAX_TOTAL_BYTES) {
  const kept = [...(entries || [])]
    .map((entry) => ({
      id: String(entry.id),
      bytes: Math.max(0, Number(entry.bytes) || 0),
      at: Number(entry.at) || 0,
    }))
    .sort((a, b) => a.at - b.at);
  let total = kept.reduce((sum, entry) => sum + entry.bytes, 0);
  const dropped = [];
  while (kept.length && total > maxBytes) {
    const oldest = kept.shift();
    total -= oldest.bytes;
    dropped.push(oldest.id);
  }
  return { dropped, bytes: total };
}

function openDb() {
  if (typeof indexedDB === 'undefined') return Promise.resolve(null);
  return new Promise((resolve) => {
    let request;
    try {
      request = indexedDB.open(DB_NAME, VERSION);
    } catch {
      resolve(null);
      return;
    }
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE)) {
        const store = db.createObjectStore(STORE, { keyPath: 'id' });
        store.createIndex('turn', 'turn', { unique: false });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => resolve(null);
    request.onblocked = () => resolve(null);
  });
}

function once(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function withStore(mode, run) {
  const db = await openDb();
  if (!db) return null;
  try {
    const tx = db.transaction(STORE, mode);
    const result = await run(tx.objectStore(STORE));
    await new Promise((resolve) => {
      tx.oncomplete = resolve;
      tx.onerror = resolve;
      tx.onabort = resolve;
    });
    return result;
  } catch {
    return null;
  } finally {
    db.close?.();
  }
}

/** Keep the photos for a turn, evicting the oldest if that overruns the budget. */
export async function putPhotos(turnId, dataUrls) {
  const list = (dataUrls || [])
    .filter((entry) => typeof entry === 'string' && entry.startsWith('data:image/'))
    .slice(0, MAX_PHOTOS_PER_TURN);
  if (!list.length) return 0;
  const now = Date.now();
  const rows = list.map((data, index) => ({
    id: `${turnId}:${index}`,
    turn: String(turnId),
    at: now + index,
    bytes: photoBytes(data),
    data,
  }));
  const stored = await withStore('readwrite', async (store) => {
    for (const row of rows) await once(store.put(row));
    const all = await once(store.getAll());
    const plan = planEviction((all || []).map(({ id, bytes, at }) => ({ id, bytes, at })));
    for (const id of plan.dropped) await once(store.delete(id));
    return rows.length;
  });
  return stored || 0;
}

/** The photos for one turn, in the order they were attached. */
export async function getPhotos(turnId) {
  const rows = await withStore('readonly', (store) => once(store.index('turn').getAll(String(turnId))));
  return (rows || [])
    .sort((a, b) => Number(a.at) - Number(b.at))
    .map((row) => row.data)
    .filter(Boolean);
}

/** The answer landed, so the images are no longer worth megabytes. */
export async function dropPhotos(turnId) {
  await withStore('readwrite', async (store) => {
    const keys = await once(store.index('turn').getAllKeys(String(turnId)));
    for (const key of keys || []) await once(store.delete(key));
  });
}
