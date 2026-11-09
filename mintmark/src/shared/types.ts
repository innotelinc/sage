// Types shared by the Worker (src/worker) and the app (src/app).

/** One appraisal, exactly as the vision model returns it. */
export interface AppraisalAnalysis {
  identified: boolean
  name: string
  country: string
  denomination: string
  year: string
  mintMark: string
  variety: string
  composition: string
  rarity: string
  grade: number
  gradeLabel: string
  condition: string
  confidence: number
  valueLow: number
  valueHigh: number
  currency: string
  valueBasis: string
  drivers: string[]
  checks: string[]
  redFlags: string[]
  summary: string
  imageQuality: string
}

/** A stored appraisal: the analysis plus its photo and owner note. */
export interface Appraisal extends AppraisalAnalysis {
  id: string
  createdAt: number
  /** Full photo as a data URL, for the detail page. */
  image: string
  /** Small copy for lists. */
  thumb: string
  note: string
}

/** The row the sidebar and collection list need, without the images. */
export interface AppraisalSummary {
  id: string
  name: string
  subtitle: string
  valueLow: number
  valueHigh: number
  currency: string
  grade: number
  gradeLabel: string
  confidence: number
  identified: boolean
  thumb: string
  createdAt: number
}

/** What the app draws itself from. The key itself is never in here. */
export interface AppState {
  capabilities: {
    /** A gateway key is configured on the server. Never the key itself. */
    vision: boolean
    database: boolean
    /** Whether appraisals are blocked until a key exists (admin setting). */
    requireKey: boolean
  }
  gateway: {
    model: string
    baseUrl: string
    keySource: 'stored' | 'env' | null
    /** e.g. `sk-…80ad`, for recognising which key is in use. */
    keyHint: string | null
  }
  usage: { used: number; limit: number; resetsAt: number }
}
