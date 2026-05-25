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

Each check prints "ok" or "FAIL" with detail. Exit code is 0 only if every
check passes. Designed to be invoked from preflight.mjs and from CI.

Requires only: fastapi, httpx, pydantic. The full requirements-local.txt
(torch, transformers, diffusers, etc.) is NOT needed for this file.

Usage:
    python scripts/smoke_gui_endpoints.py
"""

from __future__ import annotations
import sys
import re
from pathlib import Path

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

    # ---- Auth: POST /launcher/... without header -> 401 ----
    r = c.post("/launcher/bot/status")
    check("POST /launcher/bot/status without token -> 401",
          r.status_code == 401, f"got {r.status_code}")

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
    r = c.get("/data/server-stats.json")
    if r.status_code == 200:
        body = r.json()
        check("GET /data/server-stats.json -> 200 (normalizer applied)",
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
        check("GET /data/server-stats.json -> 200 (or empty fallback)",
              False, f"got {r.status_code}; expected 200 if file exists or empty fallback")

    # auto-reactions.json: file may not exist on a fresh repo; normalizer
    # should still return empty {rules:[]} not 404.
    r = c.get("/data/auto-reactions.json")
    check("GET /data/auto-reactions.json -> 200 (empty-fallback for missing file)",
          r.status_code == 200, f"got {r.status_code}")
    if r.status_code == 200:
        body = r.json()
        check("  ...returns {rules: []} when file missing",
              isinstance(body.get("data", {}).get("rules"), list))

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
                # The WS should receive the event
                msg = ws.receive_json()
                check("WS subscriber receives the emitted event",
                      msg.get("type") == "smoke.test" and msg.get("data", {}).get("k") == "v",
                      f"got {msg}")
        except Exception as e:
            check("WS /events round-trip", False, str(e))

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
