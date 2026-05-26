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
| `POST /model/warm`                    | Models pane "Warm" button — wired to `local_ai_server.py`'s real loaders (`warm_chat_role` / `load_image_pipe` / `load_vision_model`); stub-only if `register_gui_endpoints` is called without `warmup_handlers=`. |

### Safety notes baked in

- **`.env` merge** is atomic — writes to `.env.tmp` then `.replace()`s. Existing comments + ordering preserved.
- **Log + data file reads** reject path traversal (`../`) and restrict to `.json` for `/data/`.
- **Launcher** has a service whitelist (`ai-server` · `bot` · `searxng`) and action whitelist (`start` · `stop` · `restart` · `status`).
- **`/model/warm`** ships wired to the real chat/image/vision loaders in `local_ai_server.py` (passed via `warmup_handlers=`). If you import `register_gui_endpoints` without that kwarg (e.g. standalone test mode), the endpoint returns `{ok:true, stub:true, note:"no warmup handlers wired"}` instead of loading.

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

## 3.4 · Chat backends: HuggingFace transformers or Ollama (per-role)

`POST /chat` dispatches each role to one of two backends, decided at request time from env:

- **`hf`** (default) — in-process via `transformers` + `bitsandbytes`. Counts against the SDXL / vision VRAM budget. Per-role pinning, eviction, fallback all apply.
- **`ollama`** — out-of-process via the Ollama daemon (default `http://127.0.0.1:11434`). Separate VRAM allocation managed by Ollama; **does not** count against this server's `vram_can_fit` budget.
- **`openai-compat`** — remote `/v1/chat/completions` endpoint. **Sends prompts off the box.** Covers OpenAI, DeepSeek, Groq, **xAI / Grok**, OpenRouter, Together, Mistral La Plateforme, Perplexity, plus any local proxy in openai-mode (LM Studio, vLLM, tgwui). Per-role API URL + key.
- **`anthropic`** — Anthropic's native `/v1/messages` endpoint. **Sends prompts off the box.** Distinct from openai-compat because of different auth header (`x-api-key`) and message shape (system at top level). Claude models only.
- **`gemini`** — Google's native `/v1beta/models/{model}:generateContent`. **Sends prompts off the box.** Different again: `x-goog-api-key` auth, model name in URL, `user`/`model` role names. Gemini models only.

### Resolution

```
LOCAL_CHAT_BACKEND=hf                              # global default, applies to default_chat + anything not overridden
LOCAL_CHAT_FALLBACK_BACKEND=ollama                 # per-role overrides
LOCAL_CHAT_QUALITY_BACKEND=openai-compat           # mix-and-match across all three backends
LOCAL_CHAT_REASONING_BACKEND=ollama
LOCAL_CHAT_LIGHTWEIGHT_BACKEND=ollama
LOCAL_CHAT_REFINE_BACKEND=ollama
```

Anything other than `hf` / `ollama` / `openai-compat` / `anthropic` / `gemini` is normalized to `hf`. Resolution order per role: per-role env → global `LOCAL_CHAT_BACKEND` → `hf`.

For `openai-compat`, the role's endpoint resolves the same way (per-role `LOCAL_CHAT_<ROLE>_API_URL` + `_API_KEY` → global `OPENAI_API_BASE_URL` + `OPENAI_API_KEY`). This lets different roles target different providers (e.g. cheap Groq for `default_chat`, premium OpenAI for `quality_text`).

### Model ID semantics

The role's existing `LOCAL_CHAT_<...>_MODEL_ID` env value changes meaning based on the resolved backend:

| Backend | Model ID env value example |
|---|---|
| `hf` | `meta-llama/Llama-3.1-8B-Instruct` (HuggingFace repo ID) |
| `ollama` | `llama3:8b` (Ollama tag, with optional `:version`) |
| `openai-compat` | `deepseek-chat` / `gpt-4o-mini` / `grok-2-latest` / `mistral-small-latest` / `anthropic/claude-3.5-sonnet` (via OpenRouter) — whatever the remote provider names it |
| `anthropic` | `claude-3-5-sonnet-20241022` / `claude-3-5-haiku-20241022` / `claude-3-opus-20240229` (Anthropic native names) |
| `gemini` | `gemini-2.0-flash` / `gemini-1.5-pro` / `gemini-2.5-pro-exp-03-25` (Google Gemini model names) |

