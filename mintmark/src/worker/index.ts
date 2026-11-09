import { Hono } from 'hono'

import { requireDb } from './db'
import type { AppContext, Env } from './env'
import { appCors, sameOrigin } from './http'
import { admin } from './routes/admin'
import { appraisals } from './routes/appraisals'
import { state } from './routes/state'

const app = new Hono<AppContext>()

app.get('/api/health', (c) => c.json({ ok: true }))

// No sign-in: the app is open, and each visitor is identified only by a hash of
// their address for their own collection and daily limit.
const api = new Hono<AppContext>()
api.use('*', appCors, requireDb, sameOrigin)
api.route('/state', state)
api.route('/admin', admin)
api.route('/appraisals', appraisals)
app.route('/api', api)

app.onError((error, c) => {
  console.error(error)
  return c.json({ error: 'Something went wrong.' }, 500)
})
app.notFound((c) => (c.req.path.startsWith('/api/') ? c.json({ error: 'Not found.' }, 404) : c.env.ASSETS.fetch(c.req.raw)))

export default {
  fetch: (request: Request, env: Env, ctx: ExecutionContext) => app.fetch(request, env, ctx),
}
