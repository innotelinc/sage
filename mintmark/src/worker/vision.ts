// The vision client. The browser never talks to the gateway; this module does,
// with the key the admin panel stored (or MINTMARK_API_KEY), and normalises the
// reply so the app can trust its shape.
//
// The gateway (OmniRoute at gateway.innotel.us) exposes the OpenAI-compatible
// `/v1` surface: a Bearer key, chat completions with multimodal content parts,
// and a model id of the form `<provider-prefix>/<model-id>`.

import { APPRAISAL_SCHEMA, MAX_OUTPUT_TOKENS, SYSTEM_PROMPT, buildAppraisalPrompt } from '../shared/config'
import type { AppraisalAnalysis } from '../shared/types'

export class VisionError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status = 502,
  ) {
    super(message)
  }
}

/** Everything one request needs, resolved by gateway.ts per call. */
export type Gateway = { apiKey: string; model: string; baseUrl: string }

type ChatResponse = {
  choices?: {
    message?: { content?: unknown; refusal?: unknown } | null
    finish_reason?: string | null
  }[]
  error?: { code?: string | number; type?: string; message?: string }
}

/** Structured-output support varies by route, so the request has three shapes. */
type Structured = 'schema' | 'object' | 'none'

/** Turns a gateway failure into something safe to show. Never includes the key. */
function failure(status: number, error: ChatResponse['error'] | null): VisionError {
  const detail = `${error?.code ?? ''} ${error?.type ?? ''} ${error?.message ?? ''}`.toLowerCase()
  if (status === 401 || status === 403 || /auth_00|unauthor|invalid.?api.?key|key.*(revoked|disabled|expired)/.test(detail))
    return new VisionError('invalid_key', 'The gateway refused this key. Add a working key in the admin panel.', 503)
  if (status === 404 || /model.*(not found|unknown|unsupported)|no such model|not available|unknown provider/.test(detail))
    return new VisionError(
      'model_unavailable',
      'The gateway does not route that model. Set MINTMARK_MODEL to a vision model it serves.',
      503,
    )
  if (status === 429) return new VisionError('busy', 'The gateway is busy right now. Try again in a moment.', 429)
  if (status === 400 || status === 422) return new VisionError('refused', 'That request was refused. Try a smaller or clearer photo.', 400)
  return new VisionError('unavailable', 'The appraisal gateway is unavailable right now. Try again shortly.', 503)
}

const text = (value: unknown, max = 200) => (typeof value === 'string' ? value.trim().slice(0, max) : '')

const list = (value: unknown, max = 4) =>
  Array.isArray(value)
    ? value
        .filter((item): item is string => typeof item === 'string')
        .map((item) => item.trim().slice(0, 240))
        .filter(Boolean)
        .slice(0, max)
    : []

function number(value: unknown, min: number, max: number, fallback: number): number {
  const parsed = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(parsed)) return fallback
  return Math.min(max, Math.max(min, parsed))
}

/** Never trust a model's arithmetic or its idea of a schema. */
export function normalize(raw: Record<string, unknown>): AppraisalAnalysis {
  const identified = raw.identified === true
  let valueLow = Math.round(number(raw.valueLow, 0, 100_000_000, 0) * 100) / 100
  let valueHigh = Math.round(number(raw.valueHigh, 0, 100_000_000, 0) * 100) / 100
  if (valueLow > valueHigh) [valueLow, valueHigh] = [valueHigh, valueLow]
  if (!identified) {
    valueLow = 0
    valueHigh = 0
  }
  const currency = text(raw.currency, 3).toUpperCase()
  return {
    identified,
    name: identified ? text(raw.name, 120) : '',
    country: text(raw.country, 60),
    denomination: text(raw.denomination, 60),
    year: text(raw.year, 24),
    mintMark: text(raw.mintMark, 24),
    variety: text(raw.variety, 80),
    composition: text(raw.composition, 80),
    rarity: text(raw.rarity, 24),
    grade: Math.round(number(raw.grade, 0, 70, 0)),
    gradeLabel: text(raw.gradeLabel, 48),
    condition: text(raw.condition, 200),
    confidence: Math.round(number(raw.confidence, 0, 1, 0) * 100) / 100,
    valueLow,
    valueHigh,
    currency: /^[A-Z]{3}$/.test(currency) ? currency : 'USD',
    valueBasis: text(raw.valueBasis, 220),
    drivers: list(raw.drivers),
    checks: list(raw.checks),
    redFlags: list(raw.redFlags),
    summary: text(raw.summary, 700),
    imageQuality: text(raw.imageQuality, 240),
  }
}

/** Assistant content is a string, or content parts on some routes. */
function replyText(content: unknown): string {
  if (typeof content === 'string') return content.trim()
  if (!Array.isArray(content)) return ''
  return content
    .map((part) => (part && typeof part === 'object' && typeof (part as { text?: unknown }).text === 'string' ? (part as { text: string }).text : ''))
    .join('')
    .trim()
}

