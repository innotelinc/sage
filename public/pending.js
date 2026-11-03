/**
 * Turns kept on the device while the server is unreachable.
 *
 * The one thing a network drop must not do is lose the question the user just
 * typed while the lecture moved on. A turn that cannot reach the server is kept
 * here — with a count of the photos that came with it, since a photo is megabytes
 * and belongs in the image store beside this one — and replayed when the connection
 * returns. Pure functions, so the queue can be tested without a browser.
 */

const MAX_PENDING = 12;

export function queued(queue) {
  return Array.isArray(queue)
    ? queue.filter(
        (turn) => turn && typeof turn.text === 'string' && (turn.text.trim() || Number(turn.images) > 0)
      )
    : [];
}

/** Append a turn, keeping the newest `limit` — an old question outlives its use. */
export function enqueue(queue, turn, limit = MAX_PENDING) {
  const entry = {
    id: `p${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
    mode: String(turn.mode || 'answer'),
    text: String(turn.text || '').slice(0, 6000),
    // A count only: the photos are in the image store, keyed by this id.
    images: Math.max(0, Math.min(4, Number(turn.images) || 0)),
    maxTokens: Number(turn.maxTokens) || 0,
    tab: String(turn.tab || ''),
    // The documents this turn was asked against while the connection was down:
    // they came from the copy on this device, and the reply should say so.
    fromCache: (Array.isArray(turn.fromCache) ? turn.fromCache : [])
      .filter((name) => typeof name === 'string' && name.trim())
      .map((name) => name.slice(0, 120))
      .slice(0, 8),
    at: new Date().toISOString(),
  };
  if (!entry.text.trim() && !entry.images) return queued(queue);
  return [...queued(queue), entry].slice(-Math.max(1, limit));
}

export function forget(queue, id) {
  return queued(queue).filter((turn) => turn.id !== id);
}

export function pendingLabel(queue) {
  const count = queued(queue).length;
  if (!count) return '';
  return `${count} turn${count === 1 ? '' : 's'} waiting for the connection`;
}
