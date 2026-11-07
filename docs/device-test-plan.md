# On-device test plan — the App Store build

Everything in the repository is checked against a stub: the purchase route is tested with
a chain of our own making (`node scripts/test-iap.mjs`), the UI is checked in a desktop
browser, and nothing has run on a phone. This is the list that closes that gap, and it is
also the script for the recording App Review asked for.

Build numbers move; the plan does not. Install whichever build is attached to version 1.0
(`gh workflow run asc-iap.yml -f probe=true` says which).

## 0 · Before touching the phone

- A **sandbox Apple Account** (App Store Connect → Users and Access → Sandbox → Testers).
  Sign out of the App Store in iOS Settings first, or the purchase is charged for real.
- The app installed through **TestFlight**, not a sideloaded build: StoreKit answers
  sandbox products for TestFlight and App Review, and nothing for an ad-hoc install.
- **Business → Agreements** showing the Paid Apps row as *Active*, with banking and tax
  complete. The App Store Connect API cannot read that tab, so
  `gh workflow run asc-iap.yml -f iap_status=true` is the fastest check that it is not the
  cause: a lapsed agreement is refused as `403 REQUIRED_AGREEMENTS_MISSING_OR_EXPIRED`.
  What the tab has to show is listed in `deploy/ios/README.md`.
- `https://sage.innotel.tech/api/iap/config` answering `enabled: true` with the three
  `us.innotel.sage.session.*` ids. That is what the button is built from.
- A second device or a private window on `https://sage.innotel.tech`, for the trial rule.

## 1 · First run

1. Launch with no prior data: the "What are you studying?" card appears above the capture
   buttons.
2. Type `BIO 101 — Cells` and tap **Start**. The card goes; the header course picker shows
   the name; Settings → You has it in the course field.
3. Force-quit and reopen: the card does not return, and the course name is still there.

**Pass:** a named course on first run, kept across a relaunch.

## 2 · The purchase (the one that has failed so far)

1. Settings (gear) → **Session**. Three plans are listed with the App Store's own prices
   ($3.00 / $9.00 / $19.00 in the US storefront) and the minutes each buys — the trial says
   five.
2. Choose the trial, then **Buy with the App Store**. Apple's sheet appears with the
   product name and price.
3. Confirm with the sandbox account. The app says the purchase is confirmed and installing
   the key, then **the session clock shows time left** in Settings → Gateway.
4. Ask a question on Answer: it answers with the session key.
5. Wait out the window: capture stops by itself and the next turn says the session ended.

**Pass:** sheet → confirmed → key installed → answer works → clock stops it.

**If the sheet does not appear**, record what the app says and check in this order: the
`/api/iap/config` response; the product ids in App Store Connect against that response
(character for character); whether the three consumables are still `READY_TO_SUBMIT` with
a localization, a price, availability and a review screenshot; whether the build came from
App Store Connect at all; and whether Business → Agreements still reads *Active*.

Approval is **not** the gate: a sandbox purchase works before the app is reviewed, which
is what makes it possible to test billing at all. An empty answer means the store will not
sell that product to that build, so the fault is in the account or the product record, not
in the review queue.

## 3 · One trial per person, and per connection

1. With the trial already bought on this phone, open Settings → Session and try the trial
   again: the server refuses with the trial message, and nothing is charged.
2. On the web (`sage.innotel.tech`, Settings → Session, a browser with no session), try the
   trial with the same email: refused.
3. Try it with a different email from the same network: refused, because the connection has
   already had one.
4. Bought the standard session instead? It goes through — only the trial is once.

**Pass:** four outcomes as above, and the ledger at `data/trial-claims.json` on the server
names the email and the address.

## 4 · Capture, which has never run on hardware

1. **Listen** in a quiet room: the transcript fills, notes appear within ~20 s.
2. Lock the phone with Listen running: the transcript keeps growing when it is unlocked
   (the `audio` background mode and the audio-session plugin are what this proves).
3. **Watch** on the iPhone: iOS has no in-app screen capture, so the app offers the
   broadcast route. Start it, switch to another app, and confirm notes still arrive.
4. Play audio in another app, then start Listen: the other app's audio does not stop.

**Pass:** notes arrive with the screen locked and the app backgrounded, and audio from
another app survives the microphone opening.

## 5 · What to record for App Review

One continuous take, no edits, under three minutes:

1. Launch, name the course, capture starts (Listen or Watch).
2. A question answered with the material on screen.
3. Settings → Session → the trial purchase, Apple's sheet, and the key installing.
4. A second question answered with that session key.

Attach it in App Review → Messages straight after submitting, and say in the message which
build it shows.
