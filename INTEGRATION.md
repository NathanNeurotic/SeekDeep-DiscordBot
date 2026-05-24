# SeekDeep GUI · Integration

This folder contains the SeekDeep GUI surfaces — 16 HTML files + shared `styles.css` + `assets/`. They can be opened directly via `file://` (the live probes try `http://127.0.0.1:7865` and fall back to canned mocks), but **the recommended deployment is to serve them from `local_ai_server.py` at `/gui/`** so the same-origin live probes work without CORS hacks.

## TL;DR

Add **9 lines** to `local_ai_server.py`, drop this folder at the repo root as `gui/`, restart the server, open `http://127.0.0.1:7865/gui/`.

## 1 · Mount the GUI as static files

Add the following near the top of `local_ai_server.py`, after `app = FastAPI(...)`:

```python
# ===== SeekDeep GUI · static mount =====
from fastapi.staticfiles import StaticFiles
import os
_GUI_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "gui")
if os.path.isdir(_GUI_DIR):
    app.mount("/gui", StaticFiles(directory=_GUI_DIR, html=True), name="gui")
    print(f"[SeekDeep] GUI mounted at /gui  ->  {_GUI_DIR}")
```

`html=True` makes `/gui/` serve `index.html` automatically. Restart the server; you'll see the GUI at `http://127.0.0.1:7865/gui/`.

## 2 · CORS (only if you keep using `file://`)

If you want to keep opening the HTML files directly in a browser instead of through `/gui/`, add CORS middleware:

```python
from fastapi.middleware.cors import CORSMiddleware
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],          # dev only — restrict for production
    allow_methods=["GET", "POST"],
    allow_headers=["*"],
)
```

If you serve through `/gui/` (recommended), you don't need CORS at all.

## 3 · Write endpoints — what the Control Center wants

The Control Center, Installer, and API Explorer currently treat these as mocks. Add them to `local_ai_server.py` to close the loop:

### `POST /config` — save .env edits

```python
import os, json, re
from fastapi import Body
from pydantic import BaseModel

class ConfigPatch(BaseModel):
    updates: dict   # { "KEY": "value", ... }

@app.post("/config")
async def patch_env(patch: ConfigPatch):
    """Merge a partial dict of env-var updates into the on-disk .env file."""
    env_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), ".env")
    if not os.path.isfile(env_path):
        return {"ok": False, "error": ".env not found"}

    with open(env_path, "r", encoding="utf-8") as f:
        lines = f.readlines()

    seen = set()
    out = []
    for line in lines:
        m = re.match(r"^([A-Z_][A-Z0-9_]*)\s*=", line)
        if m and m.group(1) in patch.updates:
            key = m.group(1)
            out.append(f"{key}={patch.updates[key]}\n")
            seen.add(key)
        else:
            out.append(line)
    # Append new keys
    for k, v in patch.updates.items():
        if k not in seen:
            out.append(f"{k}={v}\n")

    with open(env_path, "w", encoding="utf-8") as f:
        f.writelines(out)
    return {"ok": True, "updated": list(patch.updates.keys())}
```

### `POST /model/warm` — preload a model

```python
class WarmRequest(BaseModel):
    role: str = "default_chat"   # default_chat | quality_text | reasoning_code | image | vision | ...

@app.post("/model/warm")
async def warm_model(req: WarmRequest):
    """Force-load the given role's model into VRAM. Intended for the Control Center 'Warm' button."""
    # plug into your existing role->model_id router + loader
    try:
        # e.g. load_chat_model(role=req.role) or load_image_pipeline() depending on role
        return {"ok": True, "role": req.role, "loaded": True}
    except Exception as e:
        return {"ok": False, "error": str(e)}
```

### `POST /model/evict` — explicit unload

`/unload` already exists. The GUI sends an empty POST; no body needed. Optionally accept `{"role": "..."}` to evict a specific role.

### `POST /launcher/restart` — re-spawn a service (advanced)

```python
import subprocess, shlex

class ServiceAction(BaseModel):
    service: str       # "ai-server" | "bot" | "searxng"
    action: str = "restart"   # "start" | "stop" | "restart"

@app.post("/launcher/{service}/{action}")
async def launcher_control(service: str, action: str):
    """Bridge to seekdeep_launcher.bat. Requires the bat process to be reachable from this server."""
    # SAFETY: only allow whitelisted services
    if service not in {"ai-server", "bot", "searxng"}:
        return {"ok": False, "error": "unknown service"}
    if action not in {"start", "stop", "restart"}:
        return {"ok": False, "error": "unknown action"}
    # Implementation depends on whether you run the launcher as a service,
    # a docker-compose stack, or a parent process. Sketch only.
    return {"ok": True, "service": service, "action": action, "todo": "wire to your process supervisor"}
```

> **Heads-up:** The launcher-control endpoint lets HTTP callers start/stop processes. **Bind the server to `127.0.0.1` only**, and don't expose this port through Cloudflare / ngrok / etc. without auth.

## 4 · How the GUI auto-detects the deployment

Every wired page (`app.html`, `chat.html`, `api.html`, `installer.html`) now uses a smart `SEEKDEEP_BASE`:

```javascript
const SEEKDEEP_BASE = (function() {
  if (typeof window === 'undefined') return 'http://127.0.0.1:7865';
  const sameOrigin = window.location.protocol === 'http:' || window.location.protocol === 'https:';
  if (sameOrigin && window.location.host) {
    return window.location.origin;
  }
  return 'http://127.0.0.1:7865';
})();
```

- **Served from FastAPI** (`http://127.0.0.1:7865/gui/app.html`) → uses same origin, no CORS
- **Opened from `file://`** → falls back to `http://127.0.0.1:7865` and requires CORS middleware
- **Future Tauri shell** → same origin, fully internal

## 5 · Install script

Run the one-shot installer from the repo root:

```powershell
.\gui\scripts\install_gui.ps1
```

It:
1. Verifies `gui/` is alongside `local_ai_server.py`
2. Patches `local_ai_server.py` if the static mount isn't already present
3. Prints the next steps (restart the server, open the URL)

## 6 · Per-surface verification

After mounting, sanity-check each URL:

| URL                                              | What you should see                                    |
|--------------------------------------------------|--------------------------------------------------------|
| `http://127.0.0.1:7865/gui/`                     | Hub                                                    |
| `http://127.0.0.1:7865/gui/app.html`             | Control Center · title-bar pill should read **LIVE**   |
| `http://127.0.0.1:7865/gui/chat.html`            | Chat client · bot card shows real model + VRAM         |
| `http://127.0.0.1:7865/gui/installer.html`       | Installer · step 2 should resolve all checks green     |
| `http://127.0.0.1:7865/gui/api.html`             | API explorer · `GET /health` returns real JSON         |

If any of them still show **MOCK** pills, hard-reload (Ctrl+F5) to bust the cached page.

## 7 · Removing or updating

The GUI is a single self-contained folder. To remove it: `rm -rf gui/` and delete the 9-line mount block from `local_ai_server.py`. To update it: drop a newer version on top — there's no migration, no database, no state.
