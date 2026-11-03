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

## In-app purchase

Apple requires digital goods sold inside an iOS app to go through StoreKit, so a
session bought on the phone is a consumable, not a card form. `SageStorePlugin.swift`
buys it and hands back the **signed transaction** StoreKit returns; the server checks
Apple's signature over that transaction and only then mints the key.

That check runs offline in `src/iap.mjs` against **Apple Root CA - G3**, pinned by
fingerprint, so no App Store Server API key is needed and nothing has to be read back
from Apple. A forged, edited, refunded or local Xcode transaction cannot become a
session, and the product id is taken from Apple's signed payload rather than from the
request.

Three consumables must exist in App Store Connect, with these product ids:

| Product id | Plan |
| --- | --- |
| `us.inotnel.sage.session.trial` | trial |
| `us.inotnel.sage.session.standard` | standard |
| `us.inotnel.sage.session.intensive` | intensive |

Set `IAP_PRODUCTS` (`productId:planSlug,productId:planSlug,…`) to use different ones.
They cannot be created by the App Store Connect API, so this is a manual step in
the web UI. The ids carry `inotnel` while the bundle id is `us.innotel.sage`: they are
what the products were registered as, and renaming them would orphan what a buyer can
already see.

Server configuration (without a mint endpoint the app keeps the store page and no
purchase can happen):

| Variable | Meaning |
| --- | --- |
| `IAP_MINT_URL` | endpoint that turns a verified transaction into a session key |
| `IAP_MINT_TOKEN` | bearer token for that endpoint, if it needs one |
| `APPLE_BUNDLE_ID` | defaults to `us.innotel.sage` — the bundle the signature must name |
| `IAP_TRUST_ANCHORS` | optional comma-separated SHA-256 fingerprints checked instead of Apple's root. Leave unset in production; it exists for tests |

### The mint contract

`POST IAP_MINT_URL` with `authorization: Bearer <IAP_MINT_TOKEN>` when a token is set:

```json
{
  "productId": "us.inotnel.sage.session.trial",
  "planSlug": "sage-session-trial",
  "transactionId": "2000000000000001",
  "email": "admin@innotel.us",
  "bundleId": "us.innotel.sage",
  "environment": "Production",
  "purchasedAt": "2026-11-02T18:02:11.000Z"
}
```

Answer `200` with the same shape the claim exchange returns, because a key is a key
once it is issued:

```json
{ "key": "sk-…", "planName": "Session · 15 min", "expiresAt": "2026-11-02T18:17:11Z", "secondsLeft": 900 }
```

Anything else is reported to the app as a failed purchase, with the reason, and the
session is not installed — StoreKit already took the money at that point, so a `502`
here means a buyer needs a key reissued.

Two rules make the route safe to call:

- **Pay out once per `transactionId`.** It is the idempotency key. A repeat must be
  refused, not minted again. `src/iap.mjs` refuses the repeats one process has seen,
  but only the mint route survives a restart.
- **Answer only for the products above.** The plan arrives as `planSlug`, so the route
  never needs this app's product ids, but it should refuse anything it does not sell.

`npm test` builds a certificate chain of its own and checks the whole route against a
stub mint service, so the verification rules can be exercised without Apple, a device
or a credential.

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

## Listening in the background

`SageAudioSessionPlugin.swift` exists because iOS gives an app one audio session
and a WebView's microphone borrows it. Left at its default that session is
play-and-record without `.mixWithOthers`: opening the microphone interrupts
whatever the person was playing, and leaving the app without an active session
ends the capture - an audiobook in another app is enough to stop a lecture being
recorded.

The plugin sets `.playAndRecord` with `[.mixWithOthers, .defaultToSpeaker,
.allowBluetooth, .allowBluetoothA2DP]`, activates it, and takes it back when an
interruption ends with `.shouldResume`. `public/app.js` calls `SageAudio.begin()`
before it opens the microphone; nothing calls `end`, because deactivating would
stop playback the plugin never started.

The `UIBackgroundModes: audio` key added to `Info.plist` in the workflow is the
other half: without it iOS suspends the capture when the screen is locked.

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

## App icon and App Store listing

The Xcode project is generated inside the workflow, so it starts with whatever
icon Capacitor's template ships - the placeholder. `deploy/ios/AppIcon.appiconset`
is Sage's icon, and the **Install app icon** step copies it over the generated
catalog before the archive; `ASSETCATALOG_COMPILER_APPICON_NAME=AppIcon` is pinned
on the `xcodebuild` line so the catalog is the one compiled in.

Regenerate after editing the artwork:

```bash
node scripts/make-icons.mjs     # sharp is already a devDependency
```

- `deploy/ios/icon-source.svg` - 1024 square, full bleed. **No corner radius:** iOS
  applies its own mask, so baked corners double-round. `public/icon.svg` keeps its
  rounded rect because browsers do not mask it.
- `deploy/ios/AppIcon.appiconset/` - 18 slots (iPhone and iPad 20/29/40/60/76/83.5
  plus `ios-marketing`), stored as 15 files where two slots share a pixel size.
- `deploy/ios/app-store-icon-1024.png` - the same 1024 image as a loose file, for
  **App Store Connect -> App Information -> App Icon**.

Every PNG is flattened onto `#080b12` with the alpha channel removed. That is not
cosmetic: uploads are rejected when the large icon is transparent, and the workflow
re-checks it with `sips -g hasAlpha` instead of trusting the committed file.

## Still unverified

- **Device behaviour.** The build uploads, but nobody has installed it yet:
  microphone, camera and background audio in the shell are untested on hardware.
- **A real purchase.** The transaction rules and the route around them are covered by
  `npm test`, but no purchase has been run against a live mint endpoint — that route
  does not exist yet.
- **Guideline 4.2.** Bundling assets helps, but a reviewer may still see a web app
  in a native frame. The camera and microphone work are the argument that it is
  not a wrapped website.
- **Background listening.** `UIBackgroundModes: audio` does not guarantee
  classroom-length capture with the screen off.
