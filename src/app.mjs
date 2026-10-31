/**
 * Framework-agnostic request handler shared by the Node dev server and the
 * Cloudflare Worker entry. No dependencies, standard Request/Response only.
 */
import { buildSystemPrompt, parseMemory, parseStructured, MODES } from './persona.mjs';
import { handleRelay } from './relay.mjs';
import { synthesize, ttsConfig } from './tts.mjs';

const MAX_IMAGES = 6;
const MAX_TEXT = 24000;
const UPSTREAM_TIMEOUT_MS = 120000;

// The estate's OmniRoute gateway. Keys entered in the app are issued here, so it
// is also the default endpoint — one place to look when something is wrong.
const DEFAULT_BASE_URL = 'https://gateway.innotel.us/v1';
const MAX_KEY_LENGTH = 200;

export function resolveConfig(env = {}) {
  const baseUrl = String(env.AI_BASE_URL || DEFAULT_BASE_URL).replace(/\/+$/, '');
  const key = env.AI_API_KEY || env.OPENAI_API_KEY || '';
  const chatModel = env.AI_CHAT_MODEL || 'gpt-4o-mini';
  return {
    baseUrl,
    key,
    chatModel,
    visionModel: env.AI_VISION_MODEL || chatModel,
    transcribeModel: env.AI_TRANSCRIBE_MODEL || 'whisper-1',
    accessCode: env.ACCESS_CODE || '',
  };
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });
}

function gatewayHosts(env = {}) {
  return String(env.GATEWAY_HOSTS || 'gateway.innotel.us')
    .split(',')
    .map((host) => host.trim().toLowerCase())
    .filter(Boolean);
}

/**
 * A key entered in the app's admin panel arrives per request. It is only ever
 * forwarded upstream, and the base URL is pinned to the gateway host, so this
 * cannot be turned into an open proxy or a way to spend someone else's credits.
 */
function withClientCredentials(request, env, cfg) {
  const key = String(request.headers.get('x-ai-key') || '').trim();
  const base = String(request.headers.get('x-ai-base') || '').trim();
  if (!key && !base) return { cfg };

  let next = cfg;

  if (key) {
    if (key.length > MAX_KEY_LENGTH || /\s/.test(key)) {
      return { error: json({ error: 'bad_key', message: 'That does not look like an API key.' }, 400) };
    }
    next = { ...next, key };
  }

  if (base) {
    let parsed;
    try {
      parsed = new URL(base);
    } catch {
      return { error: json({ error: 'bad_base', message: 'Base URL must be a full https URL.' }, 400) };
    }
    const allowed = gatewayHosts(env);
    if (parsed.protocol !== 'https:' || !allowed.includes(parsed.host.toLowerCase())) {
      return { error: json({ error: 'bad_base', message: `Base URL must be https://${allowed.join(' or https://')}.` }, 400) };
    }
    next = { ...next, baseUrl: `${parsed.origin}${parsed.pathname.replace(/\/+$/, '')}` };
  }

  return { cfg: next };
}

function isDataImage(value) {
  return typeof value === 'string' && /^data:image\/(png|jpe?g|webp|gif);base64,/.test(value) && value.length < 6_000_000;
}

function authorised(request, cfg) {
  if (!cfg.accessCode) return true;
  const provided = request.headers.get('x-access-code') || '';
  return provided && provided === cfg.accessCode;
}

/** A rejected key is a user problem, not a server one: say so plainly. */
function keyRejected(status, detail) {
  return json(
    {
      error: 'bad_key',
      status,
      message: `The gateway rejected this API key (${status}). Check it in Settings → Gateway. ${String(detail).slice(0, 300)}`,
    },
    401
  );
}

