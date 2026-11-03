/**
 * Turns kept on the device while the server is unreachable.
 *
 * The one thing a network drop must not do is lose the question the user just
 * typed while the lecture moved on. A turn that cannot reach the server is kept
 * here — text only, because a photo is megabytes and replaying last week's
 * whiteboard later is worse than losing it — and replayed when the connection
 * returns. Pure functions, so the queue can be tested without a browser.
 */

const MAX_PENDING = 12;

export function queued(queue) {
  return Array.isArray(queue) ? queue.filter((turn) => turn && typeof turn.text === 'string' && turn.text.trim()) : [];
}

/** Append a turn, keeping the newest `limit` — an old question outlives its use. */
export function enqueue(queue, turn, limit = MAX_PENDING) {
  const entry = {
    id: `p${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
    mode: String(turn.mode || 'answer'),
    text: String(turn.text || '').slice(0, 6000),
    maxTokens: Number(turn.maxTokens) || 0,
    tab: String(turn.tab || ''),
    at: new Date().toISOString(),
  };
  if (!entry.text.trim()) return queued(queue);
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
