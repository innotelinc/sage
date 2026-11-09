// Where the gateway key and the model come from. A key pasted into the admin
// panel is stored in D1 and wins over MINTMARK_API_KEY, so a key can be changed
// without a redeploy. Only a masked hint ever leaves this module.

import { GATEWAY_BASE_URL, VISION_MODEL } from '../shared/config'
import { getSetting } from './db'
import type { Env } from './env'

export const KEY_SETTING = 'gateway_key'
export const REQUIRE_KEY_SETTING = 'require_key'

export type KeySource = 'stored' | 'env' | null

export type GatewaySettings = {
  /** The key itself, or null when none is configured anywhere. */
  key: string | null
  source: KeySource
  /** Whether appraisals are blocked until a key exists. Admin can turn this off. */
  requireKey: boolean
  model: string
  baseUrl: string
}

export async function readGatewaySettings(env: Env, db: D1Database): Promise<GatewaySettings> {
  const [stored, requirement] = await Promise.all([getSetting(db, KEY_SETTING), getSetting(db, REQUIRE_KEY_SETTING)])
  const storedKey = stored?.trim() || null
  const envKey = env.MINTMARK_API_KEY?.trim() || null
  const key = storedKey ?? envKey
  return {
    key,
    source: storedKey ? 'stored' : envKey ? 'env' : null,
    requireKey: requirement !== '0',
    model: env.MINTMARK_MODEL?.trim() || VISION_MODEL,
    baseUrl: (env.MINTMARK_BASE_URL || GATEWAY_BASE_URL).replace(/\/+$/, ''),
  }
}

/** `sk-0614…80ad`: enough to recognise a key, not enough to use it. */
export function maskKey(key: string): string {
  if (key.length <= 10) return '••••'
  const head = key.startsWith('sk-') ? 'sk-' : key.slice(0, 2)
  return `${head}…${key.slice(-4)}`
}

/** A pasted key: printable ASCII, no spaces, a plausible length. */
export const looksLikeKey = (value: string) => /^[\x21-\x7e]{16,200}$/.test(value)
