// Admin panel: store or clear the gateway key, and decide whether a key is
// required before an appraisal can run. There are no accounts, so there is
// nothing to sign in as; a deployed instance is intended for its owner.

import { Hono } from 'hono'

import { deleteSetting, putSetting } from '../db'
import type { AppContext } from '../env'
import { KEY_SETTING, REQUIRE_KEY_SETTING, looksLikeKey, readGatewaySettings } from '../gateway'
import { privateJson } from '../http'
import { VisionError, checkKey } from '../vision'

export const admin = new Hono<AppContext>()

admin.post('/key', async (c) => {
  const body = await c.req.json<Record<string, unknown>>().catch(() => ({}) as Record<string, unknown>)
  const key = typeof body.key === 'string' ? body.key.trim() : ''
  if (!looksLikeKey(key)) return c.json({ error: 'key', message: 'Paste the whole Mintmark key, with no spaces.' }, 400)

  const settings = await readGatewaySettings(c.env, c.get('db'))
  try {
    await checkKey({ apiKey: key, baseUrl: settings.baseUrl })
  } catch (error) {
    const failure = error instanceof VisionError ? error : new VisionError('failed', 'Could not verify that key.', 502)
    return c.json({ error: failure.code, message: failure.message }, failure.status as never)
  }

  await putSetting(c.get('db'), KEY_SETTING, key)
  return privateJson(c, { ok: true })
})

admin.delete('/key', async (c) => {
  await deleteSetting(c.get('db'), KEY_SETTING)
  return privateJson(c, { ok: true })
})

admin.post('/require-key', async (c) => {
  const body = await c.req.json<Record<string, unknown>>().catch(() => ({}) as Record<string, unknown>)
  if (typeof body.requireKey !== 'boolean') return c.json({ error: 'requireKey', message: 'Send true or false.' }, 400)
  await putSetting(c.get('db'), REQUIRE_KEY_SETTING, body.requireKey ? '1' : '0')
  return privateJson(c, { ok: true })
})
