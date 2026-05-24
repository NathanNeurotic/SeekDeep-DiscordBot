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

The Archive pane in `app.html` reads `data/archive-snapshots.json`. The bot is the only process with Discord API access, so the bot writes that snapshot periodically and the GUI reads it via the existing `GET /data/archive-snapshots.json` endpoint — no browser-side Discord token, no auth gymnastics.

> The earlier draft of this section assumed conventions that don't match SeekDeep's `index.js` (it used `fs/promises`, `client.once('ready')`, and an in-memory `seekdeepArchiveConfig` variable). The block below is a drop-in that matches the file as it actually exists.

### 4.1 · Step-by-step walkthrough (hand this to anyone setting up the bridge)

1. **Open** [`index.js`](index.js) in your editor.
2. **Find the existing block** that starts with `// SEEKDEEP_ARCHIVE_CHANNEL_CONFIG_START` (around line 4978). This is where the bot's archive helpers already live.
3. **Scroll down** to the matching `// SEEKDEEP_ARCHIVE_CHANNEL_CONFIG_END` line.
4. **Paste the snippet below immediately after** that end marker. It uses the same conventions as the surrounding code (`fs` sync API, `writeJsonAtomic`, `seekdeepReadArchiveGuildConfig`, `client.once('clientReady', ...)`).
5. **Save the file.**
6. **(Optional) Toggle in `.env`:**
   - `SEEKDEEP_ARCHIVE_BRIDGE=off` — disable the bridge entirely (default: on)
   - `SEEKDEEP_ARCHIVE_BRIDGE_MINUTES=5` — cadence in minutes (default: 5, min 1)
   - `SEEKDEEP_ARCHIVE_BRIDGE_ENTRIES=10` — entries fetched per thread (default: 10, max 100)
   - `SEEKDEEP_ARCHIVE_BRIDGE_LOG=on` — log each snapshot write to console
7. **Restart the bot** (`seekdeep_launcher.bat` option 8, or whichever path you normally use).
8. **Verify**:
   - After ~10 seconds you should see `data/archive-snapshots.json` appear (with `SEEKDEEP_ARCHIVE_BRIDGE_LOG=on`, a console line confirms it).
   - Open `http://127.0.0.1:7865/gui/app.html`, click the **Archive** pane in the sidebar. You should see one tab per archive thread + a `SHARED · N` aggregate tab.

### 4.2 · The snippet

