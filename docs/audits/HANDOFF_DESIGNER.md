# Handoff · backend → GUI work (for Claude Designer)

Hand this file to Claude Designer along with the repo. Mirrors `HANDOFF_CLAUDE_CODE.md` but going the other direction: this is what Claude Code shipped while you were away, and the GUI work that's now unblocked because of it.

Last updated: 2026-05-25 · `main` at `1c38336`

---

## What changed since your last drop

Everything you flagged as "needs backend" is now live. Every wire you sketched against has a real endpoint, a real event topic, or a real on/off flag. Pick up here.

### Five chat backends — not just HuggingFace

The bot now dispatches `/chat` to any of:

| Backend | env value | Notes |
|---|---|---|
| `hf` | (default) | The existing HuggingFace transformers path. No change. |
| `ollama` | `LOCAL_CHAT_BACKEND=ollama` | Daemon-based local. Auto-pull on `/model/warm` if missing. |
| `openai-compat` | `LOCAL_CHAT_BACKEND=openai-compat` | DeepSeek, OpenAI, Groq, OpenRouter, **xAI Grok**, and anything else that speaks the OpenAI Chat Completions API. BYK (bring-your-own-key). |
| `anthropic` | `LOCAL_CHAT_BACKEND=anthropic` | Native `/v1/messages` with `x-api-key` + `anthropic-version` headers. |
| `gemini` | `LOCAL_CHAT_BACKEND=gemini` | Native `/v1beta/models/{model}:generateContent` with `x-goog-api-key`. |

Per-role overrides exist for all of them: `LOCAL_CHAT_<ROLE>_BACKEND` + `LOCAL_CHAT_<ROLE>_MODEL_ID` + `LOCAL_CHAT_<ROLE>_API_URL` + `LOCAL_CHAT_<ROLE>_API_KEY` where `<ROLE>` is `DEFAULT` / `LIGHTWEIGHT` / `QUALITY` / `REASONING` / `FALLBACK`. Use these in the wizard (Task 1 below) so a user can have `default_chat` on HF and `quality_chat` on Anthropic in the same install.

⚠ Remote backends carry a privacy disclosure — prompts leave the local machine. Every wizard / settings surface that lets the user pick one must show the warning copy that's already in `.env.example` (search for "LEAVES THE LOCAL MACHINE"). Don't bury it.

### `POST /model/install` and `POST /model/uninstall`

- `POST /model/install` — for `hf` it `snapshot_download`s into the cache, for `ollama` it `POST /api/pull`s, for remote backends it probes connectivity. Optional `role` param assigns to a chat role by patching `.env`.
- `POST /model/uninstall` — counterpart. For `hf` it deletes the cached snapshot via `huggingface_hub.scan_cache_dir().delete_revisions()`. For `ollama` it `DELETE /api/delete`s. For remote backends it's a no-op (nothing local to delete). Optional `role` blanks per-role env keys.

Both are `X-SeekDeep-Token`-guarded (your `nav.js` interceptor handles this automatically).

### `GET /route/debug?role=...`

Read-only, no auth. Returns the full routing plan for a given role:

```jsonc
{
  "ok": true,
  "prompt_preview": "<first 240 chars of optional ?prompt=>",
  "role_requested": "default_chat",
  "role_resolved": "default_chat",
  "backend": "hf",                // hf|ollama|openai-compat|anthropic|gemini
  "model_id": "meta-llama/Llama-3.1-8B-Instruct",
  "endpoint": {                   // shape varies by backend
    "external": false,
    "already_loaded": false,
    "would_swap": false,
    "currently_loaded_role": null,
    "currently_loaded_model_id": null,
    "estimated_vram_mb": 5500
  },
  "fallback_chain": [
    { "role": "fallback_chat", "backend": "hf", "model_id": "ibm-granite/granite-3.3-8b-instruct" }
  ],
  "auto_fallback_enabled": true,
  "note": "Role-selection regex heuristics live in index.js seekdeepSelectChatModelRole..."
}
```

For remote backends, `endpoint` becomes `{ base_url, external: true, warning: "prompts for this role leave the local machine" }`. For `anthropic`, it also has `version`.

