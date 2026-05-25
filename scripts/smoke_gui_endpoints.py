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
