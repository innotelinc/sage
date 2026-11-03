/**
 * A grounded turn, end to end on the server: the documents reach the prompt and
 * the reply says which ones it used. The model is stubbed, so this checks the
 * wiring, not the answer.
 */
import assert from 'node:assert/strict';
import { handleRequest } from '../src/app.mjs';

let seenPrompt = '';
const realFetch = globalThis.fetch;

globalThis.fetch = async (url, init = {}) => {
  const target = String(url);
  if (target.endsWith('/models')) {
    return new Response(JSON.stringify({ data: [{ id: 'stub/chat' }] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }
  const body = JSON.parse(init.body || '{}');
  seenPrompt = (body.messages || []).map((m) => (typeof m.content === 'string' ? m.content : '')).join('\n');
  return new Response(
    JSON.stringify({
      choices: [{ message: { content: '{"answer":"Osmosis.","working":"Water moves to the solute.","confidence":0.9,"why":"from the handout","sayThis":"Osmosis."}' } }],
      usage: { total_tokens: 10 },
    }),
    { status: 200, headers: { 'content-type': 'application/json' } }
  );
};

const runtime = { accessRequired: () => false, accessAccepted: () => false };
const post = (mode) =>
  handleRequest(
    new Request('http://localhost/api/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        mode,
        text: 'What is osmosis?',
        sources: [{ name: 'lecture-3.pdf', kind: 'pdf', text: 'Osmosis moves water across a semipermeable membrane.' }],
      }),
    }),
    { AI_API_KEY: 'stub', AI_CHAT_MODEL: 'stub/chat' },
    runtime
  );

const quiz = await post('quiz');
const quizBody = await quiz.json();
console.log('  quiz status', quiz.status);
assert.equal(quiz.status, 200);
assert.deepEqual(quizBody.grounded, ['lecture-3.pdf'], 'the reply names the document');
assert.match(seenPrompt, /Osmosis moves water across a semipermeable membrane/);
assert.match(seenPrompt, /Grounding rule/);

const essay = await post('essay');
const essayBody = await essay.json();
assert.equal(essay.status, 200);
assert.deepEqual(essayBody.grounded, ['lecture-3.pdf'], 'essay is grounded too');

const ungrounded = await handleRequest(
  new Request('http://localhost/api/chat', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ mode: 'note', text: 'Anything new?' }),
  }),
  { AI_API_KEY: 'stub', AI_CHAT_MODEL: 'stub/chat' },
  runtime
);
assert.deepEqual((await ungrounded.json()).grounded, [], 'a live note claims no grounding');

globalThis.fetch = realFetch;
console.log('\n4 passed\n');
