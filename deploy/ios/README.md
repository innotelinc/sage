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
| `us.innotel.sage.session.trial` | trial |
| `us.innotel.sage.session.standard` | standard |
| `us.innotel.sage.session.intensive` | intensive |

Set `IAP_PRODUCTS` (`productId:planSlug,productId:planSlug,…`) to use different ones.
They cannot be created by the App Store Connect API, so this is a manual step in
the web UI. The ids are the ones registered in App Store Connect (`scripts/asc-iap.mjs`
creates them as `${APPLE_BUNDLE_ID}.session.*`), and StoreKit returns nothing for an
id that differs from the registered one by even a character.

### What the Business tab has to show

A product can be `READY_TO_SUBMIT`, priced and available in every storefront and still be
answered with an empty list, because the account itself is part of the setup. Before a
sandbox purchase can work, the **Account Holder** — not an Admin — has to leave
**Business → Agreements** in this state:

| Row | What it must say |
| --- | --- |
| Paid Apps (Paid Applications Agreement) | **Active**, with an expiry in the future |
| Free Apps | Active — needed to ship at all, and it authorises nothing to be sold |
| Bank Accounts | the account the proceeds are paid into, in the legal entity's name |
| Tax Forms | complete for the territories you sell in (the U.S. form for a U.S. entity) |

Anything else on the Paid Apps row is a reason StoreKit answers nothing: **New** has not
been signed, **Pending User Info** is signed with banking or tax fields still empty,
**Processing** is with Apple, and **Expired** or **Invalid** means no paid submission is
accepted until the Account Holder agrees again. A lapsed membership voids the agreement
even while banking and tax are still on file, and completing the fields takes up to 24
hours to propagate.

Apple's own wording for the unsigned row is worth recognising, because it appears in the
web UI rather than in the app and it is what empties StoreKit:

> To offer apps or other in-app purchases, you must sign the Paid Apps Agreement.

That is a signature, not a setting: only the Account Holder can accept it, at
**Business → Agreements → Paid Apps → View and Agree to Terms**, after which banking and
tax still have to be complete for the row to read *Active*. Reading metadata over the API
succeeds while the row is unsigned — the refusal happens at the point of sale — so a
green App Store Connect run does not mean the agreement is signed.

### When there is no Paid Apps row at all

Some accounts show only the Free Apps Agreement, with the banner "To offer apps or other
in-app purchases, you must sign the Paid Apps Agreement" and no row to click. There is no
self-service request button: Apple offers the row when the account is in a state that can
hold a paid contract. Check these in order, because each one hides the row the same way:

1. **The role.** Only the Account Holder can sign, and only Account Holder, Admin or
   Finance can see the row at all. Users and Access → your name → Role. An Admin sees the
   warning and cannot clear it, which is the most common way a team gets stranded here.
2. **The team.** The Apple ID must belong to the team that owns the app — compare the team
   ID on Users and Access with the one in the developer account. A second team, or an
   individual account, has its own agreements.
3. **The Program License Agreement.** developer.apple.com/account → Membership details. If
   Apple is asking for a revised agreement there, accept it: the Paid Apps row can be held
   back until the current Program License Agreement is accepted, and that is what "the
   Agreements tab shows nothing to accept" usually means.
4. **Membership status.** An expired or pending membership has no paid contract to sign,
   and an organisation still being verified has none either.

If all four are right and the row is still absent, it is an account state only Apple can
change: developer.apple.com/contact, choose Agreements, Tax, and Banking, and say the Paid
Apps row is missing while the Free Apps agreement is Active, quoting the team ID. Nothing
in this repository or in the App Store Connect API can create it — there is no agreements
endpoint — and Apple's own In-App Purchase setup guide states that the agreement must be
Active before in-app purchases can be tested in the sandbox. Until it is, StoreKit answers
with an empty product list and that is not a fault in the app.

### Granting a session without the store

A signed session code is the way through while the agreement is missing, and it is not a
second kind of session: redeeming one mints a key through the same service a purchase uses.

