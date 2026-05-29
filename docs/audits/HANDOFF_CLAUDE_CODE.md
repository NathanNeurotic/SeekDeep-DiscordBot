> **SUPERSEDED 2026-05-29 — historical snapshot, not current.**
> Archived from the repo root (audit DOC-4). Figures here (endpoint
> counts, LOC, "unverified" flags) reflect the date in the filename
> and contradict the live code. Kept for provenance only; do not cite
> as current state.

# Handoff · GUI → backend work (for Claude Code)

This document captures the work the GUI side has prepared, and the backend changes that need to land for it to come alive. Hand this file to Claude Code along with the repo.

---

## What the GUI side has already done

These are visual / design changes already applied in this project. Do not re-do them; pick up from this state.

- **Brand page removed.** All references to `brand.html` deleted across `app.html` (sidebar entry + click handler), `landing.html` (hero CTA), `pitch.html` (surface inventory). The file itself was not in the repo; no orphan link.
- **Hub re-prioritised.** `index.html` is now organised in three tiers — *Primary surfaces* (Control Center / Chat / Installer), *Working surfaces* (Docs / API / Architecture / Roadmap / Changelog / Memory), *Reference & marketing* (Landing / Pitch / Tour / Mobile / Boot). Old version preserved at `index v1.html`.
- **Tone pass.** Marketing-style copy removed across `index.html`, `landing.html`, `pitch.html`, `installer.html`, `tour.html`, `boot.html`. Backups kept at `landing v1.html` and `pitch v1.html`.
- **Version strings unified to `v10.35`.** Was a mix of `v10.15` / `v10.34` / `v10.35` before. Single source of truth needed (see Task 4 below).
- **`SEEKDEEP · 14 SURFACES`** count in `nav.js` jump panel updated after Brand removal.
- **Hub `Local stack` panel** is explicitly labelled **`Example readout · awaiting live wiring`**. Once the WebSocket bridge (Task 2) lands, that label should be removed and the rows driven by real data.

---

## Backend tasks · land in this order

The first two are blocking — most of the rest of the GUI work depends on them.

### Task 1 — Token auth for `gui_endpoints.py`

**Goal.** Stop `POST /config`, `POST /launcher/{svc}/{action}`, `POST /model/warm` from being callable by anyone who can reach the box.

**Implementation.**

1. On first run, the bot or the FastAPI side-car generates a 32-byte hex token and writes it to `.env` as `SEEKDEEP_GUI_TOKEN=…` if not already present. Print the token once to stdout on generation so the operator can copy it; never log it again.
2. In `gui_endpoints.py`, add an `X-SeekDeep-Token` header check on every mutating route (everything that is not `GET`). Reads stay public on `127.0.0.1` for now.
3. Add a `GET /gui/auth` endpoint that returns `{ok: true}` when the header matches and `401 {error: "token_mismatch"}` otherwise. The GUI uses this to render a clear "GUI is locked · paste your token" state instead of silent 401s.
4. The GUI pages (`app.html`, `installer.html`, `chat.html`) need a one-time token paste at first load, stored in `localStorage.seekdeep_gui_token`. When the FastAPI server is served from the same origin as the GUI (the recommended mount, see `INTEGRATION.md`), the bot can inject the token automatically via a `<meta name="seekdeep-token" content="…">` tag and the GUI prefers that over `localStorage`.

**Acceptance.**
- `curl -X POST http://127.0.0.1:7865/config -d '{}'` returns 401 without the header.
- `curl -X POST http://127.0.0.1:7865/config -H "X-SeekDeep-Token: $TOKEN" -d '{}'` succeeds.
- Token survives bot restart (read from `.env`, not regenerated).
- `npm run doctor` reports `GUI_TOKEN present` as a check.

---

### Task 2 — WebSocket event bridge

**Goal.** Replace the GUI's 5s `/health` polling with a single push stream so the Hub's stack panel, the Control Center's logs, and the API Explorer's live indicator all reflect reality without lag.

