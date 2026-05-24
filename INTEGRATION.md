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

The Control Center, Installer, and API Explorer expect a handful of write endpoints. We've packaged all of them as a single drop-in module: **`gui_endpoints.py`** at the repo root.

### One-line installation

Add these three lines to `local_ai_server.py` (after `app = FastAPI(...)`):

```python
from gui_endpoints import register_gui_endpoints
register_gui_endpoints(app, log_dir="logs", data_dir="data", env_path=".env")
```

Restart the server. Done. All of the following are now live:

| Endpoint                              | What it powers                                                |
|---------------------------------------|---------------------------------------------------------------|
| `POST /config`                        | Bot Config pane Save button — atomic .env merge               |
| `GET /logs/tail?lines=N&file=...`     | Logs Viewer pane                                              |
| `GET /logs/stream`                    | Logs Viewer pane · SSE tail-f                                 |
| `POST /launcher/{svc}/{action}`       | Launcher Start / Stop / Restart                               |
| `GET /data/{file}.json`               | Stats / Auto-react rules / Archive config                     |
| `POST /model/warm`                    | Models pane "Warm" button (wire to your loader; stub by default) |

### Safety notes baked in

- **`.env` merge** is atomic — writes to `.env.tmp` then `.replace()`s. Existing comments + ordering preserved.
- **Log + data file reads** reject path traversal (`../`) and restrict to `.json` for `/data/`.
- **Launcher** has a service whitelist (`ai-server` · `bot` · `searxng`) and action whitelist (`start` · `stop` · `restart` · `status`).
- **`/model/warm`** ships as a stub — wire it to your existing model loader where commented.

### Security — please read

These endpoints accept HTTP input that can write files and spawn child processes. **Bind the server to `127.0.0.1` only.** Do not expose port 7865 publicly without an authenticating reverse proxy in front.

If you want stricter coupling: edit `gui_endpoints.py` to gate every endpoint behind a header check (`X-SeekDeep-Token`) read from `.env`.

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
