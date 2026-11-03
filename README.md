<div align="center">

[![Latest release](https://img.shields.io/github/v/release/innotelinc/sage?color=18181b)](https://github.com/innotelinc/sage/releases)
[![Website](https://img.shields.io/badge/site-innotelinc.github.io%2Fsage-6366f1)](https://innotelinc.github.io/sage)
[![Pages](https://github.com/innotelinc/sage/actions/workflows/pages.yml/badge.svg)](https://innotelinc.github.io/sage/)
[![Theme: Unity](https://img.shields.io/badge/theme-Unity-6366f1)](https://github.com/innotelinc/innotel-platform-stack/blob/main/standards/unity/README.md)

[![CI](https://github.com/innotelinc/sage/actions/workflows/ci.yml/badge.svg)](https://github.com/innotelinc/sage/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

# 🎓 SAGE — Course-Taking Agent

**It sits in the lecture, watches the slides, reads the material, answers quizzes and writes essays — in your voice.**

SAGE is a self-hosted course-taking agent for a phone or a browser. It listens to the lecture, samples the
screen or the board, reads what it was given, and then answers as a capable student rather than as an
assistant: quizzes, tests and essays, with the working and the confidence that earn the mark. Three layers
shape every reply — a formed personality, your settings, and memory it wrote itself between classes. The
interface follows the shared **Unity** theme, and the whole thing runs on plain Node with **zero dependencies**.

</div>

---

## Why SAGE

| Problem | SAGE answer |
| --- | --- |
| Notes miss the thing the instructor stressed | Transcript and frames are digested every ~20s into notes, with exam hints tagged `EXAM:` |
| Generic AI answers sound nothing like you | A formed student voice, not an assistant; tone, depth, humour and risk appetite are yours to set |
| Nothing is remembered between classes | Durable facts are stored as it works; **Evolve** rewrites its own behaviour traits from what actually happened |
| A quiz arrives as a photo, not text | Camera, screen share, screenshots and screen recordings all become answers |
| Essays that read machine-written, with invented citations | Argued in a line, cites only material you supplied, never fabricates a reference |
| Assistant tooling that needs a cloud account | Self-hosted, single process, installable to the home screen, key stays on the server |

> **About SAGE** — a course-taking agent: it listens, watches, reads, evaluates, decides, and evolves.
> The perception layer is live microphone transcription plus sampled screen, camera and file frames;
> the reasoning layer is one persona file with a separate contract per task (`note`, `answer`, `quiz`,
> `essay`, `read`, `phrase`, `evolve`); the memory layer persists in the browser and is fed back on every
> turn. It ships wired to the **Innotel OmniRoute** gateway, works with any OpenAI-compatible endpoint, and
> runs unchanged as a Node process or a Cloudflare Worker.
>
> **A product of [Innotel Labs](https://innotel.us)** — applied AI, learning platforms, and the systems behind them.
>
> **App:** [innotelinc.github.io/sage](https://innotelinc.github.io/sage) ·
> **About:** [innotelinc.github.io/sage](https://innotelinc.github.io/sage) ·
> **Releases:** [github.com/innotelinc/sage/releases](https://github.com/innotelinc/sage/releases)

---

## What it does

- **Listens** — live transcript via on-device speech recognition, with chunked server transcription where the key allows it.
- **Watches** — screen share, phone camera or uploaded screen recording; frames sampled every few seconds and read as they change.
- **Reads** — slides, photographs, handouts and pasted text become study notes, likely exam questions and gaps in the material.
- **Answers** — one question, typed or photographed, with the answer first, the working behind it, a confidence bar and a line you can say out loud.
- **Quizzes** — paste a whole paper or photograph the page; it answers in order, one decision at a time, with mark-earning points.
- **Essays** — prompt plus rubric plus sources, argued and in your register, copyable or downloadable as Markdown.
- **Evolves** — reviews its own session notes and rewrites behaviour traits that carry into the next class.

## Quick start

```bash
cp .env.example .env      # add your gateway key
npm run dev               # http://localhost:8787
```

No install step: no dependencies, Node 20+. Set `AI_BASE_URL` for any OpenAI-compatible provider.

**Install on a phone:** open the app, then *Add to Home Screen*. Mic and screen capture require a secure
context — `https://` or `localhost` — so use a tunnel or a deployment rather than a bare LAN address.

## Run it in Docker

The image is Node plus the source — there is no `npm install` layer, because the app has no dependencies.

```bash
docker compose up -d --build     # reads .env from the host, serves http://localhost:8787
```

Or without Compose:

```bash
docker build -t sage .
docker run -d --name sage -p 8787:8787 --env-file .env sage
```

Your key is passed in at runtime from `.env`; `.dockerignore` keeps `.env`, `.git` and local state out of the
image, so a built image is safe to share. Every setting is an ordinary environment variable: `AI_BASE_URL`,
`OPENAI_API_KEY`, `AI_CHAT_MODEL`, `AI_VISION_MODEL`, `AI_TRANSCRIBE_MODEL`, `ACCESS_CODE`, `PORT`, and optionally `STT_BASE_URL`, `STT_API_KEY`, `STT_MODEL`.

Run **exactly one container**. The relay keeps frames in the process's memory, so a second replica would never
see what the first one received. Set `ACCESS_CODE` when the instance is reachable by anyone but you.

### Serving HTTPS

Microphones and screen capture need a secure context, so a bare `http://192.168.x.x` address will not let a phone
listen or watch. Point `TLS_CERT` and `TLS_KEY` at a certificate and the same server speaks HTTPS on `PORT`
instead — no extra proxy container:

```bash
PORT=8443
TLS_CERT=/app/certs/fullchain.pem
TLS_KEY=/app/certs/privkey.pem
```

`./certs:/app/certs:ro` is already mounted by the compose file. The image runs as uid 1000, so the material has to
be readable by it: `chown -R 1000:1000 certs`, a traversable `certs/` directory, `chmod 600` on the key.

Issuance belongs to **Cerulean**, not to this repo: register the name in a zone it manages, let it issue the
certificate (ACME DNS-01 through Technitium), then copy the material onto the host. A zone wildcard covers every
name beneath it, so `sage.<zone>` needs only the DNS record.
## Capture matrix

A web page cannot read an iPhone screen or a cast stream. This is what actually works:

| Source | Capturable | How |
| --- | --- | --- |
| Android app — whole phone screen, in another app | **yes** | *Watch* → capture runs as a foreground service, so it keeps sampling while the course app is in front. The notification says when it is on |
| Android Chrome — whole phone screen | **yes** | *Watch* → pick the screen. Chrome ends the capture when it leaves the foreground; the app does not |
| Desktop browser — tab, window or screen | **yes** | *Watch* → pick the surface |
| Mirrored iPhone (AirPlay to a Mac/PC) | **yes** | *Watch* the mirroring window |
| iPhone screen directly | **yes, from the app** | *Watch* → the system broadcast sheet → start it, then switch to the course app. A ReplayKit broadcast extension keeps recording; notes are waiting when you return |
| iPhone screen from a browser | **no** | A web page cannot start a broadcast — use the app, mirror it and use the **relay**, or upload a screen recording in *Read* |
| Camera — board, projector, TV | **yes** | *Aim* |
| TV cast stream (Chromecast / AirPlay) | **no** | The stream never reaches the page — aim the camera, or capture on the receiving computer |
| Worksheet, textbook page | **yes** | Photo → *Answer* or *Read* |

## Buying a session

A session is a timed key: pay once, use the gateway as often as you like until the window closes. Buying used
to mean opening Magnate in another tab and copying a claim code back; it is now a block in **Settings → Session**.

| Step | Where it happens |
| --- | --- |
| Prices and plans | `GET /api/store` reads them from Magnate's own page, cached ten minutes |
| Payment | `POST /api/store/checkout` asks Magnate for a Stripe URL and opens it |
| Key installs itself | the receipt page opens this app at `#claim=<code>`, which `POST /api/claim` trades for the key |

On iOS the payment has to be an App Store purchase: `Settings → Session` asks StoreKit for the session
product, and the **signed transaction** it returns is checked here against Apple's root certificate before a
key is minted — no App Store Server API key is involved, and the product comes from Apple's signed payload
rather than from the request. That needs three consumables in App Store Connect and `IAP_MINT_URL` on the
server (see `deploy/ios/README.md`); until then the phone says so instead of offering a purchase it cannot
complete.

The browser never talks to a billing origin directly — CORS forbids it and the plan list would be a second
place to keep in step — so both calls are proxied by the server. `MAGNATE_URL` points it at a different store,
and if the catalog cannot be read the app offers the store link rather than inventing a price or a slug.

## Study mode (hands-free)

One toggle starts the behaviour that matters in a lecture: the mic and the screen run together, notes accumulate,
and when a question shows up in the transcript it answers on its own — throttled to one answer every 45 seconds so
it does not fill the room with text. Nothing to tap while the class is moving.

## Reading another app on the same phone

You cannot study in one app and capture that app from a web page on iOS — the platform forbids it. Three paths,
in order of fidelity:

| Setup | What happens |
| --- | --- |
| **Android — direct capture** | Start *Watch*, choose the whole screen, then switch to the course app. Sage keeps sampling frames and reading what is on screen, with the audio. |
| **iPhone / TV — mirror + relay** | Mirror the phone to a Mac or PC (AirPlay, or a QuickTime recording window). Open `/relay.html` there, share the mirrored window, and it publishes frames under a short code. Join that code in *Live* on the phone: analysis appears on the phone while the course app stays in front. A TV cast window works the same way. |
| **iPhone — recording** | Record the screen from Control Center and upload the video in *Read*. Best for material you can replay, not for live answers. |

Relay frames live in the server process and expire after ten idle minutes, so the relay needs the single Node
server rather than a multi-isolate Worker deployment.

## Voice

Answers are read aloud. The default is the browser`s own `speechSynthesis`, which is free and instant but sounds
like a screen reader and differs on every device. Point `TTS_URL` at the bundled Kokoro sidecar and the same
replies come from **Kokoro-82M** instead — Apache-2.0, ~340 MB of ONNX, faster than realtime on a couple of CPU
cores, so no GPU and no per-character bill.

```bash
TTS_URL=http://127.0.0.1:8880
TTS_VOICE=af_heart      # af_bella, af_nicole, am_michael, bf_emma, bm_george …
TTS_SPEED=1
```

`deploy/kokoro/` carries the service, the systemd unit and the model fetch. It is `kokoro-onnx`, not the torch
build, precisely so a CPU host can serve it. With no `TTS_URL` the app keeps working and the client falls back to
the browser — speech is never a hard dependency.

## Architecture

```
src/persona.mjs   identity, per-task contracts, memory + JSON parsing
src/app.mjs       /api/health, /api/chat (vision-aware), /api/transcribe — standard Request/Response
public/           the app: capture pipeline, feeds, quiz/essay surfaces, memory, PWA shell
server.mjs        zero-dependency Node server: static files, API bridge, LAN URLs
worker.mjs        Cloudflare Worker entry — same handler, ASSETS binding
web/landing/      Unity-styled About page, served at /about; published to GitHub Pages too
```

The app owns the root. `web/landing/` is served at `/about` (and everything under it,
stylesheet and theme script included) rather than at `/`, so the marketing page cannot
stand in front of the thing you came to use. The same tree is what the Pages workflow
publishes to innotelinc.github.io/sage.

The API handler is written against standard `Request`/`Response`, so the Node server and the Worker share one
code path. Nothing is duplicated between runtimes.

## Gateway and models

Any OpenAI-compatible endpoint works; this build ships pointed at the Innotel gateway.

| | |
| --- | --- |
| Endpoint | `https://gateway.innotel.us/v1` |
| Verified model | `agy/gemini-3-flash` — text and vision, ~1.0–1.4 s |
| Keys | [subscribe.innotel.us](https://subscribe.innotel.us) |

Measured against a live key, rather than assumed:

| Route | Result |
| --- | --- |
| `agy/gemini-3-flash` (text, vision) | **200** |
| `agy/gemini-4-argon-medium` | 200, ~4 s — no advantage |
| `agy/claude-sonnet-4-6` | 400 — not in the active live set |
| `auto/claude-sonnet`, `auto/claude-opus` | 503 — targets skipped by pre-dispatch filter |
| `openrouter/*`, including all audio models | 403 — excluded by the key's connection allowlist |

A key's connection allowlist, not the 1,249-model list, is the real contract. Because no audio route is
reachable here, server transcription answers 403; SAGE detects that once and falls back to on-device speech
recognition instead of retrying. Enable the `openrouter` connection for the key to turn server transcription back on — or give transcription a route of its own: when `STT_API_KEY` is set, `/api/transcribe` uses `STT_BASE_URL`/`STT_MODEL` on that key instead of the gateway, so an audio-capable provider is enough even when the chat key reaches no audio model.

On the deployed instance that route is a Whisper sidecar in the SAGE container (`deploy/stt`): faster-whisper on CPU,
int8, on `127.0.0.1:8881`, no provider key and no per-minute cost. Measured on the container's two cores with the same
5.6s clip, `Systran/faster-whisper-base.en` transcribed in 1.3s (5.3x realtime) and `Systran/faster-whisper-small` at
0.85x with identical text, so base.en is the default and `STT_MODEL` switches to a multilingual model when lectures
are not in English.

## Operator panel (`/admin`)

The access code, and what the instance is doing, sit behind Cerulean SSO instead of an `.env` edit and a restart:

| Step | What to do |
| --- | --- |
| 1 | In Authentik, create an OIDC provider and application for Sage with the redirect URI `https://sage.innotel.tech/admin/callback` |
| 2 | Set `CERULEAN_ISSUER`, `CERULEAN_CLIENT_ID`, `CERULEAN_CLIENT_SECRET`, `SAGE_ADMIN_SECRET` (`openssl rand -base64 48`) and `SAGE_ADMIN_EMAILS` |
| 3 | Open `/admin`, sign in with Cerulean, then set or replace the access code |

The code is kept as a salted SHA-256 digest in `data/settings.json` (mode 0600, on the `sage-data` volume), never in
plain text, and it beats `ACCESS_CODE` from the environment once set here — including an explicit *remove the code*,
which reopens the instance even while `ACCESS_CODE` is still in the container's environment. Sign-in is authorization
code + PKCE with a state and nonce bound to a short-lived cookie; the session cookie is HMAC-signed for eight hours;
every write is same-origin and CSRF-checked; an account signed in to Cerulean but absent from `SAGE_ADMIN_EMAILS` gets
a 403, not a session. The panel also reports the instance's model routing and a seven-day tally of the calls it answered.

## Privacy

The key lives in `.env`, gitignored and never served — static files come only from `public/`, and traversal is
refused. Audio and frames leave the device only to reach the configured model provider. Transcripts and memory
live in the device's `localStorage`. A workspace can also be kept on the server so the phone and the
browser agree: one JSON document per identity under `SAGE_DATA_DIR` (default `data/workspaces`), keyed to
a signed-in panel session or to the access code, written whole and renamed into place, and removed with
`DELETE /api/workspace`. Nothing is stored there unless the app is given a code or a panel session. If you
expose the app publicly, set `ACCESS_CODE` so only you can spend your credits.

## Subscriptions (SaaS)

Setting `STRIPE_SECRET_KEY` turns the instance from *one access code* into *one account per subscriber*.
`/account` serves sign-up, sign-in, plan selection and the Stripe billing portal; every other `/api` route
needs a live subscription, and answers are counted against the plan's monthly cap. Without the key nothing
changes — the self-hosted path above is untouched.

| Env | What it does |
| --- | --- |
| `STRIPE_SECRET_KEY` | Turns the subscription gate on. Checkout and the portal call Stripe's REST API directly — no SDK. |
| `STRIPE_WEBHOOK_SECRET` | Verifies signed events. The webhook is the only writer of subscription state; an unsigned or stale event is refused. |
| `SAGE_SESSION_SECRET` | Signs the subscriber cookie. `SAGE_ADMIN_SECRET` is a fallback; separate is better. |
| `APP_ORIGIN` | Where Stripe returns the browser after checkout. |
| `TRIAL_DAYS` | Free trial on a first subscription (default 7, `0` disables). |
| `AI_API_KEY` | Set this on a SaaS instance: a subscriber should not need a gateway key of their own. |

Plans and their limits live in `src/plans.mjs`; checkout sends the price inline, so a plan needs no dashboard
setup until you pin `STRIPE_PRICE_*` ids for prices that must never move. Accounts are one JSON document per
instance under `SAGE_DATA_DIR`, written atomically, passwords stored as salted scrypt digests.

```bash
node --test scripts/test-saas.mjs        # accounts, gate, webhook signatures, quota
stripe listen --forward-to localhost:8787/api/billing/webhook
```

Accounts need a filesystem, so the subscription gate is Node-only: run the container, not the Worker entry.
`TRUSTMRR.md` covers listing the resulting SaaS for sale, and what has to be true before the numbers are worth verifying.

## Availability

The iPhone build is finished but **not yet in the App Store**: there is no listing to link, so the sites say
that plainly rather than showing a download badge. Until it ships, the same app installs from Safari with
*Share → Add to Home Screen*. The web build at `sage.innotel.tech` is the current release surface.

## Roadmap

- **v1.0** — shipped: listening, watching, reading, quiz and essay surfaces, self-evolution memory, gateway wiring, PWA install.
- **v1.1** — shipped: hands-free study mode with automatic question detection, and the cross-device relay for mirrored phones, tablets and cast windows.
- **v1.2** — shipped: automatic model choice — the app ranks the models the key in use can actually call, uses the best one, and falls back to the configured default if the gateway refuses it; and sessions bought at Magnate that install themselves from the receipt, with no key to copy.
- **v1.3** — shipped: per-task model routing — running notes and spoken phrasing take the fastest model the key can call, while answers, quizzes and essays take the strongest; both chosen automatically, no setting to get wrong.
- **v1.4** — shipped: the session clock — a bought session's remaining minutes are shown, and capture stops by itself when the window closes instead of spending turns on 401s.
- **v1.5** — shipped: capture that survives playback — the microphone is taken back by itself when a lesson video interrupts it, Apple's own screen recorder can be imported and read in one tap, Settings closes with an ✕ and never opens itself when you return to the app, and an answered question's photo is cleared rather than reused for the next one.
- **v2.0** — shipped: the operator panel — the access code, model routing and a seven-day usage tally behind Cerulean SSO, changed live with no restart, so the code is set from a phone instead of a shell.
- **v2.1** — shipped: Windows and Android builds, and transcription that runs on your own machine instead of through a vendor's cloud.
- **v2.2** — shipped: the App Store and TestFlight icon the iOS job had been shipping a placeholder for, and answers that argue their case — every answer carries the reasoning, every quiz item names the options it ruled out, and every essay ends with how to explain it in your own words.
- **v2.3** — shipped: study packs — a course exported as one file (notes, corrections, every answer, quiz item and source, with the reasoning attached) and merged on another device, plus a print-ready revision sheet.
- **v2.4** — shipped: several courses in one workspace — each with its own persona, memory and record, a switcher in the header, and a timetable that hands a class's window to its own course so the right course answers while you are looking at another; a study pack imports into the course of the same name, or arrives as a new one.
- **v2.5** — shipped: course memory on the server — the workspace follows you between the phone and the browser under one identity (a panel session, or the access code), saved whole and renamed into place so a half-written copy is never read back, the newer save winning when two devices disagree, and nothing kept
at all on an instance with no code and no sign-in.
- **v2.5.1** — shipped: watching the screen after you leave the app — the Android build now captures through its own foreground service (a MediaProjection of the whole display) instead of the browser's, so *Watch* keeps sampling when the course app comes to the front, and an ongoing notification says it is still running so it is never silent.
- **v2.6** — shipped: buying a session inside the app — Settings → Session lists the plans with their prices, takes the email the receipt goes to, starts the Stripe checkout through the server, and the key installs itself when the receipt reopens the app.
- **v2.7** — shipped: in-app purchase on iOS — the session is a StoreKit consumable, its transaction is verified against Apple before a key is minted, and the web keeps the Stripe storefront.
- **v2.8** — shipped: foundation documents — a course carries its own PDFs, Word files, screenshots and recordings, each read once on the server and then used by Answer, Quiz and Read, with a scan that has no text layer saying so instead of pretending it was read.
- **v2.9** — shipped: grounded essays — the foundation documents now reach Essay as well, and a reply that leaned on them names the files it used, so a mark can be traced back to the page it came from.
- **v3.0** — shipped: a turn survives the network — a question that cannot reach the server is kept on the device (text only, never a photo) and replayed the moment the connection returns, into the tab that asked; the native capture work continues separately, and no iOS build is in the App Store yet.
- **v3.1** — shipped: Essay takes photographs — the prompt, a handout, a page of handwritten notes or a whiteboard can be attached instead of typed, read before a word is written, and then cleared so the next essay never inherits the last one's page; the [v4.0 plan](docs/roadmap-4.0.md) carries the rest.
- **v4.0** — shipped: capture that outlives the app — the iOS broadcast extension keeps reading the screen with Sage in the background or the phone locked, Android keeps its own foreground service, and the server is the meeting point between an extension that cannot hold a secret and the app that owns the session.
- **v4.1** — shipped: a kept turn keeps its photos — a question photographed in a dead spot is stored with its images in an IndexedDB store capped by total bytes and evicting oldest first, replayed once with the picture attached, and the images are dropped when the answer lands.
- **v4.2** — shipped: a citation you can turn to — a PDF whose text streams line up with its pages is offered page by page, a grounded reply cites the page it used as [file p.N], and the page opens from the copy the course already holds; a citation to something never supplied is dropped rather than shown.
- **v4.3** — shipped: exam rehearsal — a timed paper set from the course's own material, sat in the app with a clock that runs on the deadline rather than on the last tick, and marked question by question against the marks it set: no answer, hint or marking note appears before it is submitted, and each question comes back with the one thing that would have earned the rest.
- **v4.4** — shipped: audio-only lectures — a lecture with no screen is taken by the microphone alone, each fragment reaches the notes with the offset range it covers, every note carries the moment it came from as [lecture M:SS], and the recording stays on the device so tapping that moment replays it from there; an offset that was never given is never cited.
- **v4.5** — shipped: one search across every course — a query runs on the device over every course's notes, answers, quiz items, essays and foundation pages, needs all of its words, ranks what mentions them most (and in the title) first, and opens each hit where it came from; a PDF with real page boundaries is searched page by page, and anything else opens as one document rather than pretending to a page. Essay reads the uploaded brief into the question and the rubric, and drafts from *what you understand* — the notes, answers, quiz items and practice exams the course has already gathered, in your own words.
- **v4.6** — shipped: spaced revision — a paper's lost marks, and quiz items or answers the model was under 60% sure of, become a queue on 1/3/7/21-day intervals: right moves a question out, wrong returns it to tomorrow, four in a row retires it. A five-minute daily session asks only what is due, with the backlog, the streak and the next date stated plainly, and the queue is kept on the device per course.
- **v4.6.1** - shipped: listening that survives leaving the app on iOS. The WebView's microphone borrows the app's single audio session; the native side now makes that session play-and-record with `.mixWithOthers`, so opening the microphone no longer interrupts an audiobook playing in another app, the session is held while Sage is listening, and it is retaken after a call or alarm ends. Screen capture was already a ReplayKit extension; this is the audio-only path.
- **v4.7** — shipped: handoff between devices — a live session record (course, the notes so far, and which device holds the microphone) is written while a lecture runs, not when something is saved. Another device opening the app is offered the session and carries its notes across, deduplicated, and only one device may hold the microphone: when one starts capturing, the other stops and says so. The record expires four hours after its last heartbeat.
- **v4.8** — shipped: documents that work offline — every foundation document is kept on the device as well as in the workspace, under its own budget with a content hash per file. The Foundation panel says which documents this device can ground on, and reconciling with the server refreshes the copy whose text changed and drops the ones the course no longer holds. A question asked with no connection is kept with the documents it was asked against, and its reply cites the cached copy by name and page.
- **v4.9** — shipped: accessible and multilingual — capture state and every finished reply are announced in a live region rather than only drawn, the citation viewer takes and returns focus and traps Tab, choosing a tab lands focus in its panel, and the fields that hold material carry labels. The course language sets the document's direction: Arabic, Hebrew, Persian, Urdu and Sorani render right to left, while page labels, code and citation chips keep their own direction so punctuation is not mirrored.
- **v5.0** — shipped: share a course — a read-only link to a course or a single document, opened by anyone holding it with no account: the notes and the documents, with the sharer’s name on what they contributed. A share is a snapshot, not a window: it carries no memory, no answers and no settings, it cannot be written to, and it expires after thirty days. Shared documents are stored once by content hash, so the same handout shared by two people is one file with two names on it.

---

<div align="center">
<sub>A product of <a href="https://innotel.us">Innotel Labs</a> · Unity theme · <a href="https://innotelinc.github.io/sage">innotelinc.github.io/sage</a></sub>
</div>

## Documentation

| Doc | What it covers |
| --- | --- |
| [docs/stack.md](docs/stack.md) | SAGE's role in the Innotel Platform Stack (LearningOps) |
| [docs/interface.md](docs/interface.md) | the interface layer: rail, command palette, theme, shortcuts, deep links |
| [docs/roadmap-4.0.md](docs/roadmap-4.0.md) | v4.0: background capture, offline photos, citable pages, exam rehearsal |
| [README.md#architecture](README.md) | how capture, memory and routing fit together |

## License

MIT — see [LICENSE](LICENSE). No vendored upstream code.

*SAGE — listens, watches, reads, evaluates. © 2026 Darnel Hunter*

## 🏛️ Platform stack

SAGE is the ecosystem's **LearningOps** platform in the
[**Innotel Platform Stack**](https://github.com/innotelinc/innotel-platform-stack) —
the canonical single-responsibility architecture where Authentik owns identity,
Cerulean Vault owns secrets, Cerulean owns trust, ONYX owns storage, Magnate owns
revenue, NPM Edge owns the edge, and every other platform is a business function
that consumes them. See [docs/stack.md](docs/stack.md) for this platform's
owns/consumes boundaries.
