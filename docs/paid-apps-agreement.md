# Paid Apps Agreement: where it is signed, and what to check after

StoreKit sells nothing on this account until the **Paid Apps Agreement** is Active. The app
cannot cause that and no build makes it happen: Apple declines to return the products until
the contract is signed, which the app shows as `Selling · blocked` with
`StoreKit · answered 0 of 3` in **Settings → Session**.

## Where it is signed

1. Sign in to **App Store Connect** as the **Account Holder** — the Legal role. An Admin can
   see the page but cannot agree, and Apple does not offer the row to anyone else.
2. Open **Business** in the top navigation (`appstoreconnect.apple.com/business`; the older
   path is *Agreements, Tax, and Banking*). The **Agreements** table lists the contracts for
   team `92588352`.
3. Find the **Paid Apps** row and choose **View and Agree to Terms**. Read it, tick the box,
   and submit — the Account Holder is the only signer.

If there is no Paid Apps row at all, only the Free Apps row, the contract has not been issued
to the team: that is a support request, not a setting. `docs/apple-support-paid-apps.md` holds
the message to send.

## After signing, in this order

Apple reveals each section only once the one before it is done, and the order is fixed:

1. **Paid Apps Agreement** — signed, effective date shown.
2. **Tax Forms** — a U.S. tax form for Denovo Credit Corporation (a W-9 for a U.S. entity).
3. **Banking** — the account the proceeds are paid into.
4. **Contacts** — the legal and financial contacts Apple writes to.

The row reads **Active** usually within a day of the last form being accepted; Apple emails
when it changes. No new build and no server change is needed for StoreKit to start answering.

## Checks once it reads Active

- **Business → Agreements** — Paid Apps row says Active, with an expiry date.
- **Tax and Banking** — both show complete, with nothing marked *Action needed*.
- **Products** — `gh workflow run asc-iap.yml -f iap_status=true` prints each session product's
  state and its territory availability. The three should be `READY_TO_SUBMIT`
  (`us.inotell.sage.session.trial`, `.standard`, `.intensive`) and priced in every storefront.
- **On the phone, build 84 or newer** — **Settings → Session** should now read
  `Selling · ready — the App Store will charge`, then `StoreKit · answered 3 of 3` with three
  prices, then `payments · allowed · storefront US` (the storefront of the signed-in Apple ID).
- **A sandbox purchase** — in TestFlight, buy the trial session; it should complete, mint a key
  and install it without leaving the app. A cancel or failure is reported in `buyStatus`
  under the button.

## Then, to sell it for real

Products go to App Review with a version, so the order is: `-f attach=true` (newest valid
build onto 1.0 and into the open submission), then `-f submit=true`, and only after that
`-f publish=true` — which is the step that actually submits to App Review, and is never run
without being asked for.

## If StoreKit still answers nothing after Active

- Give it until the next day: the API lags the Business page.
- `-f iap_status=true` — a product missing from a storefront, or not `READY_TO_SUBMIT`, answers
  nothing on a phone in that storefront.
- Check the ids the server offers: `GET /api/iap/config` must list the same three as App Store
  Connect (`IAP_PRODUCTS` on the server).
- In the TestFlight build, the panel's `payments` line separates the two cases: `allowed` means
  the Apple ID is fine and the store is the one refusing; `this Apple ID may not pay` means
  Screen Time or payment restrictions on the device.
