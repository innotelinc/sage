# SAGE roadmap — 4.0 through 7.0

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
devices), 4.8 (documents that work offline), 4.9 (accessible and multilingual), 5.0 (share a course) and 5.1
(measured grounding) are shipped. 5.2 is the next build, designed below.

The series from 5.2 on is where the app stops being a set of surfaces and starts being a course that knows
what it is: 5.x finishes what sharing and measuring opened, 6.x turns what was captured into a document you
can study from, and 7.0 is the first release that can answer for the course as a whole rather than for the
turn in front of it.

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

## 5.0 — share a course *(shipped in 5.0.0)*

Everything here is single-user; study groups are not.

- Read-only share links for a course or a single document, with the sharer's name on the
  material they contributed.
- Shared foundation documents deduplicate by hash: the same handout shared twice is
  stored once and attributed to both.

**Done means:** a classmate opens a link, reads the notes and documents, and can neither
edit anything nor see personal memory.

*As built:* `POST /api/share` takes a course or a document and returns `/share/<token>`; the
page is rendered server-side with no script, so there is nothing on it to click into an edit.
The snapshot carries the course name, the notes and the documents — not memory, answers,
persona or settings — and the reading endpoint needs no identity, because the link is the
credential. Documents are stored once under their content hash and every share points at that
copy, with each sharer added to its attribution. Links are revoked by their owner, refused if
they outlive thirty days, and writes to them answer 405.

## 5.1 — measured grounding *(shipped in 5.1.0)*

Every release claimed grounding. Nothing measured it.

- A golden set per course under `docs/golden/`: documents with their pages, questions with the
  page that answers them, and questions the material cannot answer at all.
- Each case runs through the real `/api/chat` handler — the prompt, the citation parser and the
  grounding report — and is scored for grounding, citation accuracy and refusal. A page the
  material does not have counts against the score rather than passing as a citation.
- Run in CI against the stub model and against the gateway on a budget (`--live`), with the
  scores kept in `docs/golden/baseline.json`, so a release that drops any of the three fails.

**Done means:** a release that degrades grounding fails CI with the question that broke,
instead of being noticed in an exam.

*As built:* two course sets (BIO 101, PHYS 210) with seven cases, two of which the material cannot
answer. `scripts/golden.mjs` runs them stubbed or live, prints a line per case, and compares the
totals against the baseline it recorded; `scripts/test-golden.mjs` tests the scorer itself, because a
check that cannot fail is not a check. What the stub run measures is the plumbing — that pages reach
the prompt, that a citation survives parsing only when its document was supplied, that an admitted
gap comes back clean — and what `--live` measures is the model. The limitation belongs on the page:
seven cases are a floor, not a suite, and a course is only measured once somebody writes its set.

## 5.2 — a share that stays honest

A share is a snapshot that never says it has aged. A classmate reads notes from three weeks ago with
nothing on the page to show it.

- Record the revision a share was cut from; when the course has moved on, the page says so and
  offers the owner’s newer link rather than pretending.
- The owner publishes a revision deliberately, so a shared page is never half-updated.
- A single document can be shared on its own, opening at the page that was meant.

**Done means:** a shared page whose course changed since says which revision it is, and the owner
can publish a new one without changing the old link’s address.

## 5.3 — group revision

A shared course carries a question bank and nothing uses it. Revision stays single-user.

- Import a shared course’s quiz items and practice questions into your own spaced revision,
  attributed to the course they came from.
- Merge duplicates by content rather than by wording, so the same question from two people is
  asked once.
- The queue says where an item came from, and nothing on the shared side can be written to.

**Done means:** a revision session includes a classmate’s questions, each labelled with the course
it came from.

## 5.4 — the marking scheme, learned

Exam rehearsal (4.3) marks against the course persona. A real paper is marked against a scheme.

- Read a supplied marking scheme once, and mark criterion by criterion with the marks the scheme
  allocates.
- Feedback names the criterion that was missed and the page or lecture moment that would have
  supplied it, reusing 4.2 and 4.4.
