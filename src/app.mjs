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
    // Where a bought session key is claimed from. Magnate mints the OmniRoute
    // key and hands back a token; this server trades the token for it.
    magnateUrl: String(env.MAGNATE_URL || 'https://magnate.innotel.us').replace(/\/+$/, ''),
    // No model is configured per device: the best one this key can call is
    // chosen per request unless AI_CHAT_MODEL pins the default explicitly.
    autoModel: true,
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
  const model = String(request.headers.get('x-ai-model') || '').trim();
  if (!key && !base && !model) return { cfg };

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

  // The model chosen in the app, from the list that key can actually call. It
  // rides on the request like the key does, so a shared instance keeps serving
  // its own default to everyone else.
  if (model) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._:\/-]{1,79}$/.test(model)) {
      return { error: json({ error: 'bad_model', message: 'That does not look like a model id.' }, 400) };
    }
    next = { ...next, chatModel: model, visionModel: model, autoModel: false };
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

  const spec = MODES[mode];
  // Nothing to pick: the best model this credential can call is chosen here, and
  // a model the gateway then refuses falls back to the configured default rather
  // than failing the turn.
  let model = cfg.autoModel ? '' : images.length ? cfg.visionModel : cfg.chatModel;

  const ask = (candidate) =>
    fetch(`${cfg.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(cfg.key ? { authorization: `Bearer ${cfg.key}` } : {}),
      },
      body: JSON.stringify({
        model: candidate,
        temperature: typeof body.temperature === 'number' ? body.temperature : spec.temperature,
        max_tokens: Number(body.maxTokens) > 0 ? Math.min(Number(body.maxTokens), 4000) : 1600,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: userContent },
        ],
      }),
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    });

  let upstream;
  try {
    if (cfg.autoModel) {
      for (const candidate of await modelCandidates(cfg)) {
        upstream = await ask(candidate);
        model = candidate;
        if (upstream.ok) {
          rememberModel(cfg, candidate);
          break;
        }
      }
      if (!upstream) {
        upstream = await ask(cfg.chatModel);
        model = cfg.chatModel;
      }
    } else {
      upstream = await ask(model);
    }
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

/**
 * The models the credential in play can actually call.
 *
 * Read back from the gateway with the same key the next chat turn will use, so
 * the picker offers what this key can reach rather than a catalogue listing
 * that may not apply to it — a key's connection allowlist is the real contract.
 */
async function handleModels(cfg) {
  if (!cfg.key) {
    return json({
      models: [],
      model: cfg.chatModel,
      best: '',
      auto: Boolean(cfg.autoModel),
      message: 'No key is configured yet, so there is nothing to list.',
    });
  }

  const models = await modelsForKey(cfg);
  if (!models.length) {
    return json({
      models: [],
      model: cfg.chatModel,
      best: '',
      auto: Boolean(cfg.autoModel),
      message: 'The gateway returned no model list for this key.',
    });
  }

  // `verified` is what makes this honest: the ranking is a guess until a turn
  // has actually come back from the model it names.
  const preferred = modelCache.get(credentialKey(cfg))?.preferred;
  return json({
    models: models.slice(0, 200),
    model: cfg.chatModel,
    best: preferred || pickBestModel(models),
    verified: Boolean(preferred),
    auto: Boolean(cfg.autoModel),
    visionModel: cfg.visionModel,
  });
}

/* ── automatic model choice ───────────────────────────────── */
/* The gateway lists what a key *can* call, not which is best, and the list
   contains non-chat ids. Rank by capability keywords, prefer a concrete model
   over a meta-router (a router can point at a target its own filter then skips),
   and cache per credential so an ordinary turn costs no extra round trip. */
const NON_CHAT = /embed|whisper|tts|speech|audio|transcribe|rerank|moderation|guard|dall|sdxl|stable-diffusion|flux|image-gen/i;

function rankModel(id) {
  const name = String(id || '').toLowerCase();
  let score = 50;
  if (/opus/.test(name)) score = 100;
  else if (/gpt-6|gpt-5/.test(name)) score = 98;
  else if (/sonnet/.test(name)) score = 95;
  else if (/(^|[-_/])o[34](\b|-)/.test(name)) score = 93;
  else if (/gemini.*pro/.test(name)) score = 92;
  else if (/reasoning/.test(name)) score = 82;
  else if (/gemini.*flash/.test(name)) score = 80;
  else if (/coding/.test(name)) score = 68;
  else if (/fast|mini|flash|small/.test(name)) score = 60;
  // The billable edge of the catalogue: cheap and free tiers are fallbacks, not
  // what a paid session should be spending its cap on.
  if (/cheap|thrifty|free|chaos/.test(name)) score -= 25;
  if (/no-think|nothink/.test(name)) score -= 10;
  if (/^auto\//.test(name)) score -= 12;
  return score;
}

function pickBestModel(models) {
  const usable = models.filter((id) => id && !NON_CHAT.test(id));
  if (!usable.length) return '';
  return usable
    .map((id) => ({ id, score: rankModel(id) }))
    .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id))[0].id;
}

const modelCache = new Map();
const MODEL_TTL_MS = 10 * 60_000;

/** The model ids a credential may call, remembered for ten minutes. */
async function modelsForKey(cfg) {
  if (!cfg.key) return [];
  const cacheKey = `${cfg.baseUrl}|${cfg.key.slice(-12)}`;
  const hit = modelCache.get(cacheKey);
  if (hit && Date.now() - hit.at < MODEL_TTL_MS) return hit.models;
  try {
    const res = await fetch(`${cfg.baseUrl}/models`, {
      headers: { authorization: `Bearer ${cfg.key}`, accept: 'application/json' },
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) return hit ? hit.models : [];
    const body = await res.json().catch(() => ({}));
    const list = Array.isArray(body.data) ? body.data : Array.isArray(body.models) ? body.models : [];
    const models = list.map((entry) => String((entry && (entry.id || entry.name)) || entry)).filter(Boolean);
    // Keep the model that last answered across a refresh: the list changes far
    // less often than the ranking's first guess turns out to be wrong.
    modelCache.set(cacheKey, { models, at: Date.now(), preferred: hit ? hit.preferred : undefined });
    return models;
  } catch {
    return hit ? hit.models : [];
  }
}

function credentialKey(cfg) {
  return `${cfg.baseUrl}|${cfg.key.slice(-12)}`;
}

/** Remember the model that actually answered, so later turns skip the failures. */
function rememberModel(cfg, id) {
  const key = credentialKey(cfg);
  const entry = modelCache.get(key) || { models: [], at: Date.now() };
  modelCache.set(key, { ...entry, preferred: id });
}

/**
 * Candidates in the order they should be tried: the model that last answered,
 * then the ranked list, then the configured default.
 *
 * A gateway's model list is what a key is *allowed* to call, not what the
 * gateway can currently serve — a fresh key lists `agy/claude-opus-4-6-thinking`
 * and then refuses it. So the ranking is a first guess, and the turn keeps the
 * first candidate that answers.
 */
async function modelCandidates(cfg) {
  const models = await modelsForKey(cfg);
  const ranked = models
    .filter((id) => id && !NON_CHAT.test(id))
    .map((id) => ({ id, score: rankModel(id) }))
    .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id))
    .map((entry) => entry.id);
  const preferred = modelCache.get(credentialKey(cfg))?.preferred;

  // The configured default goes in before the long tail: it is the one id known
  // to be served, so a first turn answers even when every ranked candidate turns
  // out to be a listed model the gateway refuses. `auto/best-chat` is the last
  // resort the gateway itself routes.
  const ordered = [preferred, ...ranked.slice(0, 2), cfg.chatModel, 'auto/best-chat'].filter(Boolean);
  return [...new Set(ordered)].slice(0, 5);
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

const MAX_CLAIM_LENGTH = 64;

/**
 * A key bought at Magnate arrives as a claim code: the receipt page opens the
 * app at `#claim=…`, and this endpoint trades that code for the key. The trade
 * runs server-side so the browser never needs CORS access to a billing origin,
 * and only the key crosses back — the claim token is not stored anywhere here.
 */
async function handleClaim(request, cfg) {
  const body = await request.json().catch(() => null);
  const token = String((body && body.token) || '').trim();
  if (!token || token.length > MAX_CLAIM_LENGTH || !/^[A-Za-z0-9_-]+$/.test(token)) {
    return json({ error: 'bad_claim', message: 'That is not a claim code.' }, 400);
  }

  let upstream;
  try {
    upstream = await fetch(`${cfg.magnateUrl}/api/sage/claim?token=${encodeURIComponent(token)}`, {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(15000),
    });
  } catch (error) {
    return json({ error: 'claim_unreachable', message: `Cannot reach ${cfg.magnateUrl} (${error.message}).` }, 502);
  }

  const data = await upstream.json().catch(() => ({}));
  if (!upstream.ok) {
    const message = String(data.error || `The claim was refused (${upstream.status}).`);
    return json({ error: 'claim_rejected', message }, upstream.status === 410 ? 410 : 400);
  }

  const key = String(data.key || '').trim();
  if (!key || key.length > MAX_KEY_LENGTH || /\s/.test(key)) {
    return json({ error: 'bad_key', message: 'Magnate issued a key the gateway will not accept.' }, 502);
  }

  return json({
    key,
    code: String(data.code || ''),
    planName: String(data.planName || ''),
    expiresAt: data.expiresAt || null,
    secondsLeft: Number(data.secondsLeft) || 0,
    baseUrl: DEFAULT_BASE_URL,
  });
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
      autoModel: Boolean(cfg.autoModel),
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

  if (url.pathname === '/api/models' && request.method === 'GET') {
    return handleModels(cfg);
  }

  if (url.pathname === '/api/claim' && request.method === 'POST') {
    return handleClaim(request, cfg);
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
