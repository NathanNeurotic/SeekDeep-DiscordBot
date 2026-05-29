# Designer Hand-off — 2026-05-25 (Phase 2 + Phase 4 ready to start)

Everything in the backend / Claude Code lane that your 2026-05-25 audit surfaced is now landed on `main`. This doc summarizes what changed and what's queued on your plate.

If you're reading this fresh, the audit response with the full 30-finding cross-check is at [`AUDIT_DESIGNER_2026-05-25.md`](AUDIT_DESIGNER_2026-05-25.md). This doc is the action summary.

---

## What's already done (don't redo)

### Phase 1 (Claude Code) — done long ago
- `gui/nav.js` maintainer-owned tails are pasted and live on `main`:
  - `installTokenInterceptor` IIFE (every same-origin POST gets `X-SeekDeep-Token`)
  - `autoLoadSiblings` IIFE (auto-injects `events.js` + `version.js` + `playground.js`)
- `gui/events.js`, `gui/version.js`, `gui/playground.js` all exist and ship from `main`.
- If your local nav.js still has the TODO marker, that's your stale local copy — `git pull origin main` will fix it.

### Phase 3 (Claude Code) — done in this pass (2026-05-25)
- **`POST /persona`** + **`GET /persona`** — the chat-page persona pill + Tweaks panel persona select can now call `/persona` instead of going through Discord. See [`INTEGRATION.md § 3.7`](INTEGRATION.md) for the schema. Scopes: `global` (web playground default), `channel`, `server`. Reset via `{scope, action: "reset"}`.
- **`GET /stats/counts`** — replaces the hardcoded `274 / 35 / 109 / 18` literals on `pitch.html` + `changelog.html` + the topnav stat tiles. See [`INTEGRATION.md § 3.8`](INTEGRATION.md) for the response shape + `data-stat-<key>` adoption pattern.

### Phase 5 (Claude Code) — done in this pass
- **Version reconciliation**: `package.json` bumped `10.0.0-fresh-rebuild` → `10.35.0`. `/health.version`, FastAPI's reported version, and every `version.js`-rewritten `[data-version]` cell now match release tags. Tauri installer metadata follows via `tauri.conf.json` reading `"../package.json"`.
- **License copy** (audit item C5): `gui/landing.html` (lines 196 + 399) and `gui/pitch.html` (lines 328 + 340) now say `GPL-2.0`, matching the actual `LICENSE` file. No more MIT references on the marketing surfaces.
- **PWA scope** (audit item C2): kept `start_url: chat.html` (the playground is the daily-use page). Expanded `sw.js` cache to include `events.js` + `version.js` + `playground.js` + `manifest.json` so an offline chat.html load gets the real event bus + version rewriter + composer wiring instead of just the static shell.
- **`sw.js` path-convention comment** (audit item E12): added.
- **`cBotVram` placeholder** (audit item E13): `cLIVE.apply()` now sets `cpu · no gpu` when `/health.gpu` is empty, instead of leaving the static `14.2 / 24 GB` placeholder visible.

### Designer audit items that need no action
Items D1–D6 (vendor-drop folders, `v1` legacy files, four `HANDOFF_CLAUDE_CODE.md` copies, `INTEGRATION.md` stub, "move bot files to `reference/`", `smoke_test.mjs` location) are all based on your local working copy of the zip — they do NOT exist on `main`. We're a bot+GUI mono-repo; `gui_endpoints.py` / `local_ai_server.py` / `index.js` belong at the repo root by design.

See [`MAINTAINER.md § 2.5`](MAINTAINER.md) for the recurring-misconception cheatsheet so future audits skip these patterns.

---

## Phase 2 — your domain, ready to start

The chat.html composer + body cleanup. Everything below is real and the backend is ready.

### A1. Composer / textbox (audit items #3, #4, #5, #6, #7)

| # | Fix | Notes |
|---|---|---|
| 3 | Replace `<input>` with auto-growing `<textarea>` | Shift+Enter is currently broken because single-line `<input>` can't accept newlines. `playground.js` already listens for Shift+Enter and will route correctly once the element supports it. |
| 4 | ↑ to "edit last" — either remove the hint OR flag it back | The helper-row `<kbd>↑</kbd>` hint is currently fictional. If you want it real, ping Claude Code to add the history stack in `playground.js`; if you'd rather drop the hint, just remove the markup. |
| 5 | Rebalance composer grid columns | Current `auto 1fr auto auto` collapses the input at narrow widths. |
| 6 | Wire the CLINICAL persona pill | Backend now ready: `POST /persona` with `{scope:'global', persona:'<name>'}`. Pill should fetch `GET /persona` on load to show current, and POST on click (cycle through the 4 valid personas, or open a popover). |
| 7 | Wire the paperclip | Either trigger `playground.js`'s drop handler programmatically, or add a hidden `<input type="file" accept="image/*">` and forward to the existing `captureFile()` function. The drop-anywhere flow already works invisibly; the paperclip just needs to be a visible affordance for it. |

