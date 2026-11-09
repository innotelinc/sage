/**
 * Milestone 6.0: the reader keeps its anchors and its edits apart.
 *
 * Only the pure builder is exercised here — no server, no clock — so each case
 * pins the behaviour the reader promises rather than the shape of a response.
 */
import { buildReader, clockSeconds, findSections, kindOf, tokenise } from '../src/reader.mjs';

let passed = 0;
const failed = [];

function check(name, fn) {
  try {
    fn();
    passed += 1;
  } catch (error) {
    failed.push(`${name}: ${error.message}`);
  }
}

function eq(actual, expected, what) {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a !== b) throw new Error(`${what} — expected ${b}, got ${a}`);
}

function ok(value, what) {
  if (!value) throw new Error(what);
}

const NOW = new Date('2026-11-09T10:00:00.000Z');
const DAY = 24 * 60 * 60 * 1000;
const HOUR = 60 * 60 * 1000;

const docs = [
  { name: 'week-3.pdf', segments: [{ locator: 'p.4', text: 'Osmosis is the movement of water.' }] },
  { name: 'handout.md', segments: [] },
];

function course(notes, extra = {}) {
  return {
    id: 'c1',
    name: 'Cell Biology',
    foundation: docs,
    session: { notes, transcript: [] },
    ...extra,
  };
}

check('a captured note becomes one section', () => {
  const reader = buildReader({ course: course([{ text: 'Osmosis moves water across a membrane.', at: 1000 }]), now: NOW });
  eq(reader.sections.length, 1, 'sections');
  eq(reader.sections[0].blocks.length, 1, 'blocks');
  eq(reader.sections[0].title, 'Lecture 1', 'title');
  eq(reader.builtAt, NOW.toISOString(), 'builtAt');
});

check('a gap of more than forty-five minutes starts a new lecture', () => {
  const reader = buildReader({
    course: course([
      { text: 'first lecture point', at: 1000 },
      { text: 'later in the day', at: 1000 + 2 * HOUR },
      { text: 'the same lecture again', at: 1000 + 2 * HOUR + 60000 },
    ]),
    now: NOW,
  });
  eq(reader.sections.length, 2, 'sections');
  eq(reader.sections[0].blocks.length, 1, 'first section');
  eq(reader.sections[1].blocks.length, 2, 'second section');
});

check('a lecture clock that goes backwards starts a new lecture', () => {
  const reader = buildReader({
    course: course([
      { text: 'the end of the first recording [lecture 48:10]', at: 1000 },
      { text: 'a second recording starts [lecture 0:20]', at: 1000 + 60000 },
    ]),
    now: NOW,
  });
  eq(reader.sections.length, 2, 'sections');
});

check('blocks keep the order they were taught in, whatever kind they are', () => {
  const reader = buildReader({
    course: course([
      {
        text: [
          '- Osmosis is defined as the movement of water across a membrane.',
          '- EXAM: they always ask for the direction of flow.',
          '- For example, a red blood cell in pure water swells [week-3.pdf p.4]',
        ].join('\n'),
        at: 5000,
      },
    ]),
    now: NOW,
  });
  eq(
    reader.sections[0].blocks.map((block) => block.kind),
    ['definition', 'hint', 'example'],
    'kinds in capture order'
  );
});

check('a definition, an example and a hint are told apart', () => {
  eq(kindOf('Osmosis is defined as the movement of water.'), 'definition', 'definition');
  eq(kindOf('A cell is a unit bounded by a membrane.'), 'definition', 'definition article form');
  eq(kindOf('For example, a red blood cell swells.'), 'example', 'example');
  eq(kindOf('EXAM: state the direction of flow.'), 'hint', 'hint');
  eq(kindOf('We covered three membrane proteins.'), 'outline', 'outline');
});

check('a page anchor opens the document the course actually holds', () => {
  const reader = buildReader({
    course: course([{ text: 'Water crosses the membrane [week-3.pdf p.4]', at: 1000 }]),
    now: NOW,
  });
  eq(reader.sections[0].blocks[0].anchors, [{ kind: 'page', doc: 'week-3.pdf', locator: 'p.4' }], 'anchor');
  eq(reader.counts.pages, 1, 'page count');
});

check('an anchor naming a document the course does not hold is dropped', () => {
  const reader = buildReader({
    course: course([{ text: 'A claim from nowhere [missing.pdf p.9]', at: 1000 }]),
    now: NOW,
  });
  const anchors = reader.sections[0].blocks[0].anchors;
  eq(anchors.length, 1, 'fallback anchor');
  eq(anchors[0].kind, 'note', 'falls back to the note');
});

check('a lecture moment becomes a timestamp the recording can be played from', () => {
  const reader = buildReader({
    course: course([{ text: 'This is where it clicked [lecture 1:02:03]', at: 1000 }]),
    now: NOW,
  });
  const anchor = reader.sections[0].blocks[0].anchors.find((item) => item.kind === 'moment');
  eq(anchor, { kind: 'moment', clock: '1:02:03', at: 3723 }, 'moment');
  eq(clockSeconds('12:30'), 750, 'mm:ss');
  eq(clockSeconds('nope'), null, 'garbage');
});