**Endpoint.** `GET /events` — WebSocket on the FastAPI side-car. Same auth as Task 1 (token via `?token=` query param, since browsers can't set headers on WS).

**Event shape.**

```jsonc
{ "type": "vram.sample",   "ts": 1748102400123, "data": { "used_mb": 6100, "total_mb": 24576, "loaded": "default_chat" } }
{ "type": "model.loaded",  "ts": 1748102400123, "data": { "role": "default_chat", "model": "meta-llama/Llama-3.1-8B-Instruct", "vram_mb": 5240 } }
{ "type": "model.evicted", "ts": 1748102400123, "data": { "role": "vision",       "reason": "task-lru",                       "freed_mb": 3400 } }
{ "type": "queue.depth",   "ts": 1748102400123, "data": { "image": 1, "chat": 0, "vision": 0 } }
{ "type": "request.start", "ts": 1748102400123, "data": { "id": "req_8842", "kind": "image", "user_id": "1234…" } }
{ "type": "request.done",  "ts": 1748102400123, "data": { "id": "req_8842", "ok": true, "elapsed_ms": 16780 } }
{ "type": "log.line",      "ts": 1748102400123, "data": { "level": "info", "src": "router", "msg": "default_chat → Llama-3.1-8B" } }
```

**Producers.**
- `index.js` (the Node bot) writes a UNIX domain socket / local TCP port that the FastAPI side-car reads and re-emits. Or simpler: the bot POSTs to `POST /events/emit` (internal-only, token-checked) and the side-car broadcasts. Pick whichever is easier — the GUI doesn't care.
- The Python side-car already knows about model loads, evictions, queue depth, VRAM samples — emit from those code paths directly.

**Consumer.**
The GUI surfaces an `events.js` module that opens the WS, dispatches by `type`, and exposes a tiny subscribe API:

```js
import { onEvent } from './events.js';
const off = onEvent('vram.sample', (d) => updateVramPanel(d));
```

**Acceptance.**
- Hub's `Local stack` panel updates in real time when a model loads or VRAM changes; the `Example readout · awaiting live wiring` label is removed.
- API Explorer's `LIVE · :7865` pill flips correctly on WS connect/disconnect (today it only updates after a manual request).
- Control Center logs viewer is wired to `log.line` instead of reading the file.

---

### Task 3 — Version single source of truth

The GUI now hardcodes `v10.35` in ~10 places. The backend should expose the actual version and the GUI should read it.

1. Add `version` to the `GET /health` response, sourced from `package.json` (`require('./package.json').version`).
2. In every GUI page, replace the hardcoded `v10.35` string in the titlebar / footer / sidebar with a `<span data-version>v10.35</span>` placeholder. A small `version.js` reads `/health` once on load and substitutes the real value into every `[data-version]` element. Falls back to the hardcoded string if `/health` is unreachable (so static-file viewing still works).

Files with hardcoded version strings to convert: `index.html`, `landing.html`, `pitch.html`, `app.html`, `chat.html`, `docs.html`, `api.html`, `architecture.html`, `roadmap.html`, `changelog.html`, `memory.html`, `mobile.html`, `boot.html`, `installer.html`, plus `nav.js`.

---

### Task 4 — Docs consolidation

Three files cover overlapping ground:

- `AGENTS.md` (24 KB)
- `CODEX_REPO_BRIEF.md` (24 KB)
- `README.md` (47 KB)

Pick `README.md` as the canonical entrypoint. Either rewrite the other two as short stubs that link into the relevant `README.md` section, or delete them after moving any unique content over. The smoke test suite + commands list are the only sections that should still exist outside `README.md` (in `COMMANDS.md` and the smoke test file itself).

---

### Task 5 — `.env.default` vs `.env.example` merge

Both files exist at ~7.5 KB each and largely overlap. Decide on one and delete the other, or add a one-line comment at the top of each explaining the difference (e.g. `.env.default = full reference, .env.example = minimum to boot`).

The setup script (`setup_local.ps1`) currently copies `.env.default` → `.env`. Whichever file remains is the one it should copy.

---

### Task 6 — Split `index.js` (869 KB)

Pure refactor. The roadmap explicitly says the remaining 112 lines in the `messageCreate` handler ARE orchestration and shouldn't be extracted further — that's correct, leave it alone. But the file as a whole is too big to navigate. Split by feature area:

- `lib/image-pipeline.js` — txt2img / img2img / pix2pix / inpaint / upscale routing and prompt-refinement glue
- `lib/archive.js` — archive setup, threads, count management, clean flow
- `lib/persona.js` — persona overrides, memory presets, daily digest / translate channel
- `lib/router.js` — chat role router, web search routing, lightweight chat routing
- `lib/commands.js` — slash + context-menu + reaction command registration
- `lib/reactrules.js` — auto-reaction engine
- `lib/discord-presence.js` — rotating status + context-aware presence

Each chunk should be import-only — `index.js` stays the entry point and the event handlers stay where they are. The smoke suite is the safety net; run `npm run preflight` after each extraction.

---

### Task 7 — Split `smoke_test.mjs` (103 KB)

Same shape as Task 6. Group tests by area into `tests/smoke/*.mjs`, with `npm run preflight` running an index file that imports them all. Each area file should be runnable in isolation for fast iteration.

Suggested split: `archive`, `image-pipeline`, `router`, `persona`, `reactrules`, `commands`, `gpu-health`.

---

### Task 8 — GitHub Actions CI

`.github/workflows/test.yml`:

```yaml
name: smoke
on: [push, pull_request]
jobs:
  smoke:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: '20' }
      - uses: actions/setup-python@v5
        with: { python-version: '3.11' }
      - run: npm ci
      - run: npm run preflight   # node --check + py_compile + smoke
```

No GPU on CI, so any test that actually loads a model has to be gated behind `process.env.CI` and skip. The smoke suite is structured to not need a GPU; verify before merging.

---

## What the GUI side will deliver next (out of scope for Claude Code)

These are design surfaces I'm preparing on the GUI side. They become Claude Code work after the design lands:

- **Memory recall UI** in `memory.html` — write-side commands, JSON schema, atomic writes.
- **Route inspector** panel in `api.html` — needs a new `GET /route/debug?prompt=…` endpoint that returns `{matched_rule, confidence, chosen_model, fallback_chain}`.
- **Image-pipeline A/B view** — a UI to compare `txt2img / img2img / pix2pix / inpaint` outputs side by side; backend already supports the four endpoints.

Each of these will land as a separate spec doc (`MEMORY_SPEC.md`, `ROUTE_DEBUG_SPEC.md`, `IMAGE_AB_SPEC.md`) once the design is finalised.

---

## Recommended sequencing

1. **Task 1 (token auth)** — must land first; everything else depends on the GUI being able to call mutating endpoints.
2. **Task 2 (WebSocket bridge)** — unlocks all the live panels.
3. **Task 3 (version SoT)** — fast follow once `/health` exposes `version`.
4. **Tasks 4 + 5 (docs / env)** — background cleanup, no dependencies.
5. **Task 6 (index.js split)** — refactor; do once the rest is stable.
6. **Tasks 7 + 8 (smoke split + CI)** — finish line.
