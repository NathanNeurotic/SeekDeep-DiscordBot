"""E2E probe for the new progress + tick events.

Connects to ws://127.0.0.1:7865/events, triggers /system/smoke + /cache/prune
via HTTP, and verifies the expected event topics arrive on the WS bus while
the HTTP calls are still in flight. Also waits for one stats.tick frame.
"""
from __future__ import annotations
import asyncio
import io
import json
import re
import sys
import time
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
    if not env.is_file():
        return ""
    for line in env.read_text(encoding="utf-8", errors="replace").splitlines():
        m = re.match(r"^SEEKDEEP_GUI_TOKEN=(.+)", line.strip())
        if m:
            return m.group(1).strip().strip('"').strip("'")
    return ""


TOKEN = _token()


def http_post(path: str, body: dict | None = None, timeout: int = 90) -> tuple[int, str]:
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

    seen = {"smoke.started": 0, "smoke.line": 0, "smoke.progress": 0,
            "smoke.complete": 0, "smoke.failed": 0,
            "cache.prune.started": 0, "cache.prune.complete": 0,
            "cache.prune.line": 0, "cache.prune.progress": 0,
            "stats.tick": 0, "gpu.tick": 0, "launchers.tick": 0, "health.tick": 0}

    async with websockets.connect(ws_url, open_timeout=5) as ws:
        print("WS connected.")

        # Reader task — drains frames into the `seen` counter.
        stop = asyncio.Event()
        last_progress = {"current": 0, "total": 0, "label": ""}
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
                    if t == "smoke.progress":
                        d = j.get("data") or {}
                        last_progress.update({"current": d.get("current", 0),
                                              "total": d.get("total", 0),
                                              "label": d.get("label", "")})

        reader_task = asyncio.create_task(reader())

        # Trigger smoke (long-running). The WS reader runs in parallel.
        print("\n→ POST /system/smoke (expect smoke.* events to stream while it runs)")
        loop = asyncio.get_event_loop()
        smoke_status, smoke_body = await loop.run_in_executor(None, http_post, "/system/smoke")
        print(f"   /system/smoke returned {smoke_status} ({len(smoke_body)} bytes)")
        # Give the bus a moment to deliver trailing frames
        await asyncio.sleep(0.3)

        # Trigger cache prune
        print("\n→ POST /cache/prune (expect cache.prune.* events)")
        prune_status, prune_body = await loop.run_in_executor(None, http_post, "/cache/prune")
        print(f"   /cache/prune returned {prune_status} ({len(prune_body)} bytes)")
        await asyncio.sleep(0.3)

        # Wait up to 12s for at least one stats.tick (cadence 10s)
        print("\n→ Waiting up to 12s for stats.tick (cadence 10s) ...")
        deadline = time.monotonic() + 12.0
        while time.monotonic() < deadline:
            if seen["stats.tick"] >= 1:
                break
            await asyncio.sleep(0.5)

        stop.set()
        await asyncio.sleep(0.6)
        reader_task.cancel()

    print("\n--- Event counts ---")
    for k in sorted(seen):
        flag = "OK " if seen[k] > 0 else "   "
        print(f"  {flag} {k}: {seen[k]}")
    print(f"\nLast smoke.progress: current={last_progress['current']}/{last_progress['total']} label={last_progress['label']!r}")

    expected = ["smoke.started", "smoke.line", "smoke.progress", "smoke.complete",
                "cache.prune.started", "cache.prune.complete", "stats.tick"]
    missing = [k for k in expected if seen[k] == 0]
    if missing:
        print(f"\nFAIL — missing: {missing}")
        return 1
    print("\nPASS — every expected topic delivered at least once.")
    return 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
