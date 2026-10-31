<div align="center">

[![Latest release](https://img.shields.io/github/v/release/innotelinc/sage?color=18181b)](https://github.com/innotelinc/sage/releases)
[![Pages](https://github.com/innotelinc/sage/actions/workflows/pages.yml/badge.svg)](https://innotelinc.github.io/sage/)
[![Theme: Unity](https://img.shields.io/badge/theme-Unity-6366f1)](https://github.com/innotelinc/innotel-platform-stack/blob/main/standards/unity/README.md)

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
> **Landing page:** [innotelinc.github.io/sage](https://innotelinc.github.io/sage) ·
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
`OPENAI_API_KEY`, `AI_CHAT_MODEL`, `AI_VISION_MODEL`, `AI_TRANSCRIBE_MODEL`, `ACCESS_CODE`, `PORT`.

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

## Architecture

```
src/persona.mjs   identity, per-task contracts, memory + JSON parsing
src/app.mjs       /api/health, /api/chat (vision-aware), /api/transcribe — standard Request/Response
public/           the app: capture pipeline, feeds, quiz/essay surfaces, memory, PWA shell
server.mjs        zero-dependency Node server: static files, API bridge, LAN URLs
worker.mjs        Cloudflare Worker entry — same handler, ASSETS binding
web/landing/      Unity-styled landing page, published to GitHub Pages
```

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
recognition instead of retrying. Enable the `openrouter` connection for the key to turn server transcription back on.

## Privacy

The key lives in `.env`, gitignored and never served — static files come only from `public/`, and traversal is
refused. Audio and frames leave the device only to reach the configured model provider. Transcripts and memory
live in the device's `localStorage`; the server keeps no state. If you expose the app publicly, set
`ACCESS_CODE` so only you can spend your credits.

## Roadmap

- **v1.0** — shipped: listening, watching, reading, quiz and essay surfaces, self-evolution memory, gateway wiring, PWA install.
- **v1.1** — shipped: hands-free study mode with automatic question detection, and the cross-device relay for mirrored phones, tablets and cast windows.
- In-app model picker that lists what a key can actually call.
- Native iOS capture, which no web page can do.

---

<div align="center">
<sub>A product of <a href="https://innotel.us">Innotel Labs</a> · Unity theme · <a href="https://innotelinc.github.io/sage">innotelinc.github.io/sage</a></sub>
</div>