- A scheme that cannot be parsed says so instead of marking against a guess.

**Done means:** a marked paper scores each criterion the scheme names, and the feedback points at
the material that was missed.

## 5.5 — answers that cite the recording

Audio notes carry `[lecture M:SS]` (4.4); answers still cite only pages.

- Teach the citation parser the recording form, and let Answer and Essay point at the moment a
  claim came from.
- The chip opens the recording at that offset on the device that holds it, and says plainly when
  it does not.

**Done means:** an answer says it leant on `lecture-4.m4a 12:40`, and tapping that plays the
lecture from there.

## 5.6 — a timetable that starts the lecture

The timetable decides which course answers. It does not start anything.

- Capture starts on the timetable’s window with a confirmation the first time, and stops when the
  window closes, reconciling with the session clock (1.4).
- A missed window starts nothing and says so; a class that runs over is extended by one tap, not by
  a setting.
- The live session record (4.7) is created for the class, so a second device is offered it.

**Done means:** walking into a timetabled class begins the capture it asked about, and leaving the
window ends it without losing the notes.

## 5.7 — a budget you can see

Sessions are timed, not metered, and a runaway turn is invisible until it is expensive.

- A per-course and per-day cap on tokens, enforced on the server and reported in the app, with the
  cost of the current session stated plainly.
- A turn that would exceed the cap is refused with the reason and the option, not silently
  downgraded to a worse model.
- The tally the operator panel already keeps is reused, so there is one number and not two.

**Done means:** a course that reaches its cap says so before the next turn, and the number in the app
matches the server’s.

## 5.8 — a workspace you can carry

Courses, memory, documents and the revision queue live on one device’s server.

- One archive of a whole workspace, hashed file by file, restorable on another instance.
- Import refuses a partial or corrupt archive and names the entry that failed, rather than half
  restoring a course.
- Documents both sides already hold are stored once, by content hash.

**Done means:** a workspace exported from the phone’s server restores on a laptop’s server with the
same courses, pages and queue.

## 5.9 — the shared page, for everyone

Sharing shipped before the accessibility pass (4.9) reached it.

- Shared pages are keyboard- and screen-reader complete, with the language and direction of the
  source material, and a print stylesheet that keeps its page labels.
- A share that was revoked or expired explains itself on the same page rather than as a bare 404.

**Done means:** a shared course can be read with a keyboard and a screen reader, printed, and opened
in Arabic without mirrored punctuation.

## 6.0 — the lecture, as a document

Capture produces notes and answers. It does not produce a document you could study from.

- A course reader assembled from what was captured: per lecture, an outline, the definitions, the
  worked examples and the exam hints, in the order they were taught.
- Every section keeps the anchors it came from — page, offset, timestamp — so the reader is a view
  of the material rather than a summary of it.
- The reader is editable, and an edit is kept apart from the capture it came from.

**Done means:** a lecture captured once becomes a reader section whose every claim opens the page
or moment it came from.

## 6.1 — questions about the reader

A question about the course is answered against pages, not sections.

- Retrieval over the reader: a question maps to the section that answers it, and the reply cites
  the section as well as the page.
- A question that spans two lectures says so and cites both.
- The golden set grows a reader case per course, so this is measured like everything else.

**Done means:** “where did we do osmosis” returns the section, the page and the lecture, and each
one opens.

## 6.2 — a question bank with shape

Quiz items are produced one paper at a time and thrown away.

- A bank built from the reader, past papers and what was marked wrong, deduplicated by content.
- Each item carries a difficulty estimated from how it was answered, and the topic it tests.
- Items are editable, and deleting one removes it from the queue and from future papers.

**Done means:** the bank can produce a paper of a given length and difficulty without repeating a
question.

## 6.3 — uncertainty that means something

Every reply has a confidence number nothing has ever calibrated.

- Calibrate stated confidence against the golden set: a 90% claim should be right nine times in ten,
  and the score says whether it is.
- A claim below the calibrated threshold is labelled in the reply rather than hidden behind a bar.
- The calibration is recorded per release, so drift is visible.

