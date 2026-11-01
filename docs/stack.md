# SAGE in the Innotel Platform Stack

**Role: LearningOps (public)** — the course-taking agent: listen, watch, read,
evaluate, answer and write.

Part of the [Innotel Platform Stack](https://github.com/innotelinc/innotel-platform-stack).
The canonical definition of the stack, its shared layers and their owners lives
there; this file records only what SAGE does inside it.

## Owns

- capture of the lecture and the screen, on the phone and in the browser
- transcription, course memory and the study pack export
- decision routing: quiz answer, essay draft, notes, or "ask the human"
- the persona and the lessons learned from corrections

## Consumes

- OmniRoute / an OpenAI-compatible gateway (vision, drafting, transcription)
- Cerulean (Authentik SSO, DNS, TLS)
- Cerulean Vault (secrets), referenced as `vault://`
- NPM Edge for the public host

## Explicitly does NOT own

- identity (Authentik)
- secrets (Cerulean Vault)
- DNS/TLS (Cerulean)
- billing (Magnate)

## Service map

| Component | Technology | Job |
| --- | --- | --- |
| server | Node.js (`server.mjs`) | capture intake, routing, decisions |
| compose | Docker Compose | the self-hosted stack |
| landing | static (`web/landing/`) | the public page, Unity-themed |

## In the ecosystem

| Flow | Path |
| --- | --- |
| Model calls | SAGE → OmniRoute gateway → provider |
| Answers | server → answer card → the phone or the browser |
| Identity | Cerulean's Authentik → OIDC → SAGE sessions |
