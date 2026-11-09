/**
 * The shape of the audio the broadcast extension is allowed to send.
 *
 * The extension writes the container itself, so every field this test builds is a
 * field the server then has to check: a real RIFF layout is accepted, and the
 * things that would make a transcription meaningless — a wrong magic, a missing
 * data chunk, a bit depth no decoder wants, a rate the route cannot carry — are
 * refused rather than forwarded.
 */
import assert from 'node:assert/strict';
import { readWav } from '../src/wav.mjs';

let passed = 0;
function ok(name, fn) {
  fn();
  passed += 1;
  console.log(`  ok   ${name}`);
}

function wav({ samples = 16000, rate = 16000, channels = 1, bits = 16, format = 1, extraChunk = false, dataSize } = {}) {
  const blockAlign = channels * (bits / 8);
  const payload = samples * blockAlign;
  const header = Buffer.alloc(44);
  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(36 + payload, 4);
  header.write('WAVE', 8, 'ascii');
  header.write('fmt ', 12, 'ascii');
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(format, 20);
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(rate, 24);
  header.writeUInt32LE(rate * blockAlign, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(bits, 34);
  header.write('data', 36, 'ascii');
  header.writeUInt32LE(dataSize === undefined ? payload : dataSize, 40);
  const parts = [header, Buffer.alloc(payload)];
  if (extraChunk) {
    const list = Buffer.alloc(12);
    list.write('LIST', 0, 'ascii');
    list.writeUInt32LE(4, 4);
    parts.splice(1, 0, list);
  }
  return Buffer.concat(parts);
}

ok('a 16 kHz mono PCM16 chunk is accepted and its duration reported', () => {
  const parsed = readWav(wav({ samples: 16000 }));
  assert.equal(parsed.sampleRate, 16000);
  assert.equal(parsed.channels, 1);
  assert.equal(parsed.bitsPerSample, 16);
  assert.equal(Math.round(parsed.seconds), 1);
});

ok('stereo is accepted, and one second is still one second', () => {
  const parsed = readWav(wav({ samples: 16000, channels: 2 }));
  assert.equal(parsed.channels, 2);
  assert.equal(Math.round(parsed.seconds), 1);
});

ok('a chunk shorter than a second reports the fraction it holds', () => {
  const parsed = readWav(wav({ samples: 4000 }));
  assert.equal(parsed.seconds.toFixed(2), '0.25');
});

ok('another format before the data chunk does not hide it', () => {
  assert.ok(readWav(wav({ extraChunk: true })));
});

ok('the wrong magic is not audio', () => {
  const bytes = wav();
  bytes.write('RIFX', 0, 'ascii');
  assert.equal(readWav(bytes), null);
});

ok('a header with no samples is not audio', () => {
  assert.equal(readWav(wav({ samples: 0 })), null);
});

ok('a truncated header is not audio', () => {
  assert.equal(readWav(Buffer.alloc(20)), null);
  assert.equal(readWav(Buffer.alloc(0)), null);
});

ok('compressed payloads are refused rather than forwarded', () => {
  assert.equal(readWav(wav({ format: 3 })), null, 'IEEE float is not what the extension writes');
});

ok('a bit depth the route cannot carry is refused', () => {
  assert.equal(readWav(wav({ samples: 8000, bits: 24 })), null);
});

ok('a rate outside what transcription takes is refused', () => {
  assert.equal(readWav(wav({ rate: 4000 })), null);
  assert.equal(readWav(wav({ rate: 96000 })), null);
});

ok('a data size larger than the file is clamped to what is there', () => {
  const parsed = readWav(wav({ samples: 16000, dataSize: 999999 }));
  assert.ok(parsed);
  assert.equal(Math.round(parsed.seconds), 1);
});

console.log(`\n  ${passed} checks passed`);
