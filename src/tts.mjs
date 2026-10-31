/**
 * Optional local speech.
 *
 * The browser's own voices are the fallback, not the plan: they sound like a
 * screen reader and differ on every device. When `TTS_URL` points at a local
 * Kokoro service (see deploy/kokoro), replies are spoken by Kokoro-82M instead
 * — Apache-2.0, ~340 MB, and comfortably faster than realtime on a few CPU
 * cores, so no GPU is involved.
 *
 * Nothing here is required: with no `TTS_URL` the app keeps working and the
 * client falls back to `speechSynthesis`.
 */

const CACHE_LIMIT = 48;
const cache = new Map();

export function ttsConfig(env = {}) {
  const base = String(env.TTS_URL || '').replace(/\/+$/, '');
  return {
    base,
    voice: env.TTS_VOICE || 'af_heart',
    speed: Number(env.TTS_SPEED) > 0 ? Number(env.TTS_SPEED) : 1,
    enabled: Boolean(base),
  };
}

function remember(key, value) {
  if (cache.size >= CACHE_LIMIT) cache.delete(cache.keys().next().value);
  cache.set(key, value);
}

/**
 * Synthesize `text` to WAV. Returns `{ audio, type }`, or null when no local
 * voice is configured. Throws when a configured service fails, so the caller
 * can decide to degrade rather than retry blindly.
 */
export async function synthesize(text, options = {}, env = {}) {
  const cfg = ttsConfig(env);
  if (!cfg.base) return null;

  const clean = String(text || '')
    .replace(/\*\*|__|\*|_|`|#/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 1800);
  if (!clean) return null;

  const voice = options.voice || cfg.voice;
  const speed = Number(options.speed) > 0 ? Math.min(Math.max(Number(options.speed), 0.6), 1.6) : cfg.speed;
  const key = `${voice}|${speed}|${clean}`;
  const hit = cache.get(key);
  if (hit) return hit;

  const response = await fetch(`${cfg.base}/synthesize`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text: clean, voice, speed }),
    signal: AbortSignal.timeout(60_000),
  });

  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw new Error(`voice service returned ${response.status} ${String(detail).slice(0, 200)}`.trim());
  }

  const result = {
    audio: new Uint8Array(await response.arrayBuffer()),
    type: response.headers.get('content-type') || 'audio/wav',
  };
  remember(key, result);
  return result;
}
