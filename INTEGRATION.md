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

### Security — token auth is on by default

The three write endpoints (`POST /config`, `POST /launcher/*`, `POST /model/warm`) require the `X-SeekDeep-Token` header. Read endpoints (`/health`, `/gpu`, `/data/*`, `/logs/*`, `/config/status`) stay open so the GUI can render without the token.

**Bootstrap:**

- On first server boot, `gui_endpoints.py` checks `.env` for `SEEKDEEP_GUI_TOKEN`. If absent, it generates a 32-byte url-safe token and appends it to `.env`. You'll see `[SeekDeep] generated new SEEKDEEP_GUI_TOKEN; persisted to <path>` in the startup log.
- The GUI's `gui/nav.js` monkey-patches `window.fetch` so every same-origin POST automatically carries the header. Designer-shipped HTMLs (`app.html`, `chat.html` etc.) don't need to know about auth — they just call `fetch()` and the header appears.
- `nav.js` fetches the token via `GET /token`, which only answers loopback callers (anyone proxying port 7865 from outside the box gets 403 on `/token` even if they can read everything else).

**Operations:**

| Action | How |
|---|---|
| Rotate the token | Edit `SEEKDEEP_GUI_TOKEN` in `.env`. The server re-reads on every request, so no restart needed; tell browsers to Ctrl+F5 |
| Disable for trusted local dev | Set `SEEKDEEP_GUI_TOKEN_DISABLED=1` in `.env` and restart. `[SeekDeep] auth DISABLED` will appear in the boot log |
| Call from `curl` | `curl -H "X-SeekDeep-Token: $(grep ^SEEKDEEP_GUI_TOKEN= .env \| cut -d= -f2-)" -X POST http://127.0.0.1:7865/config -d ...` |
| Recover from a wiped `.env` token | Restart the server — it'll regenerate |

**Still bind to `127.0.0.1`.** The token narrows the threat model but doesn't replace network isolation. If you expose port 7865 through ngrok / cloudflared / a port-forward, the token leaks via the tunnel like any response body.

## 3.5 · WebSocket event bridge (`/events`)

For live updates the GUI doesn't poll any more — it subscribes to a single push stream and the server emits events as they happen.

### Endpoints (in `gui_endpoints.py`)

| Method | Path | Auth | Purpose |
|---|---|---|---|
| `GET (WS)` | `/events?token=<token>` | yes (query param) | WebSocket subscriber connection |
| `POST` | `/events/emit` | yes (`X-SeekDeep-Token`) | Server-side producers (e.g. the Node bot) push events here and the bus broadcasts |
| `GET` | `/events/status` | open | Cheap probe: `{ok, subscribers, server_time_ms}` |

Why query-string auth on the WS? Browsers cannot set headers on the initial WebSocket handshake. The token is the same value used elsewhere; the WS upgrades over the same `127.0.0.1` connection, so the wire-level confidentiality is identical.

A 10s **heartbeat** event auto-emits while at least one subscriber is connected — it's a built-in canary so you can verify the bus is alive even before real producers are wired.

### Event shape

```jsonc
// every event has the same envelope
{
  "type": "model.loaded",                      // topic
  "ts":   1779668616368,                       // server ms; auto-stamped if producer omits
  "data": { "role": "image", "vram_mb": 6800 } // arbitrary, topic-defined
}
```

Topics defined so far (`gui_endpoints.py` and `gui/events.js` agree on these — the set is open, any new `type` works automatically):

- `hello` — sent once to each new subscriber on connect
- `heartbeat` — every 10s while at least one subscriber connected
- `model.loaded` / `model.evicted` — VRAM lifecycle
- `vram.sample` — periodic VRAM telemetry
- `queue.depth` — per-pipeline queue counts
- `request.start` / `request.done` — per-request lifecycle
- `log.line` — structured log lines for the Logs viewer

### Producer patterns

**From an async FastAPI handler:**
```python
from gui_endpoints import event_bus
await event_bus.publish({"type": "model.loaded", "data": {"role": "image", "vram_mb": 6800}})
```

**From the Node bot (or anything not in this Python process):**
```javascript
await fetch('http://127.0.0.1:7865/events/emit', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'X-SeekDeep-Token': process.env.SEEKDEEP_GUI_TOKEN },
  body: JSON.stringify({ type: 'queue.depth', data: { image: 1, chat: 0, vision: 0 } }),
});
```

### Consumer pattern (in `gui/events.js`)

Already auto-loaded on every page that includes `nav.js`. Pages can subscribe with:

```javascript
const off = window.SeekDeepEvents.on('vram.sample', (data) => {
  document.querySelector('#vram-used').textContent = data.used_mb + ' MB';
});
// Later, to unsubscribe: off();
```

Connection lifecycle is handled for you: fetches the token from `window.SeekDeepAuth`, opens the WS, reconnects with exponential backoff (1s → 30s cap) on disconnect, resets backoff on reconnect. Special pseudo-topics `_open` / `_close` / `_error` let you reflect connection state in the title bar.

### Smoke test

```bash
# In one shell, start the server (see ยง6 for the launcher script).
# In another:
TOKEN=$(grep ^SEEKDEEP_GUI_TOKEN= .env | cut -d= -f2-)
curl -X POST http://127.0.0.1:7865/events/emit \
     -H "X-SeekDeep-Token: $TOKEN" \
     -H "Content-Type: application/json" \
     -d '{"type":"model.loaded","data":{"role":"image","vram_mb":6800}}'
# Returns: {"ok":true,"type":"model.loaded","subscribers":N,"delivered":N}
```

If `delivered` matches `subscribers`, every connected browser tab received the event.

## 3.6 · Version single source of truth (`/health.version` + `data-version`)

`GET /health` returns a `version` field sourced from `package.json` so the Node bot, the FastAPI side-car, and every GUI page agree on what version is running.

`gui/version.js` (auto-loaded by `nav.js`) fetches `/health` on load and rewrites every `[data-version]` element's text with the real value. The literal text inside each element is the static fallback shown when `/health` is unreachable (e.g. opening the file directly via `file://`).

Designer adoption (one attribute, no other changes):

```html
<!-- BEFORE -->
<span class="pill">v10.35</span>

<!-- AFTER -->
<span class="pill" data-version>v10.35</span>
```

Optional `data-version-prefix="v"` forces a prefix; `data-version-raw` suppresses the auto `v` prefix.

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