### Auto-pull

`POST /model/warm` with an Ollama-backed role checks `GET /api/tags` and pulls via `POST /api/pull` if the tag isn't present. The pull is synchronous (governed by `OLLAMA_PULL_TIMEOUT_SECS`, default 30 min). Already-present tags are no-op.

### `POST /model/install` (auth required) — one-shot install + role assign

Backend endpoint for "Add a Model" wizard workflows. Combines an install (HF `snapshot_download` or Ollama `/api/pull`) with an optional `.env` patch that assigns the new model to a chat role.

```jsonc
// Install an Ollama model and assign it to quality_text
POST /model/install
{
  "backend": "ollama",
  "model_id": "mistral-nemo:12b",
  "role": "quality_text",
  "auto_pull": true
}

// Install an HF model and assign it to default_chat (rewrites .env atomically)
POST /model/install
{
  "backend": "hf",
  "model_id": "meta-llama/Llama-3.1-8B-Instruct",
  "role": "default_chat",
  "revision": "main"
}
```

Response:

```jsonc
{
  "ok": true,
  "backend": "ollama",
  "model_id": "mistral-nemo:12b",
  "note": "pulled",
  "role": "quality_text",
  "env_patched": true,
  "env_keys_updated": ["LOCAL_CHAT_QUALITY_MODEL_ID", "LOCAL_CHAT_QUALITY_BACKEND"]
}
```

`role` is optional — omit to just install/pull without touching `.env`. The env patch is atomic via `_merge_env` (preserves existing comments + ordering). Restart the AI server for new chat role bindings to take effect, OR call `POST /model/warm` to load the new model immediately.

### `/health` reporting

```jsonc
{
  "chat_backends": { "default_chat": "hf", "quality_text": "openai-compat", "lightweight_chat": "ollama", ... },
  "remote_chat_endpoints": {
    "quality_text": {
      "endpoint": "https://api.deepseek.com/v1",
      "external": true,
      "warning": "prompts for this role leave the local machine"
    }
  },
  "ollama": {
    "available": true,
    "base_url": "http://127.0.0.1:11434",
    "installed_tags": ["llama3:8b", "phi4:latest", "mistral-nemo:12b"]
  }
}
```

The GUI's Models pane can use `chat_backends` to render an "HF" / "Ollama" / "Remote ⚠" badge per role, and `remote_chat_endpoints` to show which provider each external role is calling. API keys are NEVER returned in `/health` — only the public endpoint URL.

### Privacy posture for `openai-compat`

Every role configured with `openai-compat` sends its prompts and conversation context OUTSIDE the local machine. The remote provider may log, retain, or train on those prompts per their own terms — **SeekDeep does not, and cannot, control this.** Use this backend per role only for content you're comfortable sharing with the named provider.

Local backends (`hf`, `ollama`) keep everything on `127.0.0.1`.

### Operations

| Action | How |
|---|---|
| Switch a single role to Ollama | Set `LOCAL_CHAT_QUALITY_BACKEND=ollama` and `LOCAL_CHAT_QUALITY_MODEL_ID=mistral-nemo:12b`. Restart the AI server. |
| Switch ALL roles to Ollama | Set `LOCAL_CHAT_BACKEND=ollama` and every `LOCAL_CHAT_<...>_MODEL_ID` to its Ollama tag. |
| Pre-pull a model | `curl -X POST http://127.0.0.1:7865/model/warm -H "X-SeekDeep-Token: $TOK" -d '{"role":"quality_text"}'` — pulls if missing |
| Force-revert a role to HF | Set `LOCAL_CHAT_<ROLE>_BACKEND=hf` (overrides global Ollama) |
| Daemon offline | `/health.ollama.available=false`. Chat requests to Ollama roles will fail; bot's `MODEL_AUTO_FALLBACK` path then tries `fallback_chat` (which can be either backend). |

### When to pick each backend per role

