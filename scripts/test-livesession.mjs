/**
 * The live session route: identity, newer-wins, and the four-hour window.
 *
 * The handler is exercised directly, with a temporary data directory, so no
 * server has to be started and nothing is written outside the test's own folder.
 */
import assert from 'node:assert/strict';
import { mkdtemp, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const dir = await mkdtemp(path.join(tmpdir(), 'sage-live-'));
const { handleLiveSession, TTL_MS, MAX_NOTES, sanitiseSession, isFresh } = await import('../src/livesession.mjs');

const env = { SAGE_DATA_DIR: dir, ACCESS_CODE: 'code-123' };
const base = 'http://localhost:8787/api/live';
const url = new URL(base);

function call(method, body, headers = {}) {
  const merged = { 'content-type': 'application/json', 'x-access-code': 'code-123', ...headers };
  return handleLiveSession(
    new Request(base, { method, headers: merged, body: body === undefined ? undefined : JSON.stringify(body) }),
    url,
    env,
  );
}

const iso = (ms) => new Date(ms).toISOString();
const now = Date.now();

const session = (over = {}) => ({
  device: 'phone-1',
  label: 'iPhone',
  courseId: 'c1',
  courseName: 'BIO 201',
  capturing: true,
  notes: [
    { text: 'Osmosis moves water.', at: iso(now - 30000) },
    { text: 'Turgor keeps the cell rigid.', at: iso(now - 10000) },
  ],
  at: iso(now),
  ...over,
});

/* ── identity ─────────────────────────────────────────────────── */
let res = await handleLiveSession(new Request(base, { method: 'GET' }), url, env);
assert.equal(res.status, 401, 'no identity means no session');
assert.equal((await res.json()).error, 'sign_in_required', 'and it says which identity is missing');

res = await handleLiveSession(
  new Request(base, { method: 'GET', headers: { 'x-access-code': 'wrong' } }),
  url,
  env,
);
assert.equal(res.status, 401, 'a wrong access code is refused, not shared');

res = await handleLiveSession(new Request(base, { method: 'PUT' }), url, { ACCESS_CODE: '', SAGE_DATA_DIR: dir });
assert.equal(res.status, 401, 'an instance with no access code cannot hold a session');

/* ── writing and reading ──────────────────────────────────────── */
res = await call('PUT', { session: session() });
assert.equal(res.status, 200, 'a heartbeat is accepted');
let body = await res.json();
assert.equal(body.saved, true, 'and reported as saved');
assert.ok(body.rev, 'with a revision');

res = await call('GET');
body = await res.json();
assert.equal(res.status, 200, 'a reader can fetch it');
assert.equal(body.session.device, 'phone-1', 'and sees which device holds it');
assert.equal(body.session.notes.length, 2, 'with the notes written so far');
assert.equal(body.session.capturing, true, 'and that the microphone is open');

res = await call('GET', undefined, { 'x-access-code': '' });
assert.equal(res.status, 401, 'a reader with no identity gets nothing');

/* ── newer wins, and a late heartbeat cannot rewind ───────────── */
res = await call('PUT', { session: session({ at: iso(now - 60000), notes: [{ text: 'older', at: iso(now - 90000) }] }) });
assert.equal(res.status, 409, 'an older heartbeat is refused');
body = await res.json();
assert.equal(body.error, 'stale', 'and named as stale');
assert.equal(body.session.notes.length, 2, 'returning the stored copy so the caller can catch up');

res = await call('PUT', { session: session({ device: 'laptop-9', label: 'laptop', at: iso(now + 1000), capturing: false }) });
assert.equal(res.status, 200, 'a newer write from another device is accepted');
body = await call('GET').then((r) => r.json());
assert.equal(body.session.device, 'laptop-9', 'and the record now names the laptop');
assert.equal(body.session.capturing, false, 'with the microphone closed');

/* ── the window ───────────────────────────────────────────────── */
// Clear first: a stored, fresh record would (rightly) win against this one.
await call('DELETE');
res = await call('PUT', { session: session({ device: 'phone-1', at: iso(Date.now() - TTL_MS - 60000) }) });
assert.equal(res.status, 200, 'an old record can still be written');
body = await call('GET').then((r) => r.json());
assert.equal(body.session, null, 'but it is not handed back once the window has passed');
assert.equal(isFresh({ at: iso(Date.now() - TTL_MS - 1) }), false, 'four hours is the window');

/* ── what is kept ─────────────────────────────────────────────── */
const fat = sanitiseSession({
  device: 'd1',
  notes: Array.from({ length: 90 }, (_, i) => ({ text: `note ${i}`, at: 'x' })),
});
assert.equal(fat.notes.length, MAX_NOTES, 'notes are capped');
assert.equal(fat.notes[fat.notes.length - 1].text, 'note 89', 'keeping the newest');
assert.equal(sanitiseSession({ notes: [] }), null, 'a session without a device is refused');
assert.equal(sanitiseSession({ device: 'd1', notes: [{ text: '   ' }] }).notes.length, 0, 'blank notes are dropped');
assert.equal(sanitiseSession({ device: 'd1', notes: [{ text: 'x'.repeat(5000) }] }).notes[0].text.length, 1200, 'a note is clipped');

res = await call('PUT', { session: { device: 'd1' } }, { origin: 'https://elsewhere.example' });
assert.equal(res.status, 403, 'a write from another origin is refused');
res = await call('PUT', { session: { label: 'no device' } });
assert.equal(res.status, 400, 'a session without a device is refused');
res = await handleLiveSession(
  new Request(base, { method: 'PUT', headers: { 'x-access-code': 'code-123' }, body: '{not json' }),
  url,
  env,
);
assert.equal(res.status, 400, 'broken JSON is a bad request, not a crash');

/* ── clearing ─────────────────────────────────────────────────── */
res = await call('DELETE');
assert.equal(res.status, 200, 'the record can be cleared');
body = await call('GET').then((r) => r.json());
assert.equal(body.session, null, 'and reads as empty afterwards');
const files = await readdir(path.join(dir, 'live')).catch(() => []);
assert.equal(files.filter((name) => name.endsWith('.json')).length, 0, 'nothing is left on disk');

console.log('  30 checks passed');
