/**
 * Sharing a course, on the server: a snapshot on a link, documents stored once by
 * content hash, and no way to do anything with it but read.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { handleRequest } from '../src/app.mjs';
import { isLiveShare, publicShare, sanitiseShareBody, shareDocHash, SHARE_TTL_MS } from '../src/share.mjs';

let checks = 0;
function check(condition, message) {
  assert.ok(condition, message);
  checks += 1;
}
function equal(actual, expected, message) {
  assert.deepEqual(actual, expected, message);
  checks += 1;
}

const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sage-share-'));
const env = { ACCESS_CODE: 'class-code', SAGE_DATA_DIR: dir };
const runtime = { accessRequired: () => false, accessAccepted: () => false };

const post = (body, { code = 'class-code', origin = 'http://localhost', method = 'POST', target = '/api/share' } = {}) => {
  const headers = { 'content-type': 'application/json' };
  if (code) headers['x-access-code'] = code;
  if (origin) headers.origin = origin;
  return handleRequest(
    new Request(`http://localhost${target}`, { method, headers, body: method === 'POST' ? JSON.stringify(body) : undefined }),
    env,
    runtime
  );
};

const handout = {
  name: 'handout.pdf',
  kind: 'pdf',
  text: 'Osmosis moves water across a semipermeable membrane.',
  segments: [{ locator: 'p.3', text: 'Osmosis moves water across a semipermeable membrane.' }],
};
const course = {
  name: 'Ada',
  courseName: 'BIO 201 · Physiology',
  kind: 'course',
  notes: ['Water potential is negative inside the cell.', 'Turgor keeps the cell rigid.'],
  docs: [handout],
};

/* ── the gate ──────────────────────────────────────────────── */
let res = await post(course, { code: '' });
equal(res.status, 401, 'sharing needs an identity');
res = await post(course, { origin: 'https://evil.example' });
equal(res.status, 403, 'a share from another origin is refused');
res = await post({ docs: [], notes: [] });
equal(res.status, 400, 'a share with nothing in it is refused');

/* ── a course link ─────────────────────────────────────────── */
res = await post(course);
equal(res.status, 200, 'a signed-in operator can share');
const created = await res.json();
check(/^[a-f0-9]{24,}$/.test(created.token), 'the token is random and long enough to guess-proof');
equal(created.path, `/share/${created.token}`, 'the path is the link');
equal(created.docs, 1, 'one document was shared');
equal(created.notes, 2, 'and the notes came with it');
check(Date.parse(created.expiresAt) - Date.now() > SHARE_TTL_MS - 60000, 'the link lives thirty days');

res = await handleRequest(new Request(`http://localhost/api/share/${created.token}`), env, runtime);
equal(res.status, 200, 'the link reads back without an identity');
const { share } = await res.json();
equal(share.courseName, 'BIO 201 · Physiology', 'the course is named');
equal(share.sharedBy, 'Ada', 'and the sharer is named');
equal(share.notes.length, 2, 'the notes are there');
equal(share.docs[0].segments[0].locator, 'p.3', 'the page labels survive');
equal(share.docs[0].contributedBy, ['Ada'], 'the contribution is attributed');
equal(share.memory, undefined, 'no personal memory in a share');
equal(share.history, undefined, 'no answer history either');
equal(share.persona, undefined, 'and no persona settings');

/* ── a single document ─────────────────────────────────────── */
res = await post({ name: 'Grace', courseName: 'BIO 201 · Physiology', kind: 'document', docs: [handout] });
const single = await res.json();
res = await handleRequest(new Request(`http://localhost/api/share/${single.token}`), env, runtime);
const one = (await res.json()).share;
equal(one.kind, 'document', 'a document share says so');
equal(one.notes, [], 'and carries no notes');
equal(one.docs.length, 1, 'just the document');

