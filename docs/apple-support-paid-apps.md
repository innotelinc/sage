# Support request: Paid Apps Agreement row is missing

Send this to **developer.apple.com/contact** → *Agreements, Tax, and Banking*. The account
I would send it from is the one that can see Business → Agreements; if that is an Admin
rather than the Account Holder, say so, because Apple will ask.

---

**Subject:** Paid Apps Agreement row missing from Business → Agreements (team 92588352)

Hello,

Our organisation cannot offer or test in-app purchases because the **Paid Apps
Agreement** is not offered anywhere in our account, and I am asking you to make it
available.

**Account**

- Organisation: Denovo Credit Corporation, 11 Moore St, Springfield, MA 01107-1029, United States
- Team ID: 92588352
- App: SAGE (App Store Connect app 6829329963, bundle `us.innotel.sage`)
- Signed in as: Darnel Hunter

**What the Business page shows**

`Business → Agreements` lists exactly one agreement:

- Free Apps Agreement — All Countries or Regions — effective Oct 31, 2026 to Sep 2, 2027 — **Active**

There is no Paid Apps row, no "View and Agree to Terms" button, and no way to request the
agreement. Above the table, App Store Connect shows the banner:

> To offer apps or other in-app purchases, you must sign the Paid Apps Agreement.

**What I have already checked**

- The role on this account, in Users and Access → [role]: [Account Holder / Admin — state which].
- The Apple ID is a member of team 92588352 and no other team is involved.
- developer.apple.com/account → Membership details shows an active Apple Developer Program
  membership, and no agreement is waiting to be accepted there.
- Both the current Business section and the older Agreements, Tax, and Banking page show
  the same thing, in two browsers, with cache cleared.
- No banking information or tax forms can be submitted, because Apple requires the Paid
  Apps Agreement to be signed before either form appears (per your own documentation).

**Impact**

Three In-App Purchase products exist and are `READY_TO_SUBMIT` with prices in 175 storefronts
(`us.innotel.sage.session.trial`, `.standard`, `.intensive`). Your In-App Purchase setup guide
states the agreement must be Active to test in-app purchases in the sandbox, so the
purchase path cannot be tested at all — StoreKit returns an empty product list — and the app
cannot be submitted with its products.

**Request**

Please either make the Paid Apps Agreement available to sign on team 92588352, or tell me
what account condition is preventing it from being offered so I can correct it.

Thank you,
Darnel Hunter
Denovo Credit Corporation

---

## What to expect

The row appears when Apple creates the contract; nothing in App Store Connect, this
repository, or the App Store Connect API can create it. Once the row exists the order is
fixed: **sign it first**, then the Tax Forms section appears, then banking, and the row reads
Active usually within a day. StoreKit starts answering for those products after that, and no
new build is needed for it.

Until then, sessions can be handed out with `scripts/grant-session.mjs` — see
`deploy/ios/README.md`, "Granting a session without the store".

Where the agreement is signed, the order Apple reveals tax and banking in, and what to check
on the phone and in App Store Connect once it reads Active: `docs/paid-apps-agreement.md`.
