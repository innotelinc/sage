/**
 * The meeting point for a screen capture that outlives the app.
 *
 * The extension and the app never share memory or a secret: the app opens a
 * session for its device, the extension posts frames without one, and the app
 * drains the notes. These are the rules that make that safe to leave running.
 */
import assert from 'node:assert/strict';
import { openSession, closeSession, accepts, recordFrame, readNotes } from '../src/broadcast.mjs';

let passed = 0;
function ok(name, fn) {
  fn();
  passed += 1;
  console.log(`  ok   ${name}`);
}

const DEVICE = 'device-a';

ok('a device with no session cannot post frames', () => {
  assert.equal(accepts(DEVICE), false);
  assert.equal(accepts(''), false);
});

ok('opening a session is what makes the device acceptable', () => {
  const state = openSession(DEVICE);
  assert.equal(state.open, true);
  assert.equal(accepts(DEVICE), true);
});

ok('a frame is counted and its note held for the app', () => {
  const state = recordFrame(DEVICE, 'EXAM: mitochondria make ATP');
  assert.equal(state.frames, 1);
  assert.equal(state.running, true);
  assert.equal(state.notes.length, 0, 'the note is handed out by readNotes, not by every write');
});

ok('reading drains the notes exactly once', () => {
  const first = readNotes(DEVICE);
  assert.equal(first.notes.length, 1);
  assert.match(first.notes[0].text, /mitochondria/);
  const second = readNotes(DEVICE);
  assert.equal(second.notes.length, 0, 'a note returned twice would multiply itself in the feed');
});

ok('a frame that produced no note still advances the session', () => {
  const state = recordFrame(DEVICE, '');
  assert.equal(state.frames, 2);
});

ok('closing stops the frames but keeps the count for the app to read', () => {
  closeSession(DEVICE);
  assert.equal(accepts(DEVICE), false);
  const state = readNotes(DEVICE);
  assert.equal(state.open, false);
  assert.equal(state.frames, 2);
});

ok('one device cannot read another device its notes', () => {
  openSession('device-b');
  recordFrame('device-b', 'b only');
  assert.equal(readNotes(DEVICE).notes.length, 0);
  assert.equal(readNotes('device-b').notes[0].text, 'b only');
  closeSession('device-b');
});

ok('an empty device is not a session', () => {
  assert.equal(openSession(''), null);
});

console.log(`\n  ${passed} checks passed`);