### `/health` extended

```jsonc
{
  "version": "10.x.x",
  "chat_backends": { "default_chat": "hf", "quality_chat": "anthropic", ... },
  "remote_chat_endpoints": { "quality_chat": "https://api.anthropic.com/v1/messages", ... },
  "ollama": { "available": true, "base_url": "http://127.0.0.1:11434", "tags": [...] },
  // ...plus everything that was already there
}
```

Use `chat_backends` to render which backend each role uses. Use `remote_chat_endpoints` to flag remote roles with the ⚠ pill.

### Three reaction features now share one lifecycle

| Flag | Default | Controls |
|---|---|---|
| `SEEKDEEP_FEATURE_FORCE_REACT` | `off` | Right-click "Force React (SeekDeep)" + picker |
| `SEEKDEEP_FEATURE_EMOJI_VAULT` | `off` | `@SeekDeep emoji backup/import/count/list` |
| `SEEKDEEP_FEATURE_AUTO_REACT` | `off` | `@SeekDeep reactrule …` admin + per-message rule scan |

All three off by default so SeekDeep doesn't fight demonbot in shared servers. **Settings pane should expose all three as togglable switches.** When off, the relevant help sections / commands / handlers are inert.

### User-facts memory

New bot commands:

- `@SeekDeep remember <fact>` — store persistent fact about the user
- `@SeekDeep recall` — list current facts with indices
- `@SeekDeep forget #N` / `forget <substring>` / `forget all`

Stored at `data/user-facts.json` (gitignored). Injected into every chat call's system prompt for that user. Caps: 25 facts/user, 500 chars/fact, both env-configurable. This unblocks **Memory recall UI (Task 12)** — you now have a real JSON store to read from, not a mock.

### WebSocket `/events` bus — 7 live topics

Connect once at page load via `window.SeekDeepEvents` (provided by `gui/events.js`, auto-injected by `nav.js`). Topics currently broadcast:

```
vram.sample        every ~5s while a model is loaded
model.loaded       on role load
model.evicted      on LRU evict or pressure event
queue.depth        FastAPI middleware emits on request count change
request.start      bot emits on every Discord message it picks up
request.done       bot emits on every completion (try/finally idempotent)
log.line           opt-in via SEEKDEEP_EMIT_LOG_LINES=on (rate-limited)
```

Subscribe pattern: `SeekDeepEvents.on('vram.sample', (data) => { ... })`. Pseudo-events `_open` / `_close` fire on connect/disconnect — wire these to the title-bar LIVE pill (Task 6).

### Version SoT

`gui/version.js` reads `/health.version` once on page load and rewrites every `[data-version]` element. Hardcoded `v10.x` strings stay as the fallback if `/health` is unreachable. **Task 7 is just adding the `data-version` attribute to existing version cells** — no JS work needed on your side.

---

## Files we own — DO NOT overwrite

Every designer-shipped zip (15, 17, 18, 19, 20, 21, 22, 23, 27, 28) has dropped older / regressed copies of these. Read `MAINTAINER.md` § 1 for the full catalog. The short version:

| File | What our version has that yours probably won't |
|---|---|
| `gui_endpoints.py` | Token auth, `/config/status`, normalizers, PID launcher, real `/model/warm` dispatch, `/token`, `/events`, `/events/emit`, `/events/status` |
| `local_ai_server.py` | 5 chat backends, `/model/install`, `/model/uninstall`, `/route/debug`, 7 event producers, VRAM pressure logic, SDXL 77-token cap |
| `gui/nav.js` | Token interceptor (monkey-patches `window.fetch`), `events.js` auto-loader at the tail, jump palette, brand-removed |
| `gui/events.js` | Entire file is ours — your zips don't ship this. `window.SeekDeepEvents` pub/sub. |
| `gui/version.js` | Entire file is ours — your zips don't ship this. Reads `/health.version`, rewrites `[data-version]`. |
| `INTEGRATION.md` | Auth section, all 5 backends, event bus, version SoT. Your draft uses APIs that don't exist. |
| `data/auto-reactions.json` schema | Server-side normalizer matches what `index.js` actually writes. Don't redefine. |

