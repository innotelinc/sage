/**
 * Device-level probe of the two ways SAGE can hear something.
 *
 * The browser decides this, not the code that ships: the same page is served to Chrome,
 * to Safari and inside the iOS shell, and each grants a different subset. So this file
 * asks each path once, with a real request, and reports what came back — the audio
 * track, its rate, a level reading, and whether a two-second clip could be encoded.
 *
 * The classification and the report are exported, so a unit test can hold them to the
 * contract without a browser; the DOM wiring only runs when there is a document.
 */

export const PATHS = [
  {
    id: 'lecture',
    label: 'Lecture — the microphone',
    what: 'The room through the phone’s microphone. This is the path Listen uses by default, and the one a lecture hall needs.',
    request: 'getUserMedia({ audio })',
  },
  {
    id: 'audiobook',
    label: 'Audiobook — another app’s audio',
    what: 'The sound another app is playing, read through a share request whose picture is stopped the moment it arrives.',
    request: 'getDisplayMedia({ video, audio, systemAudio: “include” })',
  },
];

const HINTS = {
  refused:
    'The shell refused it. A refusal here is about the container, not the device: try the same page in Chrome on that phone to tell the two apart.',
  'no-device':
    'The request was granted but carried nothing to read — no microphone, or a share without audio ticked.',
  unsupported: 'This engine has no capture path for it at all.',
  'bad-constraints':
    'The engine rejected the options themselves, which is how a shell that only partly implements the API answers. The page retries once without them.',
  cancelled: 'The sheet was closed without choosing anything.',
  failed: 'An unexpected failure; the message is the engine’s own.',
};

/**
 * A capture failure, named the way the report needs it. The engine's message is kept
 * verbatim: it is the only evidence of what the shell did.
 */
export function classifyCaptureError(error) {
  const name = String(error?.name || '');
  const message = String(error?.message || error || '');
  let code = 'failed';
  if (name === 'NotAllowedError' || name === 'SecurityError') code = 'refused';
  else if (name === 'NotFoundError' || name === 'OverconstrainedError') code = 'no-device';
  else if (name === 'NotSupportedError') code = 'unsupported';
  else if (name === 'AbortError') code = 'cancelled';
  else if (name === 'TypeError') code = 'bad-constraints';
  else if (/carried no sound|no audio track/i.test(message)) code = 'no-device';
  return { code, hint: HINTS[code], name, message };
}

/** What a live stream actually offers, in the terms the report prints. */
export function describeStream(stream) {
  const audio = stream?.getAudioTracks?.() || [];
  const video = stream?.getVideoTracks?.() || [];
  let settings = {};
  try {
    settings = audio[0]?.getSettings?.() || {};
  } catch {
    /* some engines throw on settings before the track starts */
  }
  return {
    audioTracks: audio.length,
    videoTracks: video.length,
    label: String(audio[0]?.label || ''),
    sampleRate: Number(settings.sampleRate) || 0,
    channels: Number(settings.channelCount) || 0,
    readyState: String(audio[0]?.readyState || ''),
  };
}

/**
 * One verdict per path. `allowed` needs an audio track and a clip that actually encoded;
 * a silent room still passes, because silence is the room's problem, not the shell's.
 */
export function summariseReport(rows, extra = {}) {
  const lines = [];
  lines.push('SAGE device capture report');
  if (extra.userAgent) lines.push(`agent: ${extra.userAgent}`);
  if (extra.native) lines.push(`native shell: ${extra.native}`);
  lines.push('');
  for (const path of PATHS) {
    const row = rows.find((item) => item.path === path.id);
    if (!row) {
      lines.push(`${path.label}: not tested`);
      continue;
    }
    lines.push(`${path.label}: ${row.status.toUpperCase()} — ${row.detail}`);
    lines.push(`  request: ${path.request}`);
    if (row.facts && Object.keys(row.facts).length) {
      const facts = Object.entries(row.facts)
        .filter(([, value]) => value !== '' && value !== 0 && value !== undefined && value !== null)
        .map(([key, value]) => `${key}=${value}`);
      if (facts.length) lines.push(`  ${facts.join(' ')}`);
    }
  }
  if (extra.transcode) lines.push(`encoding: ${extra.transcode}`);
  const allowed = rows.filter((row) => row.status === 'allowed').map((row) => row.path);
  lines.push('');
  lines.push(
    allowed.length
      ? `usable on this device: ${allowed.join(', ')}`
      : 'usable on this device: neither path — this shell cannot hear anything'
  );
  return lines.join('\n');
}

/* ---- browser side ---- */

const MIME_CANDIDATES = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/aac'];

