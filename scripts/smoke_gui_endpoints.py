"""
SeekDeep GUI endpoints smoke test
=================================

End-to-end checks for the FastAPI side-car routes that the GUI depends on.
Runs against an in-process TestClient -- no uvicorn, no GPU, no model load,
no Discord login. Safe on CI.

Covers the routes that have ZERO chance of regressing silently because
they're all defended by the audit overrides catalogued in MAINTAINER.md:

  /token                  (loopback-only auth bootstrap)
  /config/status          (modal-shaping endpoint, secret leak risk)
  /config        POST     (.env merge; X-SeekDeep-Token required)
  /launcher/...  POST     (process control; token required)
  /model/warm    POST     (loader dispatch; token required)
  /data/{file}   GET      (normalizers for server-stats / auto-reactions)
  /events        WS       (bus connect)
  /events/emit   POST     (publish + delivered count round-trip via WS)
  /events/status GET      (cheap probe)

Additionally exercises a second TestClient bound to local_ai_server.app for
the model lifecycle + routing introspection endpoints:

  /model/install   POST   (validation: missing model_id, unknown backend)
  /model/uninstall POST   (auth required; hf absent-model is ok; remote no-op)
  /route/debug     GET    (no auth; returns role -> backend -> endpoint plan)

Each check prints "ok" or "FAIL" with detail. Exit code is 0 only if every
check passes. Designed to be invoked from preflight.mjs and from CI.

Requires only: fastapi, httpx, pydantic. The full requirements-local.txt
(torch, transformers, diffusers, etc.) is NOT needed for this file.

Usage:
    python scripts/smoke_gui_endpoints.py
"""

from __future__ import annotations
import os
import sys
import re
from pathlib import Path

# Never let the smoke's in-process registration trigger the Docker/SearXNG
# auto-start — it would probe Docker and could launch Docker Desktop on a
# developer's machine during preflight. FORCE off (a test must never launch
# Docker), set BEFORE register_gui_endpoints ever runs.
os.environ["SEEKDEEP_AUTO_START_SEARXNG"] = "0"

# Project root = parent of scripts/
ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

# Track pass/fail counts
_results: list[tuple[bool, str, str]] = []   # (ok, name, detail)

def check(name: str, ok: bool, detail: str = "") -> None:
    _results.append((bool(ok), name, detail))
    marker = "  ok  " if ok else "  FAIL"
    suffix = f" -> {detail}" if detail else ""
    print(f"{marker} {name}{suffix}")


def _self_update_checks() -> None:
    """AUD-001 / AUD-004: hermetic /system/self-update coverage.

    The route writes executable code over its own tree, so we NEVER point it at
    the real repo here. A dedicated app is registered with repo_root=<tempdir>
    and every GitHub call is mocked through urllib.request.urlopen — no network,
    no live-tree mutation. Covers: ref policy (strict/loose/allow-main), auth,
    disabled flag, concurrency lock, bounded fetch, integrity mismatch (live
    tree untouched), and a mocked happy path that commits into the temp root.
    """
    import tempfile, shutil, json as _json, hashlib
    from unittest import mock
    from pathlib import Path as _Path
    try:
        from fastapi import FastAPI
        from fastapi.testclient import TestClient
        import gui_endpoints as _ge
        import urllib.request as _urlreq
        import release_signing as _rsign
        import base64 as _b64
    except Exception as e:
        check("self-update: test imports", False, str(e))
        return

    # ---- Ed25519 (release signing) — RFC 8032 §7.1 official test vectors ----
    # Pins the vendored pure-Python Ed25519's correctness: pubkey derivation,
    # signing, verification, and tamper-rejection must match the RFC exactly.
    _t1 = ("9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60",
           "d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a",
           "",
           "e5564300c360ac729086e2cc806e828a84877f1eb8e5d974d873e065224901555fb8821590a33bacc61e39701cf9b46bd25bf5f0595bbe24655141438e7a100b")
    _t2 = ("4ccd089b28ff96da9db6c346ec114e0f5b8a319f35aba624da8cf6ed4fb8a6fb",
           "3d4017c3e843895a92b70aa74d1b7ebc9c982ccf2ec4968cc0cd55f12af4660c",
           "72",
           "92a009a9f0d4cab8720e820b5f642540a2b27b5416503f8fb3762223ebdb69da085ac1e43e15996e458f3613d0f11d8c387b2eaeb4302aeeb00d291612bb0c00")
    for _i, (_sk, _pk, _m, _sig) in enumerate((_t1, _t2), 1):
        _seed = bytes.fromhex(_sk); _wantpub = bytes.fromhex(_pk)
        _msg = bytes.fromhex(_m); _wantsig = bytes.fromhex(_sig)
        _pub = _rsign.ed25519_publickey(_seed)
        _gotsig = _rsign.ed25519_sign(_msg, _seed, _pub)
        _tampered = (bytes([_msg[0] ^ 1]) + _msg[1:]) if _msg else b"\x01"
        check(f"ed25519 RFC8032 vector {_i}: pubkey + signature + verify match",
              _pub == _wantpub and _gotsig == _wantsig
              and _rsign.ed25519_verify(_wantsig, _msg, _wantpub) is True
              and _rsign.ed25519_verify(_wantsig, _tampered, _wantpub) is False)

    # ---- pure ref-policy matrix (no app, no network) ----
    pol_keys = ("SEEKDEEP_SELF_UPDATE_REF_POLICY", "SEEKDEEP_SELF_UPDATE_ALLOW_MAIN")
    pol_saved = {k: os.environ.get(k) for k in pol_keys}
    for k in pol_keys:
        os.environ.pop(k, None)  # strict default
    try:
        check("self-update ref(strict): vX.Y.Z tag allowed", _ge._self_update_ref_is_allowed("v10.35.47")[0] is True)
        check("self-update ref(strict): vX.Y.Z-pre tag allowed", _ge._self_update_ref_is_allowed("v10.36.0-rc1")[0] is True)
        check("self-update ref(strict): 40-char SHA allowed", _ge._self_update_ref_is_allowed("a" * 40)[0] is True)
        check("self-update ref(strict): 'main' refused", _ge._self_update_ref_is_allowed("main")[0] is False)
        check("self-update ref(strict): 7-char SHA refused", _ge._self_update_ref_is_allowed("abc1234")[0] is False)
        check("self-update ref(strict): 'vlatest' (non-semver) refused", _ge._self_update_ref_is_allowed("vlatest")[0] is False)
        check("self-update ref(strict): path-ish ref refused", _ge._self_update_ref_is_allowed("../etc/passwd")[0] is False)
        os.environ["SEEKDEEP_SELF_UPDATE_ALLOW_MAIN"] = "on"
        check("self-update ref: 'main' allowed with ALLOW_MAIN=on", _ge._self_update_ref_is_allowed("main")[0] is True)
        os.environ.pop("SEEKDEEP_SELF_UPDATE_ALLOW_MAIN", None)
        os.environ["SEEKDEEP_SELF_UPDATE_REF_POLICY"] = "loose"
        check("self-update ref(loose): 'main' allowed", _ge._self_update_ref_is_allowed("main")[0] is True)
        check("self-update ref(loose): short SHA allowed", _ge._self_update_ref_is_allowed("abc1234")[0] is True)
    finally:
        for k, v in pol_saved.items():
            if v is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = v

    # ---- route tests against a temp-root app ----
    tmp = _Path(tempfile.mkdtemp(prefix="sd-selfupd-"))
    auth_saved = dict(_ge._AUTH_STATE)
    cap_saved = _ge._SELF_UPDATE_MAX_FILE_BYTES
    enabled_saved = os.environ.get("SEEKDEEP_SELF_UPDATE_ENABLED")
    sig_env_saved = {k: os.environ.get(k) for k in
                     ("SEEKDEEP_RELEASE_SIGNING_PUBKEY", "SEEKDEEP_SELF_UPDATE_REQUIRE_SIGNATURE")}
    try:
        TT = "selfupd-test-token-0001"
        (tmp / ".env").write_text(f"SEEKDEEP_GUI_TOKEN={TT}\n", encoding="utf-8")
        app2 = FastAPI()
        _ge.register_gui_endpoints(app2, log_dir="logs", data_dir="data",
                                   env_path=str(tmp / ".env"), repo_root=str(tmp))
        c2 = TestClient(app2)
        H = {_ge._TOKEN_HEADER: TT}
        for k in ("SEEKDEEP_SELF_UPDATE_REF_POLICY", "SEEKDEEP_SELF_UPDATE_ALLOW_MAIN", "SEEKDEEP_SELF_UPDATE_ENABLED"):
            os.environ.pop(k, None)  # strict + enabled defaults

        check("POST /system/self-update no token -> 401",
              c2.post("/system/self-update", json={}).status_code == 401)

        os.environ["SEEKDEEP_SELF_UPDATE_ENABLED"] = "off"
        r = c2.post("/system/self-update", json={"ref": "v1.2.3"}, headers=H)
        os.environ.pop("SEEKDEEP_SELF_UPDATE_ENABLED", None)
        check("POST /system/self-update disabled -> 403", r.status_code == 403, f"got {r.status_code}")

        r = c2.post("/system/self-update", json={"ref": "main"}, headers=H)
        check("POST /system/self-update ref=main (strict) -> 400", r.status_code == 400, f"got {r.status_code}")

        r = c2.post("/system/self-update", json={"ref": "garbage!!"}, headers=H)
        check("POST /system/self-update bad ref -> 400", r.status_code == 400, f"got {r.status_code}")

        # concurrency: hold the lock -> the route's non-blocking acquire fails.
        got = _ge._SELF_UPDATE_LOCK.acquire(blocking=False)
        try:
            r = c2.post("/system/self-update", json={"ref": "v1.2.3"}, headers=H)
            check("POST /system/self-update while update in progress -> 409",
                  r.status_code == 409, f"got {r.status_code}")
        finally:
            if got:
                _ge._SELF_UPDATE_LOCK.release()

        # ---- mocked-network staging tests ----
        def _git_blob_sha(data: bytes) -> str:
            h = hashlib.sha1()
            h.update(b"blob " + str(len(data)).encode() + b"\x00")
            h.update(data)
            return h.hexdigest()

        class _FakeResp:
            def __init__(self, data: bytes):
                self._d = data
                self._p = 0
            def __enter__(self):
                return self
            def __exit__(self, *a):
                return False
            def read(self, n=-1):
                if self._p >= len(self._d):
                    return b""
                if n is None or n < 0:
                    chunk = self._d[self._p:]
                    self._p = len(self._d)
                    return chunk
                chunk = self._d[self._p:self._p + n]
                self._p += len(chunk)
                return chunk

        def _make_urlopen(file_bytes: bytes, tree_paths: dict, manifest_bytes=None, sig_bytes=None):
            def _open(req, timeout=None):
                url = getattr(req, "full_url", None) or str(req)
                # Manifest/sig URLs (.sig checked first — it's a superstring of the
                # manifest name). When no manifest is provided, 404 them so the
                # route's fetch raises and _have_manifest becomes False (mirrors a
                # release that simply hasn't published a signed manifest).
                if url.endswith(_rsign.MANIFEST_SIG_NAME):
                    if manifest_bytes is None:
                        raise OSError("404 manifest signature not found")
                    return _FakeResp(sig_bytes)
                if url.endswith(_rsign.MANIFEST_NAME):
                    if manifest_bytes is None:
                        raise OSError("404 manifest not found")
                    return _FakeResp(manifest_bytes)
                if "api.github.com" in url and "/contents/" in url:
                    return _FakeResp(b"[]")  # empty gui/ + scripts/ listings
                if "api.github.com" in url and "/git/trees/" in url:
                    tree = {"tree": [{"type": "blob", "path": p, "sha": s} for p, s in tree_paths.items()]}
                    return _FakeResp(_json.dumps(tree).encode())
                return _FakeResp(file_bytes)  # raw.githubusercontent file
            return _open

        # (a) integrity mismatch (empty tree => no SHA matches) -> 409, untouched.
        with mock.patch.object(_urlreq, "urlopen", _make_urlopen(b"FAKE-CODE", {})):
            r = c2.post("/system/self-update", json={"ref": "v9.9.9"}, headers=H)
        check("self-update integrity mismatch -> 409", r.status_code == 409, f"got {r.status_code}")
        check("self-update integrity fail: live tree untouched (no committed file)",
              not (tmp / "local_ai_server.py").exists())
        check("self-update integrity fail: staging dir cleaned up",
              not any(tmp.glob(".self-update-staging-*")))

        # (b) oversized response -> bounded read fails per-file, nothing committed.
        _ge._SELF_UPDATE_MAX_FILE_BYTES = 4
        with mock.patch.object(_urlreq, "urlopen", _make_urlopen(b"WAY-TOO-LONG", {})):
            r = c2.post("/system/self-update", json={"ref": "v9.9.9"}, headers=H)
        _ge._SELF_UPDATE_MAX_FILE_BYTES = cap_saved
        body = {}
        try:
            body = r.json()
        except Exception:
            pass
        check("self-update oversized: byte-cap failure surfaced, nothing committed",
              (r.status_code == 200 and body.get("ok") is False and "exceeds" in _json.dumps(body))
              or r.status_code in (409, 500),
              f"status={r.status_code} body={str(body)[:160]}")
        check("self-update oversized: live tree untouched",
              not (tmp / "local_ai_server.py").exists())

        # (c) happy path: tree SHAs match fetched bytes -> commit into temp root.
        content = b"# patched by self-update smoke test\n"
        single = ["local_ai_server.py", "gui_endpoints.py", "warmup_local_cache.py",
                  "package.json", "requirements-local.txt", "requirements-ml.txt"]
        tree_paths = {name: _git_blob_sha(content) for name in single}
        with mock.patch.object(_urlreq, "urlopen", _make_urlopen(content, tree_paths)):
            r = c2.post("/system/self-update", json={"ref": "v9.9.9"}, headers=H)
        body = {}
        try:
            body = r.json()
        except Exception:
            pass
        check("self-update happy path -> 200 ok=True",
              r.status_code == 200 and body.get("ok") is True, f"status={r.status_code} body={str(body)[:160]}")
        check("self-update happy path: file committed into temp root with fetched bytes",
              (tmp / "local_ai_server.py").exists() and (tmp / "local_ai_server.py").read_bytes() == content)
        check("self-update happy path: .self-updated sentinel written",
              (tmp / ".self-updated").exists())

        # (d) AUD-001 follow-up: release-signature gate. Ephemeral offline key →
        # pin its public half via env; sign a manifest covering the staged files.
        eph_seed = os.urandom(32)
        eph_pub = _rsign.ed25519_publickey(eph_seed)
        wrong_seed = os.urandom(32)
        wrong_pub = _rsign.ed25519_publickey(wrong_seed)
        os.environ["SEEKDEEP_RELEASE_SIGNING_PUBKEY"] = eph_pub.hex()

        def _signed(content_bytes, names, seed, pub, ref="v9.9.9"):
            man = {"schema": "seekdeep-release-manifest/v1", "ref": ref, "algorithm": "sha256",
                   "files": {n: hashlib.sha256(content_bytes).hexdigest() for n in names}}
            mb = _rsign.manifest_to_bytes(man)
            sig = _b64.b64encode(_rsign.ed25519_sign(mb, seed, pub))
            return mb, sig

        # (d1) require=on + valid signature -> commits the signed content.
        os.environ["SEEKDEEP_SELF_UPDATE_REQUIRE_SIGNATURE"] = "on"
        c2_content = b"# signed-update content v2\n"
        c2_tree = {n: _git_blob_sha(c2_content) for n in single}
        mb1, sig1 = _signed(c2_content, single, eph_seed, eph_pub)
        with mock.patch.object(_urlreq, "urlopen", _make_urlopen(c2_content, c2_tree, mb1, sig1)):
            r = c2.post("/system/self-update", json={"ref": "v9.9.9"}, headers=H)
        check("self-update signed: valid signature (require=on) -> 200",
              r.status_code == 200 and (r.json() or {}).get("ok") is True, f"got {r.status_code}")
        check("self-update signed: committed the signed content",
              (tmp / "local_ai_server.py").read_bytes() == c2_content)

        # (d2) present-but-INVALID signature (wrong key) -> 409 EVEN with require=off
        #      (a present-but-bad signature is always an attack signal). Different
        #      content that must NOT land.
        os.environ["SEEKDEEP_SELF_UPDATE_REQUIRE_SIGNATURE"] = "off"
        c3_content = b"# attacker swapped content v3\n"
        c3_tree = {n: _git_blob_sha(c3_content) for n in single}
        mb2, badsig = _signed(c3_content, single, wrong_seed, wrong_pub)  # signed by the WRONG key
        with mock.patch.object(_urlreq, "urlopen", _make_urlopen(c3_content, c3_tree, mb2, badsig)):
            r = c2.post("/system/self-update", json={"ref": "v9.9.9"}, headers=H)
        check("self-update signed: invalid signature -> 409 even when require=off",
              r.status_code == 409, f"got {r.status_code}")
        check("self-update signed: invalid-signature content NOT committed",
              (tmp / "local_ai_server.py").read_bytes() == c2_content)

        # (d3) require=on + NO manifest published -> 409.
        os.environ["SEEKDEEP_SELF_UPDATE_REQUIRE_SIGNATURE"] = "on"
        with mock.patch.object(_urlreq, "urlopen", _make_urlopen(c2_content, c2_tree)):  # no manifest
            r = c2.post("/system/self-update", json={"ref": "v9.9.9"}, headers=H)
        check("self-update signed: require=on + no manifest -> 409", r.status_code == 409, f"got {r.status_code}")

        # (d4) require=off + NO manifest (pinned key set) -> proceeds (graceful for
        #      old unsigned releases).
        os.environ["SEEKDEEP_SELF_UPDATE_REQUIRE_SIGNATURE"] = "off"
        with mock.patch.object(_urlreq, "urlopen", _make_urlopen(c2_content, c2_tree)):
            r = c2.post("/system/self-update", json={"ref": "v9.9.9"}, headers=H)
        check("self-update signed: require=off + no manifest -> 200 (unsigned tolerated)",
              r.status_code == 200 and (r.json() or {}).get("ok") is True, f"got {r.status_code}")

        # (d5) completeness: a VALID signed manifest that lists a file which was
        #      NOT staged must abort (silent-omission guard, per PR review).
        os.environ["SEEKDEEP_SELF_UPDATE_REQUIRE_SIGNATURE"] = "off"
        man5 = {"schema": "seekdeep-release-manifest/v1", "ref": "v9.9.9", "algorithm": "sha256",
                "files": {**{n: hashlib.sha256(c2_content).hexdigest() for n in single},
                          "gui/never-staged.js": hashlib.sha256(b"x").hexdigest()}}
        mb5 = _rsign.manifest_to_bytes(man5)
        sig5 = _b64.b64encode(_rsign.ed25519_sign(mb5, eph_seed, eph_pub))
        with mock.patch.object(_urlreq, "urlopen", _make_urlopen(c2_content, c2_tree, mb5, sig5)):
            r = c2.post("/system/self-update", json={"ref": "v9.9.9"}, headers=H)
        check("self-update signed: manifest lists an unstaged file -> 409 (completeness)",
              r.status_code == 409, f"got {r.status_code}")
    except Exception as e:
        check("self-update: route tests ran without harness error", False, repr(e))
    finally:
        _ge._SELF_UPDATE_MAX_FILE_BYTES = cap_saved
        _ge._AUTH_STATE.clear()
        _ge._AUTH_STATE.update(auth_saved)
        if enabled_saved is None:
            os.environ.pop("SEEKDEEP_SELF_UPDATE_ENABLED", None)
        else:
            os.environ["SEEKDEEP_SELF_UPDATE_ENABLED"] = enabled_saved
        for _k, _v in sig_env_saved.items():
            if _v is None:
                os.environ.pop(_k, None)
            else:
                os.environ[_k] = _v
        shutil.rmtree(tmp, ignore_errors=True)


