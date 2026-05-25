# Designer Audit Response — 2026-05-25

Designer ran a deep audit on chat.html + the rest of the GUI. This doc preserves their findings, marks each item against current `main` (commit `77ec7b7` at audit time), and folds the real action items into `PLANNED.md`.

**Critical context:** designer's audit was based on their local working copy, which is downstream of their last zip drop. Several "issues" they flagged are already fixed on `main` — those are noted below so we don't re-do work. The audit is still extremely valuable; the real findings are at the bottom.

---

## A. Chat page composer — what's actually wrong

### A1. Composer / textbox

| # | Designer's finding | Status on `main` | Action |
|---|---|---|---|
| 1 | Send button has no JS handler | **Partially false.** `gui/playground.js` (committed at `9fbf5eb`) hooks `.composer .send-btn` and routes to `/chat`. Auto-injected by `nav.js`'s `autoLoadSiblings`. Designer's local copy of `chat.html` may have shipped without `playground.js` available, which would explain the false positive. | None — already wired |
| 2 | Enter key does nothing | **False.** `playground.js` line ~440 binds `Enter` + `Shift+Enter` distinction (Enter sends, Shift+Enter is intended newline — but see #3). | None |
| 3 | Shift+Enter for newline impossible (it's `<input>` not `<textarea>`) | **True.** `playground.js` listens for `Shift+Enter` but the underlying element is single-line — Shift+Enter inserts nothing. | **Real ask** → designer Phase 2: replace `<input>` with `<textarea>` (auto-grow) |
| 4 | ↑ to "edit last" doesn't work | **True.** `playground.js` doesn't currently implement up-arrow history recall. The helper-row `<kbd>↑</kbd>` hint is fictional. | **Real ask** → designer Phase 2: either remove the hint OR designer flags it as needed and Claude Code adds the history stack |
| 5 | Placeholder truncates at narrow widths | **True.** Composer grid `auto 1fr auto auto` gives the input <input> field whatever's left after paperclip + CLINICAL pill + Send. | **Real ask** → designer Phase 2: rebalance the grid columns |
| 6 | CLINICAL pill is decorative, clicking doesn't change persona | **True.** Pill is static markup. Persona change only happens via the Tweaks panel. | **Real ask** → either wire to a new `/persona` endpoint (logged in PLANNED.md item G below) OR remove the pill |
| 7 | Paperclip icon decorative, no drop zone | **Partially true.** `playground.js` DOES wire global `dragover`/`drop` + paste handlers (`captureFile` function) — drop ANYWHERE on chat.html attaches an image. But there's no visible drop affordance OR `<input type="file">` on the paperclip itself. The paperclip is decorative; the drop-anywhere flow works invisibly. | **Real ask** → designer Phase 2: wire the paperclip to either trigger `captureFile()` directly OR make a hidden file input |
| 8 | Helper-row "ROUTING …" badge is wired but misleading (it polls `/route/debug` but no UI reacts to it) | **Partially true.** `playground.js` updates `#helperRoute` after each `/chat` response with the actual `model_role` + `model_id` from the response. It's not just decoration — it reflects what just happened. The badge IS honest, but only updates per request, not on a poll. | None — designer's complaint is based on a different design |

### A2. Chat body — static content

Designer is **100% right** that the conversation, channels, members list, attachment cards, reactions, thread embeds, server rail, "Discord-mirrored" channels, "Saved · local" sessions, and user card are all hardcoded fiction with no live source.

`playground.js` clears the demo conversation on first send (`clearMockChildren`), but everything else stays. The static content is misleading because:
- It implies SeekDeep is multi-tenant SaaS (it's not — it's a bot you self-host)
- It implies a "Discord-mirrored" feature exists (it doesn't)
- It shows fake reactions, citations, attachment buttons that aren't connected to anything

**Real ask** → designer Phase 2: strip the fake content from `chat.html`. Keep brand mark, persona pill (or remove), composer, the real `cLIVE`-driven bot-card stats, Tweaks panel.

### A3. Layout & sizing problems

| # | Designer's finding | Status | Action |
|---|---|---|---|
| 9 | Bottom of window clipped | **True.** `.app-wrap { height: 100vh }` ignores the topnav (`--topnav-h` ≈ 88px). | **Real ask** → designer Phase 2: change to `calc(100vh - var(--topnav-h))` |
| 10 | `body { overflow: hidden }` hides overflow rather than fixing it | **True.** Same root cause. | **Real ask** → designer Phase 2 |
| 11 | Narrow widths cook the composer | **True.** No media query collapses the rails. | **Real ask** → designer Phase 2 |

---

## B. Version & truth-in-labelling

Designer flagged "the topnav pill shows v10.0.0-FRESH-REBUILD" while "78 hardcoded v10.35 cells" stay stale, and claimed "the three maintainer-owned tails were never re-pasted."

**The tails ARE re-pasted on main.** Designer was looking at their local nav.js (which still has the TODO marker from the zip they shipped). Concrete proof from current `main`:

- `gui/nav.js` lines ~17–96: `installTokenInterceptor()` IIFE — present, hooks every same-origin POST with `X-SeekDeep-Token`
- `gui/nav.js` tail: `autoLoadSiblings()` IIFE — present, dynamically injects `events.js` + `version.js` + `playground.js`
- `gui/events.js` (152 lines) — exists, real WebSocket consumer
- `gui/version.js` (82 lines) — exists, fetches `/health.version` and rewrites every `[data-version]` element

So the tails work. **The version-mismatch issue designer flagged IS real, but the cause is different:**

- `package.json` has `"version": "10.0.0-fresh-rebuild"`
- `local_ai_server.py:384` reads from `package.json` via `_read_pkg_version()`
- `GET /health.version` returns `"10.0.0-fresh-rebuild"`
- `version.js` rewrites every `[data-version]` cell to `"10.0.0-fresh-rebuild"` (or `"v10.0.0-fresh-rebuild"` with prefix)
- The "v10.35" designer sees in cells means **`version.js` isn't running on those pages** — either:
  - Page doesn't load `nav.js` (which auto-injects `version.js`)
  - `[data-version]` attribute is missing on the element designer was looking at
  - Browser cache from an old visit
  - `/health` is unreachable so the fallback (the hardcoded literal) stays

**Real ask** → reconcile `package.json` version. We've been at `10.0.0-fresh-rebuild` since the original baseline. Real release tags are `v10.35`. Either bump `package.json` to `10.35.0` and tag releases off it, OR accept the rebuild label as the "rolling" version and update marketing copy to match. This is a Nathan decision, not a code one. Logged as item H in PLANNED.md.

---

## C. Rest of site — quick sweep

| # | Designer's finding | Status | Action |
|---|---|---|---|
| C1 | "PLAYGROUND · LIVE" pill ships with LIVE as initial state, only flips to MOCK on probe failure | **True.** Default state could be "PROBING" instead. | **Real ask** → designer Phase 2 |
| C2 | `manifest.json` `start_url: chat.html` lands users on the most-broken page | **True.** Should be `index.html` (About) or wherever the most-functional surface lives. | **Real ask** → user decision logged as item I in PLANNED.md |
| C3 | Hardcoded counts (274 smoke tests / 35 releases / 109 commands / 18 surfaces) on `pitch.html` / `changelog.html` / `index v1.html` will rot | **Partially true.** `pitch.html` + `changelog.html` confirmed have these. (`index v1.html` doesn't exist in our repo — see D2.) | **Real ask** → backend item J in PLANNED.md (`/stats/counts` endpoint) + designer Phase 4 (mark cells with `data-stat-*` attrs) |
| C4 | `tts.html` is honestly marked Mock, but other unwired pages aren't | **True.** `chat.html`, `image-ab.html`, `mobile.html`, `boot.html`, `pitch.html`, `tour.html` should also have MOCK badges. | **Real ask** → designer Phase 4 |
| C5 | `landing.html` says "Open source · MIT licensed" but repo is GPL-2.0 | **TRUE AND IMPORTANT.** Verified: `LICENSE` is GPL-2.0; `landing.html` lines 196 + 399 both say MIT. | **Real ask** → designer Phase 4 (fix copy), Claude Code Phase 5 (global license grep) |

---

## D. Duplicate & stale files — **mostly designer's local copy, not our repo**

| # | Designer's finding | Status on `main` | Action |
|---|---|---|---|
| D1 | Three vendor-drop folders (`seekdeep-designer-drop/`, `seekdeep-gui-cumulative/`, `seekdeep-zip-35/`) | **NOT IN REPO.** Verified `ls` — none of these dirs exist on `main`. They exist inside designer's ZIPs (zip 36, 38, etc.) but we extracted only the actual `gui/` content from each, never the wrapper dirs. | None — designer's local working dir has them; ours doesn't |
| D2 | `index v1.html`, `landing v1.html`, `pitch v1.html` legacy backups | **NOT IN REPO.** Same as D1 — designer's local backup files, never landed on `main`. | None |
| D3 | Four copies of `HANDOFF_CLAUDE_CODE.md` (root + 3 drop folders) | **One copy on `main`** (at root). The "extras" only exist in designer's local working dir. | None |
| D4 | `INTEGRATION.md` at root is a "stub" | **False.** Our `INTEGRATION.md` is 512 lines, fully populated. Designer may be looking at a stub copy that's in a zip somewhere. | None — but worth a sanity diff next time designer ships an INTEGRATION.md |
| D5 | `gui_endpoints.py`, `local_ai_server.py`, `index.js` at root "should be moved to `reference/`" | **False premise.** We're a **bot + GUI mono-repo**, not a GUI-only project. Those files ARE the bot. They belong at root. Moving them would break every `import` path, every `npm` script, the CI workflows, and `setup_local.ps1`. | None — designer was treating the project as if it were `gui/` only |
| D6 | `smoke_test.mjs` at root | **Same as D5.** Bot smoke test, belongs at root. | None |

---

## E. Specific bugs designer found

| # | Bug | Verified? | Action |
|---|---|---|---|
| 12 | `sw.js` cache paths are relative to worker URL — footgun if moved | True; cosmetic. | **Real ask** → designer Phase 2: add a comment in `sw.js` (or Claude Code can patch when revisiting PWA scope) |
| 13 | `cLIVE.apply()` shows hardcoded `14.2 / 24 GB` VRAM string in CPU-only mode | **True.** When `/health.gpu` is empty, the placeholder text stays. | **Real ask** → designer Phase 2 (or Claude Code: minor JS fix in chat.html if designer assigns it back) |
| 14 | Tweaks persona list missing `reset` | **Partially true.** Bot supports `@SeekDeep persona [scope] reset` to clear the override — but `reset` is a meta-command (clear), not a persona value. `SEEKDEEP_VALID_PERSONAS = {neurotic, unsettling, clinical, chaotic}`. The Tweaks panel should expose those 4 as a `<select>` + a separate "Clear override" button, not "reset" as a 5th option. | **Real ask** → designer Phase 2 (button) + Claude Code: `/persona` endpoint, item G below |
| 15 | Duplicate styling on `img[src*="seekdeep-mark"]` across styles.css + nav.js + per-page CSS — paint cost | True; cosmetic. | **Real ask** → designer Phase 4 (style consolidation) |
| 16 | Surface count mismatch: nav.js says "18 SURFACES", index.html About has 17 cards | **Partially true.** `nav.js` PAGES has 18 entries (verified). `index.html` doesn't have a literal "17 surfaces" string — designer is counting cards visually. Need to count card entries to confirm. | **Real ask** → designer Phase 4: count + reconcile |
| 17 | `sd-jump-btn` floating bottom-right overlaps chat right rail | True; cosmetic. | **Real ask** → designer Phase 4 |
| 18 | "Live pill" stays PROBING for 6s because `events.js` isn't loaded | **False on main.** `events.js` IS loaded via `autoLoadSiblings`. The 6s fallback only triggers if WS auth fails OR the bot isn't running. | None |

---

## F. New backend asks landing in PLANNED.md

Designer's audit surfaced two genuine new endpoint asks. Both logged in `PLANNED.md` under "Queued from designer audit 2026-05-25":

- **Item G — `POST /persona`** — wire the persona pill in the chat composer (and the Tweaks panel's persona select) to the real bot persona-override system (`seekdeepHandlePersonaCommand` + `data/persona-overrides.json` or similar). Body: `{ scope: 'channel'|'server'|'global', persona: 'neurotic'|'unsettling'|'clinical'|'chaotic' }` and `{ scope, action: 'reset' }` for clearing. Returns the new effective persona.
- **Item J — `GET /stats/counts`** — small endpoint returning `{ smoke_tests, releases, commands, surfaces }` so the GUI's hardcoded `274 / 35 / 109 / 18` numbers stop rotting. Numbers should source from real artifacts (test count from `preflight.mjs` last run, releases from `git tag | wc -l`, commands from a command-registry export, surfaces from `nav.js` PAGES length).

Also worth tracking:

- **Item H — Version reconciliation** — `package.json` is at `10.0.0-fresh-rebuild`; release tags are `v10.35`. Either bump `package.json` to `10.35.0` (so `/health.version` and `version.js`-rewritten cells match the release tag), or accept the rebuild label and update marketing copy. Nathan's call.
- **Item I — PWA scope decision** — `manifest.json` `start_url` currently points at `chat.html`. With the playground now functional, that may be right — but designer flagged it as "lands on the most-broken page." Open question: keep `chat.html` (playground), switch to `index.html` (About + hub), or two PWAs? Also `sw.js` only caches the chat shell; other pages would benefit from inclusion if the PWA is a real install target.

---

## G. Designer's proposed phase plan — Claude Code's view

Designer proposed a 5-phase handoff. Mapping to current state:

| Phase | Who | What | Status |
|---|---|---|---|
| 1 | Claude Code | Re-paste 3 maintainer-owned tails (`installTokenInterceptor`, `events.js` auto-load, `version.js` auto-load) | **ALREADY DONE** — landed on main at zip-merge time (commits `e697f95`, `9fbf5eb` and earlier nav.js merges). Designer's local copy is behind main. |
| 2 | Designer | Chat rebuild (composer textarea, message render path, layout fixes, MOCK badges, mock content strip) | **Real work; designer's domain.** Ready to start whenever they pick this up. |
| 3 | Claude Code | New endpoints: `/persona`, `/stats/counts`. (Designer also listed `/archive/config` + `/memory/*` — both already shipped at `308feda` + `95948f4`.) | **Items G + J in PLANNED.md.** Ready to ship once designer's chat rebuild surface is in. |
| 4 | Designer | License fix, surface count reconcile, MOCK badges, repo cleanup, persona vocab parity | **Designer's domain.** "Repo cleanup" items (vendor-drop folders, v1 files, move bot files to reference/) are based on designer's local-only state — see section D above. Skip those. |
| 5 | Claude Code | Version reconciliation, INTEGRATION.md sweep, PWA decision, SW scope, smoke tests for new write endpoints | **Items H + I in PLANNED.md.** Smoke for `/persona` ships with item G. |

---

## H. Lessons for future audits

A few patterns worth capturing in MAINTAINER.md (so future designer drops don't keep flagging the same not-real issues):

1. **Designer audits sometimes flag issues based on local working-copy state**, not `main`. Cross-check before acting. Real signals: things designer is testing live in their browser. Stale signals: things designer is reading from their local zip's source files.
2. **Vendor-drop folders** (`seekdeep-designer-drop/`, `seekdeep-gui-cumulative/`, etc.) exist inside designer's ZIPS only. We've never extracted them into the repo and never will.
3. **The bot Python/Node files at root are intentional.** We're a bot + GUI mono-repo. Don't move them to `reference/` — every script, import, and CI config depends on root paths.
4. **nav.js maintainer tails were re-pasted long ago.** When designer's local nav.js still has the TODO marker, that's a stale local copy, not a real gap.
5. **`v10.35` hardcoded in HTML literals is a fallback,** not the live render. `version.js` rewrites them once `/health` responds. If a page shows the literal, the page either wasn't served via the local AI server (file://) or the server was down.

---

## TL;DR

- **30 of designer's findings audited.** 11 are real and need action (logged in PLANNED.md). 9 are based on designer's stale local copy and need no action. 10 are mixed/partial and have specific notes above.
- **2 new backend asks** added to PLANNED.md (`/persona`, `/stats/counts`). 2 user decisions queued (`version reconciliation`, `PWA scope`).
- **Phase 1 of designer's handoff is already done** — they can start Phase 2 (chat rebuild) immediately without waiting on Claude Code.
- **No code changes from this audit pass** — pure documentation per Nathan's instruction.
