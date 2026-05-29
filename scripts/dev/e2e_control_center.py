"""E2E sweep against a *running* local_ai_server. Hits every Control Center endpoint.

Not a TestClient — uses real HTTP against http://127.0.0.1:7865.
Writes JSON results to logs/e2e_control_center.json.
"""
from __future__ import annotations
import io
import json
import re
import sys
import time
import urllib.request
import urllib.error
import urllib.parse
from pathlib import Path

# Force UTF-8 stdout so Windows cp1252 doesn't choke on arrows.
try:
    sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")
except Exception:
    pass

ROOT = Path(__file__).resolve().parent.parent.parent  # scripts/dev/ -> repo root (DEAD-1 move)
BASE = "http://127.0.0.1:7865"

def _token() -> str:
    env = (ROOT / ".env")
    if not env.is_file():
        return ""
    for line in env.read_text(encoding="utf-8", errors="replace").splitlines():
        m = re.match(r"^SEEKDEEP_GUI_TOKEN=(.+)", line.strip())
        if m:
            return m.group(1).strip().strip('"').strip("'")
    return ""

TOKEN = _token()
HDR = {"X-SeekDeep-Token": TOKEN} if TOKEN else {}

def call(method: str, path: str, *, body=None, headers=None, timeout=30):
    url = BASE + path
    data = None
    hdrs = dict(HDR)
    if headers:
        hdrs.update(headers)
    if body is not None:
        data = json.dumps(body).encode("utf-8")
        hdrs.setdefault("Content-Type", "application/json")
    req = urllib.request.Request(url, data=data, method=method, headers=hdrs)
    t0 = time.monotonic()
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            raw = r.read()
            ms = int((time.monotonic() - t0) * 1000)
            ct = r.headers.get("content-type", "")
            body_out = None
            if "json" in ct:
                try:
                    body_out = json.loads(raw.decode("utf-8") or "null")
                except Exception:
                    body_out = raw[:400].decode("utf-8", errors="replace")
            else:
                body_out = raw[:400].decode("utf-8", errors="replace")
            return {"ok": True, "status": r.status, "ms": ms, "body": body_out}
    except urllib.error.HTTPError as e:
        ms = int((time.monotonic() - t0) * 1000)
        raw = e.read()
        try:
            j = json.loads(raw.decode("utf-8") or "null")
        except Exception:
            j = raw[:400].decode("utf-8", errors="replace")
        return {"ok": False, "status": e.code, "ms": ms, "body": j}
    except Exception as e:
        ms = int((time.monotonic() - t0) * 1000)
        return {"ok": False, "status": 0, "ms": ms, "body": f"{type(e).__name__}: {e}"}

CHECKS: list[tuple[str, str, str, dict | None]] = [
    # (label, method, path, body)
    ("token bootstrap",      "GET",  "/token", None),
    ("health",               "GET",  "/health", None),
    ("launchers status",     "GET",  "/launchers/status", None),
    ("system firstrun",      "GET",  "/system/firstrun", None),
    ("system runtime",       "GET",  "/system/runtime", None),
    ("system docker",        "GET",  "/system/docker", None),
    ("system bootstrap status", "GET", "/system/bootstrap-status", None),
    ("system detect-venv",   "GET",  "/system/detect-venv", None),
    ("system ollama-status", "GET",  "/system/ollama-status", None),
    ("config get",           "GET",  "/config", None),
    ("config status",        "GET",  "/config/status", None),
    ("persona get",          "GET",  "/persona", None),
    ("archive config get",   "GET",  "/archive/config", None),
    ("stats counts",         "GET",  "/stats/counts", None),
    ("stats snapshot",       "GET",  "/stats/snapshot", None),
    ("events status",        "GET",  "/events/status", None),
    ("data bot-status",      "GET",  "/data/bot-status.json", None),
    ("data server-stats",    "GET",  "/data/server-stats.json", None),
    ("data settings",        "GET",  "/data/settings.json", None),
    ("data auto-reactions",  "GET",  "/data/auto-reactions.json", None),
    ("logs tail",            "GET",  "/logs/tail?n=5", None),
    # POSTs (token-guarded)
    ("config reload",        "POST", "/config/reload", {}),
    ("config post no-op",    "POST", "/config", {"updates": {}}),
    ("events emit smoke",    "POST", "/events/emit", {"type": "smoke.tick", "data": {"hi": 1}}),
    ("memory users",         "GET",  "/memory/users", None),
    ("memory user web",      "GET",  "/memory/user/web", None),
    # long-running last, with bigger timeouts inline:
    ("system doctor",        "POST", "/system/doctor", {}),
    ("system smoke",         "POST", "/system/smoke", {}),
]

