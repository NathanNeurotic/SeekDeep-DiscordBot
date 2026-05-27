"""SeekDeep emergency recovery — fixes token-mismatch deadlocks WITHOUT rebuilding the installer.

Symptom this fixes:
  • GUI 'Restart bot' button → 401
  • GUI 'SELF-UPDATE' button → 401
  • GUI any fix-action button → 401
  • Toast says: 'missing or invalid X-SeekDeep-Token; GUI fetches the token from GET /token'

Root cause:
  The GUI's bundled nav.js cached an OLD token from a previous /token call.
  The .env (and therefore the server's expected token) has since rotated —
  often because we restarted the AI server during one of those windows
  when it regenerated the token. The bundled nav.js predates the 401
  auto-retry in current source, so the GUI can't recover client-side.

How this script recovers:
  1. Reads the CURRENT SEEKDEEP_GUI_TOKEN from .env on disk.
  2. POSTs /system/self-update with that current token (which the server
     WILL accept, because we just read it from the same .env the server
     reads). This pulls the latest gui/*, scripts/* etc from GitHub main
     into the bundled install location.
  3. Tells you to restart sidecar from the tray + hard-refresh the GUI
     page. After that the new nav.js (with 401 auto-retry + the latest
     token interceptor) takes over and the deadlock is broken.

Usage:
  python scripts\\recover.py
  (or:  .venv\\Scripts\\python.exe scripts\\recover.py)

If you can't even start the AI server, see the manual fallback at the
bottom of the script output.
"""
import json
import sys
import urllib.error
import urllib.request
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
ENV_PATH  = REPO_ROOT / ".env"
BASE      = "http://127.0.0.1:7865"


def read_token() -> str:
    if not ENV_PATH.is_file():
        print(f"ERROR: .env not found at {ENV_PATH}")
        print("Are you running from the repo root?")
        sys.exit(2)
    for line in ENV_PATH.read_text(encoding="utf-8", errors="replace").splitlines():
        if line.startswith("SEEKDEEP_GUI_TOKEN="):
            val = line.split("=", 1)[1].strip().strip('"').strip("'")
            if val:
                return val
            print("ERROR: SEEKDEEP_GUI_TOKEN line is present in .env but empty.")
            print("       Restart the AI server from the tray — it will regenerate the token.")
            sys.exit(2)
    print("ERROR: SEEKDEEP_GUI_TOKEN not found in .env.")
    print("       Either .env was never seeded, or the token line was deleted.")
    print("       Add a line `SEEKDEEP_GUI_TOKEN=` (empty value) and restart the AI server.")
    sys.exit(2)


def call(path: str, token: str, body: dict | None = None, method: str = "POST", timeout: int = 120):
    data = json.dumps(body or {}).encode("utf-8")
    req = urllib.request.Request(
        f"{BASE}{path}",
        data=data if method != "GET" else None,
        method=method,
        headers={
            "Content-Type":      "application/json",
            "X-SeekDeep-Token":  token,
            "Origin":            "http://tauri.localhost",
            "Sec-Fetch-Site":    "same-origin",  # defeat the cross-site check we added on /token
            "User-Agent":        "SeekDeep-Recovery/1.0",
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.status, json.loads(r.read().decode("utf-8", errors="replace"))
    except urllib.error.HTTPError as e:
        try:
            return e.code, json.loads(e.read().decode("utf-8", errors="replace"))
        except Exception:
            return e.code, {"error": f"HTTP {e.code}"}
    except Exception as e:
        return 0, {"error": str(e)}


def main() -> int:
    print("=" * 72)
    print("SeekDeep emergency recovery")
    print("Pulls latest GUI / scripts from GitHub main → bundled install location.")
    print("=" * 72)
    print()

    token = read_token()
    print(f"Token from {ENV_PATH}: {token[:8]}... (length {len(token)})")
    print(f"Target: {BASE}/system/self-update (ref=main)")
    print("Downloading + applying updates (30-90s)...")
    print()

    status, payload = call("/system/self-update", token, body={"ref": "main"})

    if status == 200 and payload.get("ok"):
        downloaded = payload.get("downloaded", []) or []
        errors     = payload.get("errors", []) or []
        print(f"  SUCCESS: applied {len(downloaded)} files.")
        if downloaded[:5]:
            print("  First 5 files updated:")
            for d in downloaded[:5]:
                if isinstance(d, dict):
                    print(f"    {d.get('path', '?'):40} {d.get('bytes', '?')} bytes")
        if errors:
            print(f"  Warnings ({len(errors)}):")
            for e in errors[:10]:
                print(f"    - {e}")
        print()
        print("NEXT STEPS:")
        print("  1. Right-click the SeekDeep tray icon → 'Restart sidecar'")
        print("     (loads the new AI server code)")
        print("  2. Hard-refresh the GUI page (Ctrl+F5)")
        print("     (loads the new nav.js with 401 auto-retry)")
        print("  3. Click 'Restart bot' in the Launcher — should work now.")
        return 0

    print(f"  RECOVERY VIA SELF-UPDATE FAILED: HTTP {status}")
    if isinstance(payload, dict):
        print(f"  Response: {json.dumps(payload)[:400]}")
    print()
    print("MANUAL FALLBACK (always works):")
    print(f"  1. Open {ENV_PATH} in any text editor (Notepad is fine).")
    print("  2. Find the line starting with `SEEKDEEP_GUI_TOKEN=`")
    print("  3. Delete EVERYTHING after the equals sign, so the line reads exactly:")
    print("        SEEKDEEP_GUI_TOKEN=")
    print("  4. Save the file.")
    print("  5. Right-click SeekDeep tray icon → 'Restart sidecar'")
    print("     (server detects empty token, generates a fresh one, writes to .env)")
    print("  6. Hard-refresh the GUI page (Ctrl+F5)")
    print("     (nav.js fetches the fresh token from /token, caches it)")
    print("  7. All buttons should work now.")
    print()
    if status == 0:
        print("  (HTTP status 0 means the AI server itself isn't reachable.")
        print("   Right-click the tray icon and confirm the sidecar is running.)")
    return 1


if __name__ == "__main__":
    sys.exit(main())