check('every block carries at least one anchor', () => {
  const reader = buildReader({
    course: course([
      { text: 'a claim with no citation at all', at: 86400000 },
      { text: 'another [handout.md p.2]', at: 86401000 },
    ]),
    now: NOW,
  });
  for (const section of reader.sections) {
    for (const block of section.blocks) ok(block.anchors.length > 0, `block ${block.id} has no anchor`);
  }
  eq(reader.counts.notes, 1, 'one note anchor');
});

check('an edit is kept beside the capture, not over it', () => {
  const notes = [{ text: 'the captured sentence [week-3.pdf p.4]', at: 1000 }];
  const first = buildReader({ course: course(notes), now: NOW });
  const blockId = first.sections[0].blocks[0].id;
  const edited = buildReader({
    course: course(notes),
    edits: [{ blockId, text: 'my own wording', at: 2000 }],
    now: NOW,
  });
  eq(edited.sections[0].blocks[0].text, 'the captured sentence [week-3.pdf p.4]', 'capture untouched');
  eq(edited.sections[0].blocks[0].edited.text, 'my own wording', 'edit kept apart');
  eq(edited.counts.edited, 1, 'edited count');
  // Rebuilding without the edit returns the capture, which is what makes it undoable.
  const plain = buildReader({ course: course(notes), now: NOW });
  eq(plain.sections[0].blocks[0].edited, null, 'edit removed');
});

check('the newest edit for a block wins', () => {
  const notes = [{ text: 'original', at: 1000 }];
  const blockId = buildReader({ course: course(notes), now: NOW }).sections[0].blocks[0].id;
  const reader = buildReader({
    course: course(notes),
    edits: [
      { blockId, text: 'older', at: 100 },
      { blockId, text: 'newer', at: 900 },
    ],
    now: NOW,
  });
  eq(reader.sections[0].blocks[0].edited.text, 'newer', 'newest edit');
});

check('block ids stay the same across rebuilds, so an edit survives one', () => {
  const notes = [
    { text: 'first point', at: 1000 },
    { text: 'second point', at: 2000 },
  ];
  const a = buildReader({ course: course(notes), now: NOW });
  const b = buildReader({ course: course(notes), now: new Date('2027-01-01T00:00:00.000Z') });
  eq(
    a.sections[0].blocks.map((block) => block.id),
    b.sections[0].blocks.map((block) => block.id),
    'ids'
  );
});

check('an empty course says so instead of inventing a lecture', () => {
  const reader = buildReader({ course: course([]), now: NOW });
  eq(reader.sections.length, 0, 'sections');
  ok(reader.note.includes('Nothing captured yet'), 'explains the empty state');
});

check('a course with no foundation keeps the moment and the note, not a page', () => {
  const reader = buildReader({
    course: { id: 'c2', name: 'No material', foundation: [], session: { notes: [{ text: 'a point [lecture 3:05]', at: 1000 }] } },
    now: NOW,
  });
  eq(reader.sections[0].blocks[0].anchors.map((anchor) => anchor.kind), ['moment'], 'moment only');
});

check('a question finds the section that answers it, with the page it came from', () => {
  const reader = buildReader({
    course: course([
      { text: 'The cell cycle has four phases [week-3.pdf p.4]', at: 1000 },
      { text: 'Osmosis is defined as the movement of water across a membrane [week-3.pdf p.4]', at: 1000 + 3 * HOUR },
    ]),
    now: NOW,
  });
  const found = findSections(reader.sections, 'where did we do osmosis?');
  eq(found.matches.length, 1, 'one match');
  eq(found.matches[0].title, 'Lecture 2', 'the osmosis lecture');
  eq(found.matches[0].anchors, [{ kind: 'page', doc: 'week-3.pdf', locator: 'p.4' }], 'the page');
  eq(found.spans, false, 'one lecture');
});

check('a question that spans two lectures says so and keeps both', () => {
  const reader = buildReader({
    course: course([
      { text: 'Osmosis and diffusion are both passive transport [week-3.pdf p.4]', at: 1000 },
      { text: 'Osmosis in a plant cell causes turgor [week-3.pdf p.4]', at: 1000 + 3 * HOUR },
    ]),
    now: NOW,
  });
  const found = findSections(reader.sections, 'osmosis');
  eq(found.matches.length, 2, 'two matches');
  eq(found.spans, true, 'spans lectures');
});

check('a question nothing covers matches nothing rather than the nearest lecture', () => {
  const reader = buildReader({ course: course([{ text: 'the cell cycle has four phases', at: 1000 }]), now: NOW });
  eq(findSections(reader.sections, 'what is the Krebs cycle').matches, [], 'no match');
});

check('stop words alone are not a question', () => {
  eq(tokenise('where did we do it'), [], 'stopwords');
  const reader = buildReader({ course: course([{ text: 'the cell cycle', at: 1000 }]), now: NOW });
  eq(findSections(reader.sections, 'where did we do it').matches, [], 'nothing to match on');
});

console.log(`\n${passed} passed`);
if (failed.length) {
  console.error(`\n${failed.length} failed:\n${failed.join('\n')}`);
  process.exit(1);
}