**Recurring slip-ups to audit on every drop** (from `MAINTAINER.md` § 2):

| You claim | What the zip actually does | Fix |
|---|---|---|
| "Brand surface removed" | `brand.html` still in zip + still linked from `app.html` sidebar + `landing.html` topnav + nav.js palette | Delete `gui/brand.html`; strip all references; renumber hub cards + nav palette consecutively |
| "Swapped to webp" | Zero `.webp` refs in any HTML | Sweep `seekdeep-mark.png` → `seekdeep-mark.webp` across all `gui/*.html` + `gui/nav.js` |
| "gui_endpoints.py is current" | Ships the old 321-line version without normalizers/auth | Keep ours; port new endpoints in manually |

There's a 14-line Python helper at the bottom of `MAINTAINER.md` (§ 7) that runs the brand+webp sweep in one shot. Use it.

---

## Tasks · backend ready, build UI now

These all have live endpoints + events. Pick them up in any order.

### Task 1 — "Add a Model" wizard

3–4 step picker for adding a model + assigning it to a chat role.

- **Step 1: Backend.** Picker with five options: `hf` / `ollama` / `openai-compat` / `anthropic` / `gemini`. Show short helper text for each (hf = local download, ollama = local daemon, remote three = BYK + ⚠ privacy warning).
- **Step 2: Model ID.** Input field with provider-specific affordances:
  - `hf` → link to `https://huggingface.co/models`, free-text input
  - `ollama` → fetch `GET /health` → `health.ollama.tags` for a dropdown of installed tags + a "pull new" text input
  - `openai-compat` → free-text model name (e.g. `deepseek-chat`, `gpt-4`, `grok-4`)
  - `anthropic` → dropdown of current claude models (claude-opus-4-7, claude-sonnet-4-6, claude-haiku-4-5-20251001) + free text
  - `gemini` → dropdown of current gemini models + free text
- **Step 3: API URL + key** (skip when `hf` or `ollama`). For `openai-compat`, also let user override the base URL (defaults `https://api.openai.com/v1` but DeepSeek / Groq / etc. all need different ones).
- **Step 4: Assign to role + confirm.** Dropdown of roles (`default_chat` / `lightweight_chat` / `quality_chat` / `reasoning_chat` / `fallback_chat`) + a confirm button that calls `POST /model/install`.

Backend payload:

```jsonc
POST /model/install
{
  "backend": "anthropic",
  "model_id": "claude-opus-4-7",
  "role": "quality_chat",           // optional; if set, patches .env
  "api_url": "...",                  // optional; remote backends only
  "api_key": "...",                  // optional; remote backends only
  "api_version": "2023-06-01",       // optional; anthropic only
  "auto_pull": true                  // optional; ollama only
}
```

Response includes `ok`, `backend`, `model_id`, plus backend-specific fields (HF includes `local_dir` + `files_downloaded`, Ollama includes `note`, remote includes `external: true` + privacy note). Show the response.

Pair with a "Remove" button on each installed model that calls `POST /model/uninstall` with the same shape. Show the freed bytes (HF returns `freed_bytes`).

### Task 2 — Settings / paths UI

Config pane fields:

- `HF_HOME` — HuggingFace cache root
- `OLLAMA_MODELS` — Ollama models dir
- `LOCAL_MODEL_CACHE_DIR` — override for HF snapshot location
- `OLLAMA_KEEP_ALIVE` — keep-alive duration string (e.g. `"5m"`, `"0"` to evict immediately)
- Per-role API URL + key (5 roles × 2 fields = 10 inputs, can be in a collapsed section)
- Three reaction feature toggles: `SEEKDEEP_FEATURE_FORCE_REACT`, `SEEKDEEP_FEATURE_EMOJI_VAULT`, `SEEKDEEP_FEATURE_AUTO_REACT`

Backend: `POST /config` with `{ "updates": { "HF_HOME": "/new/path", ... } }`. Already exists, already token-guarded, already merges into `.env` preserving comments + order.

### Task 3 — Wire Hub "Local stack" panel to live data

The panel currently shows `Example readout · awaiting live wiring`. Remove that label and drive the four rows from:

