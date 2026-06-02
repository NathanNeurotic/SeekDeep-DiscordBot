#!/usr/bin/env python3
"""Sign the SeekDeep release manifest (AUD-001 follow-up). Run at release time.

Builds release-manifest.json (every self-updatable file -> sha256) for the
current checkout and writes a detached Ed25519 signature release-manifest.json.sig
(base64) using the OFFLINE private seed. Commit both files; the server verifies
the signature against the pinned public key before applying a self-update.

Usage:
    python scripts/sign_release_manifest.py [--ref vX.Y.Z] [--seed PATH]

  --ref   ref/version the manifest is for (default: "v" + package.json version).
  --seed  private seed path (default: env SEEKDEEP_RELEASE_SIGNING_SEED, else
          ~/.seekdeep/release-signing.seed).
"""
from __future__ import annotations

import argparse
import base64
import json
import os
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
import release_signing as rs  # noqa: E402


def _read_seed(path: Path) -> bytes:
    txt = path.read_text(encoding="utf-8").strip()
    seed = bytes.fromhex(txt)
    if len(seed) != 32:
        raise ValueError(f"seed at {path} is {len(seed)} bytes, expected 32")
    return seed


def _default_ref() -> str:
    try:
        ver = json.loads((ROOT / "package.json").read_text(encoding="utf-8")).get("version")
        if ver:
            return f"v{ver}"
    except Exception:
        pass
    return "v0.0.0"


def main() -> int:
    ap = argparse.ArgumentParser(description="Sign the SeekDeep release manifest.")
    ap.add_argument("--ref", default=None, help="ref/version (default: v<package.json version>)")
    default_seed = os.environ.get("SEEKDEEP_RELEASE_SIGNING_SEED") \
        or str(Path(os.path.expanduser("~")) / ".seekdeep" / "release-signing.seed")
    ap.add_argument("--seed", default=default_seed, help=f"private seed path (default: {default_seed})")
    args = ap.parse_args()

    ref = args.ref or _default_ref()
    seed_path = Path(args.seed)
    if not seed_path.is_file():
        print(f"ERROR: private seed not found at {seed_path}.", file=sys.stderr)
        print("       Generate one offline with scripts/gen_release_keypair.py first.", file=sys.stderr)
        return 1
    try:
        seed = _read_seed(seed_path)
    except Exception as exc:
        print(f"ERROR: could not read seed: {exc}", file=sys.stderr)
        return 1

    pub = rs.ed25519_publickey(seed)
    pinned = (rs.RELEASE_SIGNING_PUBKEY_HEX or "").strip()
    if not pinned:
        print("WARNING: release_signing.RELEASE_SIGNING_PUBKEY_HEX is empty — the server")
        print("         won't verify until you pin this public key:")
        print(f"           RELEASE_SIGNING_PUBKEY_HEX = \"{pub.hex()}\"")
    elif pinned != pub.hex():
        print("ERROR: the seed's public key does not match the pinned RELEASE_SIGNING_PUBKEY_HEX.", file=sys.stderr)
        print(f"       seed pubkey:  {pub.hex()}", file=sys.stderr)
        print(f"       pinned:       {pinned}", file=sys.stderr)
        print("       You're signing with a key the server won't trust. Aborting.", file=sys.stderr)
        return 1

    manifest = rs.build_manifest(ROOT, ref)
    manifest_bytes = rs.manifest_to_bytes(manifest)
    sig = rs.ed25519_sign(manifest_bytes, seed, pub)
    sig_b64 = base64.b64encode(sig).decode("ascii")

    (ROOT / rs.MANIFEST_NAME).write_bytes(manifest_bytes)
    (ROOT / rs.MANIFEST_SIG_NAME).write_text(sig_b64 + "\n", encoding="utf-8")

    n = len(manifest.get("files", {}))
    print(f"Wrote {rs.MANIFEST_NAME} ({n} files, ref={ref}) + {rs.MANIFEST_SIG_NAME}.")
    print("Signature verifies locally:",
          rs.verify_release_bytes(manifest_bytes, sig_b64.encode(), pub.hex())[0])
    print("Commit both files. The server will verify them on the next self-update for this ref.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
