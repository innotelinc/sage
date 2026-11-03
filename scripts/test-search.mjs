/**
 * One search across every course: the index, the ranking and the boundaries.
 *
 * Pure module, so this runs in Node: a phrase finds a note, an answer, an essay
 * and a document page, an entry missing one of the words is excluded, and every
 * hit carries the place it came from.
 */
import assert from 'node:assert/strict';
import { buildIndex, searchCourses } from '../public/search.js';

const courses = [
  {
    id: 'c1',
    persona: { course: 'Biology 101' },
    memory: ['Osmosis moves water across a semi-permeable membrane.', 'Mitosis has four phases.'],
    history: {
      answers: [{ question: 'What drives osmosis?', answer: 'A water potential gradient.', at: '2026-10-01T10:00:00Z' }],
      quizzes: [],
      essays: [{ question: 'Discuss osmosis in plants', answer: 'Turgor pressure follows from it.', at: '2026-10-05T10:00:00Z' }],
      sources: [],
    },
    foundation: [
      { name: 'lecture-3.pdf', text: 'Osmosis and diffusion', segments: [
        { locator: 'p.3', text: 'Osmosis is the movement of water down its potential gradient.' },
        { locator: 'p.4', text: 'Turgor pressure keeps the cell rigid.' },
      ] },
      { name: 'handout.txt', text: 'Nothing about water here.' },
    ],
  },
  {
    id: 'c2',
    persona: { course: 'Thermodynamics' },
    memory: ['Entropy always increases in a closed system.'],
    history: { answers: [], quizzes: [], essays: [], sources: [] },
    foundation: [],
  },
];

const index = buildIndex(courses);
console.log('  indexed', index.length, 'entries');
assert.ok(index.length >= 8, 'every note, record and page is indexed');
assert.equal(index.find((entry) => entry.locator === 'p.3')?.course, 'Biology 101', 'a page keeps its course');

const hits = searchCourses(courses, 'osmosis');
console.log('  "osmosis" found', hits.length);
assert.equal(hits.length, 4, 'the phrase is found in the note, the answer, the essay and the page');
assert.ok(hits.some((hit) => hit.course === 'Biology 101' && hit.kind === 'document'), 'a document page is a hit');
assert.ok(hits.some((hit) => hit.kind === 'note'), 'a note is a hit');
assert.ok(hits.every((hit) => hit.tab && hit.tabLabel), 'every hit names where it opens');

assert.equal(
  searchCourses(courses, 'water potential').some((hit) => hit.course === 'Thermodynamics'),
  false,
  'a course with neither word is not matched'
);
assert.equal(
  searchCourses(courses, 'osmosis turgor').map((hit) => hit.kind).join(','),
  'essay',
  'only the essay carries both words'
);
assert.equal(
  searchCourses(courses, 'osmosis rigid').length,
  0,
  'no entry carries both words, so nothing is invented'
);
assert.equal(
  searchCourses(courses, 'turgor').map((hit) => hit.locator).filter(Boolean).join(','),
  'p.4',
  'the word only one page carries finds that page, and the essay carries it too'
);
assert.equal(searchCourses(courses, 'osmosis banana').length, 0, 'a stray word returns nothing');
assert.equal(searchCourses(courses, 'e').length, 0, 'a single letter is not a search');
assert.equal(searchCourses(courses, 'osmosis', 2).length, 2, 'the limit is honoured');

const ranked = searchCourses(courses, 'osmosis');
assert.ok(ranked[0].score >= ranked[ranked.length - 1].score, 'hits come back best first');
assert.ok(ranked[0].snippet.toLowerCase().includes('osmosis'), 'the snippet holds the match');

console.log('  15 checks passed');
