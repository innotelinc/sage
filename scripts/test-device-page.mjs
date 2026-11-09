/**
 * The device page must say the right thing about the failures it will actually meet.
 *
 * Every shell answers a capture request differently, and the page is only useful if a
 * refusal, a missing method and a rejected constraint are told apart — so the contract
 * tested here is the naming and the report, not the capture itself, which needs a phone.
 */
import assert from 'node:assert/strict';
import { classifyCaptureError, describeStream, PATHS, summariseReport } from '../public/device-test.js';

let passed = 0;
const ok = (name, run) => {
  run();
  passed += 1;
  console.log(`  ok ${name}`);
};

ok('not allowed is a refusal from the container', () => {
  const said = classifyCaptureError(Object.assign(new Error('Permission denied'), { name: 'NotAllowedError' }));
  assert.equal(said.code, 'refused');
  assert.match(said.hint, /Chrome/);
  assert.equal(said.message, 'Permission denied');
});

ok('a missing device is not a refusal', () => {
  assert.equal(classifyCaptureError({ name: 'NotFoundError', message: 'Requested device not found' }).code, 'no-device');
  assert.equal(classifyCaptureError({ name: 'OverconstrainedError', message: '' }).code, 'no-device');
});

ok('a share without sound reads as no device, not as success', () => {
  assert.equal(classifyCaptureError({ name: 'Error', message: 'that share carried no sound' }).code, 'no-device');
});

ok('rejected options point at a partial shell', () => {
  const said = classifyCaptureError({ name: 'TypeError', message: "Failed to read the 'systemAudio' property" });
  assert.equal(said.code, 'bad-constraints');
  assert.match(said.hint, /retries once/);
});

ok('unsupported, cancelled and unknown stay distinct', () => {
  assert.equal(classifyCaptureError({ name: 'NotSupportedError', message: '' }).code, 'unsupported');
  assert.equal(classifyCaptureError({ name: 'AbortError', message: '' }).code, 'cancelled');
  const other = classifyCaptureError(new Error('boom'));
  assert.equal(other.code, 'failed');
  assert.equal(other.message, 'boom');
});

ok('a stream is described by its tracks', () => {
  const stream = {
    getAudioTracks: () => [{ label: 'iPhone Microphone', readyState: 'live', getSettings: () => ({ sampleRate: 48000, channelCount: 1 }) }],
    getVideoTracks: () => [{}, {}],
  };
  const described = describeStream(stream);
  assert.deepEqual(described, {
    audioTracks: 1,
    videoTracks: 2,
    label: 'iPhone Microphone',
    sampleRate: 48000,
    channels: 1,
    readyState: 'live',
  });
});

ok('an engine that throws on settings still describes its tracks', () => {
  const described = describeStream({
    getAudioTracks: () => [{ getSettings: () => { throw new Error('not started'); } }],
    getVideoTracks: () => [],
  });
  assert.equal(described.audioTracks, 1);
  assert.equal(described.sampleRate, 0);
});

ok('the report names both paths and settles on a verdict', () => {
  const text = summariseReport(
    [
      { path: 'lecture', status: 'allowed', detail: 'read 4200 bytes', facts: { rate: 48000, ch: 1, peak: 0.21 } },
      { path: 'audiobook', status: 'refused', detail: 'NotAllowedError: Permission denied' },
    ],
    { userAgent: 'iPhone/17.2 Safari', native: 'browser', transcode: 'audio/mp4' }
  );
  assert.match(text, /Lecture — the microphone: ALLOWED/);
  assert.match(text, /Audiobook — another app’s audio: REFUSED/);
  assert.match(text, /rate=48000 ch=1 peak=0.21/);
  assert.match(text, /usable on this device: lecture/);
  assert.match(text, /iPhone\/17\.2 Safari/);
});

ok('nothing allowed is said plainly', () => {
  const text = summariseReport([
    { path: 'lecture', status: 'unsupported', detail: 'no getUserMedia' },
    { path: 'audiobook', status: 'unsupported', detail: 'no getDisplayMedia' },
  ]);
  assert.match(text, /usable on this device: neither path/);
});

ok('a path that never ran is reported as untested', () => {
  const text = summariseReport([{ path: 'lecture', status: 'allowed', detail: '' }]);
  assert.match(text, /Audiobook — another app’s audio: not tested/);
});

ok('the two paths are the two sources Listen has', () => {
  assert.deepEqual(PATHS.map((path) => path.id), ['lecture', 'audiobook']);
  for (const path of PATHS) {
    assert.ok(path.label && path.what && path.request, `${path.id} is described`);
  }
});

console.log(`\n${passed} passed`);