/** Models sometimes wrap JSON in fences or a sentence; find the object. */
function parseObject(reply: string): Record<string, unknown> | null {
  const trimmed = reply
    .trim()
    .replace(/^```(?:json)?/i, '')
    .replace(/```$/, '')
    .trim()
  const start = trimmed.indexOf('{')
  const end = trimmed.lastIndexOf('}')
  const candidates = [trimmed]
  if (start >= 0 && end > start) candidates.push(trimmed.slice(start, end + 1))
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate) as unknown
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as Record<string, unknown>
    } catch {
      /* try the next shape */
    }
  }
  return null
}

function requestBody(
  gateway: Gateway,
  input: { mimeType: string; base64: string; note: string },
  structured: Structured,
): Record<string, unknown> {
  const today = new Date().toISOString().slice(0, 10)
  const body: Record<string, unknown> = {
    model: gateway.model,
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      {
        role: 'user',
        content: [
          { type: 'text', text: buildAppraisalPrompt({ note: input.note, today }) },
          { type: 'image_url', image_url: { url: `data:${input.mimeType};base64,${input.base64}` } },
        ],
      },
    ],
    temperature: 0.2,
    max_tokens: MAX_OUTPUT_TOKENS,
  }
  if (structured === 'schema') {
    body.response_format = {
      type: 'json_schema',
      json_schema: { name: 'coin_appraisal', strict: true, schema: APPRAISAL_SCHEMA },
    }
  }
  if (structured === 'object') body.response_format = { type: 'json_object' }
  return body
}

function errorOf(raw: string): ChatResponse['error'] | null {
  try {
    return (JSON.parse(raw) as ChatResponse).error ?? null
  } catch {
    return null
  }
}

async function post(gateway: Gateway, body: Record<string, unknown>): Promise<{ ok: boolean; status: number; text: string }> {
  let response: Response
  try {
    response = await fetch(`${gateway.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${gateway.apiKey}`,
        'content-type': 'application/json',
        accept: 'application/json',
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(90_000),
    })
  } catch (error) {
    if (error instanceof Error && error.name === 'TimeoutError') throw new VisionError('timeout', 'The model took too long to read this photo. Try again.', 504)
    throw new VisionError('network', 'Could not reach the appraisal gateway.', 503)
  }
  return { ok: response.ok, status: response.status, text: await response.text() }
}

/**
 * Saves a key only if the gateway accepts it: one cheap authorised GET. It does
 * not spend a vision call.
 */
export async function checkKey(gateway: { apiKey: string; baseUrl: string }): Promise<void> {
  let response: Response
  try {
    response = await fetch(`${gateway.baseUrl}/models`, {
      headers: { authorization: `Bearer ${gateway.apiKey}`, accept: 'application/json' },
      signal: AbortSignal.timeout(20_000),
    })
  } catch {
    throw new VisionError('network', 'Could not reach the appraisal gateway to check that key.', 503)
  }
  if (response.ok) return
  throw failure(response.status, errorOf(await response.text()))
}

/**
 * One photo in, one appraisal out. `base64` is the raw image bytes without a
 * data URL prefix. The request first asks for schema-constrained JSON, then
 * falls back to a plain JSON-object request, then to the prompt alone, because
 * structured-output support depends on the model the gateway routes to.
 */
export async function analyzeCoin(
  gateway: Gateway,
  input: { mimeType: string; base64: string; note: string },
): Promise<AppraisalAnalysis> {
  if (!gateway.apiKey) throw new VisionError('not_configured', 'No gateway key is configured. Add one in the admin panel.', 503)

  let result = await post(gateway, requestBody(gateway, input, 'schema'))
  if (result.status === 400 || result.status === 422) {
    result = await post(gateway, requestBody(gateway, input, 'object'))
    if (result.status === 400 || result.status === 422) result = await post(gateway, requestBody(gateway, input, 'none'))
  }

  if (!result.ok) throw failure(result.status, errorOf(result.text))

  let body: ChatResponse
  try {
    body = JSON.parse(result.text) as ChatResponse
  } catch {
    throw new VisionError('malformed', 'The appraisal came back unreadable. Try again.', 502)
  }

  const choice = body.choices?.[0]
  if (!choice) throw new VisionError('empty', 'The model returned nothing. Try another photo.', 502)
  if (choice.finish_reason === 'length') throw new VisionError('truncated', 'The appraisal was cut short. Try again.', 502)
  if (choice.finish_reason === 'content_filter') throw new VisionError('blocked', 'The model would not read this image. Try another photo.', 502)
  if (typeof choice.message?.refusal === 'string' && choice.message.refusal) {
    throw new VisionError('blocked', 'The model declined to appraise this image. Try another photo.', 502)
  }

  const reply = replyText(choice.message?.content)
  if (!reply) throw new VisionError('empty', 'The model returned an empty appraisal. Try again.', 502)

  const parsed = parseObject(reply)
  if (!parsed) throw new VisionError('malformed', 'The appraisal came back unreadable. Try again.', 502)

  return normalize(parsed)
}
