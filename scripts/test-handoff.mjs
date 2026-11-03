/**
 * Handoff between devices: who holds the microphone, whose notes are newer, and
 * when to offer to continue somewhere else.
 */
import assert from 'node:assert/strict';
import {
  MAX_NOTES,
  TTL_MS,
  ageLabel,
  captureConflict,
  describe,
  freshness,
  isLive,
  mergeNotes,
  notesToAdopt,
  shouldOffer,
} from '../public/handoff.js';

const T0 = Date.UTC(2026, 10, 3, 9, 0, 0);
const iso = (ms) => new Date(ms).toISOString();

const phone = {
  device: 'phone-1',
  label: 'iPhone',
  courseName: 'BIO 201',
  capturing: true,
  at: iso(T0),
  notes: [
    { text: 'Osmosis moves water down its potential gradient.', at: iso(T0 - 60000) },
    { text: 'Turgor pressure keeps the cell rigid.', at: iso(T0 - 30000) },
  ],
};

console.log('  record from', phone.label, 'with', phone.notes.length, 'notes');

/* ── freshness ────────────────────────────────────────────────── */
assert.equal(isLive(phone, T0 + 1000), true, 'a heartbeat a second ago is live');
assert.equal(isLive(phone, T0 + TTL_MS - 1), true, 'a record is live right up to the window');
assert.equal(isLive(phone, T0 + TTL_MS + 1), false, 'past four hours a session is over');
assert.equal(isLive(null, T0), false, 'no record is not a live session');
assert.equal(isLive({ at: 'not a date' }, T0), false, 'an unparseable time is not live');
assert.equal(freshness(phone, T0 + 90000), 90000, 'the age is the gap between the heartbeat and now');
assert.equal(freshness(phone, T0 - 1000), -1, 'a heartbeat from the future is not trusted');
assert.equal(ageLabel(30000), 'just now', 'half a minute reads as just now');
assert.equal(ageLabel(300000), '5 min ago', 'minutes read as minutes');
assert.equal(ageLabel(7200000), '2 h ago', 'hours read as hours');

/* ── the offer ────────────────────────────────────────────────── */
assert.equal(shouldOffer(phone, 'laptop-9', T0 + 1000), true, 'another device with notes is an offer');
assert.equal(shouldOffer(phone, 'phone-1', T0 + 1000), false, 'this device is never offered its own session');
assert.equal(shouldOffer({ ...phone, notes: [] }, 'laptop-9', T0 + 1000), false, 'nothing to carry is not an offer');
assert.equal(shouldOffer(phone, 'laptop-9', T0 + TTL_MS + 1), false, 'a stale session is not offered');

const laptopNotes = [
  { text: 'Turgor pressure keeps the cell rigid.', at: iso(T0 - 30000) },
  { text: 'Water potential is measured in MPa.', at: iso(T0 - 10000) },
];
assert.equal(notesToAdopt(laptopNotes, phone).length, 1, 'only the note the laptop lacks is adopted');
assert.equal(notesToAdopt(laptopNotes, phone)[0].text, 'Osmosis moves water down its potential gradient.', 'and it is the right note');
assert.deepEqual(notesToAdopt([], phone).length, 2, 'a fresh device takes everything');

const merged = mergeNotes(laptopNotes, phone.notes);
assert.equal(merged.length, 3, 'merging keeps both sets without duplicates');
assert.equal(merged[0].text, 'Osmosis moves water down its potential gradient.', 'and orders them oldest first');
assert.equal(merged[merged.length - 1].text, 'Water potential is measured in MPa.', 'newest last');
assert.equal(mergeNotes([], []).length, 0, 'merging nothing invents nothing');
assert.equal(mergeNotes([{ text: '   ' }], []).length, 0, 'a blank note is not a note');
assert.equal(mergeNotes(null, null).length, 0, 'a missing list is not a crash');
const many = Array.from({ length: 80 }, (_, i) => ({ text: `note ${i}`, at: iso(T0 + i) }));
assert.equal(mergeNotes(many, []).length, MAX_NOTES, 'the merged list is capped');
assert.equal(mergeNotes(many, [])[MAX_NOTES - 1].text, 'note 79', 'keeping the newest');

/* ── the microphone ───────────────────────────────────────────── */
assert.equal(captureConflict(phone, 'laptop-9', T0 + 1000), true, 'a capturing device conflicts with another');
assert.equal(captureConflict(phone, 'phone-1', T0 + 1000), false, 'a device never conflicts with itself');
assert.equal(captureConflict({ ...phone, capturing: false }, 'laptop-9', T0 + 1000), false, 'an idle session holds nothing');
assert.equal(captureConflict(phone, 'laptop-9', T0 + TTL_MS + 1), false, 'a dead session holds nothing');
assert.equal(captureConflict(null, 'laptop-9', T0), false, 'no record, no conflict');

/* ── the sentence ─────────────────────────────────────────────── */
const line = describe(phone, laptopNotes, T0 + 120000);
assert.equal(line.live, true, 'the banner describes a live session');
assert.equal(line.adopt, 1, 'and counts only what is missing here');
assert.ok(line.text.includes('iPhone'), 'naming the other device');
assert.ok(line.text.includes('BIO 201'), 'and the course');
assert.ok(line.text.includes('2 notes'), 'and how much was written');
const stale = describe(phone, laptopNotes, T0 + TTL_MS + 1);
assert.equal(stale.live, false, 'a record past the window is not a session any more');
assert.equal(stale.age, 0, 'and carries no age');

console.log('  26 checks passed');
