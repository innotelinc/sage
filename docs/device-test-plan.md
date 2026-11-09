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

Approval is **not** the gate — a sandbox purchase works before the app is reviewed, which is
what makes it possible to test billing at all — but the **Paid Apps Agreement must be
Active**, because Apple requires it for in-app purchases in the sandbox. An account whose
Business → Agreements page shows only the Free Apps row cannot buy anything yet: see
`deploy/ios/README.md`, "When there is no Paid Apps row at all". An empty answer means the store will not
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
4. **Audiobook, the order that works**: switch Listen to `audiobook`, press it, answer the
   share with the whole screen and **share audio**, then open the book and press play. The note
   reads `reading the other app` within a second or two. Nothing is transcribed while the share
   is silent, so pressing it early costs nothing.
5. Pause the book for half a minute: the note goes to `waiting for the sound to come back` and
   the transcript resumes by itself on the next chapter — no button.
6. Kill the audio app and reopen it: SAGE follows the new track on the same share. If the share
   itself died, `Start listening again` is the way back, and the run stays armed until then.
7. Play audio in another app, then start Listen (lecture): the other app's audio does not stop.
8. **Broadcast audio**: Watch → the sheet now offers the microphone as well as the screen. Start
   it, open the book, and let it play for a minute with the app in the background. Notes should
   arrive from the audio alone. Five minutes of a quiet room should send nothing at all: silence
   is dropped in the extension, not posted and refused.

**Pass:** notes arrive with the screen locked and the app backgrounded; the audiobook run
starts before playback, waits through silence, and resumes on sound without a tap; and
broadcast audio produces notes while the screen never changes.

Why iOS cannot simply hand SAGE another app's audio — and what a native bridge would look like
if it could — is `docs/ios-audio-capture.md`. Item 4 is the only audiobook path on iPhone until
that bridge exists.

## 5 · What to record for App Review

One continuous take, no edits, under three minutes:

1. Launch, name the course, capture starts (Listen or Watch).
2. A question answered with the material on screen.
3. Settings → Session → the trial purchase, Apple's sheet, and the key installing.
4. A second question answered with that session key.

Attach it in App Review → Messages straight after submitting, and say in the message which
build it shows.

## 0 · Run the capture test before anything else

`https://sage.innotel.tech/device-test.html` — open it on the phone that will be tested, in
the app's WebView and again in Chrome, and press **Test both**. Each source gets a verdict:

- **allowed** — an audio track opened and two seconds encoded; `peak=0` with an allowed
  microphone is a silent room, not a failure.
- **refused** — the WebView said no. Rerun in Chrome on the same phone: if Chrome is allowed
  and the shell is not, the difference is the container, and that is the finding to record.
- **rejected the options** — the method exists but `systemAudio`/`audio` did not; the page
  retries with `{ video, audio }` and prints both answers.
- **unsupported** — no such method in this engine at all.

Copy the report into `docs/` next to the device notes. It is the evidence that a Listen or
Watch path is unavailable on a build because of the shell, rather than because of the code
that ships.

The page is also one click from **Settings → Capture test**, which repeats the last verdict
it stored on this device ("the microphone (refused) unavailable on this device") instead of
leaving the question open. The reader tab has a shortcut as well: press **7** anywhere the
page is not a text field to open it, and **R** to open Review.
