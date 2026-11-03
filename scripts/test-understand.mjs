/**
 * What you understand: the gathering behind the essay's base material.
 *
 * Pure module, so this runs in Node. The checks are the promises the Essay tab
 * makes: the lecture, the answers, the quizzes and the papers all reach the
 * draft; nothing is invented; an empty course says so instead of pretending.
 */
import assert from 'node:assert/strict';
import { gatherUnderstanding } from '../public/understand.js';

const course = {
  persona: { course: 'Biology 101' },
  memory: ['Osmosis moves water across a semi-permeable membrane.', 'Mitosis has four phases.'],
  session: { notes: ['Osmosis moves water across a semi-permeable membrane.', 'Turgor keeps the cell rigid.'] },
  history: {
    answers: [
      { question: 'What drives osmosis?', answer: 'A water potential gradient.', working: 'Water moves from high to low potential.' },
      { question: 'Why does the cell not burst?', answer: 'The wall resists the pressure.' },
    ],
    quizzes: [{ question: 'Which phase separates chromatids?', choice: 'B', answer: 'Anaphase' }],
    essays: [{ question: 'Discuss osmosis in plants', answer: 'Turgor pressure is the plant making use of osmosis.' }],
    papers: [
      {
        question: 'Mid-term paper',
        answer: '18/25',
        outOf: 25,
        awarded: 18,
        summary: 'Solid on the mechanism, thin on the plant example.',
        fixes: [{ prompt: 'Explain turgor', fix: 'Name the wall doing the resisting.' }],
      },
    ],
  },
};

const gathered = gatherUnderstanding(course);
console.log('  gathered', gathered.sections.length, 'sections,', gathered.text.length, 'chars');

assert.equal(gathered.empty, false, 'a course with material is not empty');
assert.deepEqual(
  gathered.sections.map((entry) => entry.label),
  ['From the lectures', 'What you answered', 'What the quizzes asked', 'What the papers said'],
  'every source reaches the understanding in a labelled section'
);
assert.equal(gathered.counts.notes, 3, 'a note repeated between memory and the session is counted once');
assert.equal(gathered.counts.answers, 2, 'both answers are counted');
assert.equal(gathered.counts.quizzes, 1, 'the quiz item is counted');
assert.equal(gathered.counts.papers, 1, 'the paper is counted');

assert.ok(gathered.text.includes('Biology 101'), 'the course is named');
assert.ok(gathered.text.includes('Osmosis moves water'), 'a lecture note is quoted');
assert.ok(gathered.text.includes('A water potential gradient'), 'an answer reaches the draft');
assert.ok(gathered.text.includes('Anaphase'), 'a quiz answer reaches the draft');
assert.ok(gathered.text.includes('18/25'), 'the paper mark reaches the draft');
assert.ok(gathered.text.includes('Name the wall doing the resisting'), 'the paper fix reaches the draft');
assert.ok(gathered.text.startsWith('Course: Biology 101'), 'the digest opens by naming the course');
assert.ok(/edit it into your own words/i.test(gathered.text), 'the section says whose words it wants');

assert.equal(gathered.voice.length, 3, 'two answers and one essay make the voice sample');
assert.ok(gathered.voice[0].includes('water potential gradient'), 'the voice sample quotes the user’s own answers');

const limited = gatherUnderstanding(course, { limit: 1 });
assert.equal(limited.sections.find((entry) => entry.label === 'What you answered').lines.length, 1, 'the limit is honoured');
assert.equal(limited.counts.answers, 2, 'the count still reports everything gathered');

const empty = gatherUnderstanding({ persona: { course: 'Empty 101' } });
assert.equal(empty.empty, true, 'an empty course reports itself empty');
assert.equal(empty.voice.length, 0, 'an empty course has no voice to match');
assert.ok(empty.text.includes('Empty 101'), 'the empty digest still names the course');
assert.equal(/^- /m.test(empty.text), false, 'an empty course invents no material');

assert.equal(gatherUnderstanding().empty, true, 'no argument at all is safe');
assert.equal(gatherUnderstanding({ memory: ['only a note'] }).empty, false, 'one note is enough to start');

console.log('  22 checks passed');
