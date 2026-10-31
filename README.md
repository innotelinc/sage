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

## Capture matrix

A web page cannot read an iPhone screen or a cast stream. This is what actually works:

| Source | Capturable | How |
| --- | --- | --- |
| Android Chrome — whole phone screen | **yes** | *Watch* → pick the screen, including other apps |
| Desktop browser — tab, window or screen | **yes** | *Watch* → pick the surface |
| Mirrored iPhone (AirPlay to a Mac/PC) | **yes** | *Watch* the mirroring window |
| iPhone screen directly | **no** | iOS has no capture API — Control Center recording, then upload in *Read* (frames are sampled) |
| Camera — board, projector, TV | **yes** | *Aim* |
| TV cast stream (Chromecast / AirPlay) | **no** | The stream never reaches the page — aim the camera, or capture on the receiving computer |
| Worksheet, textbook page | **yes** | Photo → *Answer* or *Read* |

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
- In-app model picker that lists what a key can actually call.
- Cross-device relay from a computer capturing a mirrored phone or TV.
- Hands-free classroom mode that offers the line to say, unprompted.

---

<div align="center">
<sub>Part of the Innotel platform · Unity theme · <a href="https://innotelinc.github.io/sage">innotelinc.github.io/sage</a></sub>
</div>