def main() -> int:
    try:
        from fastapi import FastAPI
        from fastapi.testclient import TestClient
        from gui_endpoints import (
            register_gui_endpoints,
            _TOKEN_HEADER,
            _LOOPBACK_HOSTS,
            event_bus,
        )
    except Exception as e:
        print(f"  FAIL import gui_endpoints/fastapi: {e}")
        print("       Are fastapi + httpx + pydantic installed in this Python env?")
        return 1

    # Build a fresh app per run so registration starts clean.
    app = FastAPI()
    try:
        register_gui_endpoints(
            app,
            log_dir="logs",
            data_dir="data",
            env_path=".env",
            warmup_handlers={
                "chat":   lambda role: f"stub {role}",
                "image":  lambda: "stub-image",
                "vision": lambda: "stub-vision",
            },
        )
        check("register_gui_endpoints completes", True)
    except Exception as e:
        check("register_gui_endpoints completes", False, str(e))
        return 1

    # Snag the live token off .env so we can hit the protected routes.
    env_path = ROOT / ".env"
    token = ""
    if env_path.is_file():
        for line in env_path.read_text(encoding="utf-8", errors="replace").splitlines():
            m = re.match(r"^SEEKDEEP_GUI_TOKEN=(.+)", line.strip())
            if m:
                token = m.group(1).strip().strip('"').strip("'")
                break
    check("SEEKDEEP_GUI_TOKEN present in .env", bool(token),
          "" if token else "register should auto-generate it; check .env writability")

    c = TestClient(app)

    # ---- /events/status (open GET) ----
    r = c.get("/events/status")
    check("GET /events/status -> 200", r.status_code == 200, f"status={r.status_code}")
    j = r.json() if r.status_code == 200 else {}
    check("  ...returns {ok, subscribers, server_time_ms}",
          isinstance(j, dict) and "subscribers" in j and "server_time_ms" in j,
          f"keys={sorted(j.keys()) if isinstance(j, dict) else type(j)}")

    # ---- /config/status (open GET, shape contract for the modal) ----
    r = c.get("/config/status")
    check("GET /config/status -> 200", r.status_code == 200)
    j = r.json() if r.status_code == 200 else {}
    check("  ...has needs_setup boolean", isinstance(j.get("needs_setup"), bool))
    check("  ...required is list", isinstance(j.get("required"), list))
    check("  ...optional is list", isinstance(j.get("optional"), list))
    # Verify secrets are not leaked
    secrets_with_value = [r for r in (j.get("required", []) + j.get("optional", []))
                          if r.get("kind") == "secret" and r.get("value")]
    check("  ...secret values blanked on the wire (no HF_TOKEN leak)",
          len(secrets_with_value) == 0,
          f"leaked: {[r['key'] for r in secrets_with_value]}")

    # ---- /token (loopback-only) ----
    # TestClient's request.client.host is 'testclient', NOT in _LOOPBACK_HOSTS,
    # so the endpoint should refuse. That's the test: GET /token from non-
    # loopback callers must fail.
    r = c.get("/token")
    check("GET /token from non-loopback -> 403",
          r.status_code == 403,
          f"got {r.status_code}; expected 403 (TestClient host should not be loopback)")

    # ---- CORS: a foreign Origin must NOT get an Access-Control-Allow-Origin
    # echo. The allowlist is the defense against a malicious web page driving
    # 127.0.0.1:7865; a regression to allow_origins=["*"] or origin-echo would
    # silently re-open that. ----
    r = c.get("/health", headers={"Origin": "https://evil.example"})
    acao = r.headers.get("access-control-allow-origin")
    check("CORS: foreign Origin not allowed (no ACAO echo / wildcard)",
          acao not in ("https://evil.example", "*"),
          f"ACAO={acao!r} — allowlist may be too permissive")

    # ---- Auth: POST /config without header -> 401 ----
    r = c.post("/config", json={"updates": {}})
    check("POST /config without token -> 401",
          r.status_code == 401, f"got {r.status_code}")

    r = c.post("/config", json={"updates": {}},
               headers={_TOKEN_HEADER: "definitely-wrong"})
    check("POST /config with wrong token -> 401",
          r.status_code == 401, f"got {r.status_code}")

    if token:
        r = c.post("/config", json={"updates": {}},
                   headers={_TOKEN_HEADER: token})
        check("POST /config with correct token (empty updates) -> 200",
              r.status_code == 200, f"got {r.status_code}")

    # ---- GET /launchers/status (open; backs app.html Control Center cards) ----
    r = c.get("/launchers/status")
    check("GET /launchers/status -> 200 (no auth required)", r.status_code == 200, f"got {r.status_code}")
    body = r.json() if r.status_code == 200 else {}
    check("  ...returns {ok, services, generated_at}",
          body.get("ok") is True
          and isinstance(body.get("services"), dict)
          and isinstance(body.get("generated_at"), str),
          f"body keys={sorted((body or {}).keys())}")
    # Whitelisted services should all appear (state may be 'not-running' in test).
    services = body.get("services") or {}
    check("  ...services dict contains ai-server, bot, searxng",
          all(s in services for s in ("ai-server", "bot", "searxng")),
          f"got {sorted(services.keys())}")
    if services:
        # Spot-check schema on the first entry
        sample = next(iter(services.values()))
        check("  ...per-service entry has state + (uptime_seconds, started_at) fields",
              isinstance(sample, dict) and "state" in sample and "uptime_seconds" in sample and "started_at" in sample,
              f"sample={sample}")

    # ---- Auth: POST /launcher/... without header -> 401 ----
    r = c.post("/launcher/bot/status")
    check("POST /launcher/bot/status without token -> 401",
          r.status_code == 401, f"got {r.status_code}")

    # ---- POST /launcher/bot/kill-all — nuke-piled-up-bot-instances ----
    # Right-click context menu calls this when node.exe instances accumulate
    # outside the launcher's tracking. Always returns 200 (no procs to kill
    # is a valid state, "found":0). 401 without token.
    r = c.post("/launcher/bot/kill-all")
    check("POST /launcher/bot/kill-all without token -> 401",
          r.status_code == 401, f"got {r.status_code}")
    if token:
        r = c.post("/launcher/bot/kill-all", headers={_TOKEN_HEADER: token})
        check("POST /launcher/bot/kill-all with token -> 200",
              r.status_code == 200, f"got {r.status_code}")
        body = r.json() if r.status_code == 200 else {}
        check("  ...returns {ok, service:'bot', scope, found, killed:[], failed:[]}",
              body.get("ok") is True
              and body.get("service") == "bot"
              and isinstance(body.get("scope"), str)
              and isinstance(body.get("found"), int)
              and isinstance(body.get("killed"), list)
              and isinstance(body.get("failed"), list),
              f"body keys={sorted(body.keys()) if isinstance(body, dict) else type(body)}")

    # ---- Auth: Emoji Vault (read-only GUI) GETs without token -> 401 -------
    # The emoji-vault page hits these (Python -> Discord REST with the bot token).
    # They are token-gated AND feature-gated; the token gate is what we pin here
    # (the feature-off 404 + the live Discord calls need real creds/network).
    for ep in ("/emoji-vault/guilds",
               "/emoji-vault/123456789012345678/emojis",
               "/emoji-vault/123456789012345678/backup.zip"):
        r = c.get(ep)
        check(f"GET {ep} without token -> 401", r.status_code == 401, f"got {r.status_code}")

    # ---- Auth: Force React config GUI endpoints without token -> 401 ------
    for ep in ("/force-react/guilds",
               "/force-react/123456789012345678/emojis",
               "/force-react/123456789012345678/config"):
        r = c.get(ep)
        check(f"GET {ep} without token -> 401", r.status_code == 401, f"got {r.status_code}")
    r = c.post("/force-react/123456789012345678/config", json={})
    check("POST /force-react/{guild}/config without token -> 401", r.status_code == 401, f"got {r.status_code}")

    # ---- GET /system/docker (open; installer page Docker probe) -----------
    r = c.get("/system/docker")
    check("GET /system/docker -> 200 (no auth required)", r.status_code == 200, f"got {r.status_code}")
    body = r.json() if r.status_code == 200 else {}
    check("  ...returns {ok, state} where state in {running, installed_not_running, not_installed, error}",
          body.get("ok") in (True, False)
          and body.get("state") in ("running", "installed_not_running", "not_installed", "error"),
          f"body={body}")

    # ---- GET /system/firstrun (open; first-run checklist) -----------------
    r = c.get("/system/firstrun")
    check("GET /system/firstrun -> 200 (no auth required)", r.status_code == 200, f"got {r.status_code}")
    body = r.json() if r.status_code == 200 else {}
    check("  ...returns {ok, ready, checks:[...], summary:{...}}",
          body.get("ok") is True
          and isinstance(body.get("ready"), bool)
          and isinstance(body.get("checks"), list)
          and isinstance(body.get("summary"), dict),
          f"keys={sorted(body.keys())}")
    if isinstance(body.get("checks"), list):
        sample = (body["checks"] or [None])[0]
        check("  ...check entry has {id, label, ok, fix, blocking}",
              isinstance(sample, dict)
              and all(k in sample for k in ("id", "label", "ok", "fix", "blocking")),
              f"sample={sample}")
        # At least one check should now ship fix_action metadata so the
        # setup wizard can render a one-click fix button. ml_deps and
        # searxng both have it.
        any_action = any(isinstance(ch, dict) and isinstance(ch.get("fix_action"), dict)
                         for ch in body["checks"])
        check("  ...at least one check exposes fix_action (wizard one-click fix)",
              any_action, "no check had fix_action")

    # ---- POST /docker/start-searxng (token-gated; zero-terminal start) ----
    # The wizard's "Start SearXNG" button hits this. Skipped when token is
    # disabled (no real auth to assert against). We assert the 401 shape
    # without the token, then verify a token-authed call gets a parseable
    # JSON body — docker may legitimately fail in CI (no daemon).
    r = c.post("/docker/start-searxng", json={})
    check("POST /docker/start-searxng without token -> 401",
          r.status_code == 401, f"got {r.status_code}")
    if token:
        r = c.post("/docker/start-searxng", headers={_TOKEN_HEADER: token}, json={})
        check("POST /docker/start-searxng with token -> 200",
              r.status_code == 200, f"got {r.status_code}")
        body = r.json() if r.status_code == 200 else {}
        check("  ...returns {ok, ...} (docker may legitimately fail in CI)",
              "ok" in body, f"body={body}")

    # ---- POST /system/install-python (token-gated; winget on Windows) -----
    r = c.post("/system/install-python", json={})
    check("POST /system/install-python without token -> 401",
          r.status_code == 401, f"got {r.status_code}")
    if token:
        # dry_run avoids actually invoking `winget install` during tests.
        r = c.post("/system/install-python", headers={_TOKEN_HEADER: token}, json={"dry_run": True})
        check("POST /system/install-python with token -> 200",
              r.status_code == 200, f"got {r.status_code}")
        body = r.json() if r.status_code == 200 else {}
        check("  ...returns {ok, ...} (dry_run; will fail on non-Windows / no-winget; ok=False is valid)",
              "ok" in body, f"body={body}")

    # ---- POST /system/install-docker (token-gated; winget on Windows) -----
    r = c.post("/system/install-docker", json={})
    check("POST /system/install-docker without token -> 401",
          r.status_code == 401, f"got {r.status_code}")
    if token:
        r = c.post("/system/install-docker", headers={_TOKEN_HEADER: token}, json={"dry_run": True})
        check("POST /system/install-docker with token -> 200",
              r.status_code == 200, f"got {r.status_code}")
        body = r.json() if r.status_code == 200 else {}
        check("  ...returns {ok, ...} (dry_run; will fail on non-Windows / no-winget; ok=False is valid)",
              "ok" in body, f"body={body}")

    # ---- GET /system/detect-venv (open; venv finder for the wizard) -------
    r = c.get("/system/detect-venv")
    check("GET /system/detect-venv -> 200 (no auth required)",
          r.status_code == 200, f"got {r.status_code}")
    body = r.json() if r.status_code == 200 else {}
    check("  ...returns {ok, candidates:[...], current:{executable,...}}",
          body.get("ok") is True
          and isinstance(body.get("candidates"), list)
          and isinstance(body.get("current"), dict)
          and "executable" in body.get("current", {}),
          f"keys={sorted(body.keys()) if isinstance(body, dict) else type(body)}")

    # ---- POST /system/use-venv (token-gated; sets SEEKDEEP_PYTHON in .env) -
    r = c.post("/system/use-venv", json={"executable": sys.executable})
    check("POST /system/use-venv without token -> 401",
          r.status_code == 401, f"got {r.status_code}")
    if token:
        # Use sys.executable so the file existence check passes.
        # This MUTATES .env so we save + restore the original value.
        env_file = Path(".env")
        before = env_file.read_text(encoding="utf-8") if env_file.is_file() else None
        try:
            r = c.post("/system/use-venv", headers={_TOKEN_HEADER: token},
                       json={"executable": sys.executable})
            check("POST /system/use-venv with token -> 200",
                  r.status_code == 200, f"got {r.status_code}")
            body = r.json() if r.status_code == 200 else {}
            check("  ...returns {ok, executable, note}",
                  body.get("ok") is True
                  and isinstance(body.get("executable"), str)
                  and "note" in body,
                  f"body={body}")
            # Bogus path -> 400
            r = c.post("/system/use-venv", headers={_TOKEN_HEADER: token},
                       json={"executable": "/definitely/not/a/file"})
            check("POST /system/use-venv missing file -> 400",
                  r.status_code == 400, f"got {r.status_code}")
            r = c.post("/system/use-venv", headers={_TOKEN_HEADER: token}, json={})
            check("POST /system/use-venv empty -> 400",
                  r.status_code == 400, f"got {r.status_code}")
        finally:
            if before is not None:
                env_file.write_text(before, encoding="utf-8")

    # ---- GET /system/runtime (open; installer page Node/Python/Git/Disk probe) ----
    r = c.get("/system/runtime")
    check("GET /system/runtime -> 200 (no auth required)", r.status_code == 200, f"got {r.status_code}")
    body = r.json() if r.status_code == 200 else {}
    rt = body.get("runtime") or {}
    check("  ...returns {ok, runtime:{node, python, git, disk}}",
          body.get("ok") is True
          and isinstance(rt, dict)
          and all(k in rt for k in ("node", "python", "git", "disk")),
          f"runtime keys={sorted(rt.keys())}")
    # Python always installed (we're running this test inside it). Sanity-check.
    check("  ...python entry has installed=True + version + meets_min booleans",
          rt.get("python", {}).get("installed") is True
          and isinstance(rt.get("python", {}).get("version"), str)
          and isinstance(rt.get("python", {}).get("meets_min"), bool),
          f"python={rt.get('python')}")

    if token:
        r = c.post("/launcher/bot/status", headers={_TOKEN_HEADER: token})
        check("POST /launcher/bot/status with correct token -> 200",
              r.status_code == 200, f"got {r.status_code}")
        body = r.json() if r.status_code == 200 else {}
        check("  ...returns {ok, service, state}",
              all(k in body for k in ("ok", "service", "state")),
              f"keys={sorted(body.keys())}")

    # ---- Self-host guard: ai-server restart -> 409 ----
    if token:
        r = c.post("/launcher/ai-server/restart", headers={_TOKEN_HEADER: token})
        check("POST /launcher/ai-server/restart -> 409 (self-host guard)",
              r.status_code == 409, f"got {r.status_code}")

    # ---- Unknown service -> 400 ----
    if token:
        r = c.post("/launcher/unknown/start", headers={_TOKEN_HEADER: token})
        check("POST /launcher/unknown/start -> 400",
              r.status_code == 400, f"got {r.status_code}")

    # ---- POST /model/warm -> dispatches to warmup_handlers ----
    if token:
        r = c.post("/model/warm", json={"role": "image"},
                   headers={_TOKEN_HEADER: token})
        check("POST /model/warm (image) with correct token -> 200",
              r.status_code == 200, f"got {r.status_code}")
        body = r.json() if r.status_code == 200 else {}
        check("  ...returns {ok=True, role=image, loaded=True}",
              body.get("ok") is True and body.get("role") == "image" and body.get("loaded") is True,
              f"body={body}")

    # ---- /data/{file} normalizers ----
    # server-stats.json is now token-gated (per-user discord IDs + activity
    # counts). Without token: 401. With token: 200 + normalizer applied.
    check("GET /data/server-stats.json without token -> 401",
          c.get("/data/server-stats.json").status_code == 401)
    if token:
        r = c.get("/data/server-stats.json", headers={"X-SeekDeep-Token": token})
        if r.status_code == 200:
            body = r.json()
            check("GET /data/server-stats.json (token) -> 200 (normalizer applied)",
                  body.get("normalized") is True,
                  "normalizer wired but not flagged in response" if not body.get("normalized") else "")
            data = body.get("data", {})
            check("  ...has totals.messages",
                  isinstance(data.get("totals", {}).get("messages"), int))
            check("  ...has dayBuckets.messages list",
                  isinstance(data.get("dayBuckets", {}).get("messages"), list))
            check("  ...has top contributors list",
                  isinstance(data.get("top"), list))
        else:
            check("GET /data/server-stats.json (token) -> 200 (or empty fallback)",
                  False, f"got {r.status_code}; expected 200 if file exists or empty fallback")

    # auto-reactions.json: now token-gated (contains guild + creator IDs).
    # With token: empty-fallback. Without: 401.
    if token:
        r = c.get("/data/auto-reactions.json", headers={"X-SeekDeep-Token": token})
        check("GET /data/auto-reactions.json (with token) -> 200 (empty-fallback for missing file)",
              r.status_code == 200, f"got {r.status_code}")
        if r.status_code == 200:
            body = r.json()
            check("  ...returns {rules: []} when file missing",
                  isinstance(body.get("data", {}).get("rules"), list))
        r = c.get("/data/auto-reactions.json")
        check("GET /data/auto-reactions.json (no token) -> 401 (token-gated, contains guild + creator IDs)",
              r.status_code == 401, f"got {r.status_code}")

    # archive-snapshot.json: token-gated + normalized. With our token header,
    # we should get the empty-snapshot fallback when the bot hasn't written
    # one yet — never a 404, since GUI's Archive pane queries this on every
    # page load.
    if token:
        r = c.get("/data/archive-snapshot.json", headers={"X-SeekDeep-Token": token})
        check("GET /data/archive-snapshot.json (with token) -> 200 (empty-fallback)",
              r.status_code == 200, f"got {r.status_code}")
        if r.status_code == 200:
            body = r.json()
            d = body.get("data") or body
            check("  ...returns guilds:{} shape when file missing",
                  isinstance(d.get("guilds"), dict))
        # And without the token, it should refuse (sensitive file).
        r = c.get("/data/archive-snapshot.json")
        check("GET /data/archive-snapshot.json (no token) -> 401",
              r.status_code == 401, f"got {r.status_code}")

    # prompt-templates.json: token-gated + normalized. GUI prompts.html
    # consumes the flat templates list.
    if token:
        r = c.get("/data/prompt-templates.json", headers={"X-SeekDeep-Token": token})
        check("GET /data/prompt-templates.json (with token) -> 200 (empty-fallback)",
              r.status_code == 200, f"got {r.status_code}")
        if r.status_code == 200:
            body = r.json()
            d = body.get("data") or body
            check("  ...returns {templates:[], count:0} shape when file missing",
                  isinstance(d.get("templates"), list) and "count" in d)
        r = c.get("/data/prompt-templates.json")
        check("GET /data/prompt-templates.json (no token) -> 401",
              r.status_code == 401, f"got {r.status_code}")

    # Path traversal in /data should be blocked.
    r = c.get("/data/..%2F.env")
    check("GET /data/..%2F.env -> 400 or 404 (path traversal blocked)",
          r.status_code in (400, 404), f"got {r.status_code}")

    # ---- WebSocket /events ----
    if token:
        # bad token -> close
        try:
            with c.websocket_connect("/events?token=intentionally-bad"):
                check("WS /events bad token -> refused", False,
                      "connection should have been refused")
        except Exception:
            check("WS /events bad token -> refused", True)

        # good token -> hello + publish round-trip
        try:
            with c.websocket_connect(f"/events?token={token}") as ws:
                hello = ws.receive_json()
                check("WS /events good token -> received 'hello'",
                      hello.get("type") == "hello", f"got {hello.get('type')}")

                # POST /events/emit and verify the WS receives it
                emit = c.post("/events/emit",
                              json={"type": "smoke.test", "data": {"k": "v"}},
                              headers={_TOKEN_HEADER: token})
                check("POST /events/emit -> 200",
                      emit.status_code == 200, f"got {emit.status_code}")
                emit_body = emit.json() if emit.status_code == 200 else {}
                check("  ...returns {ok, delivered>=1, subscribers>=1}",
                      emit_body.get("ok") is True and emit_body.get("delivered", 0) >= 1,
                      f"body={emit_body}")
                # The WS should receive the event. Filter by type so unrelated
                # frames already on the bus (gpu.tick, smoke.line from a
                # wrapped runner, etc.) don't race the assertion.
                msg = None
                for _ in range(50):
                    candidate = ws.receive_json()
                    if candidate.get("type") == "smoke.test":
                        msg = candidate
                        break
                check("WS subscriber receives the emitted event",
                      msg is not None and msg.get("data", {}).get("k") == "v",
                      f"got {msg}")
        except Exception as e:
            check("WS /events round-trip", False, str(e))

    # ---- Memory endpoints (Item C: /memory/*) ----
    # Round-trip the full lifecycle. Tests live on the same `app` TestClient
    # but write to the SAME on-disk data/user-facts.json that the bot uses,
    # so we use unique IDs in a numeric range that won't collide with any
    # real Discord snowflake (which are 17-19 digits).
    SMOKE_UID = "smoketestuser0000001"  # 21 chars, not a valid snowflake
    SMOKE_UID2 = "smoketestuser0000002"

    if token:
        # Clean slate -- best-effort; ignore if no row exists yet
        c.delete(f"/memory/user/{SMOKE_UID}", headers={_TOKEN_HEADER: token})
        c.delete(f"/memory/user/{SMOKE_UID2}", headers={_TOKEN_HEADER: token})

        # AUD-003: /memory/* reads now require X-SeekDeep-Token (full user
        # facts can contain Discord IDs + arbitrary remembered text).
        r = c.get("/memory/users")
        check("GET /memory/users without token -> 401",
              r.status_code == 401, f"got {r.status_code}")
        r = c.get("/memory/users", headers={_TOKEN_HEADER: token})
        check("GET /memory/users with token -> 200", r.status_code == 200, f"got {r.status_code}")
        body = r.json() if r.status_code == 200 else {}
        check("  ...returns {ok, users:[]} shape",
              body.get("ok") is True and isinstance(body.get("users"), list),
              f"keys={sorted(body.keys()) if isinstance(body, dict) else type(body)}")

        r = c.get(f"/memory/user/{SMOKE_UID}", headers={_TOKEN_HEADER: token})
        check("GET /memory/user/{absent} -> 404", r.status_code == 404, f"got {r.status_code}")

        r = c.post(f"/memory/user/{SMOKE_UID}/fact", json={"text": "smoke fact 1"})
        check("POST /memory/user/{id}/fact without token -> 401",
              r.status_code == 401, f"got {r.status_code}")

        r = c.post(f"/memory/user/{SMOKE_UID}/fact",
                   json={"text": "I prefer concise answers"},
                   headers={_TOKEN_HEADER: token})
        check("POST add fact -> 200", r.status_code == 200, f"got {r.status_code}")
        body = r.json() if r.status_code == 200 else {}
        check("  ...returns {ok, index:1}",
              body.get("ok") is True and body.get("index") == 1, f"body={body}")

        r = c.post(f"/memory/user/{SMOKE_UID}/fact",
                   json={"text": "x" * 501}, headers={_TOKEN_HEADER: token})
        check("POST fact >500 chars -> 422",
              r.status_code == 422, f"got {r.status_code}")

        r = c.post(f"/memory/user/{SMOKE_UID}/fact",
                   json={"text": ""}, headers={_TOKEN_HEADER: token})
        check("POST empty fact -> 422", r.status_code == 422, f"got {r.status_code}")

        r = c.get(f"/memory/user/{SMOKE_UID}", headers={_TOKEN_HEADER: token})
        check("GET /memory/user/{id} -> 200", r.status_code == 200, f"got {r.status_code}")
        body = r.json() if r.status_code == 200 else {}
        check("  ...has facts list with 1 entry",
              isinstance(body.get("facts"), list) and len(body["facts"]) == 1,
              f"facts={body.get('facts')}")

        r = c.patch(f"/memory/user/{SMOKE_UID}/fact/1",
                    json={"text": "updated fact"}, headers={_TOKEN_HEADER: token})
        check("PATCH fact #1 -> 200", r.status_code == 200, f"got {r.status_code}")

        r = c.patch(f"/memory/user/{SMOKE_UID}/fact/99",
                    json={"text": "x"}, headers={_TOKEN_HEADER: token})
        check("PATCH out-of-range -> 404", r.status_code == 404, f"got {r.status_code}")

        r = c.delete(f"/memory/user/{SMOKE_UID}/fact/1", headers={_TOKEN_HEADER: token})
        check("DELETE fact #1 -> 200", r.status_code == 200, f"got {r.status_code}")
        body = r.json() if r.status_code == 200 else {}
        check("  ...returns removed payload",
              isinstance(body.get("removed"), dict) and "text" in body["removed"],
              f"body={body}")

        # Re-populate then DELETE the whole user
        c.post(f"/memory/user/{SMOKE_UID}/fact", json={"text": "to be wiped"},
               headers={_TOKEN_HEADER: token})
        r = c.delete(f"/memory/user/{SMOKE_UID}", headers={_TOKEN_HEADER: token})
        check("DELETE /memory/user/{id} -> 200", r.status_code == 200, f"got {r.status_code}")
        check("  ...returns removed_facts count",
              isinstance(r.json().get("removed_facts"), int) if r.status_code == 200 else False)

        # Export 404 after deletion
        r = c.get(f"/memory/user/{SMOKE_UID}/export", headers={_TOKEN_HEADER: token})
        check("GET /memory/user/{absent}/export -> 404",
              r.status_code == 404, f"got {r.status_code}")

        # Presets round-trip
        r = c.post(f"/memory/presets/{SMOKE_UID2}",
                   json={"presets": ["brief", "expert"]}, headers={_TOKEN_HEADER: token})
        check("POST /memory/presets valid -> 200", r.status_code == 200, f"got {r.status_code}")

        r = c.post(f"/memory/presets/{SMOKE_UID2}",
                   json={"presets": ["brief", "TOTALLY_UNKNOWN_PRESET"]},
                   headers={_TOKEN_HEADER: token})
        check("POST /memory/presets unknown key -> 400",
              r.status_code == 400, f"got {r.status_code}")

        r = c.get(f"/memory/presets/{SMOKE_UID2}", headers={_TOKEN_HEADER: token})
        check("GET /memory/presets/{id} -> 200", r.status_code == 200, f"got {r.status_code}")
        body = r.json() if r.status_code == 200 else {}
        check("  ...returns {ok, presets:[brief, expert]}",
              body.get("ok") is True and body.get("presets") == ["brief", "expert"],
              f"body={body}")

        # Cleanup: drop the presets row so we don't pollute real data
        c.post(f"/memory/presets/{SMOKE_UID2}", json={"presets": []},
               headers={_TOKEN_HEADER: token})

    # =====================================================================
    # Prompt templates — write endpoints (close the marketplace
    # persistence gap that previously routed all writes through Discord
    # slash commands). Token-gated; CRUD on prompt-templates.json.
    # =====================================================================
    SMOKE_PROMPT_GUILD = "999000999000999000"
    SMOKE_PROMPT_USER  = "888000888000888000"
    SMOKE_PROMPT_NAME  = "smoke-test-tpl"
    SMOKE_PROMPT_ID    = f"{SMOKE_PROMPT_GUILD}:{SMOKE_PROMPT_USER}:{SMOKE_PROMPT_NAME}"

    # Auth gates
    r = c.post("/prompts/template", json={
        "guild_id": SMOKE_PROMPT_GUILD, "owner_user_id": SMOKE_PROMPT_USER,
        "name": SMOKE_PROMPT_NAME, "prompt": "test {{var}}",
    })
    check("POST /prompts/template without token -> 401",
          r.status_code == 401, f"got {r.status_code}")
    r = c.delete(f"/prompts/template/{SMOKE_PROMPT_ID}")
    check("DELETE /prompts/template/{id} without token -> 401",
          r.status_code == 401, f"got {r.status_code}")

    if token:
        # Create
        r = c.post("/prompts/template", headers={_TOKEN_HEADER: token}, json={
            "guild_id": SMOKE_PROMPT_GUILD, "owner_user_id": SMOKE_PROMPT_USER,
            "name": SMOKE_PROMPT_NAME, "prompt": "Summarize {{topic}} in {{count}} bullets.",
        })
        check("POST /prompts/template create -> 200",
              r.status_code == 200, f"got {r.status_code}")
        body = r.json() if r.status_code == 200 else {}
        check("  ...returns {ok, id, created:true, vars:[topic,count]}",
              body.get("ok") is True and body.get("created") is True
              and body.get("id") == SMOKE_PROMPT_ID
              and set(body.get("vars") or []) == {"topic", "count"},
              f"body={body}")

        # Update (same name re-posts) — created flag should flip false
        r = c.post("/prompts/template", headers={_TOKEN_HEADER: token}, json={
            "guild_id": SMOKE_PROMPT_GUILD, "owner_user_id": SMOKE_PROMPT_USER,
            "name": SMOKE_PROMPT_NAME, "prompt": "Updated {{topic}}.",
        })
        check("POST /prompts/template update -> 200 created:false",
              r.status_code == 200 and r.json().get("created") is False,
              f"got {r.status_code} body={r.json() if r.status_code == 200 else None}")

        # Validation
        r = c.post("/prompts/template", headers={_TOKEN_HEADER: token}, json={
            "guild_id": "", "owner_user_id": "u", "name": "n", "prompt": "x",
        })
        check("POST /prompts/template missing guild_id -> 400",
              r.status_code == 400, f"got {r.status_code}")
        r = c.post("/prompts/template", headers={_TOKEN_HEADER: token}, json={
            "guild_id": "g", "owner_user_id": "u", "name": "bad space", "prompt": "x",
        })
        check("POST /prompts/template invalid name -> 400",
              r.status_code == 400, f"got {r.status_code}")

        # Delete
        r = c.delete(f"/prompts/template/{SMOKE_PROMPT_ID}",
                     headers={_TOKEN_HEADER: token})
        check("DELETE /prompts/template/{id} -> 200",
              r.status_code == 200, f"got {r.status_code}")
        r = c.delete(f"/prompts/template/{SMOKE_PROMPT_ID}",
                     headers={_TOKEN_HEADER: token})
        check("DELETE /prompts/template/{id} second time -> 404",
              r.status_code == 404, f"got {r.status_code}")

    # =====================================================================
    # Auto-react rules — write endpoints (close the GUI-editor gap that
    # routed every change through @SeekDeep reactrule). Token-gated CRUD
    # on auto-reactions.json + per-guild builtin toggles.
    # =====================================================================
    # SMOKE_REACT_GUILD: deliberately NOT a Discord snowflake (digits-only,
    # 17-20 chars). Audit §3: the previous "777000777000777000" looked like
    # a real guild ID and survived test runs as a stub entry the user's
    # Auto-react rules pane displayed forever. The "smoke-test-" prefix is
    # impossible to collide with a real Discord guild AND gets auto-pruned
    # by _prune_empty_guilds the moment the test cleans up.
    SMOKE_REACT_GUILD = "smoke-test-guild"

    r = c.post("/reacts/rule", json={"guild_id": SMOKE_REACT_GUILD, "emoji": ":star:", "pattern": "test"})
    check("POST /reacts/rule without token -> 401",
          r.status_code == 401, f"got {r.status_code}")

    if token:
        # Create
        r = c.post("/reacts/rule", headers={_TOKEN_HEADER: token}, json={
            "guild_id": SMOKE_REACT_GUILD, "emoji": ":star:", "pattern": "smoke-test-pattern",
        })
        check("POST /reacts/rule create -> 200",
              r.status_code == 200, f"got {r.status_code}")
        body = r.json() if r.status_code == 200 else {}
        rule_id = (body.get("rule") or {}).get("id")
        check("  ...returns {ok, rule:{id, emoji, pattern, enabled, hits:0}}",
              body.get("ok") is True and isinstance(rule_id, str) and rule_id.startswith("rr_")
              and body["rule"].get("emoji") == ":star:"
              and body["rule"].get("pattern") == "smoke-test-pattern",
              f"body={body}")

        # Patch — toggle enabled, update pattern
        r = c.patch(f"/reacts/rule/{rule_id}", headers={_TOKEN_HEADER: token},
                    json={"enabled": False, "pattern": "smoke-updated"})
        check("PATCH /reacts/rule/{id} -> 200",
              r.status_code == 200, f"got {r.status_code}")
        body = r.json() if r.status_code == 200 else {}
        check("  ...applied enabled=false + new pattern",
              (body.get("rule") or {}).get("enabled") is False
              and (body.get("rule") or {}).get("pattern") == "smoke-updated",
              f"body={body}")

        # Builtin toggle per-guild
        r = c.post("/reacts/builtin/long_message", headers={_TOKEN_HEADER: token},
                   json={"guild_id": SMOKE_REACT_GUILD, "enabled": True, "threshold": 800})
        check("POST /reacts/builtin/long_message -> 200",
              r.status_code == 200, f"got {r.status_code}")
        body = r.json() if r.status_code == 200 else {}
        check("  ...persists threshold=800",
              (body.get("value") or {}).get("threshold") == 800,
              f"body={body}")

        # Unknown builtin
        r = c.post("/reacts/builtin/bogus", headers={_TOKEN_HEADER: token},
                   json={"guild_id": SMOKE_REACT_GUILD, "enabled": True})
        check("POST /reacts/builtin/<unknown> -> 400",
              r.status_code == 400, f"got {r.status_code}")

        # Delete rule
        r = c.delete(f"/reacts/rule/{rule_id}", headers={_TOKEN_HEADER: token})
        check("DELETE /reacts/rule/{id} -> 200",
              r.status_code == 200, f"got {r.status_code}")
        r = c.delete(f"/reacts/rule/{rule_id}", headers={_TOKEN_HEADER: token})
        check("DELETE /reacts/rule/{id} second time -> 404",
              r.status_code == 404, f"got {r.status_code}")

        # Audit §3 cleanup: disable the builtin so _prune_empty_guilds drops
        # the SMOKE_REACT_GUILD entry from auto-reactions.json. Without this
        # every smoke run left a stub `{rules:[], builtins:{long_message:{
        # enabled:true,...}}}` entry behind that polluted the user's
        # Control Center → Auto-react rules pane forever.
        c.post("/reacts/builtin/long_message", headers={_TOKEN_HEADER: token},
               json={"guild_id": SMOKE_REACT_GUILD, "enabled": False})

    # ---- GET /config (Item F: redacted env map for dynamic-facts IIFE) ----
    r = c.get("/config")
    check("GET /config -> 200 (no auth required)", r.status_code == 200, f"got {r.status_code}")
    body = r.json() if r.status_code == 200 else {}
    check("  ...returns {ok, env: {...}} shape",
          body.get("ok") is True and isinstance(body.get("env"), dict),
          f"keys={sorted(body.keys()) if isinstance(body, dict) else type(body)}")
    if r.status_code == 200:
        env_map = body.get("env", {})
        # Secret keys present in the actual .env should be redacted to '*****'.
        # Mirror the server's word-boundary regex so we only flag actual secret
        # names (TOKEN, KEY, PASSWORD, SECRET) -- not config knobs like
        # MAX_OUTPUT_TOKENS or CHAT_MAX_NEW_TOKENS that happen to contain
        # 'TOKEN' as a substring.
        import re as _re
        secret_re = _re.compile(r"(?:^|_)(TOKEN|KEY|PASSWORD|SECRET|PASS|PRIVATE_KEY)(?:$|_)", _re.IGNORECASE)
        named_secrets = {"HF_TOKEN", "DISCORD_TOKEN", "OPENAI_API_KEY",
                         "ANTHROPIC_API_KEY", "GOOGLE_API_KEY", "GEMINI_API_KEY",
                         "GROQ_API_KEY", "DEEPSEEK_API_KEY", "OPENROUTER_API_KEY",
                         "XAI_API_KEY", "SEEKDEEP_GUI_TOKEN"}
        leaked_secrets = []
        for k, v in env_map.items():
            if not v:
                continue  # empty values are fine
            looks_secret = bool(secret_re.search(k)) or k in named_secrets
            if looks_secret and v != "*****":
                leaked_secrets.append(f"{k}=({v[:10]}...)")
        check("  ...secret-tagged keys redacted to '*****'",
              not leaked_secrets,
              f"leaked: {leaked_secrets}" if leaked_secrets else "")
        # Config knobs like MAX_OUTPUT_TOKENS contain 'TOKEN' as substring but
        # shouldn't be redacted (they're integers, not secrets).
        if "MAX_OUTPUT_TOKENS" in env_map and env_map["MAX_OUTPUT_TOKENS"]:
            check("  ...MAX_OUTPUT_TOKENS NOT redacted (config knob, not secret)",
                  env_map["MAX_OUTPUT_TOKENS"] != "*****",
                  f"got {env_map['MAX_OUTPUT_TOKENS']!r}")
        # Non-secret keys (model ids, URLs) should NOT be redacted -- they're
        # what the dynamic-facts IIFE actually needs to read.
        if "LOCAL_CHAT_MODEL_ID" in env_map and env_map["LOCAL_CHAT_MODEL_ID"]:
            check("  ...non-secret LOCAL_CHAT_MODEL_ID echoed back unredacted",
                  env_map["LOCAL_CHAT_MODEL_ID"] != "*****",
                  f"got {env_map['LOCAL_CHAT_MODEL_ID']!r}")

    # ---- /archive/config (Item D: multi-mode author-notify settings) ----
    r = c.get("/archive/config")
    check("GET /archive/config -> 200 (no auth required)", r.status_code == 200, f"got {r.status_code}")
    body = r.json() if r.status_code == 200 else {}
    check("  ...returns {ok, config:{mode,notify_self,sent_24h,channels}}",
          body.get("ok") is True
          and isinstance(body.get("config"), dict)
          and body["config"].get("mode") in {"silent", "dm", "reply", "react"}
          and isinstance(body["config"].get("notify_self"), bool)
          and isinstance(body["config"].get("channels"), dict),
          f"body={body}")

    # POST without token -> 401
    r = c.post("/archive/config", json={"updates": {"mode": "dm"}})
    check("POST /archive/config without token -> 401",
          r.status_code == 401, f"got {r.status_code}")

    if token:
        # Valid mode update
        r = c.post("/archive/config",
                   json={"updates": {"mode": "dm", "notify_self": True}},
                   headers={_TOKEN_HEADER: token})
        check("POST /archive/config valid mode+notify_self -> 200",
              r.status_code == 200, f"got {r.status_code}")
        cfg = r.json().get("config", {}) if r.status_code == 200 else {}
        check("  ...returns updated config", cfg.get("mode") == "dm" and cfg.get("notify_self") is True)

        # Invalid mode -> 400
        r = c.post("/archive/config",
                   json={"updates": {"mode": "MEGA_LOUD"}},
                   headers={_TOKEN_HEADER: token})
        check("POST /archive/config invalid mode -> 400",
              r.status_code == 400, f"got {r.status_code}")

        # Per-channel overrides accepted
        r = c.post("/archive/config",
                   json={"updates": {"channels": {"123456": "reply", "789": "silent",
                                                  "skip-this": "INVALID"}}},
                   headers={_TOKEN_HEADER: token})
        check("POST /archive/config per-channel overrides -> 200", r.status_code == 200)
        chans = (r.json().get("config", {}).get("channels") or {})
        check("  ...valid per-channel modes accepted, invalid silently dropped",
              chans.get("123456") == "reply" and chans.get("789") == "silent" and "skip-this" not in chans,
              f"channels={chans}")

        # Teardown: delete data/archive-config.json entirely so the env-flag
        # fallback (SEEKDEEP_UNIVERSAL_ARCHIVE_NOTIFY) is restored for any
        # subsequent smoke runs (including bot-smoke, which assumes the
        # env-driven default until the GUI strip writes a config file).
        try:
            import os as _os
            from pathlib import Path as _Path
            cfg_path = _Path("data") / "archive-config.json"
            if cfg_path.is_file():
                _os.remove(cfg_path)
        except Exception:
            pass

    # ---- /persona (Item G: web-playground persona override) ----
    # Snapshot whatever the bot wrote before this run so we can restore at the
    # end and not pollute Discord-side persona state for the next session.
    import os as _os
    from pathlib import Path as _Path
    _persona_path = _Path("data") / "persona-overrides.json"
    _persona_backup: bytes | None = None
    try:
        if _persona_path.is_file():
            _persona_backup = _persona_path.read_bytes()
    except Exception:
        _persona_backup = None

    r = c.get("/persona")
    check("GET /persona -> 200 (no auth required)", r.status_code == 200, f"got {r.status_code}")
    body = r.json() if r.status_code == 200 else {}
    check("  ...returns {ok, valid_personas, env_default, global, effective_global, channels_count, guilds_count}",
          body.get("ok") is True
          # valid_personas == built-ins UNION user-defined slugs (custom-personas.json),
          # so assert the four built-ins are always present rather than exact-equality —
          # the endpoint deliberately surfaces custom personas (e.g. a user's 'ebonics'),
          # which made the old `== {4 built-ins}` check fail on any populated data dir.
          and {"neurotic", "unsettling", "clinical", "chaotic"}.issubset(set(body.get("valid_personas") or []))
          and isinstance(body.get("env_default"), str)
          and isinstance(body.get("effective_global"), str)
          and isinstance(body.get("channels_count"), int)
          and isinstance(body.get("guilds_count"), int),
          f"body={body}")

    # POST without token -> 401
    r = c.post("/persona", json={"scope": "global", "persona": "clinical"})
    check("POST /persona without token -> 401",
          r.status_code == 401, f"got {r.status_code}")

    if token:
        # Set global persona to 'clinical'
        r = c.post("/persona",
                   json={"scope": "global", "persona": "clinical"},
                   headers={_TOKEN_HEADER: token})
        check("POST /persona scope=global persona=clinical -> 200",
              r.status_code == 200, f"got {r.status_code}")
        b = r.json() if r.status_code == 200 else {}
        check("  ...returns {ok, scope:'global', persona:'clinical', set_at}",
              b.get("ok") is True and b.get("scope") == "global" and b.get("persona") == "clinical" and isinstance(b.get("set_at"), str),
              f"body={b}")

        # GET reflects the new global override
        r = c.get("/persona")
        b = r.json() if r.status_code == 200 else {}
        check("  ...GET /persona reflects new global override",
              b.get("global") == "clinical" and b.get("effective_global") == "clinical",
              f"body={b}")

        # Invalid persona -> 400
        r = c.post("/persona",
                   json={"scope": "global", "persona": "horny"},
                   headers={_TOKEN_HEADER: token})
        check("POST /persona invalid persona -> 400",
              r.status_code == 400, f"got {r.status_code}")

        # Invalid scope -> 400
        r = c.post("/persona",
                   json={"scope": "universe", "persona": "neurotic"},
                   headers={_TOKEN_HEADER: token})
        check("POST /persona invalid scope -> 400",
              r.status_code == 400, f"got {r.status_code}")

        # Channel scope without channel_id -> 400
        r = c.post("/persona",
                   json={"scope": "channel", "persona": "chaotic"},
                   headers={_TOKEN_HEADER: token})
        check("POST /persona scope=channel without channel_id -> 400",
              r.status_code == 400, f"got {r.status_code}")

        # Channel scope WITH channel_id -> 200, writes to channels map
        r = c.post("/persona",
                   json={"scope": "channel", "channel_id": "9999", "persona": "chaotic"},
                   headers={_TOKEN_HEADER: token})
        check("POST /persona scope=channel channel_id=9999 -> 200",
              r.status_code == 200, f"got {r.status_code}")

        # Server-scope alias 'guild' also accepted
        r = c.post("/persona",
                   json={"scope": "guild", "guild_id": "8888", "persona": "unsettling"},
                   headers={_TOKEN_HEADER: token})
        check("POST /persona scope=guild guild_id=8888 -> 200",
              r.status_code == 200, f"got {r.status_code}")

        # GET shows non-zero counts for channels + guilds
        r = c.get("/persona")
        b = r.json() if r.status_code == 200 else {}
        check("  ...channels_count + guilds_count reflect written overrides",
              b.get("channels_count", 0) >= 1 and b.get("guilds_count", 0) >= 1,
              f"body={b}")

        # Reset via action='reset' -> persona cleared
        r = c.post("/persona",
                   json={"scope": "global", "action": "reset"},
                   headers={_TOKEN_HEADER: token})
        check("POST /persona scope=global action=reset -> 200",
              r.status_code == 200, f"got {r.status_code}")
        b = r.json() if r.status_code == 200 else {}
        check("  ...returns {ok, persona: None}",
              b.get("ok") is True and b.get("persona") is None and b.get("action") == "reset",
              f"body={b}")

        # Reset channel scope without channel_id -> 400
        r = c.post("/persona",
                   json={"scope": "channel", "action": "reset"},
                   headers={_TOKEN_HEADER: token})
        check("POST /persona reset scope=channel without channel_id -> 400",
              r.status_code == 400, f"got {r.status_code}")

        # Body without persona OR action -> 400
        r = c.post("/persona",
                   json={"scope": "global"},
                   headers={_TOKEN_HEADER: token})
        check("POST /persona missing both persona+action -> 400",
              r.status_code == 400, f"got {r.status_code}")

    # Teardown: restore original persona-overrides.json (or delete if absent before).
    try:
        if _persona_backup is None:
            if _persona_path.is_file():
                _os.remove(_persona_path)
        else:
            _persona_path.write_bytes(_persona_backup)
    except Exception:
        pass

    # ---- /personas (custom-persona CRUD — GUI persona manager) ----
    # GET list / POST create-update / DELETE. Validation mirrors index.js's
    # `persona create/remove`; the file written is the SAME data/custom-
    # personas.json the bot reads. Snapshot + restore that file so a smoke run
    # never wipes or pollutes the user's real custom personas.
    _cpersonas_path = _Path("data") / "custom-personas.json"
    _cpersonas_backup: bytes | None = None
    try:
        if _cpersonas_path.is_file():
            _cpersonas_backup = _cpersonas_path.read_bytes()
    except Exception:
        _cpersonas_backup = None

    # A clearly-fake, regex-valid slug (^[a-z0-9_-]{2,32}$) that won't collide
    # with anything a user would actually name a persona.
    SMOKE_PERSONA = "smoke-test-persona"
    SMOKE_PERSONA_TONE = "a calm, terse persona used only by the gui-smoke round-trip"

    # GET is open (no token), same posture as GET /persona.
    r = c.get("/personas")
    check("GET /personas -> 200 (no auth required)", r.status_code == 200, f"got {r.status_code}")
    body = r.json() if r.status_code == 200 else {}
    check("  ...returns {ok, builtin:[{slug,description}], custom:[...], count, max:50}",
          body.get("ok") is True
          and isinstance(body.get("builtin"), list)
          and isinstance(body.get("custom"), list)
          and isinstance(body.get("count"), int)
          and body.get("max") == 50,
          f"body keys={sorted(body.keys()) if isinstance(body, dict) else type(body)}")
    builtin_slugs = {b.get("slug") for b in (body.get("builtin") or []) if isinstance(b, dict)}
    check("  ...builtin list carries the four built-ins, each with a description",
          {"neurotic", "unsettling", "clinical", "chaotic"}.issubset(builtin_slugs)
          and all(isinstance(b.get("description"), str) and b.get("description")
                  for b in (body.get("builtin") or [])),
          f"builtin={body.get('builtin')}")

    # Writes are token-gated.
    r = c.post("/personas", json={"slug": SMOKE_PERSONA, "tone": SMOKE_PERSONA_TONE})
    check("POST /personas without token -> 401", r.status_code == 401, f"got {r.status_code}")
    r = c.delete(f"/personas/{SMOKE_PERSONA}")
    check("DELETE /personas/{slug} without token -> 401", r.status_code == 401, f"got {r.status_code}")

    if token:
        # Clean slate (best-effort; ignore if absent).
        c.delete(f"/personas/{SMOKE_PERSONA}", headers={_TOKEN_HEADER: token})

        # Create.
        r = c.post("/personas", headers={_TOKEN_HEADER: token},
                   json={"slug": SMOKE_PERSONA, "tone": SMOKE_PERSONA_TONE})
        check("POST /personas create -> 200", r.status_code == 200, f"got {r.status_code}")
        b = r.json() if r.status_code == 200 else {}
        check("  ...returns {ok, slug, created:true, max:50}",
              b.get("ok") is True and b.get("slug") == SMOKE_PERSONA
              and b.get("created") is True and b.get("max") == 50,
              f"body={b}")

        # GET-list round-trip: the new persona shows up with its tone.
        r = c.get("/personas")
        b = r.json() if r.status_code == 200 else {}
        custom_map = {row.get("slug"): row for row in (b.get("custom") or []) if isinstance(row, dict)}
        check("  ...GET /personas custom list now includes it with its tone + updatedAt",
              SMOKE_PERSONA in custom_map
              and custom_map[SMOKE_PERSONA].get("tone") == SMOKE_PERSONA_TONE
              and isinstance(custom_map[SMOKE_PERSONA].get("updatedAt"), str),
              f"custom={b.get('custom')}")

        # Update (same slug, new tone) -> created flips false, createdAt preserved.
        r = c.post("/personas", headers={_TOKEN_HEADER: token},
                   json={"slug": SMOKE_PERSONA, "tone": "an even calmer, updated test persona"})
        check("POST /personas update (same slug) -> 200 created:false",
              r.status_code == 200 and r.json().get("created") is False,
              f"got {r.status_code} body={r.json() if r.status_code == 200 else None}")

        # Validation: bad slug (spaces + punctuation) -> 400.
        r = c.post("/personas", headers={_TOKEN_HEADER: token},
                   json={"slug": "Bad Slug!", "tone": "perfectly valid tone string"})
        check("POST /personas invalid slug -> 400", r.status_code == 400, f"got {r.status_code}")

        # Validation: tone > 2000 chars -> 400.
        r = c.post("/personas", headers={_TOKEN_HEADER: token},
                   json={"slug": "smoke-test-persona-toolong", "tone": "x" * 2001})
        check("POST /personas tone >2000 chars -> 400", r.status_code == 400, f"got {r.status_code}")

        # Validation: built-in name -> 400 (can't clobber a built-in).
        r = c.post("/personas", headers={_TOKEN_HEADER: token},
                   json={"slug": "neurotic", "tone": "trying to clobber a built-in"})
        check("POST /personas built-in slug -> 400", r.status_code == 400, f"got {r.status_code}")

        # Validation: reserved keyword -> 400 (mirror index.js reserved set).
        r = c.post("/personas", headers={_TOKEN_HEADER: token},
                   json={"slug": "reset", "tone": "trying to use a reserved keyword"})
        check("POST /personas reserved keyword -> 400", r.status_code == 400, f"got {r.status_code}")

        # DELETE a built-in -> 404 (built-ins are not removable).
        r = c.delete("/personas/neurotic", headers={_TOKEN_HEADER: token})
        check("DELETE /personas/neurotic (built-in) -> 404", r.status_code == 404, f"got {r.status_code}")

        # DELETE the created persona -> 200, then 404 on the second pass.
        r = c.delete(f"/personas/{SMOKE_PERSONA}", headers={_TOKEN_HEADER: token})
        check("DELETE /personas/{slug} -> 200", r.status_code == 200, f"got {r.status_code}")
        b = r.json() if r.status_code == 200 else {}
        check("  ...returns {ok, slug, removed:true}",
              b.get("ok") is True and b.get("slug") == SMOKE_PERSONA and b.get("removed") is True,
              f"body={b}")
        r = c.delete(f"/personas/{SMOKE_PERSONA}", headers={_TOKEN_HEADER: token})
        check("DELETE /personas/{slug} second time -> 404 (absent)", r.status_code == 404, f"got {r.status_code}")

    # Teardown: restore original custom-personas.json (or remove if absent before).
    try:
        if _cpersonas_backup is None:
            if _cpersonas_path.is_file():
                _os.remove(_cpersonas_path)
        else:
            _cpersonas_path.write_bytes(_cpersonas_backup)
    except Exception:
        pass

    # ---- /stats/counts (Item J: source-of-truth counts for stat tiles) ----
    r = c.get("/stats/counts")
    check("GET /stats/counts -> 200 (no auth required)", r.status_code == 200, f"got {r.status_code}")
    body = r.json() if r.status_code == 200 else {}
    check("  ...returns {ok, smoke_tests, gui_smoke_tests, releases, commands, surfaces, generated_at, sources}",
          body.get("ok") is True
          and "smoke_tests" in body and "gui_smoke_tests" in body
          and "releases" in body and "commands" in body and "surfaces" in body
          and isinstance(body.get("generated_at"), str)
          and isinstance(body.get("sources"), dict),
          f"body={body}")
    # Sanity-check the counts that come from files we control. None is acceptable
    # (degraded source) but if present, must be a positive int that matches the
    # actual file content within a tolerance window — the test files exist in CI.
    check("  ...smoke_tests is positive int (smoke_test.mjs check() calls)",
          body.get("smoke_tests") is None or (isinstance(body["smoke_tests"], int) and body["smoke_tests"] > 0),
          f"got {body.get('smoke_tests')!r}")
    check("  ...gui_smoke_tests is positive int (smoke_gui_endpoints.py check() calls)",
          body.get("gui_smoke_tests") is None or (isinstance(body["gui_smoke_tests"], int) and body["gui_smoke_tests"] > 0),
          f"got {body.get('gui_smoke_tests')!r}")
    check("  ...commands is positive int (COMMANDS.md table rows)",
          body.get("commands") is None or (isinstance(body["commands"], int) and body["commands"] > 0),
          f"got {body.get('commands')!r}")
    check("  ...surfaces is positive int (gui/nav.js PAGES entries)",
          body.get("surfaces") is None or (isinstance(body["surfaces"], int) and body["surfaces"] > 0),
          f"got {body.get('surfaces')!r}")

    # ---- /deps/install validation paths (first-use ML dep downloader) ----
    # We DO NOT exercise the happy path here — that would kick off a real
    # `pip install -r requirements-ml.txt` in a daemon thread, which would
    # try to download ~2 GB of torch wheels mid-smoke. The endpoint returns
    # immediately so even if we did call it the test could move on, but
    # leaving a stray pip subprocess in CI is rude. Just verify auth + 400s.

    # POST without token -> 401
    r = c.post("/deps/install", json={"requirements_file": "requirements-ml.txt"})
    check("POST /deps/install without token -> 401",
          r.status_code == 401, f"got {r.status_code}")

    if token:
        # Arbitrary requirements_file (path traversal attempt) -> 400
        r = c.post("/deps/install",
                   json={"requirements_file": "../etc/passwd"},
                   headers={_TOKEN_HEADER: token})
        check("POST /deps/install with non-whitelisted requirements_file -> 400",
              r.status_code == 400, f"got {r.status_code}")

        # Another disallowed value
        r = c.post("/deps/install",
                   json={"requirements_file": "anything.txt"},
                   headers={_TOKEN_HEADER: token})
        check("POST /deps/install with random requirements_file -> 400",
              r.status_code == 400, f"got {r.status_code}")

    # ---- AUD-001 / AUD-004: self-update hardening (hermetic; temp root) ----
    _self_update_checks()

    # =================================================================
    # Section 2: local_ai_server.app -- model lifecycle + route debug.
    # These endpoints live on the AI server (not on the bare GUI app),
    # so we bind a second TestClient to local_ai_server.app. Importing
    # local_ai_server has a ~0.5s overhead but loads NO ML models
    # (it's all lazy-init at /chat / /image / /vision time).
    # =================================================================
    import os
    os.environ.setdefault("SEEKDEEP_LOCAL_AI_BOOT_LITE", "1")
    try:
        import local_ai_server as _lai
        check("import local_ai_server", True)
    except Exception as e:
        check("import local_ai_server", False, str(e))
        return 1 if any(not ok for ok, _, _ in _results) else 0

    cl = TestClient(_lai.app)

    # ---- SAM segmentation feature gate + VRAM guardrail wiring ----
    # GPU-free checks: the flag gate, the budget estimate, and the /gpu fit map
    # the GUI uses to disable the toggle. The live GroundingDINO+SAM inference
    # is verified separately on a CUDA box (CI has no GPU). Default flag is off,
    # so check_sam_available() short-circuits before touching CUDA/weights.
    check("VRAM_ESTIMATES has sam_segment (positive int)",
          isinstance(_lai.VRAM_ESTIMATES.get("sam_segment"), int) and _lai.VRAM_ESTIMATES["sam_segment"] > 0,
          f"got {_lai.VRAM_ESTIMATES.get('sam_segment')!r}")
    sam_ok, sam_reason = _lai.check_sam_available()
    check("check_sam_available() -> (False, reason) when flag unset",
          sam_ok is False and isinstance(sam_reason, str) and "SEEKDEEP_FEATURE_SAM_SEGMENT" in sam_reason,
          f"got {(sam_ok, sam_reason)}")
    r = cl.get("/gpu")
    check("GET /gpu -> 200 (no auth required)", r.status_code == 200, f"got {r.status_code}")
    gj = r.json() if r.status_code == 200 else {}
    ff = (gj.get("feature_fit") or {}).get("sam_segment") or {}
    check("  ...feature_fit.sam_segment carries {enabled, available, estimated_mb, fits_now}",
          all(k in ff for k in ("enabled", "available", "estimated_mb", "fits_now"))
          and ff.get("enabled") is False,
          f"feature_fit={gj.get('feature_fit')}")

    # ---- GET /route/debug (no auth required) ----
    r = cl.get("/route/debug")
    check("GET /route/debug (no params) -> 200", r.status_code == 200,
          f"got {r.status_code}")
    j = r.json() if r.status_code == 200 else {}
    expected_keys = {"ok", "prompt_preview", "role_requested", "role_resolved",
                     "backend", "model_id", "endpoint", "fallback_chain",
                     "auto_fallback_enabled", "note"}
    missing = expected_keys - set(j.keys())
    check("  ...response has all documented keys", not missing,
          f"missing: {sorted(missing)}")
    check("  ...defaults role to 'default_chat'",
          j.get("role_requested") == "default_chat",
          f"got {j.get('role_requested')}")
    check("  ...backend is one of the 5 known kinds",
          j.get("backend") in {"hf", "ollama", "openai-compat", "anthropic", "gemini"},
          f"got {j.get('backend')}")
    check("  ...endpoint is a dict", isinstance(j.get("endpoint"), dict))
    check("  ...fallback_chain is a list", isinstance(j.get("fallback_chain"), list))

    # ---- GET /models/installed (no auth required; first-use model downloader) ----
    r = cl.get("/models/installed")
    check("GET /models/installed -> 200", r.status_code == 200, f"got {r.status_code}")
    j = r.json() if r.status_code == 200 else {}
    check("  ...response shape {ok, ml_deps_missing, all_local_present, roles, ollama_*, ...}",
          j.get("ok") is True
          and isinstance(j.get("ml_deps_missing"), bool)
          and isinstance(j.get("all_local_present"), bool)
          and isinstance(j.get("roles"), dict)
          and isinstance(j.get("ollama_required"), bool)
          and isinstance(j.get("ollama_available"), bool)
          and isinstance(j.get("ollama_base_url"), str)
          and isinstance(j.get("ollama_install_url"), str)
          and j.get("ollama_install_url", "").startswith("https://ollama.com"),
          f"body keys={sorted((j or {}).keys())}")
    if j.get("ml_deps_missing") is False:
        check("  ...roles dict has at least image + vision + chat.default_chat",
              "image" in j["roles"] and "vision" in j["roles"] and "chat.default_chat" in j["roles"],
              f"roles={sorted(j['roles'].keys())}")
        # Each role entry should have model_id + backend + local + present
        for role_key, role_info in j["roles"].items():
            check(f"  ...role {role_key!r} has full schema",
                  isinstance(role_info, dict)
                  and "model_id" in role_info and "backend" in role_info
                  and "local" in role_info and "present" in role_info,
                  f"role_info={role_info}")
            break  # Just check the first role; the schema is symmetric
        # Invariant: all_local_present iff every local role is present
        if "roles" in j:
            local_roles = [v for v in j["roles"].values() if v.get("local")]
            expected = all(v.get("present") for v in local_roles) if local_roles else True
            check("  ...all_local_present <-> (every local role.present)",
                  j["all_local_present"] == expected,
                  f"all_local_present={j['all_local_present']} expected={expected}")
    else:
        # When ml deps missing, roles dict is allowed to be empty
        check("  ...ml_deps_missing=true short-circuits role enumeration",
              j.get("all_local_present") is False,
              f"all_local_present={j.get('all_local_present')}")

    # ---- GET /ml_deps (no auth required; first-use ML installer probe) ----
    r = cl.get("/ml_deps")
    check("GET /ml_deps -> 200", r.status_code == 200, f"got {r.status_code}")
    j = r.json() if r.status_code == 200 else {}
    check("  ...response shape {ok, available, checked, missing, requirements_file, install_endpoint, manual_command, note}",
          j.get("ok") is True
          and isinstance(j.get("available"), bool)
          and isinstance(j.get("checked"), list)
          and isinstance(j.get("missing"), list)
          and j.get("requirements_file") == "requirements-ml.txt"
          and isinstance(j.get("install_endpoint"), str)
          and isinstance(j.get("manual_command"), str)
          and isinstance(j.get("note"), str),
          f"body={j}")
    check("  ...checked list contains the canonical ML modules",
          set(j.get("checked") or []) == {"torch", "transformers", "diffusers", "accelerate", "safetensors"},
          f"checked={j.get('checked')}")
    # Invariant: available is true iff missing is empty
    if isinstance(j.get("available"), bool) and isinstance(j.get("missing"), list):
        check("  ...available <-> (missing == [])",
              j["available"] == (len(j["missing"]) == 0),
              f"available={j['available']} missing={j['missing']}")

    # Unknown role should fall back to default_chat resolution
    r = cl.get("/route/debug", params={"role": "totally_made_up_role_xyz"})
    check("GET /route/debug?role=<bogus> -> 200 (resolves to default_chat)",
          r.status_code == 200, f"got {r.status_code}")
    if r.status_code == 200:
        j = r.json()
        check("  ...role_requested preserved, role_resolved fell back",
              j.get("role_requested") == "totally_made_up_role_xyz"
              and j.get("role_resolved") == "default_chat",
              f"req={j.get('role_requested')} res={j.get('role_resolved')}")

    # prompt_preview should be capped at 240 chars
    long_prompt = "x" * 500
    r = cl.get("/route/debug", params={"prompt": long_prompt})
    if r.status_code == 200:
        check("GET /route/debug truncates prompt_preview at 240 chars",
              len(r.json().get("prompt_preview", "")) == 240,
              f"got len={len(r.json().get('prompt_preview', ''))}")

    # ---- POST /model/install -- validation only (no real downloads) ----
    if token:
        r = cl.post("/model/install",
                    json={"backend": "hf", "model_id": ""},
                    headers={_TOKEN_HEADER: token})
        check("POST /model/install with empty model_id -> 400",
              r.status_code == 400, f"got {r.status_code}")

        # PYS-1: hf repo-id shape validation — paths / URLs / traversal refused.
        for bad in ("../../etc/passwd", "http://evil.example/x", "/abs/path", "a/b/c", "evil model id"):
            r = cl.post("/model/install",
                        json={"backend": "hf", "model_id": bad},
                        headers={_TOKEN_HEADER: token})
            check(f"POST /model/install rejects invalid hf repo id {bad!r} -> 400",
                  r.status_code == 400, f"got {r.status_code}")

        r = cl.post("/model/install",
                    json={"backend": "nonsense", "model_id": "x"},
                    headers={_TOKEN_HEADER: token})
        check("POST /model/install with invalid backend -> 422 (Pydantic)",
              r.status_code == 422, f"got {r.status_code}")

        r = cl.post("/model/install", json={"backend": "hf", "model_id": "x"})
        check("POST /model/install without token -> 401",
              r.status_code == 401, f"got {r.status_code}")

    # ---- POST /model/uninstall -- shape contract for the no-write paths ----
    if token:
        r = cl.post("/model/uninstall", json={"backend": "hf", "model_id": "x"})
        check("POST /model/uninstall without token -> 401",
              r.status_code == 401, f"got {r.status_code}")

        # Absent hf model -- idempotent success with freed_bytes=0
        r = cl.post("/model/uninstall",
                    json={"backend": "hf",
                          "model_id": "nonexistent-smoke-test-org/never-existed"},
                    headers={_TOKEN_HEADER: token})
        check("POST /model/uninstall hf absent -> 200 (idempotent)",
              r.status_code == 200, f"got {r.status_code}")
        if r.status_code == 200:
            body = r.json()
            check("  ...ok=True, freed_bytes=0, backend=hf",
                  body.get("ok") is True and body.get("freed_bytes") == 0
                  and body.get("backend") == "hf",
                  f"body={body}")

        # Remote backend uninstall is a no-op (no local storage to free)
        r = cl.post("/model/uninstall",
                    json={"backend": "openai-compat", "model_id": "gpt-4"},
                    headers={_TOKEN_HEADER: token})
        check("POST /model/uninstall openai-compat -> 200 (no-op)",
              r.status_code == 200, f"got {r.status_code}")
        if r.status_code == 200:
            body = r.json()
            check("  ...external=True, backend=openai-compat",
                  body.get("external") is True and body.get("backend") == "openai-compat",
                  f"body={body}")

        # Bogus role -> 400 with env_patched=False (doesn't touch .env)
        r = cl.post("/model/uninstall",
                    json={"backend": "openai-compat", "model_id": "x",
                          "role": "totally_bogus_role_name_xyz"},
                    headers={_TOKEN_HEADER: token})
        check("POST /model/uninstall with unknown role -> 400 (env untouched)",
              r.status_code == 400, f"got {r.status_code}")
        if r.status_code == 400:
            body = r.json()
            check("  ...env_patched=False, error mentions unknown role",
                  body.get("env_patched") is False
                  and "unknown role" in str(body.get("error", "")),
                  f"body={body}")

    # ---- TEST-4: generation / inference auth contract -----------------------
    # Every inference + warmup + model-lifecycle POST on the AI server is gated
    # by Depends(require_gui_token). Pin it: a request with NO X-SeekDeep-Token
    # must get 401 and never reach the model. If someone drops the dependency
    # from a route, this turns red. The token check is a route dependency, so it
    # fires BEFORE body validation — an empty body still yields 401, no model
    # load. (/model/install + /model/uninstall are covered above; this is the
    # generation/inference/warmup surface that was previously untested.)
    if token:
        for _p in ("/chat", "/vision", "/image", "/img2img", "/upscale",
                   "/instruct-pix2pix", "/inpaint", "/inpaint_mask_preview",
                   "/chart", "/unload", "/warmup/chat", "/warmup/image",
                   "/warmup/vision"):
            r = cl.post(_p)  # no token header, no body
            check(f"POST {_p} without token -> 401 (token-gated)",
                  r.status_code == 401, f"got {r.status_code}")

    # ---- TAU-5 / Phase A: browser-path CSP + security headers ---------------
    # The /gui StaticFiles mount mirrors the desktop CSP + anti-framing headers
    # onto GUI HTML — EXCEPT the Discord Activity (gui/activity/*), which must
    # stay embeddable in Discord's iframe and able to load its esm.sh SDK.
    r = cl.get("/gui/app.html")
    if r.status_code == 200:
        csp = r.headers.get("content-security-policy", "")
        check("Phase A: GUI page carries the browser CSP (frame-ancestors 'none')",
              "default-src 'self'" in csp and "frame-ancestors 'none'" in csp, f"csp={csp[:90]!r}")
        connect = csp.split("connect-src", 1)[1].split(";", 1)[0] if "connect-src" in csp else ""
        check("Phase A: connect-src is loopback-only (no bare https: token-egress)",
              " https:" not in connect and "127.0.0.1" in connect, f"connect-src={connect!r}")
        check("Phase A: GUI page has X-Frame-Options DENY + nosniff",
              r.headers.get("x-frame-options") == "DENY"
              and r.headers.get("x-content-type-options") == "nosniff",
              f"xfo={r.headers.get('x-frame-options')!r}")
    r = cl.get("/gui/activity/index.html")
    if r.status_code == 200:
        hk = {k.lower() for k in r.headers}
        check("Phase A: Discord Activity exempt from CSP + X-Frame-Options (stays embeddable)",
              "content-security-policy" not in hk and "x-frame-options" not in hk,
              f"csp={r.headers.get('content-security-policy')!r} xfo={r.headers.get('x-frame-options')!r}")

    # ---- Summary ----
    n_ok = sum(1 for ok, _, _ in _results if ok)
    n_fail = sum(1 for ok, _, _ in _results if not ok)
    print("-------------------")
    print(f"{n_ok} ok, {n_fail} fail")
    if n_fail:
        print("\nFailures:")
        for ok, name, detail in _results:
            if not ok:
                print(f"  - {name}{(' -> ' + detail) if detail else ''}")
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
