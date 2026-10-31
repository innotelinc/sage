# Sage · iOS / TestFlight

Sage ships as a web app wrapped in a Capacitor iOS shell. Nothing here builds on
Windows — an `.ipa` requires macOS with Xcode — so the build runs on a GitHub
**macos-26** runner and uploads itself.

## Status: a build has reached App Store Connect

The `iOS TestFlight` workflow archives, exports and uploads successfully. No
certificate or provisioning profile is stored anywhere: signing is automatic,
driven by the App Store Connect API key, so Xcode creates and manages the
distribution certificate and profile itself.

## What signing actually needs

Four repository secrets, nothing else:

| Secret | Meaning |
| --- | --- |
| `APPLE_TEAM_ID` | 10-character team id |
| `ASC_KEY_ID` | App Store Connect API key id |
| `ASC_ISSUER_ID` | App Store Connect issuer id |
| `ASC_PRIVATE_KEY` | contents of `AuthKey_<KEY_ID>.p8` |

An **App Store Connect app record for `us.innotel.sage`** must exist before the
first upload, or the upload is rejected.

## Why the runner is macos-26

App Store Connect now refuses builds that are not made with the **iOS 26 SDK**;
`macos-15` tops out at Xcode 16 (iOS 18.5 SDK) and fails with
`STATE_ERROR.VALIDATION_ERROR` / "must be built with the iOS 26 SDK". `macos-26`
is generally available and ships Xcode 26.

## Why there is no Podfile step

`@capacitor/ios` is 8.x, which moved iOS to **Swift Package Manager**. There is
no `Podfile`; `xcodebuild` resolves packages itself and the generated container
is `ios/App/App.xcodeproj`. The workflow still runs `pod install` when a Podfile
does exist, so a Capacitor 7 checkout keeps working.

## Assets are bundled, not loaded remotely

`capacitor.config.json` has no `server.url`, so `public/` is copied into the app.
That means the app is served from `capacitor://localhost` and its absolute API
call (`/api/tts`) would hit nothing. Two small changes bridge that:

- `public/index.html` sets `window.__SAGE_API__` to `https://sage.innotel.tech`
  when the protocol is `capacitor:` or `ionic:`.
- `public/app.js` routes API paths through `apiUrl()`, and `server.mjs` answers
  CORS preflights for those native origins only.

## Running it

Actions → **iOS TestFlight** → Run workflow, or push a tag `ios-v*`.
`CFBundleVersion` is set from `GITHUB_RUN_NUMBER`, so every upload is unique.

To build on a Mac instead:

```bash
cp deploy/ios/capacitor.config.json capacitor.config.json
npm install --no-save @capacitor/core @capacitor/cli @capacitor/ios
npx cap add ios && npx cap sync ios
open ios/App/App.xcodeproj     # set the team, then Product > Archive
```

## Still unverified

- **Device behaviour.** The build uploads, but nobody has installed it yet:
  microphone, camera and background audio in the shell are untested on hardware.
- **Guideline 4.2.** Bundling assets helps, but a reviewer may still see a web app
  in a native frame. The camera and microphone work are the argument that it is
  not a wrapped website.
- **Background listening.** `UIBackgroundModes: audio` does not guarantee
  classroom-length capture with the screen off.