# Per-check timeout override (seconds). Smoke + doctor run real subprocesses.
TIMEOUTS = {
    "/system/smoke":  90,
    "/system/doctor": 60,
    "/system/firstrun": 30,
}

def probe_ws_round_trip() -> dict:
    """Connect to /events WS, emit a tagged event, confirm it comes back."""
    try:
        import websockets  # type: ignore
        import asyncio
    except Exception as e:
        return {"label": "WS /events round-trip", "ok": False, "status": 0, "ms": 0,
                "body_preview": f"websockets pkg not available: {e}"}

    async def _go():
        ws_url = "ws://127.0.0.1:7865/events?token=" + urllib.parse.quote(TOKEN)
        try:
            async with websockets.connect(ws_url, open_timeout=5) as ws:
                tag = f"probe.{int(time.time()*1000)}"
                # publish via HTTP after WS is connected
                emit = call("POST", "/events/emit", body={"type": tag, "data": {"k": "v"}})
                if not emit["ok"]:
                    return {"ok": False, "status": emit["status"], "body_preview": f"emit failed: {emit['body']}"}
                # Read up to ~3s of frames looking for our tag
                deadline = time.monotonic() + 3.0
                while time.monotonic() < deadline:
                    try:
                        frame = await asyncio.wait_for(ws.recv(), timeout=max(0.1, deadline - time.monotonic()))
                    except asyncio.TimeoutError:
                        break
                    try:
                        j = json.loads(frame)
                    except Exception:
                        continue
                    if isinstance(j, dict) and j.get("type") == tag:
                        return {"ok": True, "status": 200, "body_preview": f"tag {tag} received"}
                return {"ok": False, "status": 0, "body_preview": f"tag {tag} never came back over WS"}
        except Exception as e:
            return {"ok": False, "status": 0, "body_preview": f"{type(e).__name__}: {e}"}

    t0 = time.monotonic()
    try:
        rec = asyncio.run(_go())
    except Exception as e:
        rec = {"ok": False, "status": 0, "body_preview": f"asyncio err: {e}"}
    ms = int((time.monotonic() - t0) * 1000)
    rec.update({"label": "WS /events round-trip", "method": "WS", "path": "/events", "ms": ms})
    return rec


