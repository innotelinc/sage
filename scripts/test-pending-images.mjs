/**
 * The budget for photos kept beside a queued turn.
 *
 * The interesting failure is not a photo going missing, it is the store growing
 * until the origin refuses every write the app makes. So the eviction rule is the
 * thing under test.
 */
import assert from 'node:assert/strict';
import { photoBytes, planEviction, MAX_TOTAL_BYTES, MAX_PHOTOS_PER_TURN } from '../public/pending-images.js';

let passed = 0;
function ok(name, fn) {
  fn();
  passed += 1;
  console.log(`  ok   ${name}`);
}

ok('a data URL is measured without being decoded', () => {
  const url = `data:image/jpeg;base64,${'A'.repeat(4000)}`;
  assert.equal(photoBytes(url), 3000);
  assert.equal(photoBytes(''), 0);
  assert.equal(photoBytes('not a data url'), 0);
});

ok('a store under budget drops nothing', () => {
  const plan = planEviction([
    { id: 'a', bytes: 100, at: 1 },
    { id: 'b', bytes: 100, at: 2 },
  ]);
  assert.deepEqual(plan.dropped, []);
  assert.equal(plan.bytes, 200);
});

ok('the oldest photo goes first, and only until it fits', () => {
  const plan = planEviction(
    [
      { id: 'new', bytes: 40, at: 3 },
      { id: 'old', bytes: 40, at: 1 },
      { id: 'mid', bytes: 40, at: 2 },
    ],
    80
  );
  assert.deepEqual(plan.dropped, ['old']);
  assert.equal(plan.bytes, 80);
});

ok('an overrun of every entry empties the store rather than keeping a broken shape', () => {
  const plan = planEviction([{ id: 'only', bytes: 10, at: 1 }], 5);
  assert.deepEqual(plan.dropped, ['only']);
  assert.equal(plan.bytes, 0);
});

ok('the cap and the per-turn limit are stated, not guessed', () => {
  assert.equal(MAX_TOTAL_BYTES, 6 * 1024 * 1024);
  assert.equal(MAX_PHOTOS_PER_TURN, 4);
});

console.log(`\n  ${passed} checks passed`);