- **default_chat (heavy, every conversation)** — usually HF with 4-bit quant for max quality per VRAM byte. Ollama works too but uses different (often less tight) quantization.
- **quality_text (one-off serious answers)** — Ollama is great here: no VRAM displacement of the resident default_chat, and Ollama's swap is fast.
- **lightweight_chat (short replies)** — Ollama: tiny models like `phi3:mini` boot in <1s and don't fight the SDXL pipeline for VRAM.
- **`openai-compat` (any role)** — pick this when you want a frontier model that doesn't fit locally (Claude via OpenRouter, GPT-4, DeepSeek R1, Grok) and you're OK with prompts leaving the box. Common patterns: assign `reasoning_code` to OpenAI o1 via OpenRouter; `quality_text` to DeepSeek-Chat for cost; xAI's Grok via `https://api.x.ai/v1`; or point at a **local** LM Studio / vLLM / tgwui-openai-mode proxy to use the openai-compat backend without anything going off-network.
- **`anthropic` (any role)** — pick this when you want native Claude with direct billing through Anthropic (skip the OpenRouter middleman). Claude 3.5 Sonnet / Opus / Haiku. Sends prompts off-box.
- **`gemini` (any role)** — pick this when you want Google's Gemini family with native billing through Google AI Studio / Vertex. Gemini 2.0 Flash, 1.5 Pro, 2.5 Pro exp. Sends prompts off-box.
- **vision / image** — must stay HF. Ollama doesn't run SDXL or Qwen2.5-VL.

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

| Topic | Source | Wired? | Payload |
|---|---|---|---|
| `hello` | bus on connect | yes | `{server_time_ms, subscribers}` |
| `heartbeat` | bus, every 10s with subscribers | yes | `{server_time_ms, subscribers}` |
| `model.loaded` | `load_chat_model` / `load_vision_model` / `load_image_pipe` in `local_ai_server.py` | yes | `{role, model, task, vram_allocated_mb}` |
| `model.evicted` | `unload_all` in `local_ai_server.py` | yes | `{task, role, model, reason}` |
| `vram.sample` | startup task in `local_ai_server.py`, every 10s with subscribers | yes | `{used_mb, total_mb, free_mb, allocated_mb, reserved_mb, device, loaded_task, loaded_chat_role, loaded_chat_model_id}` |
| `vram.pressure` | `_emit_pressure_event` in `local_ai_server.py` -- fires when a chat-role swap would spill into shared memory | yes | `{state: 'resolved'\|'fallback'\|'spill', task, role, available_mb, estimated_mb, mode, evicted_pinned, evicted_pinned_names}` |
| `queue.depth` | ASGI middleware in `local_ai_server.py` — bumps on every `/chat`, `/image`, `/img2img`, `/inpaint`, `/instruct-pix2pix`, `/upscale`, `/chart`, `/vision` request entry/exit | yes | `{chat, image, vision}` |
| `request.start` | `seekdeepMarkRequestStart` in `index.js` — every messageCreate path that addresses the bot | yes | `{id, kind, user_id, channel_id, guild_id}` |
| `request.done` | `seekdeepReplyToTarget` try/finally in `index.js` | yes | `{id, kind, ok, elapsed_ms, model, error}` |
| `log.line` | `index.js` console monkey-patch — **opt-in** via `SEEKDEEP_EMIT_LOG_LINES=on` in `.env`; rate-limited to 10/sec and skipped when no GUI subscribers | opt-in | `{level, src, msg}` |

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

## 3.7 · Persona override over HTTP (`/persona`)

The bot's persona ("neurotic" / "unsettling" / "clinical" / "chaotic") is overridable per-channel and per-guild via the Discord command `@SeekDeep persona [scope] <name>`. Designer's chat-page persona pill + Tweaks panel need the same control without going through Discord, so `gui_endpoints.py` wraps the existing `data/persona-overrides.json` store over HTTP.

| Method | Path | Auth | Body | Returns |
|---|---|---|---|---|
| `GET` | `/persona` | open | — | `{ ok, valid_personas, env_default, global, effective_global, channels_count, guilds_count }` |
| `POST` | `/persona` | token | `{ scope, persona }` | `{ ok, scope, persona, set_at }` |
| `POST` | `/persona` | token | `{ scope, action: "reset" }` | `{ ok, scope, persona: null, action: "reset" }` |