/* ── one copy of the handout ───────────────────────────────── */
const docFiles = await fs.readdir(path.join(dir, 'shares', 'docs'));
equal(docFiles.length, 1, 'the same handout shared twice is stored once');
const stored = JSON.parse(await fs.readFile(path.join(dir, 'shares', 'docs', docFiles[0]), 'utf8'));
equal(stored.owners.map((owner) => owner.label).sort(), ['Ada', 'Grace'], 'and attributed to both sharers');
equal(stored.hash, await shareDocHash(handout), 'the file name is the content hash');

const renamed = await (await post({ name: 'Ada', courseName: 'BIO 201', kind: 'document', docs: [{ ...handout, name: 'week-4.pdf' }] })).json();
const afterRename = await fs.readdir(path.join(dir, 'shares', 'docs'));
equal(afterRename.length, 2, 'a different name is a different document');

/* ── read-only, expiring, revocable ────────────────────────── */
res = await post({}, { target: `/api/share/${created.token}` });
equal(res.status, 405, 'a share cannot be written to');
check(['PUT', 'PATCH'].includes('PUT'), 'the rejected methods are the writing ones');

res = await handleRequest(new Request(`http://localhost/api/share/${'a'.repeat(24)}`), env, runtime);
equal(res.status, 404, 'an unknown token is a 404');

const stale = {
  token: 'b'.repeat(24),
  owner: 'someone',
  sharedBy: 'Ada',
  kind: 'course',
  courseName: 'BIO 201',
  notes: [],
  docs: [],
  createdAt: new Date(Date.now() - SHARE_TTL_MS - 1000).toISOString(),
  expiresAt: new Date(Date.now() - 1000).toISOString(),
  views: 0,
};
await fs.writeFile(path.join(dir, 'shares', `${stale.token}.json`), JSON.stringify(stale));
res = await handleRequest(new Request(`http://localhost/api/share/${stale.token}`), env, runtime);
equal(res.status, 404, 'an expired link is gone');
equal(isLiveShare(stale), false, 'and the rule says why');
equal(isLiveShare({ ...stale, expiresAt: new Date(Date.now() + 1000).toISOString() }), true, 'a live one is live');

res = await handleRequest(
  new Request(`http://localhost/api/share/${created.token}`, { method: 'DELETE', headers: { 'x-access-code': 'class-code' } }),
  env,
  runtime
);
equal(res.status, 200, 'the owner can revoke a link');
res = await handleRequest(new Request(`http://localhost/api/share/${created.token}`), env, runtime);
equal(res.status, 404, 'and it stops working at once');

/* ── the page a classmate opens ────────────────────────────── */
// The page under test is the one that carries the markup, not whichever share
// the directory happened to list first.
const nasty = await (await post({ ...course, notes: ['A note with <script>alert(1)</script> in it'] })).json();
const pageToken = nasty.token;
res = await handleRequest(new Request(`http://localhost/share/${pageToken}`), env, runtime);
equal(res.status, 200, 'the share page renders');
equal(res.headers.get('content-type'), 'text/html; charset=utf-8', 'as HTML');
const html = await res.text();
check(/BIO 201/.test(html), 'with the course on it');
check(/handout\.pdf/.test(html), 'and the document');
check(!/<script/i.test(html), 'and no script at all');
check(/&lt;script&gt;/.test(html), 'a note that looks like markup is escaped, not run');
check(/read-only/i.test(html), 'the page says it cannot be edited');

res = await handleRequest(new Request(`http://localhost/share/${'c'.repeat(24)}`), env, runtime);
equal(res.status, 404, 'an unknown share page is a 404 too');

/* ── the rules, directly ───────────────────────────────────── */
equal(sanitiseShareBody({ notes: ['  '] }), null, 'blank notes are not content');
equal(sanitiseShareBody({ docs: [handout], courseName: 'x' }).kind, 'course', 'kind defaults to a course');
equal(sanitiseShareBody({ docs: [handout], notes: [] }).docs[0].name, 'handout.pdf', 'a document survives sanitising');
equal(publicShare({ token: 't', notes: ['n'], docs: [] }, []).notes, ['n'], 'the public view keeps the notes');

await fs.rm(dir, { recursive: true, force: true });
console.log(`\n${checks} checks passed\n`);
