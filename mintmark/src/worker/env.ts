export interface Env {
  ASSETS: Fetcher
  // Attached by Freebuff Sites once provisioned (sites_add_storage). Optional so
  // the app can explain what is missing instead of crashing.
  DB?: D1Database
  // A Mintmark key for the OmniRoute gateway, sold through Magnate. Optional:
  // the admin panel can store a key in D1 instead, and this one is the fallback.
  // It is read in settings.ts and nowhere else, and never leaves the Worker.
  MINTMARK_API_KEY?: string
  // Optional overrides; they default to GATEWAY_BASE_URL and VISION_MODEL in
  // shared/config.ts.
  MINTMARK_BASE_URL?: string
  MINTMARK_MODEL?: string
}

export type Variables = {
  db: D1Database
}

export type AppContext = { Bindings: Env; Variables: Variables }