function pickMime() {
  if (typeof MediaRecorder === 'undefined') return '';
  return MIME_CANDIDATES.find((type) => {
    try {
      return MediaRecorder.isTypeSupported(type);
    } catch {
      return false;
    }
  }) || '';
}

/** Peak and average level over a window: proof that something other than silence arrived. */
function meter(stream, ms = 2000) {
  return new Promise((resolve) => {
    let context;
    try {
      context = new (window.AudioContext || window.webkitAudioContext)();
    } catch {
      resolve({ peak: 0, average: 0, note: 'no audio context' });
      return;
    }
    const source = context.createMediaStreamSource(stream);
    const analyser = context.createAnalyser();
    analyser.fftSize = 512;
    source.connect(analyser);
    const buffer = new Float32Array(analyser.fftSize);
    let peak = 0;
    let total = 0;
    let reads = 0;
    const started = Date.now();
    const tick = () => {
      analyser.getFloatTimeDomainData(buffer);
      for (const sample of buffer) {
        const value = Math.abs(sample);
        if (value > peak) peak = value;
        total += value;
        reads += 1;
      }
      if (Date.now() - started < ms) requestAnimationFrame(tick);
      else {
        const average = reads ? total / reads : 0;
        try {
          source.disconnect();
          context.close();
        } catch {
          /* already gone */
        }
        resolve({ peak: Number(peak.toFixed(3)), average: Number(average.toFixed(4)) });
      }
    };
    tick();
  });
}

/** A two-second clip through the same recorder the app uses, so the size is comparable. */
function encode(stream, ms = 2000) {
  return new Promise((resolve) => {
    if (typeof MediaRecorder === 'undefined') {
      resolve({ bytes: 0, mime: '', note: 'no MediaRecorder' });
      return;
    }
    const mime = pickMime();
    let recorder;
    try {
      recorder = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
    } catch (error) {
      resolve({ bytes: 0, mime: '', note: error.message });
      return;
    }
    const chunks = [];
    recorder.ondataavailable = (event) => {
      if (event.data?.size) chunks.push(event.data);
    };
    recorder.onstop = () => {
      const size = chunks.reduce((sum, chunk) => sum + chunk.size, 0);
      resolve({ bytes: size, mime: recorder.mimeType || mime, note: '' });
    };
    try {
      recorder.start();
    } catch (error) {
      resolve({ bytes: 0, mime: '', note: error.message });
      return;
    }
    setTimeout(() => {
      if (recorder.state === 'recording') recorder.stop();
    }, ms);
  });
}

