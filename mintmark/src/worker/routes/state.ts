import { Hono } from 'hono'

import { DAILY_APPRAISAL_LIMIT } from '../../shared/config'
import type { AppState } from '../../shared/types'
import { appraisalsToday, utcDay } from '../db'
import type { AppContext } from '../env'
import { maskKey, readGatewaySettings } from '../gateway'
import { privateJson, visitorKey } from '../http'

export const state = new Hono<AppContext>()

// Everything the app needs to draw itself: is a key configured (never the key
// itself), what model answers, and how much of the daily allowance is left.
state.get('/', async (c) => {
  const db = c.get('db')
  const settings = await readGatewaySettings(c.env, db)
  const body: AppState = {
    capabilities: {
      vision: Boolean(settings.key),
      database: true,
      requireKey: settings.requireKey,
    },
    gateway: {
      model: settings.model,
      baseUrl: settings.baseUrl,
      keySource: settings.source,
      keyHint: settings.key ? maskKey(settings.key) : null,
    },
    usage: {
      used: await appraisalsToday(db, await visitorKey(c.req.raw)),
      limit: DAILY_APPRAISAL_LIMIT,
      resetsAt: utcDay().end,
    },
  }
  return privateJson(c, body)
})
