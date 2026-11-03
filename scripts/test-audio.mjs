/**
 * Notes from an audio-only lecture carry the recording offset they came from.
 *
 * The audio never reaches the server, so what matters here is the contract: the
 * offsets are handed to the model with the fragment, the note is told to cite a
 * moment inside that range, and it is told never to invent one.
 */
import assert from 'node:assert/strict';
import { handleRequest } from '../src/app.mjs';

let prompt = '';
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
  prompt = (body.messages || []).map((m) => (typeof m.content === 'string' ? m.content : '')).join(' ');
  const content = '- Osmosis moves water across a membrane [lecture 12:30]';
  return new Response(
    JSON.stringify({ choices: [{ message: { content } }], usage: { total_tokens: 10 } }),
    { status: 200, headers: { 'content-type': 'application/json' } }
  );
};

const runtime = { accessRequired: () => false, accessAccepted: () => false };
const request = (text) =>
  handleRequest(
    new Request('http://localhost/api/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ mode: 'note', text }),
    }),
    { AI_API_KEY: 'stub', AI_CHAT_MODEL: 'stub/chat' },
    runtime
  );

const brief = [
  'Live transcript chunk from class:',
  'Recording offsets in this fragment: 12:01 to 12:40 of the lecture recording. Cite a moment as [lecture M:SS] using an offset inside that range; never invent one.',
  'so the water potential gradient drives it, and this is the bit that gets marked',
].join('\n\n');

const res = await request(brief);
const body = await res.json();
console.log('  status', res.status);
assert.equal(res.status, 200, 'a note from an audio fragment is accepted');
assert.match(prompt, /12:01 to 12:40/, 'the offsets reach the model with the fragment');
assert.match(prompt, /never invent one/, 'the citation rule travels with the offsets');
assert.match(body.reply, /\[lecture 12:30\]/, 'the note can cite a moment');
assert.equal(body.mode, 'note', 'the audio path stays in note mode');

globalThis.fetch = realFetch;
console.log('  4 checks passed');
