# Mintmark

Photograph the front of a coin and get an appraisal: what it is, how worn it
is, and what a collector would pay — with the reasons and the checks that would
confirm it.

It runs on Freebuff Sites with D1 for the collection. There is no sign-in: the
app is open, and each visitor's coins are kept under a hash of their IP address.
The vision key stays on the server, pasted in the admin panel or set as an
environment variable.

## How an appraisal works

1. The browser scales the photo down (long edge 1280px, JPEG) and sends it plus
   an optional note to `POST /api/appraisals`.
2. The Worker checks the image and the visitor's daily limit, then posts the
   photo to the Mintmark gateway (an OmniRoute `/v1` endpoint) asking for
   schema-constrained JSON, so the reply is an object rather than prose.
3. The reply is validated and clamped server-side (confidence 0–1, grade 1–70,
   low ≤ high, no value when unidentified) before it is stored.
4. The appraisal, its photo and a thumbnail go into D1, scoped to that visitor's
   hashed address. Only a successful appraisal counts against the daily limit.

## Run it

```sh
npm install
npm run dev        # http://localhost:5173 with local D1 (Miniflare)
npm run build      # dist/client (assets) + dist/mintmark/index.js (Worker)
```

Open the app, then `/admin`, and paste a Mintmark key. Without a key the capture
page explains what is missing; the app unlocks on its own once a key is saved.

## Admin

`/admin` (also the key icon at the bottom of the sidebar) holds the deployment's
settings, and they live in D1 so changing them needs no redeploy:

- **Gateway key** — pasted, checked against `GET /v1/models` before it is saved,
  then stored server-side. Only a mask like `sk-…80ad` is ever sent to a browser.
  Remove it again with **Remove key**.
- **Require a gateway key** — on by default: appraisals are blocked, with a
  setup notice, until a key exists. Turned off, the app lets anyone press
  Appraise; with no key the gateway call fails with its own message.
- **Model and gateway URL** — read-only; set by `MINTMARK_MODEL` and
  `MINTMARK_BASE_URL`.

There is no authentication in front of `/admin`, because the app has no
accounts. Deploy it for personal use, or put the site behind Cloudflare Access
if it should not be public.

## The gateway and its key

Photos are read by the OmniRoute gateway at `https://gateway.innotel.us/v1`, an
OpenAI-compatible surface. The app holds no provider key: it sends a **Mintmark
key** (sold through Magnate) as `Authorization: Bearer …`, and the gateway
verifies it, bills it, and routes the request to a vision model.

- Never ask for the key in chat, print it, log it, commit it, or put it in
  browser code. The app only ever tells the browser whether a key is set.
- Locally it lives in `.env` (see `.env.example`), which Git ignores and
  Wrangler reads. Do not add a `.dev.vars` file: when one exists, Wrangler stops
  reading `.env`.
- On Freebuff Sites, set `MINTMARK_API_KEY` in Sites → Secrets as a fallback, or
  paste the key in `/admin` after the first deploy. A key saved in the panel
  wins over the environment variable.
- `MINTMARK_MODEL` picks the model. Ids take the form `<provider>/<model>`.

**The catalogue is not the routing table.** `GET /v1/models` lists far more ids
than the deployment actually serves, so a listed id can still fail:

```sh
curl https://gateway.innotel.us/v1/models -H "Authorization: Bearer $MINTMARK_API_KEY"
```

The pinned default, `gemini/gemini-3-flash-preview`, was verified against a real
key: it reads a photo and answers strict `response_format: json_schema` in about
two seconds. `gemini/gemini-3.6-flash`, `gemini/gemini-4-argon` and
`gemini/gemini-3.1-pro-preview` are listed but answer *"not available in the
active live catalog"*; `gemini/gemini-2.5-flash` accepts the photo but rejects
JSON mode. If you change the model, check it with a real photo first.

Structured output is provider-dependent, so the Worker asks for `json_schema`
first, retries with `json_object`, and finally sends the prompt alone — the
reply is validated and clamped either way. An appraisal costs one vision call
and nothing when the gateway refuses a request; `DAILY_APPRAISAL_LIMIT` of 25
per visitor per day caps the spend.

## Deploy to Freebuff Sites

1. `sites_create`, then `sites_add_storage` for D1 named `DB`.
2. `npm run build`, then `sites_deploy` with `deploy.json`.
3. Open the deployed site's `/admin` and paste the key, or set
   `MINTMARK_API_KEY` in Sites → Secrets. Until then the capture page shows the
   setup notice.

## Where things are

- `src/shared/config.ts`: name, the appraiser's instructions, the JSON schema,
  the gateway URL and default model, `DAILY_APPRAISAL_LIMIT` and the size caps.
- `src/worker/vision.ts`: the gateway request, error mapping, the key check, and
  the validation/clamping of the reply (`normalize`). `gateway.ts` resolves which
  key and model to use; `http.ts` holds the visitor hash and the same-origin
  guard.
- `src/worker/routes/appraisals.ts`: create, list, read, delete one and delete
  all. `routes/state.ts` serves `/api/state`; `routes/admin.ts` saves the key and
  the access toggle. `db.ts` owns the schema (created on first request), the
  settings table and the usage count.
- `src/app/pages/Capture.tsx`: drop zone, camera, paste, note and the appraise
  button. `Admin.tsx`: key and access. `Settings.tsx`: usage, connections and
  delete-everything. `AppraisalView.tsx`: the value card, grade scale, drivers,
  checks and red flags.
- `src/app/lib/image.ts`: the client-side downscale. `lib/api.ts`: queries and
  mutations. `components/Shell.tsx`: the collection sidebar.
- `src/styles.css`: warm paper, ink and brass tokens, plus `.label-caps` (small
  museum labels) and `.coin-photo` (the table the coin sits on).

## What this is not

One photo of the obverse cannot prove authenticity, metal, weight or grade. The
app says so on every result: ranges widen when the model is unsure, common worn
coins come back worth cents, and it suggests what to photograph next. It is not
a professional grading and not an offer to buy.

## Security notes

There is no session and no cookie, so there is nothing cross-site to ride on;
mutations that announce an `Origin` must match the site's own origin. Queries are
scoped by the visitor hash, never by an id from the client, and the raw address
is never stored. The Worker only accepts JPEG/PNG/WebP data URLs under 2 MB,
caps the note at 240 characters, allows one appraisal in flight per visitor, and
answers with `Cache-Control: private, no-store`. Keys are stored in D1 and only
ever leave the Worker towards the gateway.
