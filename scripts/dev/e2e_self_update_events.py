"""Self-update + dry-run-installer event probe (manual / dev-only).

DEAD-2: renamed from e2e_progress_events_v2.py — this is NOT a "v2" of the
progress probe; it tests an entirely different surface (the self-update +
installer event wiring), so e2e_progress_events.py is still current, not
obsolete. Run by hand; not wired into preflight or CI.

Real /system/self-update would actually fetch from GitHub and patch the live
tree — too destructive for an unattended probe. Instead we connect WS, hit
the dry-run installers (which auth-gate + winget-probe but skip the install),
and confirm self-update events would fire by hitting it with a bad ref to
trigger the .failed path. The .started/.failed pair is enough to prove the
emission wiring works.
"""
from __future__ import annotations
import asyncio
import io
import json
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

try:
    sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")
except Exception:
    pass

ROOT = Path(__file__).resolve().parent.parent.parent  # scripts/dev/ -> repo root (DEAD-1 move)
BASE = "http://127.0.0.1:7865"
WS_BASE = "ws://127.0.0.1:7865"


def _token() -> str:
    env = ROOT / ".env"
    # DEAD-2: restore the is_file() guard v1 has — without it the probe
    # raises FileNotFoundError the moment it runs without a .env.
    if not env.is_file():
        return ""
    for line in env.read_text(encoding="utf-8", errors="replace").splitlines():
        m = re.match(r"^SEEKDEEP_GUI_TOKEN=(.+)", line.strip())
        if m:
            return m.group(1).strip().strip('"').strip("'")
    return ""


TOKEN = _token()


def http_post(path: str, body: dict | None = None, timeout: int = 30) -> tuple[int, str]:
    url = BASE + path
    data = json.dumps(body or {}).encode("utf-8")
    req = urllib.request.Request(url, data=data, method="POST", headers={
        "Content-Type": "application/json",
        "X-SeekDeep-Token": TOKEN,
    })
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.status, r.read().decode("utf-8", errors="replace")
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode("utf-8", errors="replace")


async def main() -> int:
    import websockets  # type: ignore
    ws_url = f"{WS_BASE}/events?token={urllib.parse.quote(TOKEN)}"
    print(f"Connecting WS: {ws_url[:60]}...")

    seen: dict[str, int] = {
        "self-update.started": 0, "self-update.failed": 0, "self-update.complete": 0,
        "self-update.line": 0, "self-update.progress": 0,
        "install-python.started": 0, "install-docker.started": 0, "install-ollama.started": 0,
    }
    last_progress: dict[str, dict] = {}

    async with websockets.connect(ws_url, open_timeout=5) as ws:
        print("WS connected.")
        stop = asyncio.Event()

        async def reader():
            while not stop.is_set():
                try:
                    frame = await asyncio.wait_for(ws.recv(), timeout=0.5)
                except asyncio.TimeoutError:
                    continue
                except Exception:
                    return
                try:
                    j = json.loads(frame)
                except Exception:
                    continue
                t = j.get("type") if isinstance(j, dict) else None
                if t in seen:
                    seen[t] += 1
                    if t.endswith(".progress"):
                        last_progress[t] = j.get("data") or {}

        reader_task = asyncio.create_task(reader())
        loop = asyncio.get_event_loop()

        # 1. self-update with a deliberately-bad ref (400 path) — should emit
        # self-update.failed even though it never reaches the download phase.
        print("\n→ POST /system/self-update {ref: 'nope'} (expect early failed)")
        status, body = await loop.run_in_executor(None, http_post, "/system/self-update",
                                                  {"ref": "definitely-not-a-valid-ref"})
        print(f"   returned {status}, body[:120]={body[:120]!r}")
        await asyncio.sleep(0.3)

        # 2. installers dry-run — should not emit installer events (dry-run
        # returns before _run_winget_streamed). Confirms we didn't accidentally
        # emit .started before the dry-run guard.
        for ep in ("install-python", "install-docker", "install-ollama"):
            print(f"\n→ POST /system/{ep} {{dry_run: true}}")
            status, body = await loop.run_in_executor(None, http_post,
                                                      f"/system/{ep}", {"dry_run": True})
            print(f"   returned {status}, body[:120]={body[:120]!r}")
            await asyncio.sleep(0.2)

        # Give the bus a moment, then stop
        await asyncio.sleep(0.5)
        stop.set()
        await asyncio.sleep(0.6)
        reader_task.cancel()

    print("\n--- Event counts ---")
    for k in sorted(seen):
        flag = "OK " if seen[k] > 0 else "   "
        print(f"  {flag} {k}: {seen[k]}")

    # Expected: self-update.failed >= 1 from the bad-ref path. The dry-run
    # installers should NOT have fired .started (we guard before that).
    expected_at_least = ["self-update.failed"]
    expected_zero = ["install-python.started", "install-docker.started", "install-ollama.started"]
    missing = [k for k in expected_at_least if seen[k] == 0]
    unexpected = [k for k in expected_zero if seen[k] > 0]
    if missing or unexpected:
        print(f"\nFAIL — missing: {missing}  unexpected: {unexpected}")
        return 1
    print("\nPASS — self-update.failed fired on bad ref; dry-run installers did not emit .started.")
    return 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