async function handleChat(body, cfg) {
  if (!cfg.key) {
    return json(
      {
        error: 'no_key',
        message:
          'No model key configured. Enter an OmniRoute key under Settings → Gateway, or set OPENAI_API_KEY in .env and restart.',
      },
      503
    );
  }

  const mode = MODES[body.mode] ? body.mode : 'note';
  const text = String(body.text || '').slice(0, MAX_TEXT);
  const images = Array.isArray(body.images) ? body.images.filter(isDataImage).slice(0, MAX_IMAGES) : [];
  const memory = Array.isArray(body.memory) ? body.memory.slice(-60).map((m) => String(m).slice(0, 300)) : [];
  const history = Array.isArray(body.history) ? body.history.filter((h) => typeof h === 'string').slice(-6) : [];
  const persona = body.persona && typeof body.persona === 'object' ? body.persona : {};

  if (!text && !images.length) return json({ error: 'empty', message: 'Nothing to work with.' }, 400);

  const system = buildSystemPrompt({ mode, memory, persona, history, language: body.language || '' });
  const userContent = images.length
    ? [
        { type: 'text', text: text || 'Read this material and respond according to the current task.' },
        ...images.map((url) => ({ type: 'image_url', image_url: { url, detail: 'auto' } })),
      ]
    : text;

  const model = images.length ? cfg.visionModel : cfg.chatModel;
  const spec = MODES[mode];

  let upstream;
  try {
    upstream = await fetch(`${cfg.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(cfg.key ? { authorization: `Bearer ${cfg.key}` } : {}),
      },
      body: JSON.stringify({
        model,
        temperature: typeof body.temperature === 'number' ? body.temperature : spec.temperature,
        max_tokens: Number(body.maxTokens) > 0 ? Math.min(Number(body.maxTokens), 4000) : 1600,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: userContent },
        ],
      }),
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    });
  } catch (error) {
    return json({ error: 'upstream_unreachable', message: `Could not reach ${cfg.baseUrl}: ${error.message}` }, 502);
  }

  if (!upstream.ok) {
    const detail = await upstream.text().catch(() => '');
    if (upstream.status === 401 || upstream.status === 403) return keyRejected(upstream.status, detail);
    return json(
      {
        error: 'upstream_error',
        status: upstream.status,
        message: `Model provider returned ${upstream.status}. ${String(detail).slice(0, 500)}`,
      },
      502
    );
  }

  const data = await upstream.json().catch(() => null);
  const raw = data?.choices?.[0]?.message?.content;
  const content = Array.isArray(raw) ? raw.map((p) => p?.text || '').join('') : String(raw || '');
  if (!content.trim()) return json({ error: 'empty_reply', message: 'The model returned nothing.' }, 502);

  const { text: visible, notes } = parseMemory(content);
  const structured = ['answer', 'quiz', 'evolve'].includes(mode) ? parseStructured(visible) : null;

  return json({
    reply: visible,
    structured,
    notes,
    mode,
    model,
    usedVision: images.length > 0,
    usage: data?.usage || null,
  });
}

async function handleTranscribe(request, cfg) {
  if (!cfg.key) {
    return json({ error: 'no_key', message: 'Transcription needs an API key — enter a gateway key in Settings.' }, 503);
  }

  let form;
  try {
    form = await request.formData();
  } catch {
    return json({ error: 'bad_form', message: 'Expected multipart form data with an "audio" file.' }, 400);
  }
  const audio = form.get('audio');
  if (!audio || typeof audio === 'string') return json({ error: 'no_audio', message: 'Missing audio file.' }, 400);

  const outbound = new FormData();
  outbound.append('file', audio, audio.name || 'chunk.webm');
  outbound.append('model', cfg.transcribeModel);
  const language = form.get('language');
  if (language) outbound.append('language', String(language));

  let upstream;
  try {
    upstream = await fetch(`${cfg.baseUrl}/audio/transcriptions`, {
      method: 'POST',
      headers: { authorization: `Bearer ${cfg.key}` },
      body: outbound,
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    });
  } catch (error) {
    return json({ error: 'upstream_unreachable', message: error.message }, 502);
  }

  if (!upstream.ok) {
    const detail = await upstream.text().catch(() => '');
    if (upstream.status === 401 || upstream.status === 403) return keyRejected(upstream.status, detail);
    return json({ error: 'upstream_error', message: `Transcription returned ${upstream.status}. ${String(detail).slice(0, 400)}` }, 502);
  }

  const data = await upstream.json().catch(() => ({}));
  return json({ text: String(data.text || '').trim(), model: cfg.transcribeModel });
}

export async function handleRequest(request, env = {}) {
  const url = new URL(request.url);
  let cfg = resolveConfig(env);

  if (!url.pathname.startsWith('/api/')) {
    return env.ASSETS ? env.ASSETS.fetch(request) : json({ error: 'not_found', message: 'Static assets are not bound.' }, 404);
  }

  if (url.pathname === '/api/health' && request.method === 'GET') {
    let host = cfg.baseUrl;
    try {
      host = new URL(cfg.baseUrl).host;
    } catch {
      /* keep raw */
    }
    return json({
      ok: true,
      configured: Boolean(cfg.key),
      provider: host,
      gateway: gatewayHosts(env),
      acceptsClientKey: true,
      chatModel: cfg.chatModel,
      visionModel: cfg.visionModel,
      transcribeModel: cfg.transcribeModel,
      authRequired: Boolean(cfg.accessCode),
      modes: Object.keys(MODES),
    });
  }

  if (!authorised(request, cfg)) {
    return json({ error: 'unauthorised', message: 'Wrong or missing access code.' }, 401);
  }

  const client = withClientCredentials(request, env, cfg);
  if (client.error) return client.error;
  cfg = client.cfg;

  if (url.pathname.startsWith('/api/relay/')) {
    return handleRelay(request, url, json);
  }

  if (url.pathname === '/api/tts/status' && request.method === 'GET') {
    const voice = ttsConfig(env);
    return json({ available: voice.enabled, voice: voice.voice, speed: voice.speed, fallback: 'browser' });
  }

  if (url.pathname === '/api/tts' && request.method === 'POST') {
    const body = await request.json().catch(() => null);
    if (!body) return json({ error: 'bad_json', message: 'Body must be JSON.' }, 400);
    try {
      const spoken = await synthesize(body.text, { voice: body.voice, speed: body.speed }, env);
      if (!spoken) {
        return json(
          { error: 'no_voice', message: 'No local voice is configured, so the browser will speak instead.', fallback: 'browser' },
          503
        );
      }
      return new Response(spoken.audio, {
        headers: { 'content-type': spoken.type, 'cache-control': 'private, max-age=86400' },
      });
    } catch (error) {
      return json({ error: 'voice_failed', message: error.message, fallback: 'browser' }, 502);
    }
  }

  if (url.pathname === '/api/chat' && request.method === 'POST') {
    const body = await request.json().catch(() => null);
    if (!body) return json({ error: 'bad_json', message: 'Body must be JSON.' }, 400);
    return handleChat(body, cfg);
  }

  if (url.pathname === '/api/transcribe' && request.method === 'POST') {
    return handleTranscribe(request, cfg);
  }

  return json({ error: 'not_found' }, 404);
}
