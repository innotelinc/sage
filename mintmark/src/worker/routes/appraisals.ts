// POST /api/appraisals: one photo in, one stored appraisal out. The photo is
// checked, the daily limit is enforced, the model is called, and only a
// successful appraisal is written (a refused request spends nothing).

import { Hono } from 'hono'

import { DAILY_APPRAISAL_LIMIT, MAX_IMAGE_BYTES, MAX_NOTE_CHARS, MAX_THUMB_BYTES } from '../../shared/config'
import type { Appraisal, AppraisalAnalysis } from '../../shared/types'
import { appraisalsToday, id, mapSummary, now, utcDay } from '../db'
import type { AppContext } from '../env'
import { readGatewaySettings } from '../gateway'
import { privateJson, visitorKey } from '../http'
import { VisionError, analyzeCoin } from '../vision'

export const appraisals = new Hono<AppContext>()

const DATA_URL = /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/]+={0,2})$/

type Decoded = { mimeType: string; base64: string }

function decodeImage(value: unknown, maxBytes: number): Decoded | null {
  if (typeof value !== 'string') return null
  const match = DATA_URL.exec(value)
  const mimeType = match?.[1]
  const base64 = match?.[2]
  if (!mimeType || !base64) return null
  if ((base64.length * 3) / 4 > maxBytes) return null
  return { mimeType, base64 }
}

const dataUrl = (image: Decoded) => `data:${image.mimeType};base64,${image.base64}`

const subtitleOf = (analysis: AppraisalAnalysis) =>
  [analysis.year, analysis.country, analysis.denomination].filter(Boolean).join(' · ')

// One appraisal at a time per visitor in this isolate. A cheap brake on a tab
// that fires requests in parallel; the daily limit and the key's own quota are
// the real ceilings.
const inflight = new Map<string, number>()
const INFLIGHT_TTL = 3 * 60_000
function isBusy(owner: string): boolean {
  const at = inflight.get(owner)
  if (at && Date.now() - at < INFLIGHT_TTL) return true
  inflight.delete(owner)
  return false
}

appraisals.post('/', async (c) => {
  const db = c.get('db')
  const owner = await visitorKey(c.req.raw)
  const settings = await readGatewaySettings(c.env, db)
  if (settings.requireKey && !settings.key) {
    return c.json({ error: 'not_configured', message: 'No gateway key is configured. Add one in the admin panel.' }, 503)
  }

  const body = await c.req.json<Record<string, unknown>>().catch(() => ({}) as Record<string, unknown>)

  const image = decodeImage(body.image, MAX_IMAGE_BYTES)
  if (!image) return c.json({ error: 'image', message: 'Attach a JPG, PNG or WebP photo under 2 MB.' }, 400)
  const thumb = decodeImage(body.thumb, MAX_THUMB_BYTES) ?? image
  const note = typeof body.note === 'string' ? body.note.replace(/\s+/g, ' ').trim().slice(0, MAX_NOTE_CHARS) : ''

  if (isBusy(owner)) return c.json({ error: 'busy', message: 'One appraisal at a time, please.' }, 429)
  if ((await appraisalsToday(db, owner)) >= DAILY_APPRAISAL_LIMIT) {
    return c.json({ error: 'limit', message: `You have reached today's limit of ${DAILY_APPRAISAL_LIMIT} appraisals.`, resetsAt: utcDay().end }, 429)
  }

  inflight.set(owner, Date.now())
  let analysis: AppraisalAnalysis
  try {
    analysis = await analyzeCoin(
      { apiKey: settings.key ?? '', model: settings.model, baseUrl: settings.baseUrl },
      { mimeType: image.mimeType, base64: image.base64, note },
    )
  } catch (error) {
    const failure = error instanceof VisionError ? error : new VisionError('failed', 'The appraisal failed. Try again.', 502)
    return c.json({ error: failure.code, message: failure.message }, failure.status as never)
  } finally {
    inflight.delete(owner)
  }

  const appraisalId = id()
  const createdAt = now()
  await db
    .prepare(
      `INSERT INTO appraisals (id, owner_sub, name, subtitle, value_low, value_high, currency, grade, grade_label, confidence, identified, image, thumb, result, note, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      appraisalId,
      owner,
      analysis.name,
      subtitleOf(analysis),
      analysis.valueLow,
      analysis.valueHigh,
      analysis.currency,
      analysis.grade,
      analysis.gradeLabel,
      analysis.confidence,
      analysis.identified ? 1 : 0,
      dataUrl(image),
      dataUrl(thumb),
      JSON.stringify(analysis),
      note,
      createdAt,
    )
    .run()

  const appraisal: Appraisal = { ...analysis, id: appraisalId, createdAt, image: dataUrl(image), thumb: dataUrl(thumb), note }
  return privateJson(c, { appraisal }, 201)
})

appraisals.get('/', async (c) => {
  const result = await c
    .get('db')
    .prepare(
      `SELECT id, name, subtitle, value_low, value_high, currency, grade, grade_label, confidence, identified, thumb, created_at
       FROM appraisals WHERE owner_sub = ? ORDER BY created_at DESC LIMIT 100`,
    )
    .bind(await visitorKey(c.req.raw))
    .all()
  return privateJson(c, { items: (result.results ?? []).map((row) => mapSummary(row as Record<string, unknown>)) })
})

// Everything this visitor has saved: the settings page's "delete all".
appraisals.delete('/', async (c) => {
  await c.get('db').prepare(`DELETE FROM appraisals WHERE owner_sub = ?`).bind(await visitorKey(c.req.raw)).run()
  return privateJson(c, { ok: true })
})

appraisals.get('/:id', async (c) => {
  const row = await c
    .get('db')
    .prepare(`SELECT * FROM appraisals WHERE owner_sub = ? AND id = ?`)
    .bind(await visitorKey(c.req.raw), c.req.param('id'))
    .first<Record<string, unknown>>()
  if (!row) return c.json({ error: 'not_found', message: 'This appraisal is not here any more.' }, 404)

  let analysis: AppraisalAnalysis
  try {
    analysis = JSON.parse(String(row.result)) as AppraisalAnalysis
  } catch {
    return c.json({ error: 'malformed', message: 'This appraisal could not be read.' }, 500)
  }
  const appraisal: Appraisal = {
    ...analysis,
    id: String(row.id),
    createdAt: Number(row.created_at),
    image: String(row.image),
    thumb: String(row.thumb),
    note: String(row.note ?? ''),
  }
  return privateJson(c, { appraisal })
})

appraisals.delete('/:id', async (c) => {
  await c
    .get('db')
    .prepare(`DELETE FROM appraisals WHERE owner_sub = ? AND id = ?`)
    .bind(await visitorKey(c.req.raw), c.req.param('id'))
    .run()
  return privateJson(c, { ok: true })
})
