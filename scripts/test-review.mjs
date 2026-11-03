/**
 * Spaced revision: where items come from, how they move out and reset, and what
 * the daily session claims.
 *
 * The clock is injected, so a day is a number rather than a wait.
 */
import assert from 'node:assert/strict';
import {
  INTERVALS,
  buildCandidates,
  dueItems,
  emptyReview,
  enqueue,
  ensureReview,
  grade,
  itemKey,
  session,
  stats,
  streakOf,
} from '../public/review.js';

const DAY = 86400000;
const T0 = Date.UTC(2026, 10, 3, 9, 0, 0);
const day = (n) => T0 + n * DAY;

assert.deepEqual(INTERVALS, [1, 3, 7, 21], 'the intervals are the ones the roadmap promised');

/* ── the queue's sources ───────────────────────────────────────── */
const history = {
  papers: [
    {
      question: 'Midterm rehearsal',
      fixes: [
        { prompt: 'What drives osmosis?', fix: 'Name the water potential gradient, not just "water moves".' },
        { prompt: 'Describe turgor.', fix: '' },
      ],
    },
  ],
  quizzes: [
    { question: 'Which phase of mitosis aligns chromosomes?', answer: 'Metaphase', why: 'alignment at the plate', confidence: 40 },
    { question: 'What is a mole?', answer: "Avogadro's number of particles", confidence: 92 },
    { question: 'Define entropy', answer: 'Disorder', confidence: 0.3 },
  ],
  answers: [
    { question: 'Why does ice float?', answer: 'Lower density than water', confidence: 25 },
    { question: 'What is pH?', answer: 'Negative log of proton activity', confidence: 99 },
  ],
};

const candidates = buildCandidates(history);
console.log('  candidates from the record:', candidates.length);
assert.equal(candidates.length, 4, 'one lost mark, two shaky quiz items and one shaky answer');
assert.ok(candidates.some((c) => c.source === 'paper' && c.prompt === 'What drives osmosis?'), 'a lost mark is an item');
assert.ok(candidates.every((c) => !c.prompt.startsWith('Describe turgor')), 'a question with no fix is not revision material');
assert.equal(
  candidates.some((c) => c.prompt === 'What is a mole?'),
  false,
  'a confident quiz item is not asked again'
);
assert.equal(
  candidates.some((c) => c.prompt === 'What is pH?'),
  false,
  'a confident answer is left alone'
);
assert.equal(buildCandidates({}).length, 0, 'an empty record invents nothing');
assert.equal(buildCandidates(null).length, 0, 'a missing record is not a crash');

const deduped = buildCandidates({
  papers: [{ question: 'P', fixes: [{ prompt: 'Define osmosis', fix: 'Water down its gradient.' }] }],
  quizzes: [{ question: 'define OSMOSIS!', answer: 'water', confidence: 10 }],
});
assert.equal(deduped.length, 1, 'the same question is one item');
assert.equal(deduped[0].source, 'paper', 'and the paper version wins, because it carries the fix');

/* ── the schedule ─────────────────────────────────────────────── */
let review = emptyReview();
assert.equal(stats(review, T0).due, 0, 'a new queue is empty');
assert.equal(stats(review, T0).streak, 0, 'and carries no streak');

let added = enqueue(review, candidates, T0);
review = added.review;
assert.equal(added.added, 4, 'the first fill takes everything');
assert.equal(enqueue(review, candidates, T0).added, 0, 'a second fill adds nothing twice');
assert.equal(dueItems(review, T0).length, 0, 'a new item is not due the moment it is found');
assert.equal(dueItems(review, day(1)).length, 4, 'it is due the next day');
assert.equal(stats(review, day(0.5)).due, 0, 'and not before');
assert.equal(stats(review, day(1)).minutes <= 5, true, 'the session fits in five minutes');
assert.equal(stats(review, T0).minutes, 1, 'an empty day still claims a minute, not zero');

const key = itemKey('What drives osmosis?');
let after = grade(review, key, true, day(1));
assert.equal(after.items[key].step, 1, 'a right answer moves one step out');
assert.equal(after.items[key].due, day(1) + INTERVALS[1] * DAY, 'to three days');
assert.equal(stats(after, day(1)).due, 3, 'the other three are still due');
assert.equal(dueItems(after, day(2)).some((item) => item.key === key), false, 'the answered item waits');

after = grade(after, key, true, day(4));
assert.equal(after.items[key].due, day(4) + INTERVALS[2] * DAY, 'then seven days');
after = grade(after, key, true, day(11));
assert.equal(after.items[key].due, day(11) + INTERVALS[3] * DAY, 'then twenty-one');
after = grade(after, key, true, day(32));
assert.equal(after.items[key].retired, true, 'four right answers and it is learnt');
assert.equal(
  dueItems(after, day(40)).some((item) => item.key === key),
  false,
  'a learnt item is never asked again'
);
assert.equal(stats(after, day(40)).retired, 1, 'and it is counted as learnt');
assert.equal(stats(after, day(40)).due, 3, 'the three it never asked still wait');
assert.equal(stats(after, day(40)).waiting, 0, 'and they are overdue rather than upcoming');

/* A miss returns it to the start, so tomorrow catches it. */
const missed = grade(after, itemKey('Define entropy'), false, day(1));
assert.equal(missed.items[itemKey('Define entropy')].step, 0, 'a miss resets the item');
assert.equal(missed.items[itemKey('Define entropy')].due, day(2), 'to tomorrow');
const reset = grade(grade(review, key, true, day(1)), key, false, day(4));
assert.equal(reset.items[key].step, 0, 'a miss after a success still resets it');
assert.equal(reset.items[key].due, day(5), 'and it comes back the next day');

/* ── the daily bookkeeping ────────────────────────────────────── */
assert.equal(stats(missed, day(1)).doneToday, 2, "a right answer and a miss on the same day are both counted");
assert.equal(stats(missed, day(1)).streak, 1, 'answering anything starts a streak');
const twoDays = grade(grade(review, key, true, day(1)), key, true, day(2));
assert.equal(stats(twoDays, day(2)).streak, 2, 'two days running is a streak of two');
assert.equal(stats(twoDays, day(3)).streak, 2, 'a day not yet answered does not break it');
assert.equal(stats(twoDays, day(5)).streak, 0, 'a gap does break it');
assert.equal(streakOf({}, T0), 0, 'no days, no streak');
assert.deepEqual(grade(review, 'nothing-here', true, T0).items, review.items, 'grading an unknown item changes nothing');

assert.equal(session(review, day(1), 2).length, 2, 'the session takes only what is due, up to the limit');
assert.equal(session(review, day(1), 12).length, 4, 'and everything due when the limit allows');

/* ── tolerant of junk on disk ─────────────────────────────────── */
assert.deepEqual(ensureReview(null), emptyReview(), 'a missing queue is an empty one');
assert.deepEqual(ensureReview({ items: null, days: 'no' }).items, {}, 'a broken queue is repaired, not trusted');
assert.equal(ensureReview({ streak: '4' }).streak, 4, 'a stored streak is read as a number');

console.log('  27 checks passed');
