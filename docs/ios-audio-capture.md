# Hearing another app's audio on iOS

A design note, not a shipped feature. It exists because the web audiobook path works and the
iPhone path does not, and the difference is the platform rather than the code: a page can ask
for a share that carries system audio, and an app cannot.

The question it answers: **can SAGE read an audiobook that is playing in another app on an
iPhone?** Short answer: not directly. There is no public API that hands an app another app's
output. Everything below is about the three indirect ways, what each is worth, and the shape a
native bridge would take if one of them is worth building.

Verify the platform claims here against the SDK at build time. If Apple ships a loopback API,
this is the file that should say so.

## 1 · What each shell can do today

| Shell | Other app's audio | Mechanism | Kept? |
| --- | --- | --- | --- |
| Chrome / Edge, desktop | **yes** | `getDisplayMedia` with `systemAudio: 'include'`, video track stopped in the same tick | no |
| Chrome, Android | yes, same as desktop | same call | no |
| Android shell | **no** | `SageScreenService` holds a `MediaProjection` and posts JPEG frames; there is no `AudioPlaybackCapture` request in it | n/a |
| iOS shell (WKWebView) | **no** | `getDisplayMedia` is absent; an in-app `RPScreenRecorder` is suspended with the app | n/a |
| iOS shell, Watch | video only | the `SageBroadcast` extension posts frames; audio buffers are ignored (`SampleHandler` returns unless `.video`) | frames are not stored |

So on the phone the only audio SAGE has ever had is the microphone. On Android that is a
choice the shell makes and could reverse (see §2); on iOS it is the platform.

## 2 · The platform rule, precisely

- **`AVAudioSession` records input, never output.** `.playAndRecord` with `.mixWithOthers` is
  what lets an audiobook keep playing while the microphone opens — it does not give the app a
  copy of what is playing. `SageAudioSessionPlugin` sets exactly this, and that is all it can
  do.
- **No loopback.** There is no `AVAudioEngine` node, no `AVCaptureSession` input, and no
  `AVAudioSession` port that delivers another process's PCM. `Now Playing` gives metadata —
  title, artist, elapsed time — not samples.
- **ReplayKit is not a system recorder.** In-app `RPScreenRecorder` captures this app's own
  audio and video and is suspended the moment the app leaves the screen. A **broadcast upload
  extension** is a separate process the system keeps alive, so it keeps receiving samples — but
  its audio buffers are `.audioApp` (the broadcasting app's own audio) and `.audioMic`. Another
  app's audio does not appear in either, and DRM-protected playback is excluded outright. This
  is why screen recorders on iOS produce silent video when a streaming app is in front.
- **The only acoustic path is speaker → air → microphone.** It works, it is allowed, and it is
  what the lecture path already does. It also means headphones break it: with AirPods in, there
  is nothing in the room to hear.

Android is different and worth stating for contrast: `AudioPlaybackCapture` (Android 10+) can
capture another app's audio during a `MediaProjection`, **if that app has not opted out**.
Audiobook and music apps generally do opt out, and DRM playback is excluded. The shell asks for
none of this today.

## 3 · The three indirect ways, ranked

### a · Speaker → microphone (works now, no native code)

The audiobook plays out loud; Listen records the room. This is the fallback and it should be
made explicit rather than accidentally attempted:

- capture with `echoCancellation: false, noiseSuppression: false, autoGainControl: false` —
  exactly the options the audiobook share already uses; voice processing tuned for a talking
  person in a quiet room fights a phone speaker one metre away;
- copy that says **phone speaker, no headphones** before it says anything else;
- quality depends on the phone's speaker and the room, so the transcript will be worse than
  the file's own text. That is the honest trade.

**Verdict:** worth doing as a labelled mode, because it is the only thing that works with the
app on screen and the book next to it.

### b · Microphone inside the broadcast extension (the real native win)

Same acoustic path as (a), but the recording lives in the extension, so it **survives the app
going to the background** — which is the whole reason the audiobook ordering problem exists on
the web. The person starts the broadcast, opens the book, and SAGE keeps reading while they are
in another app.

Two facts to settle on hardware before building it:

1. `RPSystemBroadcastPickerView.showsMicrophoneButton` is currently `false`. Microphone audio in
   the extension needs it `true` (the person then confirms the microphone in the sheet, which is
   also the privacy-correct behaviour).
2. Whether `.audioMic` buffers arrive reliably when the extension is not the frontmost thing.
   Expected: yes, the extension keeps receiving; measure it rather than assume.

**Verdict:** the one native item worth building, and it is small: audio-buffer handling in
`SampleHandler` plus one server route.

### c · Import the file (exact, but only for files the person owns)

A document picker or share-sheet hand-off, then transcribe the file directly. Exact text, no
acoustics, no privacy question about a room. It fails on the two biggest sources — Audible and
Apple Books are DRM'd and hand over nothing readable — so it is a feature for people with MP3s,
not a general answer.

**Verdict:** later, and only if someone asks.

## 4 · The bridge, if (b) is built

### Contract, app side

```
SageAudioCapture.start({ chunkMs })  → { id }
        .stop()                      → {}
events: level { peak } | ended | error { code }
```

The web side already knows how to consume a level signal: `watchForSound()` in `public/app.js`
latches on the first audible window and skips silence. The bridge should feed the same decision
rather than inventing a second one — a native `level` event sets `cap.heardSound` the way the
analyser does today.

### Extension side

`SampleHandler.processSampleBuffer` gains an `.audioMic` branch (after `showsMicrophoneButton`
is turned on):

- append `CMSampleBuffer` audio into a buffer, do **not** encode video in that branch;
- every `chunkMs` (5000), convert to 16 kHz mono PCM16 and wrap it as a WAV container — Swift
  can write the 44-byte header itself, no encoder needed;
- `POST https://sage.innotel.tech/api/broadcast/audio`, multipart: `device`, `seq`, `audio`;
- exactly one upload in flight; if the previous one has not returned, **drop the chunk** rather
  than queueing. The extension has roughly 50 MB and no disk worth using, and stale audio is
  worse than a gap;
- 16 kHz mono 16-bit is 32 KB/s, so a 5 s chunk is ~160 KB — comfortable under the ceiling;
- on `broadcastFinished`, flush the pending chunk once and invalidate the session.

### Server side

One route, reusing what exists:

- `POST /api/broadcast/audio` resolves the device's open broadcast session (`accepts()`,
  the same check `/api/broadcast/frame` makes), forwards the WAV to the same speech-to-text call
  `/api/transcribe` uses, and stores the text as a note on that session (`recordFrame`-style,
  but text) so the app's existing `drainBroadcast` poll collects it;