**Scopes:** `global` (web-playground default — no Discord context needed), `channel` (requires `channel_id` in body), `server` / `guild` (requires `guild_id`).

**Validation:** `persona` must be one of `neurotic | unsettling | clinical | chaotic`. `reset` is a meta-action that clears the override, not a 5th persona value. Schema:

```json
{
  "channels": { "<channel_id>": { "persona": "clinical", "setBy": "...", "setAt": "..." } },
  "guilds":   { "<guild_id>":   { "persona": "chaotic",  "setBy": "...", "setAt": "..." } },
  "global":   { "persona": "neurotic", "setBy": "web-owner", "setAt": "..." }
}
```

**Effective persona resolution** (in `seekdeepGetEffectivePersona`, `index.js`): channel override → guild override → global override → env `SEEKDEEP_PERSONA` → `"neurotic"`. Discord per-channel commands still take priority over the web-playground global override.

## 3.8 · Source-of-truth stat counts (`/stats/counts`)

`pitch.html`, `changelog.html`, and the topnav stat tiles previously hardcoded `274 smoke tests / 35 releases / 109 commands / 18 surfaces`. Those numbers go stale the moment any of them changes. `GET /stats/counts` returns the live numbers so designer can mark each tile with `data-stat-<key>` and a tiny IIFE (or `version.js` extension) rewrites them on load.

| Method | Path | Auth | Returns |
|---|---|---|---|
| `GET` | `/stats/counts` | open | `{ ok, smoke_tests, gui_smoke_tests, releases, commands, surfaces, generated_at, sources }` |

**Sources** (best-effort, each degrades to `null` if its source file is missing):

| Field | Source |
|---|---|
| `smoke_tests` | count of `check(` calls in `smoke_test.mjs` |
| `gui_smoke_tests` | count of `check(` calls in `scripts/smoke_gui_endpoints.py` |
| `releases` | `git tag --list \| wc -l` |
| `commands` | count of table rows in `COMMANDS.md` (`^\| \`` regex) |
| `surfaces` | count of entries inside `PAGES = [ ... ]` in `gui/nav.js` |

**Designer adoption:** add `data-stat-<key>` to the relevant cells. Example wiring (Phase 4 designer task):

```html
<div class="num" data-stat-smoke_tests>274</div>
<div class="num" data-stat-releases>35</div>
<div class="num" data-stat-commands>109</div>
<div class="num" data-stat-surfaces>18</div>
```

…then a small consumer (in `version.js` or a new `stats.js`) fetches `/stats/counts` once on load and rewrites every `[data-stat-X]` element. Until that consumer is wired, the existing literals remain visible.

## 3.9 · First-use ML dependency downloader (`/ml_deps` + `/deps/install`)

The Tauri shell bundles our Python code + the boot deps list (`requirements-local.txt` — fastapi/uvicorn/pydantic/pillow/etc, ~30 MB installed) but NOT the heavy ML stack (torch/transformers/diffusers/accelerate, ~2 GB installed). Bundling 2 GB into every installer would be hostile; instead the GUI offers to install it on first use of `/image`, `/vision`, or local `/chat`.

### `GET /ml_deps` (open)

Lives on `local_ai_server.py`. Lightweight import probe — one `__import__` per module, no init — so it's safe to poll on every GUI page load.

| Field | Type | Meaning |
|---|---|---|
| `ok` | `true` | Always set when the endpoint responds. |
| `available` | `bool` | `true` iff every module in `checked` imports successfully. |
| `checked` | `[str]` | Canonical list: `torch / transformers / diffusers / accelerate / safetensors`. |
| `missing` | `[str]` | Subset of `checked` that failed to import. |
| `requirements_file` | `"requirements-ml.txt"` | The file `POST /deps/install` targets. |
| `install_endpoint` | `"POST /deps/install (token required)"` | Reminder for the GUI. |
| `manual_command` | `"python -m pip install --user -r requirements-ml.txt"` | Last-resort copy-paste for terminal users. |
| `note` | `str` | One-line explanation suitable for the install consent dialog. |