- VRAM usage row → `SeekDeepEvents.on('vram.sample', d => { ... })`. Payload: `{ used_mb, total_mb, loaded }`.
- Loaded model row → `SeekDeepEvents.on('model.loaded', d => { ... })`. Payload: `{ role, model, vram_mb }`. Also fires `model.evicted` on unload.
- Queue depth row → `SeekDeepEvents.on('queue.depth', d => { ... })`. Payload: `{ image, chat, vision }` (in-flight request counts per kind).
- Online/offline pill → `SeekDeepEvents.on('_open', ...)` / `('_close', ...)`. Or just check `SeekDeepEvents.connected`.

### Task 4 — Wire Models pane

Each model card should render:

- A **status badge**: `RESIDENT` (loaded right now) / `PINNED` (won't be evicted by LRU) / `CACHED` (downloaded but not loaded) / `NOT INSTALLED`.
- A **backend badge**: `HF` / `Ollama` / `Remote ⚠` (the warning glyph for remote because prompts leave the machine).

Data sources:

- `GET /health.chat_backends` → `{ role: backend }` for every role.
- `GET /health.remote_chat_endpoints` → which remote URLs are configured.
- `SeekDeepEvents.on('model.loaded', ...)` / `('model.evicted', ...)` → live status updates.
- For "is it in the cache" — call `GET /models` (returns HF cache scan + Ollama tags merged) if it exists, otherwise infer from `/health` only.

### Task 5 — Wire Logs viewer

The viewer currently polls `/logs/tail` every few seconds. Switch to a live stream:

```js
SeekDeepEvents.on('log.line', (d) => {
  // d = { level, src, msg, ts }
  appendLogLine(d);
});
```

**Opt-in note:** `log.line` only emits if the user sets `SEEKDEEP_EMIT_LOG_LINES=on` in `.env` (rate-limited, subscriber-gated). When the env var is off, the bus stays silent and the viewer falls back to the existing `/logs/tail` poll. Surface this in the UI: a small "live logs disabled — poll mode" pill when the flag is off.

### Task 6 — Title-bar LIVE pill

Flips green ↔ red on WebSocket connect / disconnect.

```js
SeekDeepEvents.on('_open',  () => setPill('LIVE',    'green'));
SeekDeepEvents.on('_close', () => setPill('OFFLINE', 'red'));
// Initial state:
setPill(SeekDeepEvents.connected ? 'LIVE' : 'OFFLINE', SeekDeepEvents.connected ? 'green' : 'red');
```

### Task 7 — `data-version` attribute

Add `data-version` to every version-displaying element across:

```
index.html, app.html, chat.html, landing.html, pitch.html,
docs.html, api.html, architecture.html, roadmap.html, changelog.html,
memory.html, mobile.html, boot.html, installer.html, nav.js
```

Example before/after:

```html
<!-- before -->
<span class="version-cell">v10.35</span>

<!-- after -->
<span class="version-cell" data-version>v10.35</span>
```

`gui/version.js` (already in repo, auto-loaded by `nav.js`) reads `/health.version` and rewrites every `[data-version]` to the live value. The hardcoded `v10.35` stays as the offline fallback.

### Task 8 — Image pipeline A/B view

Four panels side by side: `/image`, `/img2img`, `/instruct-pix2pix`, `/inpaint`. Same prompt + seed across all four. All four endpoints already exist; the UI is just orchestration.

Inputs: prompt (text), source image (file or URL, for the three non-`/image` panels), instruction/mask (for pix2pix/inpaint). Seed is a single number; same seed across all four panels for reproducibility.

### Task 9 — API Explorer offline state

Each endpoint card currently silently falls back to canned mocks when the backend is offline. Surface this as a visible state — small "OFFLINE · mock data" pill on each card. Use `SeekDeepEvents.connected` or the `/health` HEAD ping as the source.

### Task 10 — Quiet the bubbles on `docs.html` + `api.html`

CSS-only pass. Opacity reduction on `.abyss` + `.bubbles` for those two text-dense pages so the decorative background doesn't compete with the content. Other pages keep the current loudness.

### Task 11 — Mobile mocks → real PWA

If you want the mobile mockup to become a real installable companion app:

- Add `manifest.json` at `gui/` root with `display: "standalone"`, name, icons (use existing `seekdeep-mark.webp` for the 512px icon).
- Add a minimal service worker (`gui/sw.js`) that caches the shell of `chat.html` for offline launch. Don't try to cache `/chat` API responses.
- Register the SW from `chat.html` only (not the other pages).

Backend: nothing needed. This is pure frontend.

---

## Tasks · design now, backend after

### Task 12 — Memory recall UI in `memory.html`

Backend is now live. `data/user-facts.json` schema:

```jsonc
{
  "users": {
    "<discord-user-id>": {
      "facts": [
        { "text": "I work in PST timezone", "at": 1779707903000 },
        ...
      ],
      "updatedAt": "2026-05-25T04:43:00.000Z"
    }
  }
}
```

UI needs:

- List all facts for the current user (selectable from a dropdown if you want admin view) with timestamps.
- Edit a fact in place.
- Delete a fact.
- Export to JSON (download the user's row).
- Clear all facts (with confirm modal).

You'll need a new read endpoint (`GET /memory/user/{user_id}`) and a write/delete endpoint. **Spec these in the design, ship the mock against the schema above, and Claude Code will build the endpoints to match.**

Also expose presets read/write from the same surface. Schema lives at `data/memory-presets.json`:

```jsonc
{ "users": { "<id>": { "presets": ["brief", "expert", ...], "updatedAt": "..." } } }
```

Known preset keys: `brief`, `expert`, `no-emoji`, `no-followup-questions`, `formal`, `casual`. The list is defined in `index.js` as `SEEKDEEP_KNOWN_PRESETS` — keep your UI in sync if you want to add more (or extend the const there and have Claude Code review).

### Task 13 — Route Inspector panel in `api.html`

Backend is live: `GET /route/debug?role=<role>&prompt=<sample>`. See the response shape at the top of this doc. Panel needs:

- Role dropdown (5 roles).
- Optional prompt input (just for visualizing what the bot would see).
- "Inspect" button → calls `/route/debug` → renders the response.
- Make the fallback chain visible — show "if this fails → fall back to X with backend Y".
- Show the `note` field verbatim — it explains that role-selection regex lives in `index.js` and the AI server can only describe what happens *after* role selection.

### Task 14 — TTS preview UI

Backend not built and not on the near-term roadmap, but if you want to mock it:

- Voice channel picker (dropdown of joinable VCs in the current guild).
- Voice picker (a placeholder list — Piper voices are `en_US-amy-medium`, `en_GB-northern_english_male-medium`, etc.).
- Queue mockup with mock "now reading" + 3 queued items.

When TTS finally lands, the integration target is clear. No backend coordination needed for the mock — just design against a reasonable JSON shape.

---

## Blocked on a decision

### Task 15 — Prompt template marketplace

Import-from-URL / share button. Blocked on: **where do shared templates live?**

Options: (a) GitHub gist, (b) Nathan's own domain, (c) signed cloudflare URLs, (d) nothing remote (export-import `.json` only). Don't ship anything here until Nathan picks (a)–(d).

You can mock the import-modal UI to look the same regardless of source.

---

## Three other things waiting on Nathan's call

These aren't yours — flagging so you don't try to design around them:

| Item | Why it's not built |
|---|---|
| **Streaming chat responses** | `/chat` → SSE, bot handler restructure, Discord edits token-by-token. Big refactor; Nathan hasn't greenlit. Design as one-shot for now. |
| **Per-message cost tracking for remote backends** | Useful to prevent surprise bills on `openai-compat` / `anthropic` / `gemini`. Where to store? How to display? Open question. |
| **`index.js` split** | Nathan explicitly deferred this. Don't design UI that depends on the split happening. |

---

## Reference docs (read these before you start)

- **`PLANNED.md`** — every parking-lot item with priorities + dependencies. The Designer queue section maps 1:1 to Tasks 1–15 above.
- **`MAINTAINER.md`** — the override catalog + zip-merge protocol. Read § 1 + § 2 before your next drop or you will clobber our work and we'll have to undo it (again).
- **`INTEGRATION.md`** — the live API surface. § 3 covers the chat backends, § 3.5 the event bus, § 3.6 the version SoT, § 4 the archive bridge.
- **`README.md`** — feature-flag table in the README is the canonical list of env vars that affect UX.
- **`.env.example`** — every env var with its default + a comment explaining what it gates.
- **`HANDOFF_CLAUDE_CODE.md`** — your previous handoff to me. Worth re-reading; some assumptions in there are out of date (e.g. the WebSocket bridge is now live, the token auth is now live).

---

## How to verify your work before shipping a zip

Run preflight before zipping:

```sh
npm run preflight
```

Expected: `4 ok · 0 fail · 0 skipped`. The four stages are `js` (node --check on all JS), `py` (py_compile on all Python), `smoke` (504 unit-level checks), `gui-smoke` (52 endpoint-level checks via FastAPI TestClient).

CI runs the same `npm run preflight` on every push and PR (see `.github/workflows/ci.yml`). If you push a regressed `local_ai_server.py` or `gui_endpoints.py`, the red X on the commit will tell you within ~30 seconds — don't wait for local feedback.

There's also `npm run doctor` for setup diagnostics (env file presence, Discord token format, loopback URL checks, etc.). Doctor exits 0 when there are no failures, even with warnings — `DISCORD_CLIENT_ID` blank is now a WARN since the bot can reply to mentions without it. The Settings panel (Task 2) is the right place to expose `DISCORD_CLIENT_ID` so the user can fill it for slash-command registration.

If `gui-smoke` fails after your changes, the most likely cause is your zip overwrote `gui_endpoints.py` or `local_ai_server.py`. Restore from `git` and port your changes in manually per `MAINTAINER.md` § 1.

Visual smoke (optional but appreciated): start the bot + AI server and load `http://127.0.0.1:7865/gui/index.html`. Every nav-bar link should resolve, the brand page should not be linked anywhere, every page should show `v10.x` (auto-rewritten from `/health.version`), and the title-bar LIVE pill should be present (green if WS connected).

---

## Acceptance per task

- **Task 1 wizard**: cold-start install of a new HF model (e.g. `Qwen/Qwen3-7B`) completes end-to-end through the UI; the model appears in the Models pane with `CACHED` badge; assigning it to a role updates `.env` and `/chat` routes to it on next request.
- **Task 2 settings**: changing `HF_HOME` via the UI updates `.env` and is reflected on next bot restart. Toggling `SEEKDEEP_FEATURE_AUTO_REACT` from off → on enables the `reactrule` admin command in Discord.
- **Task 3 hub stack**: with a model loaded, the panel shows live VRAM, model name, queue depth, all updating without page refresh.
- **Task 4 models pane**: every installed model has the right status + backend badges. Remote-backend models show the ⚠ pill.
- **Task 5 logs viewer**: with `SEEKDEEP_EMIT_LOG_LINES=on`, new log lines appear in the viewer with <1s latency. With it off, the viewer falls back to poll mode and shows the disabled-pill.
- **Task 6 LIVE pill**: kill the AI server → pill goes red within 30s (WS keepalive timeout). Restart → pill goes green within 5s.
- **Task 7 `data-version`**: every version cell across 15 files reads `v10.35` (or whatever the live version is); no `v10.20` / `v10.34` strays remain on screen.

---

## TL;DR

Backend queue is empty. You have:

- 5 chat backends with consistent dispatch + per-role overrides
- `POST /model/install` + `POST /model/uninstall` for the wizard
- `GET /route/debug` for the inspector
- 7-topic WebSocket bus for live data
- Token auth (your `nav.js` interceptor already handles it)
- Version SoT (your version cells just need `data-version` attributes)
- Three reaction features with consistent on/off flags for the settings pane
- User-facts persisted store for the memory UI

Build the 11 backend-ready UI tasks in whatever order makes sense. Spec the 3 design-first tasks. Skip the 1 blocked-on-decision task until Nathan picks a hosting model.

When you ship the next zip, run preflight, follow `MAINTAINER.md` § 1, and don't ship a regressed `gui_endpoints.py`. We'll meet back here when you're done.