def run() -> int:
    print(f"E2E sweep against {BASE}  token={'set' if TOKEN else 'MISSING'}")
    out = []
    fails = 0
    for label, method, path, body in CHECKS:
        r = call(method, path, body=body, timeout=TIMEOUTS.get(path, 30))
        ok = r["ok"]
        # treat some "expected" non-200s as acceptable
        if not ok:
            # ledger-empty data files → 404 is fine for the smoke (not a server bug)
            if r["status"] == 404 and path.startswith("/data/"):
                ok = True
            # /memory/user/<id> 404 = "no row yet" is the documented contract (playground.js handles it)
            if r["status"] == 404 and re.match(r"^/memory/user/[^/]+$", path):
                ok = True
        if not ok:
            fails += 1
        rec = {"label": label, "method": method, "path": path,
               "status": r["status"], "ms": r["ms"], "ok": ok,
               "body_preview": (r["body"] if isinstance(r["body"], str) else
                                json.dumps(r["body"])[:300] if r["body"] is not None else None)}
        out.append(rec)
        flag = "ok  " if ok else "FAIL"
        print(f"  {flag} {r['status']:>3} {r['ms']:>5}ms  {method:5s} {path}")
        if not ok:
            preview = rec["body_preview"]
            if preview:
                print(f"         ↳ {preview[:200]}")
    # ---- Probes (per-verify-skill: push on the change, not just confirm it) ----
    print("\nProbes:")
    probes: list[dict] = []

    # Probe 1: WS round-trip
    ws = probe_ws_round_trip()
    probes.append(ws)
    print(f"  {'ok  ' if ws['ok'] else 'FAIL'} {ws['status']:>3} {ws['ms']:>5}ms  WS    /events  ({ws['body_preview']})")

    # Probe 2: token-guard rejects wrong token
    bad = call("POST", "/config/reload", body={}, headers={"X-SeekDeep-Token": "deadbeef-not-the-token"})
    p2_ok = bad["status"] in (401, 403)
    probes.append({"label": "wrong token rejected", "method": "POST", "path": "/config/reload",
                   "status": bad["status"], "ms": bad["ms"], "ok": p2_ok,
                   "body_preview": str(bad["body"])[:200]})
    print(f"  {'ok  ' if p2_ok else 'FAIL'} {bad['status']:>3} {bad['ms']:>5}ms  POST  /config/reload  (bad token → expect 401/403)")

    # Probe 3: token-guard with NO header at all
    nohdr_url = BASE + "/config/reload"
    req = urllib.request.Request(nohdr_url, data=b"{}", method="POST", headers={"Content-Type": "application/json"})
    t0 = time.monotonic()
    try:
        with urllib.request.urlopen(req, timeout=5) as r:
            code, ms = r.status, int((time.monotonic() - t0)*1000)
    except urllib.error.HTTPError as e:
        code, ms = e.code, int((time.monotonic() - t0)*1000)
    except Exception:
        code, ms = 0, int((time.monotonic() - t0)*1000)
    p3_ok = code in (401, 403)
    probes.append({"label": "no token rejected", "method": "POST", "path": "/config/reload",
                   "status": code, "ms": ms, "ok": p3_ok, "body_preview": ""})
    print(f"  {'ok  ' if p3_ok else 'FAIL'} {code:>3} {ms:>5}ms  POST  /config/reload  (no header → expect 401/403)")

    # Probe 4: /events/emit with malformed body — expect 422
    bad_emit = call("POST", "/events/emit", body={"oops": "no type field"})
    p4_ok = bad_emit["status"] == 422
    probes.append({"label": "events/emit malformed → 422", "method": "POST", "path": "/events/emit",
                   "status": bad_emit["status"], "ms": bad_emit["ms"], "ok": p4_ok,
                   "body_preview": str(bad_emit["body"])[:200]})
    print(f"  {'ok  ' if p4_ok else 'FAIL'} {bad_emit['status']:>3} {bad_emit['ms']:>5}ms  POST  /events/emit  (malformed → expect 422)")

    # Probe 5: /launcher/<bad>/restart — expect a clean 4xx
    bad_svc = call("POST", "/launcher/does-not-exist/restart", body={})
    p5_ok = bad_svc["status"] in (400, 404, 422)
    probes.append({"label": "launcher unknown service → 4xx", "method": "POST",
                   "path": "/launcher/does-not-exist/restart",
                   "status": bad_svc["status"], "ms": bad_svc["ms"], "ok": p5_ok,
                   "body_preview": str(bad_svc["body"])[:200]})
    print(f"  {'ok  ' if p5_ok else 'FAIL'} {bad_svc['status']:>3} {bad_svc['ms']:>5}ms  POST  /launcher/does-not-exist/restart  (unknown svc → 4xx)")

    # Probe 6: cache prune (the launcher.js Prune button)
    prune = call("POST", "/cache/prune", body={}, timeout=45)
    p6_ok = prune["ok"]
    probes.append({"label": "cache prune", "method": "POST", "path": "/cache/prune",
                   "status": prune["status"], "ms": prune["ms"], "ok": p6_ok,
                   "body_preview": str(prune["body"])[:200]})
    print(f"  {'ok  ' if p6_ok else 'FAIL'} {prune['status']:>3} {prune['ms']:>5}ms  POST  /cache/prune")

    probe_fails = sum(1 for p in probes if not p["ok"])
    fails += probe_fails

    (ROOT / "logs").mkdir(parents=True, exist_ok=True)
    (ROOT / "logs" / "e2e_control_center.json").write_text(
        json.dumps({"base": BASE, "fails": fails, "checks": out, "probes": probes}, indent=2),
        encoding="utf-8")
    total = len(CHECKS) + len(probes)
    print(f"\n{total - fails}/{total} ok  ({fails} fail)")
    return 0 if fails == 0 else 1

if __name__ == "__main__":
    sys.exit(run())
