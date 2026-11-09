# Session codes: issuing sessions without the App Store

A session code is a signed string that mints one real session — the same key, the same
expiry and the same clock a StoreKit purchase installs. Use it while the Paid Apps
Agreement is missing, or to hand a session to someone whose store cannot buy yet.

## The secret

The server accepts codes signed with `SESSION_GRANT_SECRET`, and falls back to
`SAGE_ADMIN_SECRET` when that is unset — which is the case on the deployed instance, so the
admin secret is the value to use. Whoever holds it can mint sessions, so treat it as
billing credentials, not a configuration detail. Set `SESSION_GRANT_SECRET` if you want the
two separated.

Without either secret the route answers `501 grants_disabled`. That is the intended failure:
closed, not open.

## Mint one

```sh
SESSION_GRANT_SECRET='…' node scripts/grant-session.mjs --plan sage-session-standard --email student@example.com
```

| Flag | Meaning |
| --- | --- |
| `--plan` | `sage-session-trial`, `sage-session-standard`, `sage-session-intensive` |
| `--email` | recorded against the session; optional |
| `--days` | how long the *code* stays redeemable, default 7 |

The code prints to stdout and a one-line summary (`plan · minutes · expires in`) to stderr,
so it can be piped. The minutes come from the plan, not the code: a granted trial is five
minutes, exactly like a bought one.

Nothing is stored on the minting machine and nothing is sent anywhere — the code is signed
locally, so this works offline and without the App Store.

## Redeem one

- **In the app**: Settings → Session → "Use a session code", paste, press the button. The
  session installs, the clock starts, and the gateway key is verified before it replaces
  what is stored.
- **On a fresh install**: the setup card offers the same field, so a session can be installed
  before anything else is configured.
- **By hand**, to check a code or script a redemption:

  ```sh
  curl -sS https://sage.innotel.tech/api/iap/grant \
    -H 'content-type: application/json' \
    -d '{"code":"sage1.…"}'
  ```

  The reply is the same shape a purchase returns: `key`, `planName`, `expiresAt`,
  `secondsLeft`, `minutes`, `granted: true`.

## What a code guarantees

- **Single use.** The server keeps the nonce it paid out against, per process. A second
  redemption answers `409 already_redeemed`.
- **Expiry.** The code carries its own deadline and is refused after it (`that session code
  has expired`), whether or not it was ever used.
- **Not forgeable without the secret.** HMAC-SHA256 over the payload; an edited payload or a
  wrong secret answers `that session code is not genuine`.
- **Plan-bound.** A code naming a plan the server does not sell is refused, so a stale code
  cannot silently become a free intensive session.

## Seeing what has been used

Redemptions are recorded in the running process's `handedOut` set — enough to stop replays,
not a report. There is no redemption ledger on disk; if you need one, the place to add it is
next to the trial ledger in `src/iap.mjs` (`remember`/`rememberTrial`, backed by
`data/trial-claims.json`).

For a count of what was actually granted, search the service log for `grant:` transaction
ids, or issue codes with distinct `--email` values and keep your own list. Codes are
cheap to make and cheap to let expire: prefer short `--days` over long ones.

## When the agreement arrives

Nothing has to be removed. Purchase and grant share one mint, so a session bought through
StoreKit and a session granted by code are the same kind of session; only the transaction id
differs (`grant:<nonce>` versus Apple's).
