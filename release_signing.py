"""SeekDeep release-manifest signing (AUD-001 follow-up).

The self-updater (`POST /system/self-update` in gui_endpoints.py) already verifies
downloaded files against GitHub's published git-blob SHAs. That proves the bytes
match what GitHub stores for a ref — it does NOT defend a *compromised repo*
(stolen maintainer token, malicious commit): the bad code has a valid git SHA, so
the check passes. Closing that needs a signature the app verifies against a key
the repo compromise can't reach.

This module provides that, with ZERO third-party dependencies:

  * a compact, self-contained Ed25519 (RFC 8032) implementation — sign + verify.
    Pure Python so it runs in the lightweight boot venv with no extra install;
    correctness is pinned by the official RFC 8032 §7.1 test vectors in the smoke
    suite. (Slow — milliseconds per verify — which is irrelevant for one
    signature per update.)
  * helpers to build a release manifest (file -> sha256) and verify staged files
    against it.

Trust model: the maintainer generates a keypair OFFLINE (scripts/gen_release_keypair.py),
pins the PUBLIC key here (RELEASE_SIGNING_PUBKEY_HEX), and keeps the PRIVATE seed
off the repo / off CI. Releases are signed locally (scripts/sign_release_manifest.py).
The server verifies the signature against the pinned public key before committing
an update. A GitHub account compromise that lacks the offline private key cannot
produce an installable signed release.

NOTE: this is the canonical slow reference Ed25519. It is intended for low-volume
signature verification (one per self-update). A future hardening could swap to
the `cryptography` package for constant-time verification if it becomes a runtime
dependency for other reasons.
"""

from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path

# ---------------------------------------------------------------------------
# Pinned release-signing PUBLIC key (hex, 32 bytes / 64 hex chars).
# Empty by default: until the maintainer runs scripts/gen_release_keypair.py and
# pastes the public key here, signature verification is INERT (the self-updater
# keeps its existing git-SHA integrity gate). Once set, the server will verify
# release signatures per the policy in gui_endpoints.py.
# ---------------------------------------------------------------------------
RELEASE_SIGNING_PUBKEY_HEX = ""

# Files the manifest covers (must mirror the self-updater's `single_files` plus
# the top-level gui/ and scripts/ files it fetches). The signing script walks
# these; the server checks every staged file is present + matches.
MANIFEST_SINGLE_FILES = [
    "local_ai_server.py",
    "gui_endpoints.py",
    "warmup_local_cache.py",
    "package.json",
    "requirements-local.txt",
    "requirements-ml.txt",
]
MANIFEST_SUBDIRS = ["gui", "scripts"]
MANIFEST_NAME = "release-manifest.json"
MANIFEST_SIG_NAME = "release-manifest.json.sig"

# ===========================================================================
# Ed25519 (RFC 8032) — compact reference implementation.
# ===========================================================================
_b = 256
_q = 2 ** 255 - 19
_L = 2 ** 252 + 27742317777372353535851937790883648493


def _H(m: bytes) -> bytes:
    return hashlib.sha512(m).digest()


def _inv(x: int) -> int:
    return pow(x, _q - 2, _q)


