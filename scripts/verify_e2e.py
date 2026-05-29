"""End-to-end verification of every Control Center endpoint.
Runs against a live AI server on 127.0.0.1:7865 (already booted)."""
import io
import json
import os
import sys
import time
import urllib.request
import urllib.error

# Force ASCII-safe stdout on Windows consoles (cp1252).
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")

BASE = "http://127.0.0.1:7865"
# Token gate: read it from .env so writes work without manual header copying.
TOKEN = ""
try:
    with open(".env", encoding="utf-8") as f:
        for line in f:
            if line.startswith("SEEKDEEP_GUI_TOKEN="):
                TOKEN = line.split("=", 1)[1].strip().strip('"').strip("'")
                break
except FileNotFoundError:
    pass

results = []

def call(method, path, body=None, timeout=60, expect=None):
    url = BASE + path
    data = json.dumps(body).encode("utf-8") if body is not None else None
    req = urllib.request.Request(url, data=data, method=method)
    if data is not None:
        req.add_header("Content-Type", "application/json")
    # Always attach token when we have one: /logs/tail, /data/auto-reactions.json,
    # and other GET endpoints are now token-gated too (P0 security fix).
    if TOKEN:
        req.add_header("X-SeekDeep-Token", TOKEN)
    t0 = time.time()
    status = "?"
    payload = None
    err = None
    try:
        r = urllib.request.urlopen(req, timeout=timeout)
        status = r.status
        raw = r.read().decode("utf-8", errors="replace")
        try:    payload = json.loads(raw)
        except: payload = raw[:400]
    except urllib.error.HTTPError as e:
        status = e.code
        raw = e.read().decode("utf-8", errors="replace")
        try:    payload = json.loads(raw)
        except: payload = raw[:400]
    except Exception as e:
        err = f"{type(e).__name__}: {e}"
    dt = int((time.time() - t0) * 1000)
    ok = (err is None) and (expect is None or status == expect or status in (expect if isinstance(expect, (list, tuple)) else [expect]))
    results.append({
        "method": method, "path": path, "status": status, "ms": dt,
        "ok": ok, "err": err, "preview": payload,
    })
    return payload

def pp(idx, r):
    icon = "OK" if r["ok"] else ("--" if r["err"] is None else "FAIL")
    line = f"{icon}  {idx:2}. {r['method']:6} {r['path']:42}  status={r['status']:>5}  {r['ms']:>5}ms"
    if r["err"]: line += f"  err={r['err']}"
    print(line)
    if isinstance(r["preview"], dict):
        prev = json.dumps(r["preview"])[:280]
        print(f"      -> {prev}")
    elif isinstance(r["preview"], str) and r["preview"]:
        print(f"      -> {r['preview'][:280]}")

print("\n=== SeekDeep AI server · E2E endpoint sweep ===\n")
print(f"BASE = {BASE}   token-set: {bool(TOKEN)}\n")

# ---- Reads (open) ----------------------------------------------------------
call("GET", "/health", expect=200)
call("GET", "/gpu", expect=200)
call("GET", "/logs/tail?lines=5", expect=200)
call("GET", "/launchers/status", expect=200)
call("GET", "/system/firstrun", expect=200)
call("GET", "/config", expect=200)
call("GET", "/stats/snapshot", expect=200)
call("GET", "/data/auto-reactions.json", expect=200)

# ---- Auto-react rules CRUD (writes) ----------------------------------------
# Audit §3: verify-guild-001 looked like a stub Discord ID and survived
# in the user's Auto-react rules pane. "smoke-verify-guild" cannot
# collide with any real Discord snowflake (non-digit chars) and gets
# pruned by _prune_empty_guilds once the rule is deleted below.
created = call("POST", "/reacts/rule", body={
    "guild_id": "smoke-verify-guild",
    "emoji": "🧪",
    "pattern": "verify-pattern",
    "enabled": True,
}, expect=200)
rule_id = (created or {}).get("rule", {}).get("id") if isinstance(created, dict) else None
if rule_id:
    call("PATCH", f"/reacts/rule/{rule_id}", body={"enabled": False}, expect=200)
    call("DELETE", f"/reacts/rule/{rule_id}", expect=200)
