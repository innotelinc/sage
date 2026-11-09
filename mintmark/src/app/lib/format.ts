export function initials(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0]?.toUpperCase() ?? '')
    .join('')
}

/** "$1,250", "$4.50", "$1.2K": a single amount. */
export function money(value: number, currency = 'USD', compact = false): string {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency,
    notation: compact ? 'compact' : 'standard',
    maximumFractionDigits: compact ? (value < 1000 ? 0 : 1) : value < 20 ? 2 : 0,
  }).format(value)
}

/** "$4.50 – $12" or a single amount when the ends match. */
export function moneyRange(low: number, high: number, currency = 'USD', compact = false): string {
  if (!low && !high) return '—'
  if (low === high) return money(low, currency, compact)
  return `${money(low, currency, compact)} – ${money(high, currency, compact)}`
}

/** Which sidebar group an appraisal belongs to, by its date. */
export function dayGroup(ts: number, now = Date.now()): 'Today' | 'Yesterday' | 'Previous 7 days' | 'Older' {
  const start = new Date(now)
  start.setHours(0, 0, 0, 0)
  const today = start.getTime()
  if (ts >= today) return 'Today'
  if (ts >= today - 86_400_000) return 'Yesterday'
  if (ts >= today - 7 * 86_400_000) return 'Previous 7 days'
  return 'Older'
}

export const DAY_GROUPS = ['Today', 'Yesterday', 'Previous 7 days', 'Older'] as const

/** "in 3h" / "in 25m": when the daily limit resets. */
export function untilLabel(ts: number, now = Date.now()): string {
  const minutes = Math.max(1, Math.round((ts - now) / 60_000))
  if (minutes < 60) return `in ${minutes}m`
  const hours = Math.round(minutes / 60)
  return `in ${hours}h`
}

export function dateLabel(ts: number): string {
  return new Date(ts).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
}