function boot() {
  const $ = (id) => document.getElementById(id);
  const rows = [];
  const facts = {};

  const render = () => {
    const body = $('rows');
    body.innerHTML = '';
    for (const path of PATHS) {
      const row = rows.find((item) => item.path === path.id);
      const tr = document.createElement('tr');
      const state = row ? row.status : 'untested';
      tr.className = `row ${state}`;
      tr.innerHTML = `
        <td><b>${path.label}</b><div class="mini muted">${path.request}</div></td>
        <td><span class="state ${state}">${state}</span></td>
        <td class="mini">${row ? row.detail : 'not run yet'}</td>`;
      body.appendChild(tr);
    }
    $('report').value = summariseReport(rows, facts);
  };

  const record = (path, status, detail, details = {}) => {
    const index = rows.findIndex((item) => item.path === path);
    const row = { path, status, detail, facts: details };
    if (index >= 0) rows[index] = row;
    else rows.push(row);
    render();
  };

  const guard = async (path, run) => {
    const button = path === 'lecture' ? $('runLecture') : $('runAudiobook');
    button.disabled = true;
    button.textContent = 'Testing…';
    try {
      await run();
    } finally {
      button.disabled = false;
      button.textContent = path === 'lecture' ? 'Test the microphone' : 'Test another app’s audio';
    }
  };

  $('runLecture').onclick = () =>
    guard('lecture', async () => {
      if (!navigator.mediaDevices?.getUserMedia) {
        record('lecture', 'unsupported', 'this engine has no getUserMedia');
        return;
      }
      let stream;
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
        });
      } catch (error) {
        const said = classifyCaptureError(error);
        record('lecture', said.code, `${said.name}: ${said.message} — ${said.hint}`);
        return;
      }
      const described = describeStream(stream);
      const level = await meter(stream);
      const clip = await encode(stream);
      stream.getTracks().forEach((track) => track.stop());
      const ok = described.audioTracks > 0 && clip.bytes > 1000;
      record(
        'lecture',
        ok ? 'allowed' : 'no-device',
        ok
          ? `read ${clip.bytes} bytes in two seconds; ${level.peak === 0 ? 'the room was silent' : 'sound was present'}`
          : `the microphone opened but produced ${clip.bytes} bytes`,
        {
          rate: described.sampleRate,
          ch: described.channels,
          peak: level.peak,
          clip: `${clip.bytes}B`,
          mime: clip.mime,
        }
      );
    });

  $('runAudiobook').onclick = () =>
    guard('audiobook', async () => {
      if (!navigator.mediaDevices?.getDisplayMedia) {
        record(
          'audiobook',
          'unsupported',
          'this engine has no getDisplayMedia, so it cannot hear another app at all'
        );
        return;
      }
      const options = {
        video: true,
        audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
        systemAudio: 'include',
        selfBrowserSurface: 'exclude',
        surfaceSwitching: 'include',
      };
      let stream;
      try {
        stream = await navigator.mediaDevices.getDisplayMedia(options);
      } catch (error) {
        const said = classifyCaptureError(error);
        if (said.code === 'bad-constraints') {
          // A shell that knows the method but not the options: ask for the least it
          // can accept, so the report separates "no API" from "no audio".
          try {
            stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
          } catch (second) {
            const again = classifyCaptureError(second);
            record(
              'audiobook',
              again.code,
              `rejected the options (${said.message}), then ${again.name}: ${again.message} — ${said.hint}`
            );
            return;
          }
        } else {
          record('audiobook', said.code, `${said.name}: ${said.message} — ${said.hint}`);
          return;
        }
      }
      const described = describeStream(stream);
      // The picture is the price of the sound; it is never read here.
      stream.getVideoTracks().forEach((track) => track.stop());
      if (!described.audioTracks) {
        const audioOnly = new MediaStream(stream.getAudioTracks());
        audioOnly.getTracks().forEach((track) => track.stop());
        record(
          'audiobook',
          'no-device',
          'the share was granted but carried no audio — the sheet needs “share audio” ticked, and some shells drop it silently'
        );
        return;
      }
      const sound = new MediaStream(stream.getAudioTracks());
      const level = await meter(sound);
      const clip = await encode(sound);
      sound.getTracks().forEach((track) => track.stop());
      const ok = clip.bytes > 1000;
      record(
        'audiobook',
        ok ? 'allowed' : 'no-device',
        ok
          ? `read ${clip.bytes} bytes in two seconds with the picture already stopped`
          : 'an audio track arrived but nothing could be encoded from it',
        {
          rate: described.sampleRate,
          ch: described.channels,
          peak: level.peak,
          clip: `${clip.bytes}B`,
          mime: clip.mime,
        }
      );
    });

  $('runAll').onclick = async () => {
    $('runAll').disabled = true;
    try {
      await $('runLecture').onclick();
      await new Promise((resolve) => setTimeout(resolve, 300));
      await $('runAudiobook').onclick();
    } finally {
      $('runAll').disabled = false;
    }
  };

  $('copy').onclick = async () => {
    const text = $('report').value;
    try {
      await navigator.clipboard.writeText(text);
      $('copy').textContent = 'Copied';
      setTimeout(() => ($('copy').textContent = 'Copy the report'), 1600);
    } catch {
      $('report').select();
    }
  };

  // Facts that shape how the results should be read, gathered without asking permission.
  facts.userAgent = navigator.userAgent;
  const plugins = window.Capacitor?.Plugins || {};
  const bridge = ['SageScreen', 'SageBroadcast', 'SageAudio', 'SageStore'].filter((name) => plugins[name]);
  facts.native = bridge.length ? `${bridge.join(', ')} (native app)` : 'browser';
  const mime = pickMime();
  facts.transcode = mime || 'no MediaRecorder type — clips cannot be encoded here';

  if (typeof navigator.permissions?.query === 'function') {
    navigator.permissions
      .query({ name: 'microphone' })
      .then((status) => {
        $('permissions').textContent = `microphone permission: ${status.state}`;
        status.onchange = () => {
          $('permissions').textContent = `microphone permission: ${status.state}`;
        };
      })
      .catch(() => {
        $('permissions').textContent = 'microphone permission: not reportable here';
      });
  } else {
    $('permissions').textContent = 'microphone permission: not reportable here';
  }

  fetch('/api/health')
    .then((res) => res.json())
    .then((out) => {
      facts.server = `ok=${out.ok} configured=${out.configured}`;
      render();
    })
    .catch(() => {
      facts.server = 'health unreachable';
      render();
    });

  render();
}

if (typeof document !== 'undefined' && typeof window !== 'undefined') {
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
}