_d = (-121665 * _inv(121666)) % _q
_I = pow(2, (_q - 1) // 4, _q)


def _xrecover(y: int) -> int:
    xx = (y * y - 1) * _inv(_d * y * y + 1)
    x = pow(xx, (_q + 3) // 8, _q)
    if (x * x - xx) % _q != 0:
        x = (x * _I) % _q
    if x % 2 != 0:
        x = _q - x
    return x


_By = (4 * _inv(5)) % _q
_Bx = _xrecover(_By)
_B = [_Bx % _q, _By % _q]


def _edwards(P, Q):
    x1, y1 = P
    x2, y2 = Q
    x3 = (x1 * y2 + x2 * y1) * _inv(1 + _d * x1 * x2 * y1 * y2)
    y3 = (y1 * y2 + x1 * x2) * _inv(1 - _d * x1 * x2 * y1 * y2)
    return [x3 % _q, y3 % _q]


def _scalarmult(P, e: int):
    if e == 0:
        return [0, 1]
    Q = _scalarmult(P, e // 2)
    Q = _edwards(Q, Q)
    if e & 1:
        Q = _edwards(Q, P)
    return Q


def _encodeint(y: int) -> bytes:
    return y.to_bytes(_b // 8, "little")


def _encodepoint(P) -> bytes:
    x, y = P
    val = y | ((x & 1) << (_b - 1))
    return val.to_bytes(_b // 8, "little")


def _bit(h: bytes, i: int) -> int:
    return (h[i // 8] >> (i % 8)) & 1


def _publickey_from_seed(seed: bytes) -> bytes:
    h = _H(seed)
    a = 2 ** (_b - 2) + sum(2 ** i * _bit(h, i) for i in range(3, _b - 2))
    A = _scalarmult(_B, a)
    return _encodepoint(A)


def _Hint(m: bytes) -> int:
    h = _H(m)
    return sum(2 ** i * _bit(h, i) for i in range(2 * _b))


def _isoncurve(P) -> bool:
    x, y = P
    return (-x * x + y * y - 1 - _d * x * x * y * y) % _q == 0


def _decodeint(s: bytes) -> int:
    return int.from_bytes(s, "little")


def _decodepoint(s: bytes):
    y = int.from_bytes(s, "little") & ((1 << (_b - 1)) - 1)
    x = _xrecover(y)
    if x & 1 != _bit(s, _b - 1):
        x = _q - x
    P = [x, y]
    if not _isoncurve(P):
        raise ValueError("decoded point is not on the curve")
    return P


def ed25519_publickey(seed: bytes) -> bytes:
    """Derive the 32-byte public key from a 32-byte private seed."""
    if len(seed) != 32:
        raise ValueError("seed must be exactly 32 bytes")
    return _publickey_from_seed(seed)


def ed25519_sign(message: bytes, seed: bytes, public: bytes | None = None) -> bytes:
    """Return the 64-byte Ed25519 signature of `message` under `seed`."""
    if len(seed) != 32:
        raise ValueError("seed must be exactly 32 bytes")
    if public is None:
        public = _publickey_from_seed(seed)
    h = _H(seed)
    a = 2 ** (_b - 2) + sum(2 ** i * _bit(h, i) for i in range(3, _b - 2))
    r = _Hint(h[_b // 8: _b // 4] + message)
    R = _scalarmult(_B, r)
    S = (r + _Hint(_encodepoint(R) + public + message) * a) % _L
    return _encodepoint(R) + _encodeint(S)


def ed25519_verify(signature: bytes, message: bytes, public: bytes) -> bool:
    """True iff `signature` is a valid Ed25519 signature of `message` under
    `public`. Never raises — returns False on any malformed input."""
    try:
        if len(signature) != 64 or len(public) != 32:
            return False
        R = _decodepoint(signature[: _b // 8])
        A = _decodepoint(public)
        S = _decodeint(signature[_b // 8: _b // 4])
        if S >= _L:
            return False  # reject non-canonical S (basic malleability guard)
        h = _Hint(_encodepoint(R) + public + message)
        return _scalarmult(_B, S) == _edwards(R, _scalarmult(A, h))
    except Exception:
        return False


# ===========================================================================
# Manifest helpers.
# ===========================================================================
def sha256_hex(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def list_manifest_files(root: Path) -> list[str]:
    """Repo-relative paths the manifest should cover: the single files plus the
    TOP-LEVEL files in gui/ and scripts/ (mirrors what the self-updater fetches —
    it lists each subdir non-recursively and fetches type==file entries)."""
    root = Path(root)
    rels: list[str] = []
    for f in MANIFEST_SINGLE_FILES:
        if (root / f).is_file():
            rels.append(f)
    for sub in MANIFEST_SUBDIRS:
        d = root / sub
        if d.is_dir():
            for entry in sorted(d.iterdir()):
                if entry.is_file():
                    rels.append(f"{sub}/{entry.name}")
    return sorted(rels)


def build_manifest(root: Path, ref: str) -> dict:
    """Build the manifest dict: ref + {relpath: sha256hex} for every covered file."""
    root = Path(root)
    files = {}
    for rel in list_manifest_files(root):
        files[rel] = sha256_hex((root / rel).read_bytes())
    return {
        "schema": "seekdeep-release-manifest/v1",
        "ref": ref,
        "algorithm": "sha256",
        "files": files,
    }


def manifest_to_bytes(manifest: dict) -> bytes:
    """Deterministic on-disk JSON the signature is computed over. Sorted keys +
    a trailing newline so re-serialization on the server matches byte-for-byte
    is NOT required — the signature is over the exact file bytes, so the server
    verifies the raw fetched bytes (see verify_release_bytes)."""
    return (json.dumps(manifest, indent=2, sort_keys=True) + "\n").encode("utf-8")


def check_staged_against_manifest(manifest: dict, staging: Path, staged_items: list[dict]) -> tuple[bool, str]:
    """Every staged file must be present in the manifest with a matching sha256.
    Returns (ok, reason)."""
    staging = Path(staging)
    files = (manifest or {}).get("files") or {}
    if not isinstance(files, dict) or not files:
        return False, "manifest has no files map"
    bad: list[str] = []
    for item in staged_items:
        rel = item.get("path")
        if not rel:
            continue
        want = files.get(rel)
        if not want:
            bad.append(f"{rel} (not in manifest)")
            continue
        try:
            got = sha256_hex((staging / rel).read_bytes())
        except Exception:
            bad.append(f"{rel} (unreadable in staging)")
            continue
        if got != want:
            bad.append(f"{rel} (sha256 mismatch)")
    if bad:
        return False, "manifest file check failed: " + ", ".join(bad[:8])
    return True, ""


def verify_release_bytes(manifest_bytes: bytes, signature_b64: bytes, pubkey_hex: str) -> tuple[bool, str, dict | None]:
    """Verify the detached signature over the EXACT manifest file bytes, then
    parse the manifest. Returns (ok, reason, manifest_or_None)."""
    pubkey_hex = (pubkey_hex or "").strip()
    if not pubkey_hex:
        return False, "no pinned release-signing public key", None
    try:
        pub = bytes.fromhex(pubkey_hex)
    except ValueError:
        return False, "pinned public key is not valid hex", None
    try:
        import base64
        sig = base64.b64decode(signature_b64, validate=False)
    except Exception:
        return False, "signature is not valid base64", None
    if not ed25519_verify(sig, manifest_bytes, pub):
        return False, "manifest signature does not verify against the pinned key", None
    try:
        manifest = json.loads(manifest_bytes.decode("utf-8"))
    except Exception:
        return False, "manifest is not valid JSON", None
    return True, "", manifest
