# The interface layer

SAGE's app is three files and no dependencies: `public/index.html` (markup),
`public/styles.css` (design system), `public/shell.js` (the platform frame).
`public/app.js` still owns capture, reasoning and memory — the shell owns
navigation, appearance and the small conveniences around it, so neither file
reaches into the other's job.

## Where the scale came from

The layout language was measured, not guessed. A live reference instance
(1366×599, 1988 DOM nodes, 11 stylesheets, ~1.2 MB of CSS) was inspected over
the Chrome DevTools Protocol and the following were adopted:

| Measured | Value | Used for |
| --- | --- | --- |
| Sticky header | 56 px, `position: sticky; top: 0` | `.topbar` (`--topbar`) |
| Rail | 280 px fixed column, `flex-direction: column` | `.sidebar` (`--rail`) |
| Body type | 16 px / 24 px Inter-first stack | `--font`, base `body` |
| Heading | 20 px, weight 600, `-0.33px` tracking | `h1`–`h4`, `-0.03em` |
| Radius scale | 3, 4, 6, 8, 12, 16, 24 px, 999 px pill | `--r1`–`--r6`, `--r-full` |
| Spacing scale | 4, 8, 12, 16, 24, 32, 40, 48 px | `--s1`–`--s8` |
| Search affordance | `Ctrl/⌘ K` in the header | command palette |
| Motion policy | `prefers-reduced-motion` honoured | global media query |
| Focus policy | `:focus-visible` ring, 248 such rules in the reference | `:focus-visible` |

What was **not** copied: the reference's palette. The reference is near-black
on white with a single green action (`rgb(33, 131, 88)`); SAGE keeps its Unity
indigo for action and uses that green family — `#2f9e6b` / `#218358` — only for
live and success state. Neutral surfaces, radii and type follow the reference.

## What the shell adds

- **Command palette** — `⌘K` / `Ctrl K`, or the *Command* button in the rail.
  Jumps to any tab and runs the real actions: study mode, stop capture, sync,
  evolve, study pack, revision sheet, settings, theme.
- **Keyboard** — `1`–`9` switch tabs (`7` is the reader, `8` Foundation, `9`
  Memory), `R` opens Review, `/` focuses the current tab's field, `s` toggles
  study mode, `.` stops all capture, `t` cycles the theme, `?` opens the shortcut
  sheet. All of it is suppressed while you are typing in a field or while a
  dialog is open, except `⌘K`.
- **Theme** — auto / dark / light, persisted in `localStorage` under
  `sage.shell.v1`, painted before first paint so there is no flash, and
  re-applied when the OS preference changes.
- **Deep links** — `#live`, `#quiz`, `#memory` and so on are kept in sync both
  ways, so a tab can be bookmarked or opened from the palette.
- **Live state** — the capture pill in the header and the document title mirror
  app.js's own `.on` classes through a `MutationObserver`; the shell never keeps
  a second copy of that state.
- **Connection banner** — `offline`/`online` plus a `/api/health` probe, with a
  retry, instead of silently failing requests.
- **Mobile** — the rail becomes an off-canvas drawer with a scrim, `aria-expanded`
  on the trigger, and `Escape` to close.
- **Install** — a real install button, shown only when the browser fires
  `beforeinstallprompt`.

## Accessibility

Skip link to `#main`; `role="tablist"`/`tab`/`tabpanel` with `aria-selected`
maintained in step with the visible panel; `aria-live` on the transcript, notes,
toast and connection banner; every icon-only control named; 36 px minimum
targets; focus returned to the panel on tab change; `prefers-contrast` and
`prefers-reduced-motion` honoured; a print stylesheet that strips the chrome.

## Running it

```bash
npm run dev                      # http://localhost:8787
docker compose up -d --build     # same, in the container
```

The compose file needs no `.env` to boot — it is an optional `env_file`. Host
ports are `${SAGE_HTTP_PORT:-8787}` and `${SAGE_HTTPS_PORT:-8443}`, and the API
key only ever arrives as a runtime environment variable.
