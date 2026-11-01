# Certificate and dependency audit — 1 November 2026

Every public name in the estate was queried as a client would, reading the
certificate actually presented (not the file on disk), including its SAN list,
issuer and validity window.

## Certificates

| Host | Certificate | SAN | Valid until | Verdict |
| --- | --- | --- | --- | --- |
| `innotel.us` | `CN=innotel.us` | `*.innotel.us`, `innotel.us` | 14 Dec 2026 | OK |
| `www.innotel.us` | `CN=innotel.us` | `*.innotel.us`, `innotel.us` | 14 Dec 2026 | OK (wildcard) |
| `subscribe.innotel.us` | `CN=innotel.us` | `*.innotel.us`, `innotel.us` | 14 Dec 2026 | OK (wildcard) |
| `cerulean.innotel.us` | `CN=cerulean.innotel.us` | `*.cerulean.innotel.us`, `cerulean.innotel.us` | 14 Dec 2026 | OK |
| `gateway.innotel.us` | `CN=gateway.innotel.us` | `gateway.innotel.us` | 13 Jan 2027 | OK |
| `mail.innotel.us` | `CN=mail.innotel.us` | `mail.innotel.us` | 9 Jan 2027 | OK |
| `onyx.innotel.us` | `CN=onyx.innotel.us` | `*.onyx.innotel.us`, `onyx.innotel.us` | 14 Dec 2026 | OK |
| `sage.lab.innotel.us` | `CN=lab.innotel.us` | `*.lab.innotel.us`, `lab.innotel.us` | 14 Dec 2026 | OK (wildcard) |
| `sage.innotel.tech` | `CN=lab.innotel.us` | `*.lab.innotel.us`, `lab.innotel.us` | 14 Dec 2026 | **BROKEN** |

### Findings

1. **`sage.innotel.tech` serves the wrong certificate.** It presents the
   `*.lab.innotel.us` wildcard, which does not cover the name, so every verified
   client fails — browsers show an interstitial, and iOS (App Transport
   Security) refuses the connection outright. This is the one host that needs a
   certificate issued for it; the SAGE container's `.env` already points at
   `/opt/sage/certs/{fullchain,privkey}.pem`, so installing a correct pair is
   the whole fix.
2. **The Let's Encrypt batch from 15 September 2026 expires 14 December 2026.**
   `innotel.us` and its wildcard, `cerulean.innotel.us` and `onyx.innotel.us`
   all share that window. They are valid today; renewal should happen in the
   first week of December rather than at expiry.
3. **No other host is mis-provisioned.** `gateway.innotel.us` and
   `mail.innotel.us` hold single-name certificates with their own longer
   windows, and the wildcard hosts genuinely cover the names served from them.
4. **Reissuing everything is not required and is actively risky.** Only the SAGE
   name is wrong; replacing the gateway, mail, proxy and Cerulean certificates
   would put working services through an unnecessary handover.
5. **The staging copy of certificates on `dev` is the lab wildcard.** Anything
   that copies `/opt/sage/certs` into a container inherits this, which is how
   the SAGE name broke. `deploy/i4-provision.sh` now refuses to overwrite a
   certificate that already covers `innotel.tech`, and `deploy/i4-cert.sh`
   verifies the SAN of a candidate pair before installing it.

### Installing the replacement

```bash
bash deploy/i4-cert.sh /path/fullchain.pem /path/privkey.pem sage.innotel.tech
```

The script refuses a pair whose SAN does not cover the host, copies both files
into `/opt/sage/certs`, ensures `TLS_CERT`/`TLS_KEY`/`PORT` exist in the
container's `.env`, restarts the unit, and then re-checks the name the way a
client would.

## Dependencies

The application itself has **no runtime dependencies**: `package.json` declares
no `dependencies` and no `devDependencies`, there is no lockfile, and the server
runs on Node's standard library alone. `npm audit` therefore has no tree to
audit in this repository — it exits with `ENOLOCK` rather than reporting a clean
result, which is expected here and not a failure.

The only packages ever installed are the Capacitor toolchain the iOS workflow
pulls in at build time (`--no-save`, so they never enter the repository). That
tree audits as:

| Package | Version | Severity | Advisory |
| --- | --- | --- | --- |
| `@capacitor/cli` | 8.6.0 | moderate | via `rimraf` |
| `glob` | transitive | moderate | `AbortSignal` cancellation bypass allows post-timeout filesystem traversal |
| `minimatch` | transitive | moderate | denial of service via globparts amplification |
| `rimraf` | transitive | moderate | via `glob` |

Four moderate advisories, none high or critical, all in build tooling that runs
on a GitHub-hosted macOS runner and never ships to a device or a server. No
action is needed for the app; the workflow will pick up patched versions as
Capacitor releases them.
