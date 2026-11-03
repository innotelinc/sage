/**
 * The device's copy of a course's documents: hashes, the budget, and what
 * reconciliation does when the server's copy moves. Pure rules only — the
 * IndexedDB side is exercised by hand in the browser, the same way the photo
 * store is.
 */
import assert from 'node:assert/strict';
import {
  CACHE_MAX_CHARS,
  cacheNote,
  cacheOnly,
  describeCache,
  hashDoc,
  hashText,
  planCache,
  reconcileDocs,
  stampDoc,
} from '../public/library.js';

let checks = 0;
function check(condition, message) {
  assert.ok(condition, message);
  checks += 1;
}
function equal(actual, expected, message) {
  assert.deepEqual(actual, expected, message);
  checks += 1;
}

const doc = (name, text, extra = {}) => ({ name, kind: 'pdf', text, ...extra });
const rows = (count, chars, at) =>
  Array.from({ length: count }, (_, index) => ({ id: `d${index}`, chars, at: at + index }));

/* ── hashing ───────────────────────────────────────────────── */
check(hashText('osmosis') === hashText('osmosis'), 'the same text hashes the same');
check(hashText('osmosis').length === 8, 'a hash is eight characters');
check(/^[0-9a-f]{8}$/.test(hashText('osmosis')), 'and it is hex');
check(hashText('osmosis') !== hashText('Osmosis'), 'case is part of the document');
check(
  hashDoc(doc('handout.pdf', 'water')) !== hashDoc(doc('handout.pdf', 'water ')),
  'a changed character changes the hash'
);
check(
  hashDoc(doc('a.pdf', 'same words')) !== hashDoc(doc('b.pdf', 'same words')),
  'the name is part of the identity'
);
check(hashDoc(doc('a.pdf', 'same words')) === hashDoc(doc('a.pdf', 'same words')), 'and nothing else is');

/* ── stamping ──────────────────────────────────────────────── */
const stamp = stampDoc(
  doc('handout.pdf', 'Osmosis is water.', {
    segments: [{ locator: 'p.2', text: 'Osmosis is water.' }, { locator: 'p.3', text: '  ' }],
    on: false,
  }),
  1000
);
equal(stamp.hash, hashDoc(doc('handout.pdf', 'Osmosis is water.')), 'the stamp carries the hash');
equal(stamp.chars, 17, 'characters are counted');
equal(stamp.cachedAt, 1000, 'and when it was cached');
equal(stamp.segments.length, 1, 'an empty segment is dropped');
equal(stamp.on, false, 'the use flag survives');
check(stampDoc(doc('x', 'y')).cachedAt > 0, 'the clock is optional');

/* ── the budget ────────────────────────────────────────────── */
let plan = planCache(rows(3, 100, 1));
equal(plan.dropped, [], 'under budget nothing is dropped');
equal(plan.chars, 300, 'and the size is reported');
equal(plan.count, 3, 'with everything kept');

plan = planCache(rows(4, 300, 1), { maxChars: 900 });
check(plan.chars <= 900, 'the budget is honoured');
equal(plan.dropped, ['d0'], 'the least recently used goes first');

plan = planCache(rows(5, 1, 1), { maxDocs: 3 });
equal(plan.count, 3, 'the count cap is honoured');
equal(plan.dropped, ['d0', 'd1'], 'documents beyond the cap go oldest first');

plan = planCache([{ id: 'one', chars: CACHE_MAX_CHARS * 2, at: 1 }]);
equal(plan.count, 1, 'the only document survives even when it alone is over budget');

/* ── reconciling with the course ───────────────────────────── */
const cached = [stampDoc(doc('handout.pdf', 'v1'), 1), stampDoc(doc('old.pdf', 'gone'), 2)];

let rec = reconcileDocs(cached, [doc('handout.pdf', 'v1')]);
equal(rec.keep, ['handout.pdf'], 'unchanged text is kept');
equal(rec.drop, ['old.pdf'], 'a document the course no longer has leaves the device');
equal(rec.added, [], 'and nothing is called new');

rec = reconcileDocs(cached, [doc('handout.pdf', 'v2'), doc('new.pdf', 'fresh')]);
equal(rec.refresh.map((item) => item.name), ['handout.pdf'], 'changed text is noticed');
equal(rec.added, ['new.pdf'], 'a new document is cached, not reconciled');
equal(rec.refresh[0].to, hashDoc(doc('handout.pdf', 'v2')), 'and says what it changed to');

rec = reconcileDocs([{ name: 'hand.pdf', text: 'x', hash: '' }], [doc('hand.pdf', 'x')]);
equal(rec.refresh.map((item) => item.name), ['hand.pdf'], 'an unstamped copy is refreshed rather than trusted');

/* ── what only this device holds ───────────────────────────── */
equal(cacheOnly([{ name: 'a', text: 'x' }], []).map((row) => row.name), ['a'], 'a doc the course lost is still here');
equal(cacheOnly([{ name: 'a', text: 'x' }], [{ name: 'a' }]), [], 'a doc the course holds is not a cache extra');
equal(cacheOnly([{ name: 'a', text: 'x', on: false }], []), [], 'a doc switched off is not grounding material');

/* ── wording ───────────────────────────────────────────────── */
check(/No copy on this device/.test(describeCache([])), 'an empty cache says so');
check(/1 document cached on this device/.test(describeCache([{ name: 'a', text: 'x'.repeat(1200) }])), 'and a full one counts');
check(/1,200 characters/.test(describeCache([{ name: 'a', text: 'x'.repeat(1200) }])), 'with its size');
equal(cacheNote([]), '', 'no copy, no note');
check(/handout\.pdf/.test(cacheNote(['handout.pdf'])), 'the note names the document');
equal(
  cacheNote(['a.pdf', 'a.pdf']),
  'from the copy cached on this device (a.pdf)',
  'and names it once'
);

console.log(`\n${checks} checks passed\n`);
