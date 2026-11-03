/**
 * Setting and marking a paper, end to end on the server with the model stubbed.
 *
 * The paper must not carry its own answers, and the marking must come back as marks
 * per question rather than a paragraph of encouragement.
 */
import assert from 'node:assert/strict';
import { handleRequest } from '../src/app.mjs';

let prompt = '';
const realFetch = globalThis.fetch;
const PAPER = '{"title":"Osmosis","questions":[{"n":1,"marks":5,"prompt":"Explain osmosis."}]}';
const MARKED = '{"items":[{"n":1,"awarded":3,"outOf":5,"fix":"name the membrane"}],"awarded":3,"outOf":5,"summary":"Solid."}';

globalThis.fetch = async (url, init = {}) => {
  const target = String(url);
  if (target.endsWith('/models')) {
    return new Response(JSON.stringify({ data: [{ id: 'stub/chat' }] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }
  const body = JSON.parse(init.body || '{}');
  prompt = (body.messages || []).map((m) => (typeof m.content === 'string' ? m.content : '')).join(' ');
  const content = prompt.includes('marking a paper') ? MARKED : PAPER;
  return new Response(
    JSON.stringify({ choices: [{ message: { content } }], usage: { total_tokens: 10 } }),
    { status: 200, headers: { 'content-type': 'application/json' } }
  );
};

const runtime = { accessRequired: () => false, accessAccepted: () => false };
const post = (mode, text) =>
  handleRequest(
    new Request('http://localhost/api/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ mode, text, sources: [{ name: 'lecture-3.pdf', text: 'Osmosis.' }] }),
    }),
    { AI_API_KEY: 'stub', AI_CHAT_MODEL: 'stub/chat' },
    runtime
  );

const paper = await post('paper', 'Set a paper on osmosis.');
const paperBody = await paper.json();
console.log('  paper status', paper.status);
assert.equal(paper.status, 200);
assert.equal(paperBody.structured?.questions?.length, 1, 'the paper comes back as structured questions');
assert.equal(paperBody.structured.questions[0].marks, 5);
assert.ok(
  prompt.includes('no answers, hints or marking notes'),
  'the model is told to keep answers off the paper'
);

const marked = await post('mark', 'Question 1: water moves across a membrane.');
const markedBody = await marked.json();
assert.equal(marked.status, 200);
assert.deepEqual(
  markedBody.structured?.items?.map((item) => [item.n, item.awarded, item.outOf]),
  [[1, 3, 5]],
  'marking comes back per question'
);

globalThis.fetch = realFetch;
console.log('  4 checks passed');
