/**
 * The audio half of the broadcast meeting point.
 *
 * The extension captures the microphone while another app is in front — the one
 * thing an in-app recorder cannot do — and posts it here in five-second WAV
 * chunks. Nothing about the session changes: the app opened it with the access
 * code, the extension posts under the vendor identifier it shares with the app,
 * and the text comes back through the same notes the app already drains.
 *
 * The transcription call is injected rather than imported so this module has no
 * opinion about which provider is configured, and so the rules below can be
 * tested without a network or a key.
 */
import { accepts, recordFrame } from './broadcast.mjs';
import { readWav } from './wav.mjs';

/** 2 MB of base64's worth of audio: five seconds at 16 kHz mono is ~160 KB. */
export const MAX_AUDIO_BYTES = 2 * 1024 * 1024;

const DATA_URL = /^data:audio\/(?:wav|x-wav);base64,([A-Za-z0-9+/=]+)$/;

function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

export async function handleBroadcastAudio(request, cfg, options = {}) {
  const transcribe = options.transcribe;
  const body = await request.json().catch(() => null);
  if (!body) return json({ error: 'bad_json', message: 'Body must be JSON.' }, 400);

  const device = String(body.device || '').trim().slice(0, 64);
  if (!device) return json({ error: 'no_device', message: 'A device identifier is required.' }, 400);
  if (!accepts(device)) {
    return json({ error: 'no_session', message: 'Open a broadcast session from the app first.' }, 409);
  }

  const match = DATA_URL.exec(String(body.audio || ''));
  if (!match) return json({ error: 'bad_audio', message: 'audio must be a WAV data URL.' }, 400);
  const bytes = Buffer.from(match[1], 'base64');
  if (!bytes.length) return json({ error: 'bad_audio', message: 'The chunk was empty.' }, 400);
  if (bytes.length > MAX_AUDIO_BYTES) {
    return json({ error: 'audio_too_large', message: `A chunk over ${MAX_AUDIO_BYTES} bytes is not a five-second window.` }, 413);
  }
  const wav = readWav(bytes);
  if (!wav) return json({ error: 'bad_audio', message: 'That is not 16-bit PCM WAV.' }, 400);

  let text = '';
  let reason = '';
  try {
    const out = await transcribe(bytes, wav);
    text = String(out?.text || '').trim();
    if (!text) reason = out?.reason || 'nothing said';
  } catch (error) {
    // A chunk that could not be read is not a reason to end the broadcast: the
    // extension keeps capturing and the next one may carry the words.
    reason = String(error?.message || 'transcription failed').slice(0, 200);
  }

  // Recording the chunk even when it produced no text is what keeps the session
  // live: `running` is how the app knows the extension is still capturing.
  const state = recordFrame(device, text);
  return json({
    ok: true,
    noted: Boolean(text),
    reason,
    seconds: Number(wav.seconds.toFixed(2)),
    frames: state?.frames || 0,
  });
}
