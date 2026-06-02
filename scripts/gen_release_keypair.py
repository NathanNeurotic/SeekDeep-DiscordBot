#!/usr/bin/env python3
"""Generate a SeekDeep release-signing keypair (AUD-001 follow-up). Run ONCE.

The PRIVATE seed must stay OFFLINE — on the maintainer's machine, never in the
repo and never as a CI secret. That offline-ness is the whole point: a GitHub
account/repo compromise that can't reach the private seed cannot forge a signed
release the self-updater will accept.

Usage:
    python scripts/gen_release_keypair.py [--out PATH]

Writes the 32-byte private seed (hex) to PATH (default ~/.seekdeep/release-signing.seed,
created with 0600, refuses to overwrite) and prints the PUBLIC key hex to paste
into release_signing.py's RELEASE_SIGNING_PUBKEY_HEX.
"""
from __future__ import annotations

import argparse
import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import release_signing as rs  # noqa: E402


def main() -> int:
    ap = argparse.ArgumentParser(description="Generate an offline release-signing keypair.")
    default_out = Path(os.path.expanduser("~")) / ".seekdeep" / "release-signing.seed"
    ap.add_argument("--out", default=str(default_out), help=f"private seed path (default: {default_out})")
    args = ap.parse_args()

    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)

    seed = os.urandom(32)
    pub = rs.ed25519_publickey(seed)

    # O_CREAT | O_EXCL: refuse to clobber an existing key (would orphan releases
    # signed with the old one). 0o600 so it's owner-only where the OS honors it.
    flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL
    try:
        fd = os.open(str(out), flags, 0o600)
    except FileExistsError:
        print(f"ERROR: {out} already exists. Refusing to overwrite an existing private key.", file=sys.stderr)
        print("       Delete it deliberately (and re-pin the new public key) if you really want a new key.", file=sys.stderr)
        return 1
    with os.fdopen(fd, "w", encoding="utf-8") as f:
        f.write(seed.hex() + "\n")
    try:
        os.chmod(out, 0o600)
    except Exception:
        pass

    print("Release-signing keypair generated.")
    print("")
    print(f"  PRIVATE seed -> {out}")
    print("    * KEEP THIS OFFLINE. Do NOT commit it. Do NOT put it in CI secrets.")
    print("    * Back it up somewhere safe — losing it means you can't sign new releases.")
    print("")
    print("  PUBLIC key (paste into release_signing.py RELEASE_SIGNING_PUBKEY_HEX):")
    print("")
    print(f"    RELEASE_SIGNING_PUBKEY_HEX = \"{pub.hex()}\"")
    print("")
    print("Next: 1) paste the public key above into release_signing.py and commit it;")
    print("      2) sign each release with scripts/sign_release_manifest.py;")
    print("      3) flip SEEKDEEP_SELF_UPDATE_REQUIRE_SIGNATURE=on once signed releases are the norm.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