1. Put a secret on the server: `SESSION_GRANT_SECRET` in the service environment (or reuse
   `SAGE_ADMIN_SECRET`, which the server falls back to).
2. Mint a code on any machine holding the same secret — nothing is sent anywhere:

   ```sh
   SESSION_GRANT_SECRET=… node scripts/grant-session.mjs --plan sage-session-standard --email you@example.com
   ```

   `--plan` takes `sage-session-trial`, `sage-session-standard` or `sage-session-intensive`,
   and `--days` sets how long the code stays redeemable (default 7). The minutes are the
   plan's own, so a granted trial is still five minutes.
3. In the app: **Settings → Session → “Use a session code”**, paste, done. The session clock
   and the expiry behave exactly as they do after a purchase.

A code is single-use: the server remembers the nonce it paid out against. Without the
secret the route answers 501 rather than accepting anything, which is the failure mode worth
having.

The App Store Connect API cannot read that tab: the old `/v1/agreements` endpoint is gone,
and a lapsed agreement shows up only as `403 REQUIRED_AGREEMENTS_MISSING_OR_EXPIRED` on an
otherwise valid request. `gh workflow run asc-iap.yml -f iap_status=true` prints each
product's state, price coverage and submission, and names that refusal explicitly when
Apple gives it — which is as close as a machine can get to reading the tab.

### The release check

`gh workflow run asc-iap.yml -f release_check=true` fails when the build attached to the
version Apple would take is older than the newest valid build for that version string.
That is the failure mode a version's build relationship creates: a fresh upload appears in
TestFlight and the App Store record keeps the previous binary, so a submission reviews code
nobody can install. It also fails when no build is attached at all, and when there is no
iOS version. Read-only — it never attaches anything, it names the fix instead.

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
  "productId": "us.innotel.sage.session.trial",
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

## When the certificate cap is reached

A build can fail in **Archive** with Apple's own words:

```
error: Choose a certificate to revoke. Your account has reached the maximum number of
       certificates.
error: No profiles for 'us.inotnel.sage' were found
```

That is the account, not the code. A team may hold three Apple Distribution
certificates and Xcode will not mint a fourth. The run imports `IOS_DIST_P12` and finds
one valid identity, but Xcode no longer accepts that certificate for this team, so it
tries to create one and Apple refuses. Build 52 failed exactly this way.

Two ways to clear it, both in the developer portal (Certificates, Identifiers &
Profiles → Certificates):

1. **Revoke the stale certificates** that are not the one inside `IOS_DIST_P12`. The
   next run mints a fresh one and archives.
2. **Re-export the live certificate** as a `.p12` with its private key and replace
   `IOS_DIST_P12` and `IOS_DIST_P12_PASSWORD`. Nothing else changes.

Either way the p12 has to be the certificate the account will sign with: a run that
mints one instead of using the imported one spends one of the three, which is how a
team arrives at this cap after a few builds.

## Submitting 1.0 for review

The App Store version is submitted from App Store Connect, not from this repo.
`scripts/asc-iap.mjs` prepares it (`-f listing=true` publishes the description and the
review notes) and can submit it (`-f publish=true`), but that second step is
irreversible and belongs to a person.

1. **A VALID build attached to 1.0.** `-f attach=true` attaches the newest build and
   `-f probe=true` prints what the version now carries.
2. **The three consumables are Ready to Submit** and included in this submission, or
   Apple rejects a build that sells something it cannot see.
3. **The review notes are the repository's copy** — publish them with `-f listing=true`,
   so what Apple reads is `reviewNotes()` and nothing transcribed by hand.
4. **Review Information:** contact name, phone (`APPLE_REVIEW_PHONE`) and email. No demo
   account: the app has no accounts, and the notes say so.
5. **The recording.** There is no `APPLE_REVIEW_RECORDING_URL` secret, so the notes
   promise the video in the message thread — attach it in App Review → Messages right
   after submitting, or the promise is the only evidence there is.
6. **Submit** — Version 1.0 → Add for Review → Submit for Review.

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
