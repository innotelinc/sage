/**
 * A microphone chunk from a broadcast extension, from the wire to a note.
 *
 * The extension has no access code and no shared container, so the session the app
 * opened is the only credential. These are the rules that make that safe: only an
 * open session is read, only PCM16 WAV is forwarded, and a chunk that produced no
 * words still counts as a chunk — otherwise the app would think the broadcast had
 * stopped while it was still capturing.
 */
import assert from 'node:assert/strict';
import { handleBroadcastAudio } from '../src/broadcast-audio.mjs';
import { openSession, closeSession, readNotes } from '../src/broadcast.mjs';

let passed = 0;
async function ok(name, fn) {
  await fn();
  passed += 1;
  console.log(`  ok   ${name}`);
}

function wav(samples = 16000, rate = 16000) {
  const payload = samples * 2;
  const header = Buffer.alloc(44);
  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(36 + payload, 4);
  header.write('WAVE', 8, 'ascii');
  header.write('fmt ', 12, 'ascii');
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(rate, 24);
  header.writeUInt32LE(rate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36, 'ascii');
  header.writeUInt32LE(payload, 40);
  return Buffer.concat([header, Buffer.alloc(payload)]);
}

function post(body) {
  return new Request('https://sage.test/api/broadcast/audio', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

const chunk = (device, overrides = {}) => ({
  device,
  seq: 1,
  audio: `data:audio/wav;base64,${wav().toString('base64')}`,
  ...overrides,
});

const cfg = { key: 'k', baseUrl: 'https://gateway.test/v1', transcribeModel: 'whisper-1' };
const reads = async (bytes) => ({ text: 'mitochondria make ATP' });

const DEVICE = 'audio-device-a';

await ok('a device with no open session is refused before any audio is read', async () => {
  const res = await handleBroadcastAudio(post(chunk(DEVICE)), cfg, { transcribe: reads });
  assert.equal(res.status, 409);
  assert.equal((await res.json()).error, 'no_session');
});

openSession(DEVICE);

await ok('a body that is not JSON is a bad request, not a crash', async () => {
  const res = await handleBroadcastAudio(post('{'), cfg, { transcribe: reads });
  assert.equal(res.status, 400);
});

await ok('a chunk with no device is refused', async () => {
  const res = await handleBroadcastAudio(post(chunk('')), cfg, { transcribe: reads });
  assert.equal(res.status, 400);
  assert.equal((await res.json()).error, 'no_device');
});

await ok('audio that is not a WAV data URL is refused', async () => {
  const res = await handleBroadcastAudio(post(chunk(DEVICE, { audio: 'data:audio/webm;base64,AAAA' })), cfg, { transcribe: reads });
  assert.equal(res.status, 400);
  assert.equal((await res.json()).error, 'bad_audio');
});

await ok('a WAV-shaped payload that is not PCM16 is refused without a transcription', async () => {
  let called = false;
  const res = await handleBroadcastAudio(
    post(chunk(DEVICE, { audio: `data:audio/wav;base64,${Buffer.from('RIFFxxxxWAVEjunk').toString('base64')}` })),
    cfg,
    {
      transcribe: async () => {
        called = true;
        return { text: '' };
      },
    }
  );
  assert.equal(res.status, 400);
  assert.equal(called, false, 'nothing malformed reaches the speech route');
});

await ok('an oversized chunk is refused', async () => {
  const huge = Buffer.alloc(2 * 1024 * 1024 + 8);
  const res = await handleBroadcastAudio(post(chunk(DEVICE, { audio: `data:audio/wav;base64,${huge.toString('base64')}` })), cfg, {
    transcribe: reads,
  });
  assert.equal(res.status, 413);
});

await ok('a good chunk becomes a note the app can drain', async () => {
  const res = await handleBroadcastAudio(post(chunk(DEVICE)), cfg, { transcribe: reads });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.noted, true);
  assert.equal(body.seconds, 1);
  const notes = readNotes(DEVICE);
  assert.equal(notes.notes.length, 1);
  assert.match(notes.notes[0].text, /mitochondria/);
});

await ok('a chunk that produced no words still counts, and says why', async () => {
  const before = readNotes(DEVICE).frames;
  const res = await handleBroadcastAudio(post(chunk(DEVICE)), cfg, { transcribe: async () => ({ text: '' }) });
  const body = await res.json();
  assert.equal(body.noted, false);
  assert.equal(body.reason, 'nothing said');
  const after = readNotes(DEVICE);
  assert.equal(after.frames, before + 1, 'the session has to look live while a silent chapter plays');
});

await ok('a transcription failure is a counted drop, not an ended broadcast', async () => {
  const before = readNotes(DEVICE).frames;
  const res = await handleBroadcastAudio(post(chunk(DEVICE)), cfg, {
    transcribe: async () => {
      throw new Error('gateway answered 503');
    },
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.equal(body.noted, false);
  assert.match(body.reason, /503/);
  assert.equal(readNotes(DEVICE).frames, before + 1);
});

await ok('one device cannot write into another device its session', async () => {
  openSession('audio-device-b');
  const res = await handleBroadcastAudio(post(chunk('audio-device-b')), cfg, { transcribe: reads });
  assert.equal(res.status, 200);
  assert.equal(readNotes(DEVICE).notes.length, 0);
  assert.equal(readNotes('audio-device-b').notes.length, 1);
  closeSession('audio-device-b');
});

await ok('a closed session stops accepting audio', async () => {
  closeSession(DEVICE);
  const res = await handleBroadcastAudio(post(chunk(DEVICE)), cfg, { transcribe: reads });
  assert.equal(res.status, 409);
});

console.log(`\n  ${passed} checks passed`);
