# Release Signing (self-update integrity) — AUD-001 follow-up

SeekDeep's self-updater (`POST /system/self-update`) already verifies downloaded
files against GitHub's published git-blob SHAs. That proves the bytes match what
GitHub stores for a ref — it does **not** defend a *compromised repo* (a stolen
maintainer token or a malicious commit would have a valid git SHA). Release
signing closes that: the app verifies a maintainer **Ed25519 signature** over a
release manifest before installing, using a key a repo compromise can't reach.

It is **$0 and dependency-free**: the Ed25519 implementation is vendored in
`release_signing.py` (pure Python, pinned to the RFC 8032 test vectors in the
smoke suite). No certificate authority, no paid signing service.

> This is **opt-in** and ships **inert**: until you pin a public key, the
> self-updater behaves exactly as before (git-SHA integrity gate only). A
> present-but-*invalid* signature is always refused once a key is pinned.

## One-time setup

1. **Generate a keypair — OFFLINE, on your machine:**

   ```sh
   python scripts/gen_release_keypair.py
   ```

   This writes the 32-byte private seed to `~/.seekdeep/release-signing.seed`
   (owner-only, refuses to overwrite) and prints the public key.

   - **Keep the private seed offline.** Do **not** commit it. Do **not** put it
     in CI secrets. Its offline-ness is the entire security benefit — a GitHub
     account compromise that lacks it cannot forge an installable release.
   - **Back it up** somewhere safe; losing it means you can't sign new releases
     (you'd have to generate a new key and ship it in an installer update).

2. **Pin the public key** in `release_signing.py`:

   ```python
   RELEASE_SIGNING_PUBKEY_HEX = "<the hex the script printed>"
   ```

   Commit that change. The server now *can* verify signatures (it still won't
   *require* them until step 4).

## Each release

3. **Sign the manifest** for the ref you publish (run with the offline seed):

   ```sh
   python scripts/sign_release_manifest.py --ref vX.Y.Z
   ```

   This writes `release-manifest.json` (every self-updatable file → sha256) and
   `release-manifest.json.sig` (detached base64 Ed25519 signature). **Commit both**
   to the ref/tag users update to. The manifest's `ref` field must equal the ref
   you tell users to update to — the server checks it (replay guard).

## Enforce signatures

4. Once signed releases are the norm, require them:

   ```ini
   # .env
   SEEKDEEP_SELF_UPDATE_REQUIRE_SIGNATURE=on
   ```

   Behavior matrix (pinned key present):

   | Manifest for the ref | `REQUIRE_SIGNATURE` | Result |
   |---|---|---|
   | valid signature + file hashes match | on or off | update proceeds |
   | **present but signature/hash invalid** | on or off | **aborted (409)** — always |
   | absent (old unsigned release) | off (default) | proceeds (git-SHA gate only) |
   | absent | on | aborted (409) |

   With **no** key pinned: `off` → proceeds (unchanged); `on` → aborts (you asked
   for signatures but configured none).

## How verification works (server side)

In `_post_self_update_locked` (gui_endpoints.py), after the git-SHA integrity gate
and before the commit phase:

1. Resolve the pinned key (`SEEKDEEP_RELEASE_SIGNING_PUBKEY` env override, else
   `release_signing.RELEASE_SIGNING_PUBKEY_HEX`).
2. Fetch `release-manifest.json` + `.sig` for the ref.
3. Verify the Ed25519 signature over the **exact** manifest bytes against the
   pinned key.
4. Verify every staged file's sha256 matches the manifest, and the manifest `ref`
   matches the requested ref.
5. Any failure aborts before commit — the live tree is untouched.

## Key rotation

Generate a new keypair, pin the new public key, and sign new releases with the new
seed. Clients only trust the currently-pinned key, so rotate in a release users
will pull *before* you retire the old key. Keep the old releases' manifests intact
(they were signed by the old key, which those clients still had pinned at the time).

## Residual risk

The vendored Ed25519 is the canonical (slow) reference implementation, fine for one
verification per update. A future hardening could swap to the `cryptography`
package for constant-time verification if it becomes a runtime dependency for other
reasons. The signature defends repo/account compromise; it does not replace OS-level
**installer** signing (SmartScreen/Gatekeeper), which is a separate, optional, paid
concern (`certificateThumbprint` in `tauri.conf.json` is currently null).
