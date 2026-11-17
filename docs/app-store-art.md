# App Store art: screenshots, header and search results

Everything App Store Connect asks for on the product page and in search results is
generated from the app itself, so the artwork cannot drift from the interface.

## Screenshots — `scripts/store-shots.mjs`

```sh
PORT=8799 node server.mjs &                 # 8787 is often already taken
SAGE_URL=http://127.0.0.1:8799/ node scripts/store-shots.mjs
```

Two things about that command are not incidental:

- **It must run against a local server.** The script photographs a real app, and the
  deployed site lags the repository until it is redeployed, so pointing it at
  `sage.innotel.tech` photographs whatever shipped last rather than what is in the
  tree. Set `SAGE_URL` to the loopback address of the server you just started.
- **It emulates dark mode.** App Store Connect's header and search-results slots, and
  the header art beside them, are the dark surface. A headless browser reports
  `prefers-color-scheme: light`, which the app honours, so the script sends
  `Emulation.setEmulatedMedia` for `prefers-color-scheme: dark` before the first
  navigation. Without it every capture comes back in the light theme.

A capture of an app nobody has used is a capture of its setup card, which is not what
a listing should sell. Two optional variables populate the session first:

```sh
node scripts/mock-model.mjs &                       # OpenAI-compatible, canned answers
AI_BASE_URL=http://127.0.0.1:9099/v1 AI_API_KEY=mock SESSION_GRANT_SECRET=devsecret   PORT=8799 node server.mjs &
SESSION_GRANT_SECRET=devsecret node scripts/grant-session.mjs --plan sage-session-standard   --email studio@sage.local --days 30

export SAGE_SESSION_CODE="$(cat the-code-it-printed)"
SAGE_URL=http://127.0.0.1:8799/ SAGE_POPULATE=1 node scripts/store-shots.mjs
```

`SAGE_SESSION_CODE` is redeemed through the first-run card, and `SAGE_POPULATE` drives
the app the way a student would: names the course, answers a physics question, solves a
two-question quiz, writes an essay, extracts notes from a reading, teaches it four
durable memories and runs one Evolve pass — all answered by the mock model. The
workspace lives in that profile's `localStorage`, so one population covers every slot
in the run.

It writes ten states per slot, cropped to the exact pixel sizes the console wants:

| Directory | Size | Slot |
| --- | --- | --- |
| `deploy/ios/store-phone` | 1206 × 2622 | iPhone 6.3 inch |
| `deploy/ios/store-ipad` | 2064 × 2752 | iPad 13 inch |
| `deploy/ios/store-duo` | 2007 × 2853 | iPhone Duo inner display |

`SAGE_PROFILES=store-phone` limits a run to one slot while iterating.

## Header and search-results art — `scripts/make-store-art.mjs`

```sh
node scripts/make-store-art.mjs
```

Composes `deploy/ios/store-art/header-<w>x<h>.png` and
`search-results-<w>x<h>.png` from those captures: a band of type above the app
itself, at the same slot sizes as the screenshots. The band is measured from the
copy rather than from a fraction of the height, because the iPad slot is almost
twice as wide as the phone but barely taller. Output is RGB with no alpha, which
App Store Connect requires.

`deploy/ios/store-header/header-universal.png` is a separate 5244 × 2950 asset used
by `scripts/asc-iap.mjs` through the API; it is not produced by this script.

## These files are uploaded by hand

Nothing in CI sends any of this to App Store Connect. The screenshots, the header and
the search-results art are attached in the console by hand (or through
`scripts/asc-iap.mjs` for the universal header asset only), which means a
regenerated set has no effect on the listing until someone uploads it. Running
`make-store-art.mjs` writes the files; publishing them is a separate, deliberate act.

## Palette

Both scripts read the same tokens the app uses in `public/styles.css`, taken from
the app icon: navy `#080b12` for the canvas, sky `#38bdf8` for actions and eyebrows,
mint `#6ee7b7` for rules and the second gradient stop, near-white `#e7edf7` for ink
and slate `#9aa7bb` for deck copy. Changing the palette means changing
`public/styles.css` first, then regenerating the captures, then the art.
