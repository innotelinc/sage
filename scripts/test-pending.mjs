/**
 * The on-device queue: what waits, what is dropped, and what it says.
 */
import assert from 'node:assert/strict';
import { enqueue, queued, forget, pendingLabel } from '../public/pending.js';

let passed = 0;
function ok(name, fn) {
  fn();
  passed += 1;
  console.log(`  ok   ${name}`);
}

ok('a turn is kept with what it needs to be replayed', () => {
  const list = enqueue([], { mode: 'answer', text: 'What is osmosis?', maxTokens: 900, tab: 'answer' });
  assert.equal(list.length, 1);
  assert.equal(list[0].mode, 'answer');
  assert.equal(list[0].maxTokens, 900);
  assert.equal(list[0].tab, 'answer');
  assert.ok(list[0].id.startsWith('p'));
});

ok('an empty turn is not queued', () => {
  assert.deepEqual(enqueue([], { mode: 'answer', text: '   ' }), []);
  assert.deepEqual(enqueue([], { mode: 'answer', text: '' }), []);
});

ok('a photographed turn is kept even with no words', () => {
  const list = enqueue([], { mode: 'answer', text: '', images: 2 });
  assert.equal(list.length, 1);
  assert.equal(list[0].images, 2);
  assert.equal(list[0].text, '');
});

ok('the image count is clamped to what the composer allows', () => {
  assert.equal(enqueue([], { text: 'see photo', images: 99 })[0].images, 4);
  assert.equal(enqueue([], { text: 'no photo' })[0].images, 0);
});

ok('the newest turns win when the queue is full', () => {
  let list = [];
  for (let i = 1; i <= 15; i += 1) list = enqueue(list, { text: `question ${i}` }, 12);
  assert.equal(list.length, 12);
  assert.equal(list[0].text, 'question 4', 'oldest dropped');
  assert.equal(list[11].text, 'question 15', 'newest kept');
});

ok('a memory of the queue survives junk', () => {
  const list = queued([null, { text: 'real' }, { text: '' }, { nope: true }]);
  assert.equal(list.length, 1);
  assert.equal(list[0].text, 'real');
});

ok('replaying one leaves the rest', () => {
  const list = enqueue(enqueue([], { text: 'a' }), { text: 'b' });
  const trimmed = forget(list, list[0].id);
  assert.equal(trimmed.length, 1);
  assert.equal(trimmed[0].text, 'b');
});

ok('the label is honest about the count', () => {
  assert.equal(pendingLabel([]), '');
  assert.equal(pendingLabel(enqueue([], { text: 'a' })), '1 turn waiting for the connection');
  assert.equal(pendingLabel(enqueue(enqueue([], { text: 'a' }), { text: 'b' })), '2 turns waiting for the connection');
});

console.log(`\n${passed} passed\n`);