**Invariant:** `available === (missing.length === 0)`.

### `POST /deps/install` (token-required)

Lives on `gui_endpoints.py`. Spawns `python -m pip install --user --upgrade -r <requirements_file>` in a daemon thread. Returns immediately so the GUI can swap to a progress modal without blocking.

| Field | Default | Validation |
|---|---|---|
| `requirements_file` | `"requirements-ml.txt"` | Must be one of `{requirements-ml.txt, requirements-local.txt}` — anything else returns 400. Whitelist is hardcoded to prevent path-traversal. |

Response: `{ ok, started: true, requirements_file, note }`.

**Progress events** — subscribe on `/events`:

| Topic | Data |
|---|---|
| `deps.install.started` | `{ requirements_file }` |
| `deps.install.line` | `{ line }` — one pip output line at a time |
| `deps.install.complete` | `{ requirements_file }` |
| `deps.install.failed` | `{ requirements_file, exit_code?, error? }` |

**Reload requirement:** torch / diffusers / transformers cannot be hot-imported into an already-running Python process (they have native extension modules). After `deps.install.complete`, the user must restart the AI server before `/chat`, `/image`, `/vision` start working. The GUI surfaces this in the install modal.

### Consumer wired in `gui/ml-deps.js`

Auto-loaded by `nav.js`'s `autoLoadSiblings` alongside `events.js / version.js / playground.js / stats.js`. On page load:

1. Probes `GET /ml_deps`.
2. If `available: false`, injects a topnav banner naming the missing modules + offering "Install (~2 GB)" + a Dismiss button.
3. On install click, opens a progress modal subscribed to `deps.install.*` and posts to `/deps/install`. The modal shows live pip output and the post-install "restart server" hint.

Self-gated via `window.__seekdeepMlDepsLoaded` so multiple injections no-op. Pages that want to suppress the banner can set that flag before `nav.js` runs.

**Visual primitive:** as of commit `<refactor>`, both `ml-deps.js` and `model-install.js` render their banner + modal through the shared `window.SeekDeepNotify` API (designer zip 43, `gui/notify.js`). The banner stacks naturally below other notify banners; tone is `warn` for ML-deps-missing, `info` for model-weights-missing, `warn` for Ollama-daemon-down. Each file degrades gracefully when notify.js isn't loaded (console-warn + return).

**Tauri auto-restart hook:** when the install completes, `ml-deps.js` checks for `window.__TAURI__` and calls the `restart_sidecar` command. The Rust shell kills the Python child, waits ~500 ms for port 7865 to release, then re-runs `boot_sequence`. The page auto-reloads ~5 s later to pick up `/ml_deps available:true`. Plain-browser users (no Tauri) get the manual restart hint instead.

## 3.10 · First-use HF model download UI (`/models/installed` + `/model/install`)

The user has Python deps installed, the server boots, the playground opens — but `/image` will silently hang for 10 minutes the first time because the SDXL weights aren't on disk yet. `GET /models/installed` lets the GUI surface "this needs downloading" upfront with a Download button.

### `GET /models/installed` (open)

Lives on `local_ai_server.py`. No network probe, no model load — just an `huggingface_hub.scan_cache_dir()` walk and an Ollama tag query.

| Field | Type | Meaning |
|---|---|---|
| `ok` | `true` | Always set when the endpoint responds. |
| `ml_deps_missing` | `bool` | True if `huggingface_hub` itself isn't importable. The GUI short-circuits to `ml-deps.js` in that case. |
| `all_local_present` | `bool` | True iff every role with `local: true` has `present: true`. |
| `missing` | `[{ role, model_id, backend }]` | Roles that need a download. |
| `roles` | `{ <key>: { model_id, backend, local, present } }` | One entry per chat role + `image` + `vision`. |

`local` is true for `hf` + `ollama` backends; false for `openai-compat` / `anthropic` / `gemini` (hosted upstream — never "missing").

### `POST /model/install` (token-required, pre-existing)