**Done means:** a marked paper shows the model’s confidence is neither invented nor systematically
overconfident, or the release fails.

## 6.4 — papers with the shape of the real one

Practice papers are drawn, but a real paper has a structure: sections, marks, a choice.

- Build a practice paper from the bank in the shape of a supplied past paper — the same sections,
  the same mark allocation, the same choice.
- The clock, the marking and the revision sheet follow that shape rather than a flat count.

**Done means:** a practice paper matches the section and mark structure of the paper it was modelled
on.

## 6.5 — feedback that teaches

Marking says what was missed. It does not say what to read.

- Each lost mark points at the criterion, the page and the shortest path to it — a definition, a
  worked example, a lecture moment.
- The revision sheet is built from those pointers, in the order they should be revisited.
- Feedback never restates the answer for a paper that has not been submitted.

**Done means:** a marked paper names, per lost mark, the material that would have earned it.

## 6.6 — a plan for the weeks before

Revision is a queue, not a plan; an exam date changes that.

- A plan from the timetable, the exam date and the queue: what to study on which day, with the time
  each block actually takes.
- A missed day is redistributed rather than lost, and the plan says what it dropped.
- The plan is a proposal that can be edited; nothing is scheduled silently.

**Done means:** with an exam date set, the app can say what to do this week and why, and the plan
survives a missed day.

## 6.7 — the reader, shared

A share carries notes and documents. It does not carry what was understood.

- Share a lecture reader read-only, with attribution and the revision it was cut from.
- A reader share never carries memory, answers or the plan.

**Done means:** a classmate can read a lecture reader, and the sharer’s name is on what they
contributed.

## 6.8 — the reader, offline

The reader is assembled on the server, so a basement has none.

- Cache the reader per course with a size budget, and mark each section that is cached.
- A question asked offline is kept with the section it was asked against and answered from the cache
  when the connection returns, page labels intact.

**Done means:** a question about a cached section is answered with the network off in the sense 4.8
defines: kept, then answered, with its page.

## 6.9 — the reader in your language

A course can be in one language and the student in another.

- The reader keeps the source text and adds an explanation in the course’s chosen language, with
  the source citation preserved beside it.
- Direction is per block, so a right-to-left explanation can quote a left-to-right formula.

**Done means:** a lecture in one language can be read in another without losing the page a claim
came from.

## 7.0 — the course, understood

Everything so far is about a turn, a paper or a lecture. Nothing says what the course is.

- A coverage map: what the course’s material covers, what has been captured, and where the two
  disagree — with the pages that support each claim.
- Weak areas from marks, revision history and calibration, named with their evidence rather than a
  score.
- One question the app answers well: “what will be on the exam, and what should I do this week”,
  grounded in the course’s own material, citing the pages and lecture moments, and measured against
  a golden set like everything else.

**Done means:** the coverage map names a gap the material confirms, the week’s plan follows from it,
and the answer to the exam question cites the pages it was built from.

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
| 5.0 | a classmate opens a link, reads notes and documents, and can change neither |
| 5.1 | the golden set runs in CI, and a degraded citation fails the build with the case that broke |
| 5.4 | a marked paper scores the criteria its supplied scheme names, and points at the material missed |
| 6.0 | a lecture captured once becomes a reader section that opens the page it came from |
| 7.0 | the coverage map names a gap the material confirms, and the week’s plan follows from it |

Every milestone also keeps the existing suite green (`test-saas`, `test-iap`, `test-sources`,
`test-grounding`, `test-pending`) and ships through the same path as 3.x: commit, tag, deploy to the incus
container, verify live.

## Availability

The release series in this document is the repository and web series in `package.json`. The App Store
marketing version is separate: the iPhone app is at 1.0 and currently in review. 4.x and 5.x reach the web
and the installed PWA first; the App Store build follows the marketed version, not this file, so a release
here does not imply a new build in review.

Milestones past 5.1 are designed, not promised: each one is worth doing only if it makes the three promises
at the top true, and the order is a straight line rather than a contract.
