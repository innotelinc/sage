# SAGE roadmap — 4.0 through 5.1

3.1 closes the last of the "it does the thing, on a good connection, in the foreground" releases. 4.0 is the
release where the app stops behaving like a web page that happens to run on a phone.

Three promises define it, and each one is a milestone rather than a slogan:

1. **Capture keeps working when the screen is off.** A lecture recorded in the background is still a lecture.
2. **A turn survives the network with its photos.** The queue that already protects typed questions should
   protect a photographed one.
3. **A citation is somewhere you can turn to.** "It used your handout" becomes "it used page 3 of your handout".

Everything else in 4.x is downstream of those three. If a feature does not make one of them true, it waits.

**Where this stands:** 4.0 (background capture), 4.1 (offline photos), 4.2 (citable pages), 4.3 (exam
rehearsal), 4.4 (audio-only lectures), 4.5 (cross-course search), 4.6 (spaced revision), 4.7 (handoff between
devices), 4.8 (documents that work offline) and 4.9 (accessible and multilingual) are shipped. 5.0 is the next
build; 5.0 and 5.1 are designed below, in that order.

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

## 4.3 — exam rehearsal *(shipped in 4.3.0)*

The quiet gap between "it answers my questions" and "I can sit the paper".

- Timed paper mode: a question set drawn from the course's quiz history and memory, marks per question, no
  answers revealed until the paper is submitted.
- Marking against the rubric in the course persona, with the same reasoning chain Answer gives.
- A revision sheet built from what was wrong, reusing the study-pack export.

**Done means:** a 40-minute paper can be sat start to finish without the app leaking an answer, and the
marked result names the specific points that were missed.

## 4.4 — audio-only lectures *(shipped in 4.4.0)*

Not every lecture has a screen. A recording is transcribed for Read, but only when the
file is uploaded afterwards.

- A capture mode that keeps the microphone, feeds the same note pipeline the screen feed
  uses, and stamps each note with a timestamp instead of a frame.
- Notes from audio cite the recording and the offset, reusing the 4.2 locator idea
  (`lecture-4.m4a 12:40`), so a claim can be checked against the room.

**Done means:** a 50-minute lecture captured with the screen off arrives as timestamped
notes, and a note opens the recording at its offset.

## 4.5 — one search across every course *(shipped in 4.5.0)*

Notes, answers, essays and foundation text are all local, and none can be searched
together. Finding "where did we do osmosis" is currently scrolling.

- An index over every course's memory, answers, quiz items, essays and document text,
  built on the device, so it works with no network and no server change.
- Hits grouped by course with the tab and date they came from; a hit opens the turn or
  the document at its passage, reusing the citation viewer.

**Done means:** a phrase finds every occurrence across courses in under a second on a
phone, and each hit opens where it came from.

## 4.6 — spaced revision *(shipped in 4.6.0)*

The reason to keep a record is to be asked again. Nothing comes back today.

- A review queue built from what was marked wrong, what a paper lost marks on and what
  memory flagged as shaky, on expanding intervals (1, 3, 7, 21 days).
- A five-minute daily session of due items only: answer, re-schedule. Backlog and streak
  shown plainly, nothing beyond that.

**Done means:** a wrong answer returns the next day, then on the interval, and the daily
session can be finished in the time it claims.

## 4.7 — handoff between devices *(shipped in 4.7.0)*

Course memory syncs; a session in progress does not. Start on the phone in a lecture and
the laptop does not have the notes.

- A live session record on the server (device, course, notes so far, capture state),
  written as it runs rather than on save, newer-wins like memory.
- Opening the app elsewhere offers to continue that session; capture ownership is
  explicit so two devices never both claim the microphone.

**Done means:** notes from the phone appear on the laptop within seconds, and starting
capture on one device stops it on the other.

## 4.8 — documents that work offline *(shipped in 4.8.0)*

Foundation documents live in the workspace, so a basement tutorial has no grounding at
all — the gap 4.1 opened for photos, one layer up.

- Cache each course's foundation text and segments on the device, with a size budget and
  a visible cached marker per document.
- Reconcile by hash when the server is reachable; when it is not, ground Answer and Essay
  on the cached copy and say which documents came from cache.

**Done means:** with the network off, a question about the handout is answered from the
cached copy and the reply still names the page.

*As built:* the model itself is remote, so "answered with the network off" means the turn is
kept with the documents it was asked against, grounded on the cached copy, and answered the
moment the connection returns — with the same page labels, and a reply that says which of its
sources came from the device. What offline buys here is that no re-upload and no page name is
lost in between; generating an answer with no server at all is a local model, which is not
planned.

## 4.9 — accessible and multilingual *(shipped in 4.9.0)*

The rail and palette are keyboard-complete; most of the panels are not.

- Every control reachable and labelled for a screen reader, focus visible, dialogs
  trapping and returning focus, capture states announced rather than only drawn.
- Right-to-left layout for Arabic, with prompts answering in the course's language.

**Done means:** a lesson can be captured, answered and exported with a keyboard and a
screen reader alone, and Arabic renders right-to-left without mirrored punctuation.

*As built:* the rail was already keyboard-complete, so this filled in what a screen reader
hears — capture start and stop, and each reply with the page it was grounded on — and what a
keyboard needs from the citation viewer, which is a div rather than a `<dialog>`: it now takes
focus, keeps Tab inside itself, closes on Escape and returns focus. Choosing a tab lands focus
in the panel. The course language sets `<html lang>` and `dir`, with page labels, code and
citation chips isolated left-to-right inside a right-to-left sentence. What is not done: a
full audit of every control against a real screen reader, and Arabic prompts checked by a
speaker rather than by the direction rules alone.

## 5.0 — share a course

Everything here is single-user; study groups are not.

- Read-only share links for a course or a single document, with the sharer's name on the
  material they contributed.
- Shared foundation documents deduplicate by hash: the same handout shared twice is
  stored once and attributed to both.

**Done means:** a classmate opens a link, reads the notes and documents, and can neither
edit anything nor see personal memory.

## 5.1 — measured grounding

Every release claims grounding. Nothing measures it.

- A golden set per course: questions with the document and page that answer them, in the
  repo, run in CI against the stub model and against the gateway on a budget.
- Scores for grounding (did it cite a real page), refusal (did it admit a gap) and
  citation accuracy, tracked across releases so a regression blocks the tag.

**Done means:** a release that degrades grounding fails CI with the question that broke,
instead of being noticed in an exam.

## Not planned

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
| 4.6 | a missed question returns on the interval, and a five-minute session clears what is due |
| 4.7 | notes written on the phone appear on the laptop, and capture on one stops the other |
| 4.8 | a question asked with no connection is answered from the cached copy, page intact |
| 4.9 | capture, an answer and a citation are announced, and Arabic runs right to left |

Every milestone also keeps the existing suite green (`test-saas`, `test-iap`, `test-sources`,
`test-grounding`, `test-pending`) and ships through the same path as 3.x: commit, tag, deploy to the incus
container, verify live.

## Availability

The release series in this document is the repository and web series in `package.json`. The App Store
marketing version is separate: the iPhone app is at 1.0 and currently in review. 4.x reaches the web and the
installed PWA first; the App Store build follows the marketed version, not this file.
