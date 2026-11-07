/**
 * The scorer behind 5.1 is itself a piece of logic that can be wrong, so it is
 * tested before it is trusted: a right citation passes, a page the material does
 * not have fails, and a question the material cannot answer is only passed by a
 * reply that admits it. The last check runs one golden case through the real chat
 * handler with the stub model, so the wiring is covered and not just the maths.
 */
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { BASELINE_FILE, loadGolden, runCase, scoreCase, summarise, sourcesOf } from './golden.mjs';

let passed = 0;
const failures = [];

async function test(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`  ok   ${name}`);
  } catch (error) {
    failures.push({ name, error });
    console.log(`  FAIL ${name}\n       ${error.message}`);
  }
}

const golden = {
  course: 'stub',
  documents: [
    {
      name: 'lecture.pdf',
      kind: 'pdf',
      segments: [
        { locator: 'p.1', text: 'Osmosis moves water across a membrane.' },
        { locator: 'p.2', text: 'Turgor pressure stops the plant cell bursting.' },
      ],
    },
  ],
  cases: [],
};

const answerable = { id: 'a', kind: 'answer', expect: { citations: [{ name: 'lecture.pdf', locator: 'p.1' }] } };
const unanswerable = { id: 'b', kind: 'refusal', expect: { refuse: true } };

console.log('\nmeasured grounding');

await test('the right page passes', () => {
  const scored = scoreCase(golden, answerable, {
    reply: 'Water crosses [lecture.pdf p.1].',
    citations: [{ name: 'lecture.pdf', locator: 'p.1' }],
  });
  assert.equal(scored.ok, true);
  assert.equal(scored.invented, 0);
});

await test('a page the material does not have is not a citation', () => {
  const scored = scoreCase(golden, answerable, {
    reply: 'It is on [lecture.pdf p.9].',
    citations: [{ name: 'lecture.pdf', locator: 'p.9' }],
  });
  assert.equal(scored.ok, false);
  assert.equal(scored.invented, 1);
  assert.match(scored.detail, /not a page it was given/);
});

await test('the wrong real page fails even though it exists', () => {
  const scored = scoreCase(golden, answerable, {
    reply: 'See [lecture.pdf p.2].',
    citations: [{ name: 'lecture.pdf', locator: 'p.2' }],
  });
  assert.equal(scored.ok, false);
  assert.equal(scored.invented, 0);
  assert.match(scored.detail, /instead of/);
});

await test('answering with no citation at all fails', () => {
  const scored = scoreCase(golden, answerable, { reply: 'Water moves.', citations: [] });
  assert.equal(scored.ok, false);
  assert.match(scored.detail, /without citing/);
});

await test('an admitted gap passes, and inventing one does not', () => {
  const honest = scoreCase(golden, unanswerable, {
    reply: 'That is not in the material supplied, so I cannot say.',
    citations: [],
  });
  assert.equal(honest.ok, true);
  const invented = scoreCase(golden, unanswerable, {
    reply: 'Page 1 covers it.',
    citations: [{ name: 'lecture.pdf', locator: 'p.1' }],
  });
  assert.equal(invented.ok, false);
});

await test('totals are ratios over the kind of case, not over all cases', () => {
  const totals = summarise([
    { kind: 'answer', ok: true, cited: 1, invented: 0 },
    { kind: 'answer', ok: false, cited: 0, invented: 0 },
    { kind: 'refusal', ok: true, cited: 0, invented: 0 },
  ]);
  assert.equal(totals.grounding, 0.5);
  assert.equal(totals.citation, 1);
  assert.equal(totals.refusal, 1);
  assert.equal(totals.cases, 3);
});

await test('every course set declares what a right answer is', () => {
  const sets = loadGolden();
  assert.ok(sets.length >= 2, `expected more than one course, got ${sets.length}`);
  for (const { golden: set } of sets) {
    assert.ok(set.cases.length >= 3, `${set.course} needs at least three cases`);
    assert.ok(set.cases.some((c) => c.expect?.refuse), `${set.course} needs a question the material cannot answer`);
    assert.ok(sourcesOf(set)[0].segments.length, `${set.course} needs a paged document`);
  }
});

await test('a recorded baseline exists for the stub run', () => {
  assert.ok(existsSync(BASELINE_FILE), 'run node scripts/golden.mjs --update');
  const baseline = JSON.parse(readFileSync(BASELINE_FILE, 'utf8'));
  for (const metric of ['grounding', 'citation', 'refusal']) {
    assert.equal(typeof baseline[metric], 'number', `${metric} is missing from the baseline`);
  }
});

await test('one golden case runs through the real chat handler', async () => {
  const { golden: set } = loadGolden()[0];
  const kase = set.cases.find((c) => !c.expect?.refuse);
  const body = await runCase(set, kase, { scripted: kase.reply });
  assert.ok(body.reply, 'the handler returned no reply');
  const scored = scoreCase(set, kase, body);
  assert.equal(scored.ok, true, scored.detail);
});

if (failures.length) {
  console.log(`\n${failures.length} failed, ${passed} passed\n`);
  process.exit(1);
}
console.log(`\n${passed} passed\n`);
