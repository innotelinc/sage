# Sage · iOS / TestFlight

Sage ships as a web app. This directory holds the packaging for wrapping it in an
iOS shell and getting a build into TestFlight. **Nothing here can be built on
Windows** — an `.ipa` requires macOS with Xcode.

## Why a shell and not a rewrite

Capacitor wraps the deployed PWA (`https://sage.innotel.tech`) in a native
container. Microphone, camera and speech all keep using the same browser APIs,
so there is one codebase and one deployment to maintain.

## The three things TestFlight needs that this repo does not contain

1. **An Apple Developer Program membership** (99 USD/yr) and its 10-character Team ID.
2. **An App Store Connect app record** for the bundle id `us.innotel.sage`.
   The record must exist *before* the first upload, or `altool` rejects it.
3. **Signing material**: an Apple Distribution certificate (`.p12`) and an App
   Store provisioning profile for that bundle id. App Store Connect API key
   (`AuthKey_XXXX.p8`, key id, issuer id) covers the upload itself.

## Route A — GitHub Actions (no Mac needed after secrets are set)

1. Create the app record in App Store Connect with bundle id `us.innotel.sage`.
2. Add the seven secrets listed at the top of
   `.github/workflows/ios-testflight.yml`.
3. Put the real Team ID into `ExportOptions.plist` (the workflow substitutes
   `REPLACE_TEAM_ID` from `APPLE_TEAM_ID`, but a literal value is clearer).
4. Run the **iOS TestFlight** workflow (Actions → Run workflow), or push a tag
   `ios-v1.0.0`.

The first run does `npx cap add ios`, so `ios/` is generated rather than
committed. If you would rather review the Xcode project in the repo, run
`npx cap add ios` on a Mac and commit the result — the workflow skips generation
when `ios/` already exists.

## Route B — a Mac with Xcode

```bash
npm install --no-save @capacitor/core @capacitor/cli @capacitor/ios
npx cap add ios
cp deploy/ios/capacitor.config.json capacitor.config.json
npx cap sync ios
cd ios/App && pod install
open App.xcworkspace      # set signing team, then Product > Archive
```

Merge the keys from `Info.additions.plist` into `ios/App/App/Info.plist` before
archiving. Without `NSMicrophoneUsageDescription` iOS kills the app the instant
Sage calls `getUserMedia`, and App Review rejects vague usage strings.

## Known risks, stated plainly

- **Guideline 4.2 (minimum functionality).** A container that only loads a
  website is the classic rejection. Sage is a real tool with camera, microphone
  and background audio, but the reviewer's first impression of a remote-URL
  shell is a wrapped site. Bundling `public/` locally and calling the API over
  the network reads better than `server.url` pointing at the live site.
- **Background listening.** `UIBackgroundModes: audio` lets the microphone keep
  recording with the screen off only while an audio session is active; iOS will
  still suspend a long idle recording. Classroom-length capture is not
  guaranteed and needs a real device test before promising it.
- **Version/build numbers.** `CFBundleVersion` must increase on every upload;
  the workflow uses `GITHUB_RUN_NUMBER`.
- **Nothing here has been executed.** No macOS, Xcode or Apple account was
  available while writing these files, so treat the workflow and plists as a
  reviewed starting point that still needs one real run to validate.
