import type { MiddlewareHandler } from 'hono'

import type { AppraisalSummary } from '../shared/types'
import type { AppContext } from './env'

// Schema lives with the Worker: D1 has no migration tool on Freebuff Sites, so
// tables are created on the first request of each isolate. Add new statements
// at the end; never edit existing ones in place once deployed.
const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS appraisals (
    id TEXT PRIMARY KEY,
    owner_sub TEXT NOT NULL,
    name TEXT NOT NULL,
    subtitle TEXT NOT NULL,
    value_low REAL NOT NULL,
    value_high REAL NOT NULL,
    currency TEXT NOT NULL,
    grade REAL NOT NULL DEFAULT 0,
    grade_label TEXT NOT NULL DEFAULT '',
    confidence REAL NOT NULL DEFAULT 0,
    identified INTEGER NOT NULL DEFAULT 0,
    image TEXT NOT NULL,
    thumb TEXT NOT NULL,
    result TEXT NOT NULL,
    note TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS appraisals_owner ON appraisals(owner_sub, created_at DESC)`,
  // Admin choices, one row per setting: the gateway key and whether a key is
  // required. The key is stored server-side and never sent back to a browser.
  `CREATE TABLE IF NOT EXISTS app_settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at INTEGER NOT NULL
  )`,
]

let ready: Promise<void> | undefined

export function ensureSchema(db: D1Database): Promise<void> {
  ready ??= db.batch(SCHEMA.map((sql) => db.prepare(sql))).then(
    () => undefined,
    (error) => {
      ready = undefined
      throw error
    },
  )
  return ready
}

export const requireDb: MiddlewareHandler<AppContext> = async (c, next) => {
  const db = c.env.DB
  if (!db) {
    return c.json({ error: 'database_missing', message: 'No database is attached yet. Add D1 storage named DB and redeploy.' }, 503)
  }
  await ensureSchema(db)
  c.set('db', db)
  await next()
}

export const id = () => crypto.randomUUID()
export const now = () => Date.now()

/** Midnight UTC that started the current day, and the next one. */
export function utcDay(at = now()): { start: number; end: number } {
  const start = new Date(at)
  start.setUTCHours(0, 0, 0, 0)
  return { start: start.getTime(), end: start.getTime() + 86_400_000 }
}

/** Appraisals generated today by this visitor: each one spent API credits. */
export async function appraisalsToday(db: D1Database, owner: string): Promise<number> {
  const { start } = utcDay()
  const row = await db
    .prepare(`SELECT COUNT(*) AS n FROM appraisals WHERE owner_sub = ? AND created_at >= ?`)
    .bind(owner, start)
    .first<{ n: number }>()
  return Number(row?.n ?? 0)
}

export async function getSetting(db: D1Database, key: string): Promise<string | null> {
  const row = await db.prepare(`SELECT value FROM app_settings WHERE key = ?`).bind(key).first<{ value: string }>()
  return row?.value ?? null
}

export async function putSetting(db: D1Database, key: string, value: string): Promise<void> {
  await db
    .prepare(
      `INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    )
    .bind(key, value, now())
    .run()
}

export async function deleteSetting(db: D1Database, key: string): Promise<void> {
  await db.prepare(`DELETE FROM app_settings WHERE key = ?`).bind(key).run()
}

export function mapSummary(row: Record<string, unknown>): AppraisalSummary {
  return {
    id: String(row.id),
    name: String(row.name ?? ''),
    subtitle: String(row.subtitle ?? ''),
    valueLow: Number(row.value_low ?? 0),
    valueHigh: Number(row.value_high ?? 0),
    currency: String(row.currency ?? 'USD'),
    grade: Number(row.grade ?? 0),
    gradeLabel: String(row.grade_label ?? ''),
    confidence: Number(row.confidence ?? 0),
    identified: Boolean(row.identified),
    thumb: String(row.thumb ?? ''),
    createdAt: Number(row.created_at ?? 0),
  }
}
