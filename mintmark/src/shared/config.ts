// The product's configuration, shared by the Worker and the app: the name, the
// appraiser's instructions, the JSON shape the model must return, and the
// limits that protect the API key.

export const BRAND = 'Mintmark'
export const TAGLINE = 'Photograph a coin. Learn what collectors would pay.'

/**
 * The gateway that reads the photos. It is an OmniRoute deployment on the
 * OpenAI-compatible `/v1` surface, so the app holds one Mintmark key (sold
 * through Magnate) instead of a provider key: the gateway verifies the key and
 * routes the request to a vision model.
 *
 * Every model on it is addressed as `<provider-prefix>/<model-id>`, and the ids
 * it actually serves are listed by `GET /v1/models` with the same Bearer key.
 * Override the model with MINTMARK_MODEL and the base URL with
 * MINTMARK_BASE_URL; see .env.example.
 */
export const GATEWAY_BASE_URL = 'https://gateway.innotel.us/v1'
/**
 * Default model id; MINTMARK_MODEL overrides it. Pinned against a real key:
 * the gateway's catalogue lists many more ids than it actually routes, and this
 * one reads a photo and answers strict `response_format: json_schema` in a
 * couple of seconds. `gemini/gemini-3.6-flash` and `gemini/gemini-4-argon` are
 * listed but return "not available in the active live catalog".
 */
export const VISION_MODEL = 'gemini/gemini-3-flash-preview'
export const VISION_MODEL_LABEL = 'Mintmark gateway'
/** Where the owner gets a Mintmark key. */
export const GATEWAY_KEYS_URL = 'https://gateway.innotel.us'

/** What the appraiser is told before every photo. */
export const SYSTEM_PROMPT = `You are a numismatic appraiser with forty years of experience across world coinage. You examine one photograph of the obverse of a single coin and produce a careful, conservative collector-market appraisal. You never invent a date, mint mark or variety you cannot actually see, and you never flatter a coin: common coins stay cheap. Reply only with the JSON object the response schema describes: one object, no prose, no code fences.`

/** The per-photo instructions. `note` is optional context from the owner. */
export function buildAppraisalPrompt({ note, today }: { note: string; today: string }): string {
  return `Examine this photograph of the front (obverse) of one coin.

Identify it as precisely as the photo allows: country, denomination, design, year, mint mark, and any visible variety. If a detail is not legible, return an empty string for it, lower confidence and widen the value range instead of guessing.

Grade what the photograph shows on the Sheldon 1-70 scale and name the adjectival grade. Assume the reverse and edge are unseen; when that changes the value, say so in valueBasis or checks.

Value is a collector-market range in USD at that grade. valueLow is roughly what a dealer would pay for a problem-free example; valueHigh is a fair retail price. Judge the coin in the photo, not a catalogue headline: a worn common coin is worth cents to a few dollars even when it is a century old, and a cleaned or damaged coin is worth bullion or less. Use 0 for both values when you cannot identify the coin.

drivers: 2-4 short points that make up the value (key date, mintage, metal, grade, collector demand).
checks: 2-4 concrete things to look at or photograph next (reverse design, mint mark position, edge, weight and diameter) to confirm identity and value.
redFlags: visible signs of cleaning, polishing, harsh damage, corrosion, artificial toning, holing, mounting, or a cast/fake coin. Empty array when none are visible.
rarity: exactly one of Common, Uncommon, Scarce, Rare, Key date, Unknown.
summary: two or three plain sentences for the owner, including what you are least sure about.
imageQuality: if the photo is blurry, cropped, dark, glaring or shows several coins, say what to fix. Empty string when the photo is usable.

Owner's note (may be empty): ${note || '—'}
Today is ${today}. Use today's market, not an older one.`
}

/**
 * The JSON the model must return: standard JSON Schema, sent as
 * `response_format: json_schema` so the reply is a valid object rather than a
 * paragraph with numbers in it. `strict` requires every property listed in
 * `required` and no extra fields.
 */
export const APPRAISAL_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    identified: { type: 'boolean', description: 'True only when you can name the coin.' },
    name: { type: 'string', description: 'Short catalogue name, e.g. "1909-S Lincoln Cent (VDB)".' },
    country: { type: 'string' },
    denomination: { type: 'string' },
    year: { type: 'string' },
    mintMark: { type: 'string' },
    variety: { type: 'string' },
    composition: { type: 'string' },
    rarity: { type: 'string' },
    grade: { type: 'number', description: 'Sheldon grade 1-70, or 0 when unknown.' },
    gradeLabel: { type: 'string', description: 'Adjectival grade, e.g. "Very Fine".' },
    condition: { type: 'string', description: 'One line on wear, surface and strike.' },
    confidence: { type: 'number', description: '0 to 1.' },
    valueLow: { type: 'number', description: 'Low end of the range in USD.' },
    valueHigh: { type: 'number', description: 'High end of the range in USD.' },
    currency: { type: 'string', description: 'USD.' },
    valueBasis: { type: 'string', description: 'What the range assumes.' },
    drivers: { type: 'array', items: { type: 'string' } },
    checks: { type: 'array', items: { type: 'string' } },
    redFlags: { type: 'array', items: { type: 'string' } },
    summary: { type: 'string' },
    imageQuality: { type: 'string' },
  },
  required: [
    'identified',
    'name',
    'country',
    'denomination',
    'year',
    'mintMark',
    'variety',
    'composition',
    'rarity',
    'grade',
    'gradeLabel',
    'condition',
    'confidence',
    'valueLow',
    'valueHigh',
    'currency',
    'valueBasis',
    'drivers',
    'checks',
    'redFlags',
    'summary',
    'imageQuality',
  ],
}

/** Per-user limits. Appraisals are counted per UTC day. */
export const DAILY_APPRAISAL_LIMIT = 25
/** Uploaded photo, after the browser has scaled it down. */
export const MAX_IMAGE_BYTES = 2_000_000
export const MAX_THUMB_BYTES = 200_000
export const MAX_NOTE_CHARS = 240
export const MAX_OUTPUT_TOKENS = 4_096
