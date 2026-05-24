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

## 4 · Archive browser bot bridge

The Archive browser in `app.html` reads its data from `data/archive-snapshots.json`. The bot is the only process that knows what's in each Discord archive thread — so the bot writes a snapshot of every archive, and the GUI reads that snapshot via the existing `GET /data/archive-snapshots.json` endpoint.

### Add this to `index.js`

Drop the following near your other persistence helpers (anywhere after the Discord client is ready):

```javascript
// ===== Archive bot bridge =====
// Writes data/archive-snapshots.json every 5 minutes so the GUI can render
// the archive browser without needing Discord API access from the browser.

import fs from 'node:fs/promises';
import path from 'node:path';
const ARCHIVE_SNAPSHOT_PATH = path.join(process.cwd(), 'data', 'archive-snapshots.json');

async function seekdeepWriteArchiveSnapshot() {
  try {
    const snapshots = { generated_at: new Date().toISOString(), guilds: [] };

    for (const [guildId, guild] of client.guilds.cache) {
      // archive-guild-config.json holds { [guildId]: { archive_channel_id, threads: {...} } }
      const cfg = seekdeepArchiveConfig?.[guildId];
      if (!cfg) continue;

      const archiveChannel = guild.channels.cache.get(cfg.archive_channel_id);
      if (!archiveChannel) continue;

      const guildEntry = { guild_id: guildId, guild_name: guild.name, threads: [] };

      // Fetch the active threads in the archive channel
      const threads = await archiveChannel.threads.fetchActive().catch(() => ({ threads: new Map() }));
      for (const [, thread] of threads.threads) {
        // Pull the last 10 entries per thread for the browser preview
        const messages = await thread.messages.fetch({ limit: 10 }).catch(() => new Map());
        const entries = [];
        for (const [, msg] of messages) {
          const att = msg.attachments?.first();
          if (!att) continue;
          entries.push({
            id: msg.id,
            url: att.url,           // direct CDN link
            thumb: att.proxyURL,    // smaller preview
            prompt: (msg.content || '').slice(0, 240),
            author_id: msg.author.id,
            author_name: msg.author.username,
            timestamp: msg.createdTimestamp,
            size: att.size,
            width: att.width,
            height: att.height,
          });
        }

        guildEntry.threads.push({
          thread_id: thread.id,
          name: thread.name,
          owner: thread.ownerId || null,
          archive_key: cfg.threads?.[thread.id]?.profile_user || null,
          count: cfg.threads?.[thread.id]?.count ?? entries.length,
          entries,
        });
      }
      snapshots.guilds.push(guildEntry);
    }

    await fs.mkdir(path.dirname(ARCHIVE_SNAPSHOT_PATH), { recursive: true });
    await fs.writeFile(ARCHIVE_SNAPSHOT_PATH, JSON.stringify(snapshots, null, 2));
    if (process.env.SEEKDEEP_ARCHIVE_SNAPSHOT_LOG === 'on') {
      console.log(`[SeekDeep] archive snapshot written  ${snapshots.guilds.length} guilds  ${ARCHIVE_SNAPSHOT_PATH}`);
    }
  } catch (err) {
    console.error('[SeekDeep] archive snapshot failed:', err.message);
  }
}

// Run once at boot, then every 5 minutes.
client.once('ready', () => {
  setTimeout(seekdeepWriteArchiveSnapshot, 5_000);   // first run after 5s
  setInterval(seekdeepWriteArchiveSnapshot, 5 * 60 * 1000);
});
```

### How the GUI consumes it

When the user clicks the Archive pane in the Control Center, the GUI hits `GET /data/archive-snapshots.json` (already wired via `gui_endpoints.py`) and renders the grid + per-thread tabs from the JSON. No browser-side Discord token, no auth gymnastics — same trust boundary as everything else in `data/`.

### Adjustments you might want

- **Snapshot cadence** — change the `5 * 60 * 1000` interval. 5 min is a balance between freshness and Discord API rate limits.
- **Entries per thread** — `messages.fetch({ limit: 10 })` is plenty for previews. Bump for richer browsing.
- **Privacy** — set `SEEKDEEP_ARCHIVE_SNAPSHOT_LOG=off` (default) so the snapshot path doesn't appear in console output.
- **Naming the function** — adjust `seekdeepArchiveConfig` to whatever variable holds your loaded `archive-guild-config.json` in memory.

### Hot-disable

To shut the bridge off without code changes, gate the `setInterval` behind an env flag:

```javascript
if (process.env.SEEKDEEP_ARCHIVE_BRIDGE !== 'off') {
  setInterval(seekdeepWriteArchiveSnapshot, 5 * 60 * 1000);
}
```

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