Already documented in [INTEGRATION.md § 3.4](#34--chat-backends-huggingface-transformers-or-ollama-per-role). For the first-use UI we POST without `role` so the call is a pure download (no `.env` patch). Returns synchronously once `snapshot_download` finishes — for SDXL / 7B-class that's 5-15 minutes on a decent connection.

### Consumer wired in `gui/model-install.js`

Auto-loaded by `nav.js`'s `autoLoadSiblings` alongside `events / version / playground / stats / ml-deps`. On load:

1. Probes `GET /models/installed`. If `ml_deps_missing`, stays silent (ml-deps owns the banner).
2. If `all_local_present: false`, injects a cyan topnav banner naming up to 3 missing models + "Download" + "Dismiss". Stacks below the ml-deps banner when both are present.
3. Click "Download" → opens a modal with one row per missing model. Walks them sequentially via `POST /model/install`; per-row status flips PENDING → DOWNLOADING → DONE / FAILED.
4. On modal close, re-probes `/models/installed`; banner clears if everything's now present.

Self-gated via `window.__seekdeepModelInstallLoaded`.

### Cross-tab event stream

`POST /model/install` now publishes WS events to `/events` so the modal can track installs across tabs (e.g. user kicks off SDXL on one tab, opens chat.html in another while it's downloading):

| Topic | Data |
|---|---|
| `model.install.started` | `{ model_id, backend, role? }` |
| `model.install.complete` | `{ model_id, backend, role?, result: { ok, env_patched, external } }` |
| `model.install.failed` | `{ model_id, backend, role?, error }` |

The HTTP response shape is unchanged — synchronous callers still get the full `install_result` body when the call returns. Events are additive observability for the GUI.

### In-UI backend swap (chat roles only)

The backend chip in each modal row is clickable when the row's role matches `chat.*` and the current backend is `hf` or `ollama`. Click opens a small inline popover with:
- Backend dropdown (HF ↔ Ollama)
- `model_id` text input (pre-filled with current value)
- HF / Ollama format hint
- Save button → POSTs `/model/install` with `{ backend, model_id, role: <stripped chat. prefix>, auto_pull: true }`

The endpoint patches `.env` (via `_env_key_for_role`) so the role's backend + model_id flip on disk, then runs the pull/download. Restart the AI server (tray "Restart AI server" or `restart_sidecar` Tauri command) for the new role assignment to take effect.

**Remote backends** (openai-compat / anthropic / gemini) are NOT swappable from this mini-editor — they need API URL + key + version inputs. That's the full "Add a Model" wizard (designer queue item 1 in `PLANNED.md`). Until that ships, remote backend assignment stays `.env`-driven.

## 3.11 · Tauri sidecar v2.1 — auto-restart + system tray

Building on [§ 3.7-3.10](#37--persona-override-over-http-persona) (the loading overlay + sidecar spawn + ml-deps installer), the Tauri shell now exposes:

| Tauri command | Caller | What it does |
|---|---|---|
| `install_python_deps` | ml-deps loading overlay | `python -m pip install --user -r requirements-local.txt` |
| `retry_spawn` | loading overlay "Retry" button | Re-runs `boot_sequence` after the user fixed deps/python |
| `open_external` | "Get Python 3.11+ ↗" button | Opens python.org via `tauri-plugin-opener` |
| `restart_sidecar` | `ml-deps.js` post-install hook + tray "Restart AI server" menu item | Kills the child, waits 500 ms, re-spawns. Required after pip-installing torch (native extensions can't be hot-imported). |

**System tray** ([Tauri 2 `tray-icon` feature](https://v2.tauri.app/learn/system-tray/)) — right-click for menu, left-click toggles window visibility.

| Menu item | Action |
|---|---|
| Show SeekDeep | `window.show() + unminimize + set_focus` |
| Hide window | `window.hide()` |
| Restart AI server | Same as the `restart_sidecar` command |
| Quit SeekDeep | Sets `quit_requested` flag → kills child → `app.exit(0)` |

**Close-to-tray:** `WindowEvent::CloseRequested` calls `api.prevent_close()` and hides the window UNLESS `quit_requested` is set. Tray "Quit" is the only path to truly exit; the X button just hides. Side effect: the AI server keeps running while the window is hidden, which is exactly what you want when the Discord bot needs to stay online.

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
