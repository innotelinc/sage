# SAGE v4.0 roadmap

3.1 closes the last of the "it does the thing, on a good connection, in the foreground" releases. 4.0 is the
release where the app stops behaving like a web page that happens to run on a phone.

Three promises define it, and each one is a milestone rather than a slogan:

1. **Capture keeps working when the screen is off.** A lecture recorded in the background is still a lecture.
2. **A turn survives the network with its photos.** The queue that already protects typed questions should
   protect a photographed one.
3. **A citation is somewhere you can turn to.** "It used your handout" becomes "it used page 3 of your handout".

Everything else in 4.x is downstream of those three. If a feature does not make one of them true, it waits.

**Where this stands:** 4.0 is shipped in 4.0.0 — the ReplayKit broadcast extension, the Android
foreground service and the server session that joins them. 4.1 shipped in 4.1.0 and 4.2 in 4.2.0; 4.3 follows.

## 4.0 — capture that survives the background *(shipped in 4.0.0)*

The Android build already captures through its own foreground service. iOS does not: the browser's screen
share ends when the app leaves the foreground, which is exactly when a student stops looking at the phone.

- Move iOS capture to a ReplayKit broadcast upload extension, with frames delivered to the app over the
  existing channel and the session meter charged from the same stream.
- Android: keep the current MediaProjection service; add the same stop affordance so both platforms stop the
  same way — from the notification, not only from the tab.
- Foundation documents and Read stay as they are: they are already server-side.

**Done means:** a ten-minute lecture captured with the app backgrounded and the screen locked arrives as
frames and notes; the session clock matches the wall clock within a few seconds; stopping from the
notification ends the capture and the charge together.

**Blocker to clear first:** there is no macOS machine in the loop. `ios-testflight.yml` builds on
`macos-26` runners, so the extension can only be compiled and tested through CI. Budget a debugging cycle
that runs through `gh workflow run` rather than a local simulator.

## 4.1 — offline, photos included *(shipped in 4.1.0)*

`public/pending.js` keeps a turn when the server cannot be reached, but deliberately keeps text only: a
base64 photo would blow the storage quota. That is the right call today and the wrong one for a student in a
basement tutorial room.

- Store attached images in IndexedDB, keyed with the queued turn, capped by total bytes rather than count.
- Replay sends the turn and its photos together, into the tab that asked, exactly as the text path does now.
- Evict the oldest photos first when the cap is hit, and say so in the pending label rather than dropping a
  question silently.
- Keep the promise that a queued turn is never sent twice: the queue must be idempotent across a reload.

**Done means:** airplane mode, photograph a question, kill the tab, restore the network, reopen — the answer
arrives with the photo that was taken, in the right tab, once.

## 4.2 — citations you can turn to *(shipped in 4.2.0)*

`src/sources.mjs` already extracts text with page and paragraph boundaries; the reply only reports file
names. The next step is to keep the anchors.

- Carry page/paragraph offsets through extraction into `grounded`, so a claim can name a location.
- Essay and Answer cite as they do now, with the location appended when it is known.
- Foundation documents become openable at that location, so a mark can be checked against the page.

**Done means:** an essay says it leaned on `handout.pdf p.3`, and tapping that opens page 3 of the document
that was actually read — not a re-upload, not a guess.

## 4.3 — exam rehearsal

The quiet gap between "it answers my questions" and "I can sit the paper".

- Timed paper mode: a question set drawn from the course's quiz history and memory, marks per question, no
  answers revealed until the paper is submitted.
- Marking against the rubric in the course persona, with the same reasoning chain Answer gives.
- A revision sheet built from what was wrong, reusing the study-pack export.

**Done means:** a 40-minute paper can be sat start to finish without the app leaking an answer, and the
marked result names the specific points that were missed.

## Not in 4.x

Multi-user collaboration, LMS gradebook integration, local model hosting. Each is a plausible product; none
of them makes the three promises above true, and the release series is more useful as a straight line than a
wish list.

## How each milestone is proven

| Milestone | Proof |
| --- | --- |
| 4.0 | device capture with the screen locked, session charge reconciled against the receipt |
| 4.1 | airplane-mode replay of a photographed turn across a tab kill, one delivery |
| 4.2 | a citation whose location opens the page it names |
| 4.3 | a timed paper sat end to end, marked against the rubric |

Every milestone also keeps the existing suite green (`test-saas`, `test-iap`, `test-sources`,
`test-grounding`, `test-pending`) and ships through the same path as 3.x: commit, tag, deploy to the incus
container, verify live.

## Availability

The release series in this document is the repository and web series in `package.json`. The App Store
marketing version is separate: the iPhone app is at 1.0 and currently in review. 4.x reaches the web and the
installed PWA first; the App Store build follows the marketed version, not this file.
