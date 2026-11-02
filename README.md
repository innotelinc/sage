<div align="center">

[![Latest release](https://img.shields.io/github/v/release/innotelinc/sage?color=18181b)](https://github.com/innotelinc/sage/releases)
[![Website](https://img.shields.io/badge/site-sage.innotel.tech-6366f1)](https://sage.innotel.tech)
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
> **App:** [sage.innotel.tech](https://sage.innotel.tech) ·
> **About:** [sage.innotel.tech/about](https://sage.innotel.tech/about) ·
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
| Android Chrome — whole phone screen | **yes** | *Watch* → pick the screen, including other apps |
| Desktop browser — tab, window or screen | **yes** | *Watch* → pick the surface |
| Mirrored iPhone (AirPlay to a Mac/PC) | **yes** | *Watch* the mirroring window |
| iPhone screen directly | **no** | iOS has no capture API — mirror it to a computer and use the **relay**, or upload a screen recording in *Read* |
| Camera — board, projector, TV | **yes** | *Aim* |
| TV cast stream (Chromecast / AirPlay) | **no** | The stream never reaches the page — aim the camera, or capture on the receiving computer |
| Worksheet, textbook page | **yes** | Photo → *Answer* or *Read* |

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
live in the device's `localStorage`; the server keeps no state. If you expose the app publicly, set
`ACCESS_CODE` so only you can spend your credits.

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
- **v2.4** — planned: several courses in one workspace, each with its own persona and a timetable that decides which course an answer belongs to.
- **v3.0** — planned: native capture — a broadcast extension that records the screen while a lesson video plays, an on-device fallback that keeps working when the network drops, and hands-free study that survives a locked phone.
- Native iOS capture, which no web page can do.

---

<div align="center">
<sub>A product of <a href="https://innotel.us">Innotel Labs</a> · Unity theme · <a href="https://sage.innotel.tech">sage.innotel.tech</a></sub>
</div>

## Documentation

| Doc | What it covers |
| --- | --- |
| [docs/stack.md](docs/stack.md) | SAGE's role in the Innotel Platform Stack (LearningOps) |
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
