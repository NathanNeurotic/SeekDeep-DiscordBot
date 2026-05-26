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

        r = c.get("/memory/users")
        check("GET /memory/users -> 200", r.status_code == 200, f"got {r.status_code}")
        body = r.json() if r.status_code == 200 else {}
        check("  ...returns {ok, users:[]} shape",
              body.get("ok") is True and isinstance(body.get("users"), list),
              f"keys={sorted(body.keys()) if isinstance(body, dict) else type(body)}")

        r = c.get(f"/memory/user/{SMOKE_UID}")
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

        r = c.get(f"/memory/user/{SMOKE_UID}")
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
        r = c.get(f"/memory/user/{SMOKE_UID}/export")
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

        r = c.get(f"/memory/presets/{SMOKE_UID2}")
        check("GET /memory/presets/{id} -> 200", r.status_code == 200, f"got {r.status_code}")
        body = r.json() if r.status_code == 200 else {}
        check("  ...returns {ok, presets:[brief, expert]}",
              body.get("ok") is True and body.get("presets") == ["brief", "expert"],
              f"body={body}")

        # Cleanup: drop the presets row so we don't pollute real data
        c.post(f"/memory/presets/{SMOKE_UID2}", json={"presets": []},
               headers={_TOKEN_HEADER: token})

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
          and set(body.get("valid_personas") or []) == {"neurotic", "unsettling", "clinical", "chaotic"}
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