### A2. Strip fake content
The conversation thread, fake channels, members list, attachment cards, reactions, thread embeds, server rail, "Discord-mirrored" channels, "Saved · local" sessions, user card — all hardcoded with no live source. `playground.js` clears the demo conversation on first send, but everything else stays. Strip it to: brand mark, persona pill (or remove), composer, real `cLIVE`-driven bot-card stats, Tweaks panel.

### A3. Layout fixes (audit items #9, #10, #11)
- `.app-wrap { height: 100vh }` should be `calc(100vh - var(--topnav-h))` so the topnav doesn't clip the bottom.
- `body { overflow: hidden }` is a symptom — same root cause.
- Add a media query that collapses the rails at narrow widths so the composer survives.

---

## Phase 4 — your domain after Phase 2

### C1. PLAYGROUND pill initial state
Currently ships as `LIVE` and only flips to `MOCK` on probe failure. Should ship as `PROBING` (or similar) and flip to `LIVE` once `cLIVE` confirms `/health` is up.

### C3. Wire `/stats/counts` to the stat tiles
Backend now returns the numbers; designer adds the `data-stat-<key>` attributes. Pages with hardcoded counts:
- `pitch.html` — `274 smoke tests / 35 releases / 109 commands / 18 surfaces` literals
- `changelog.html` — same set
- Topnav stat tiles wherever they appear

Adoption pattern in [`INTEGRATION.md § 3.8`](INTEGRATION.md). Either extend `version.js` to read `[data-stat-*]` too, or ship a new `stats.js` and add it to `autoLoadSiblings`. If you go the latter route, append the filename to the auto-load list in `gui/nav.js`'s `autoLoadSiblings` tail — same pattern as `playground.js`.

### C4. MOCK badges
`tts.html` is correctly marked Mock. These should also have MOCK badges since they're not wired to real backends yet:
- `chat.html` — partial (playground IS wired; helper hints / static content are not)
- `image-ab.html`
- `mobile.html`
- `boot.html`
- `pitch.html`
- `tour.html`

### E14. Tweaks persona vocab parity
Replace the persona list in the Tweaks panel with the canonical 4: `neurotic`, `unsettling`, `clinical`, `chaotic`. Add a separate **"Clear override"** button (calls `POST /persona` with `{scope:'global', action:'reset'}`) — do NOT add `reset` as a 5th persona option; it's a meta-action.

### E15. Style consolidation
`img[src*="seekdeep-mark"]` is styled in `styles.css` + `nav.js` + several per-page CSS blocks. Paint cost is small but the duplication is real. Consolidate into one source of truth (probably `styles.css`) and strip the others.

### E16. Surface count reconcile
`gui/nav.js` `PAGES` array has 18 entries. `index.html` About has 17 cards. Either add the missing card to `index.html` OR remove the missing entry from `PAGES` (or accept the difference if one is intentional and document it).

### E17. `sd-jump-btn` overlap
Floating button in the bottom-right overlaps the chat right rail at certain widths. Adjust either the rail width or the button position.

---

## What stays Claude Code's domain (not yours)

- New backend endpoints (only ship when you flag a need)
- Bot-side Discord command behavior
- Smoke tests
- CI / GH Actions workflows
- Tauri shell (`src-tauri/`)
- `INTEGRATION.md`, `MAINTAINER.md`, `PLANNED.md`, audit doc

---

## When you're done with Phase 2 + 4

Drop a zip / PR / commit reply. Claude Code will:
1. Run the 3-tail re-paste check (`installTokenInterceptor`, `autoLoadSiblings`, `playground.js` injection) — same MAINTAINER.md § 1 ritual as every zip
2. Run preflight (bot smoke + gui-smoke + js/py syntax checks)
3. Merge to main
4. Push so the rolling nightly Tauri build picks it up

Anything you'd rather Claude Code take instead of doing yourself — just say which item number from this doc and it's done.