```javascript
// SEEKDEEP_ARCHIVE_BRIDGE_START
// Writes data/archive-snapshots.json every few minutes so the GUI's
// Control Center > Archive pane can render real thread contents.
//
// Uses the same conventions as the surrounding code: sync `fs`,
// `writeJsonAtomic`, `seekdeepReadArchiveGuildConfig`, `client.once('clientReady', ...)`.

const SEEKDEEP_ARCHIVE_SNAPSHOT_PATH = path.join(__dirname, 'data', 'archive-snapshots.json');

async function seekdeepWriteArchiveSnapshot() {
  if (String(process.env.SEEKDEEP_ARCHIVE_BRIDGE || '').toLowerCase() === 'off') return;
  try {
    const entriesPerThread = Math.max(1, Math.min(100,
      Number(process.env.SEEKDEEP_ARCHIVE_BRIDGE_ENTRIES) || 10));
    const config = seekdeepReadArchiveGuildConfig();
    const snapshot = { generated_at: new Date().toISOString(), guilds: [] };

    for (const [guildId, guildCfg] of Object.entries(config.guilds || {})) {
      const guild = client.guilds.cache.get(guildId);
      if (!guild) continue;
      const guildEntry = { guild_id: guildId, guild_name: guild.name, threads: [] };

      // Pull thread IDs straight from the bot's own state instead of enumerating
      // active threads in the archive channel (cheaper, and includes auto-archived
      // threads Discord won't return from fetchActive()).
      const knownThreads = [];
      const sharedId = guildCfg.sharedArchive?.threadId;
      if (sharedId) knownThreads.push({
        thread_id: sharedId,
        archive_key: 'shared',
        count: Number(guildCfg.sharedArchive?.count) || 0,
      });
      for (const [userId, ua] of Object.entries(guildCfg.userArchives || {})) {
        if (ua?.threadId) knownThreads.push({
          thread_id: ua.threadId,
          archive_key: userId,
          count: Number(ua.count) || 0,
        });
      }

      for (const meta of knownThreads) {
        let thread;
        try { thread = await guild.channels.fetch(meta.thread_id); }
        catch { continue; }
        if (!thread) continue;

        const entries = [];
        try {
          const messages = await thread.messages.fetch({ limit: entriesPerThread });
          for (const [, msg] of messages) {
            const att = msg.attachments?.first();
            if (!att) continue;
            entries.push({
              id: msg.id,
              url: att.url,
              thumb: att.proxyURL || att.url,
              prompt: (msg.content || '').slice(0, 240),
              author_id: msg.author?.id || null,
              author_name: msg.author?.username || null,
              timestamp: msg.createdTimestamp,
              size: att.size,
              width: att.width,
              height: att.height,
            });
          }
        } catch {
          // continue with whatever we got
        }

        guildEntry.threads.push({
          thread_id: meta.thread_id,
          name: thread.name,
          owner: thread.ownerId || null,
          archive_key: meta.archive_key,
          count: meta.count,
          entries,
        });
      }
      snapshot.guilds.push(guildEntry);
    }

    writeJsonAtomic(SEEKDEEP_ARCHIVE_SNAPSHOT_PATH, snapshot);
    if (String(process.env.SEEKDEEP_ARCHIVE_BRIDGE_LOG || '').toLowerCase() === 'on') {
      console.log(`[SeekDeep] archive snapshot written  ${snapshot.guilds.length} guilds  ${SEEKDEEP_ARCHIVE_SNAPSHOT_PATH}`);
    }
  } catch (err) {
    console.warn('[SeekDeep] archive snapshot failed:', err?.message || err);
  }
}

client.once('clientReady', () => {
  if (String(process.env.SEEKDEEP_ARCHIVE_BRIDGE || '').toLowerCase() === 'off') return;
  const minutes = Math.max(1, Number(process.env.SEEKDEEP_ARCHIVE_BRIDGE_MINUTES) || 5);
  setTimeout(seekdeepWriteArchiveSnapshot, 10_000);                // first run after 10s
  setInterval(seekdeepWriteArchiveSnapshot, minutes * 60 * 1000);  // then every N minutes
});
// SEEKDEEP_ARCHIVE_BRIDGE_END
```

### 4.3 · How the GUI consumes it

The Archive pane's wiring (in `gui/app.html`) calls `GET /data/archive-snapshots.json`. The `/data/{file}` endpoint in `gui_endpoints.py` reads the file from `data/` and returns it as `{ ok, file, data }`. No per-route normalization is applied to `archive-snapshots.json` — the bridge's output shape is what the GUI expects natively.

### 4.4 · Removing the bridge

Either:
- Delete the block between `SEEKDEEP_ARCHIVE_BRIDGE_START` and `SEEKDEEP_ARCHIVE_BRIDGE_END` markers in `index.js`, OR
- Set `SEEKDEEP_ARCHIVE_BRIDGE=off` in `.env` and restart the bot (the snippet stays in place but no longer runs).

Stop the snapshot file from accumulating: `data/archive-snapshots.json` can be safely deleted; the GUI will show the empty state until the next snapshot.

## 5 · How the GUI auto-detects the deployment

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

## 6 · Install script

Run the one-shot installer from the repo root:

```powershell
.\gui\scripts\install_gui.ps1
```

It:
1. Verifies `gui/` is alongside `local_ai_server.py`
2. Patches `local_ai_server.py` if the static mount isn't already present
3. Prints the next steps (restart the server, open the URL)

## 7 · Per-surface verification

After mounting, sanity-check each URL:

| URL                                              | What you should see                                    |
|--------------------------------------------------|--------------------------------------------------------|
| `http://127.0.0.1:7865/gui/`                     | Hub                                                    |
| `http://127.0.0.1:7865/gui/app.html`             | Control Center · title-bar pill should read **LIVE**   |
| `http://127.0.0.1:7865/gui/chat.html`            | Chat client · bot card shows real model + VRAM         |
| `http://127.0.0.1:7865/gui/installer.html`       | Installer · step 2 should resolve all checks green     |
| `http://127.0.0.1:7865/gui/api.html`             | API explorer · `GET /health` returns real JSON         |

If any of them still show **MOCK** pills, hard-reload (Ctrl+F5) to bust the cached page.

## 8 · Removing or updating

The GUI is a single self-contained folder. To remove it: `rm -rf gui/` and delete the 9-line mount block from `local_ai_server.py`. To update it: drop a newer version on top — there's no migration, no database, no state.