- **nothing is written to disk**, matching `cap.keepRecordings = false`: the point is the
  transcript, not a copy of the book;
- a chunk that cannot be transcribed is dropped with a count, not an error the extension has to
  handle; the extension must never end a broadcast because a request failed.

### Ordering, carried over

The lesson from the web path applies unchanged: **start listening before pressing play.** With
the extension this is easier, because the extension is not suspended — the run can start after
the book, and the level gate means the first chunk sent is the first audible one.

### What the user sees

| Situation | Note under the buttons | Toast |
| --- | --- | --- |
| armed, nothing heard yet | `waiting for sound — the other app's audio` | "Listening. Start the audio in the other app." |
| sound latched | `reading the other app` | "Heard it — reading that source now." |
| quiet > 15 s | `waiting for the sound to come back` | none (a toast per chapter break is noise) |
| chunk rejected, stream alive | unchanged | none |
| broadcast stopped | `the source stopped` + **Start listening again** | one line, no repeat |

## 5 · Review and policy

- The app already declares `UIBackgroundModes: audio` for the lecture path; a broadcast
  extension is covered by its own extension entitlement and does not need a new mode.
- Audio leaves the device for transcription, so App Privacy must declare **Audio Data** used for
  app functionality even though nothing is retained. The existing review notes say recordings are
  not kept; that sentence has to remain true for the extension too.
- Do not reach for private APIs or audio-session tricks to get a loopback. They fail review, and
  the workaround stops working with the next iOS.
- Screen capture of copyrighted video is already a review risk that Watch carries; audio widens
  it slightly. The copy should stay "reads the sound, keeps nothing".

## 6 · What to build, in order

1. **Nothing native yet.** Run `https://sage.innotel.tech/device-test.html` on the phone, in the
   app's WebView and in Chrome, and record the verdicts (`docs/device-test-plan.md`, step 0).
   That report is what distinguishes "the shell refuses the share" from "the share carried no
   audio", and it is the evidence for whatever is built next.
2. **Speaker mode**, labelled. Cheap, works today, sets the expectation that headphones are not
   supported for this.
3. **Broadcast microphone** (§4). The only path that survives app switching on iOS.
4. **File import**, if asked.

### Acceptance tests for (b)

- Broadcast started, book playing on speaker, app backgrounded for ten minutes: notes keep
  arriving, one chunk per five seconds, no chunk larger than 200 KB.
- Broadcast started, no sound for two minutes: zero transcription requests, and the first
  audible chunk is transcribed.
- Airplane mode during a broadcast: chunks dropped, extension alive, transcript resumes on
  reconnect.
- Broadcast stopped from Control Center: extension ends, the app's poll notices within one
  window, and the run says the source stopped instead of claiming to listen.
- No audio file appears anywhere on the device or the server after a run.

## 7 · Open questions, with expected answers

| Question | Expected | How to settle |
| --- | --- | --- |
| Does `.audioMic` arrive in the extension with the app backgrounded? | yes | log buffer counts to the broadcast session for one run |
| Does `.audioApp` contain another app's audio when SAGE is not the player? | no | play a known tone in another app, check for non-silent `.audioApp` samples |
| Is Audible / Apple Books audio present at all? | no (DRM) | same probe with each app |
| Does the broadcast sheet with the microphone on still pass review unchanged? | yes, it is Apple's own UI | screenshot in the review recording |
| Does the level gate work on extension chunks the way it works on the analyser? | yes, same 0.012 peak threshold | compare against the web path on the same book |

Until (b) exists, the iPhone answer in the app stays what it is: Listen is the microphone, Watch
is the screen, and another app's book is only audible to SAGE if it is playing out loud.
