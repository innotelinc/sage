/**
 * Framework-agnostic request handler shared by the Node dev server and the
 * Cloudflare Worker entry. No dependencies, standard Request/Response only.
 */
import { buildSystemPrompt, parseMemory, parseStructured, MODES } from './persona.mjs';
import { handleRelay } from './relay.mjs';

const MAX_IMAGES = 6;
const MAX_TEXT = 24000;
const UPSTREAM_TIMEOUT_MS = 120000;

export function resolveConfig(env = {}) {
  const baseUrl = String(env.AI_BASE_URL || 'https://api.openai.com/v1').replace(/\/+$/, '');
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

function isDataImage(value) {
  return typeof value === 'string' && /^data:image\/(png|jpe?g|webp|gif);base64,/.test(value) && value.length < 6_000_000;
}

function authorised(request, cfg) {
  if (!cfg.accessCode) return true;
  const provided = request.headers.get('x-access-code') || '';
  return provided && provided === cfg.accessCode;
}

async function handleChat(body, cfg) {
  if (!cfg.key) {
    return json(
      {
        error: 'no_key',
        message:
          'No model key configured. Set OPENAI_API_KEY (and optionally AI_BASE_URL) in .env, then restart. Ollama users: AI_BASE_URL=http://localhost:11434/v1 and any key.',
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
  if (!cfg.key) return json({ error: 'no_key', message: 'Transcription needs OPENAI_API_KEY.' }, 503);

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
    return json({ error: 'upstream_error', message: `Transcription returned ${upstream.status}. ${String(detail).slice(0, 400)}` }, 502);
  }

  const data = await upstream.json().catch(() => ({}));
  return json({ text: String(data.text || '').trim(), model: cfg.transcribeModel });
}

export async function handleRequest(request, env = {}) {
  const url = new URL(request.url);
  const cfg = resolveConfig(env);

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

  if (url.pathname.startsWith('/api/relay/')) {
    return handleRelay(request, url, json);
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