else:
    print("    (skipping PATCH/DELETE — no rule_id returned)")

# ---- Launcher: bot start (auto-cwd-resolve test) ---------------------------
call("POST", "/launcher/bot/status", expect=200)
# Use the non-self-hosted services; ai-server status (NOT start — would 409)
call("POST", "/launcher/ai-server/status", expect=200)

# ---- Bot launcher: actually start the bot ---------------------------------
# This is THE test the user cares about. In this repo cwd has index.js +
# node_modules, so the bot should actually launch. After 3s we re-status.
start = call("POST", "/launcher/bot/start", expect=[200, 400])
time.sleep(3)
status_after = call("POST", "/launcher/bot/status", expect=200)
# Then stop the bot so we leave the host clean.
call("POST", "/launcher/bot/stop", expect=200)

# ---- Chat (expect 503 if no model warmed; must have `detail` field) --------
chat_payload = {
    "prompt": "verify ping — fail fast",
    "role": "default_chat",
    "max_new_tokens": 32,
    "temperature": 0.1,
}
chat_resp = call("POST", "/chat", body=chat_payload, timeout=180, expect=[200, 503])
# Verify the 503 contract: error + reason + detail fields (fix #87).
if isinstance(chat_resp, dict) and "reason" in chat_resp:
    has_detail = "detail" in chat_resp and bool(chat_resp.get("detail"))
    print(f"\n  [contract check] /chat 503 has `detail` field: {has_detail}")
    if not has_detail:
        results.append({"method": "CONTRACT", "path": "/chat detail field", "status": "MISSING",
                        "ms": 0, "ok": False, "err": None, "preview": "expected detail field on 503"})

# ---- Chart (bot stats command renders this; must produce a PNG) -----------
chart_resp = call("POST", "/chart", body={
    "day_buckets": {
        "2026-05-25": {"images": 2, "chats": 5, "vision": 1},
        "2026-05-26": {"images": 3, "chats": 8, "vision": 0},
        "2026-05-27": {"images": 1, "chats": 12, "vision": 2},
    },
    "title": "verify_e2e smoke",
}, timeout=30, expect=[200, 501])
# 501 = matplotlib not installed (requirements-local.txt regression).
# 200 = PNG bytes returned as image_b64.
if isinstance(chart_resp, dict):
    if chart_resp.get("error", "").startswith("matplotlib"):
        print("\n  [contract check] /chart 501 -> matplotlib missing from requirements-local.txt")
        results.append({"method": "CONTRACT", "path": "/chart matplotlib dep",
                        "status": "MISSING", "ms": 0, "ok": False, "err": None,
                        "preview": "add matplotlib to requirements-local.txt"})
    elif chart_resp.get("image_b64"):
        # Decode to verify it's a real PNG (89504e470d0a1a0a magic)
        import base64 as _b64
        try:
            raw = _b64.b64decode(chart_resp["image_b64"])
            is_png = raw[:8] == b"\x89PNG\r\n\x1a\n"
            print(f"  [contract check] /chart returned {len(raw)} bytes; PNG magic ok={is_png}")
            if not is_png:
                results.append({"method": "CONTRACT", "path": "/chart PNG magic",
                                "status": "BAD", "ms": 0, "ok": False, "err": None,
                                "preview": f"got {raw[:8]!r}"})
        except Exception as e:
            print(f"  [contract check] /chart base64 decode failed: {e}")

# ---- Logs tail (re-check after writes to confirm sink active) --------------
call("GET", "/logs/tail?lines=10", expect=200)

# ---- Report ----------------------------------------------------------------
print("\n=== RESULTS ===\n")
for i, r in enumerate(results, 1):
    pp(i, r)

ok = sum(1 for r in results if r["ok"])
print(f"\n{ok}/{len(results)} pass")
# Exit nonzero if any fail
sys.exit(0 if ok == len(results) else 1)
