> **SUPERSEDED 2026-05-29 — historical snapshot, not current.**
> Archived from the repo root (audit DOC-4). Figures here (endpoint
> counts, LOC, "unverified" flags) reflect the date in the filename
> and contradict the live code. Kept for provenance only; do not cite
> as current state.

# Designer Hand-off — 2026-05-26 (full-GUI consistency pass)

The unified single-file Tauri experience is now end-to-end functional. Last audit response was [`AUDIT_DESIGNER_2026-05-25.md`](AUDIT_DESIGNER_2026-05-25.md); your Phase 2 + Phase 4 work landed in zip 41 and is on `main`. Several new surfaces have been added since — this hand-off asks you to do a **comprehensive consistency audit** across the whole GUI, not just chat.html.

`git pull` first. Five new files exist on main that weren't in your last working copy.

---

## What's new since your last pass

These are the surfaces that may need design polish + cross-page consistency review:

### 1. `gui/seekdeep-loading.html` (NEW · ~250 LOC)
Initial window URL for the Tauri shell. Shown while the Rust shell finds Python, runs pip, spawns `local_ai_server.py`, and waits for `/health` to respond. After ~500 ms of `/health` 200, redirects to `chat.html`.

- **Style currently inline** (no link to `styles.css`) because it has to render before the server is up and we can't trust same-origin CSS to be fetchable. Uses the same color variables as `styles.css` but copied inline.
- **Stage hints** update as the wait stretches (`WAITING FOR /health` → `PROBING · cold start typical 5-15s` → ... → `NEARLY GIVING UP`).
- **Three failure-state buttons** (shown after 60s of failures): Retry / Install Python deps / Get Python 3.11+ ↗.

**What I'd want from you:** review the visual language vs the rest of the GUI. The animated logo + radar-style rings are a guess at brand fit; replace if you have a better idea. The placeholder ring icon should probably use the real `seekdeep-mark.webp`.

### 2. `gui/ml-deps.js` (NEW · ~290 LOC)
Auto-loaded by `nav.js`. Probes `GET /ml_deps`; if any of `{torch, transformers, diffusers, accelerate, safetensors}` are missing, injects a topnav banner (`⚠ ML libraries not installed · Install (~2 GB) · Dismiss`). Install click opens a modal that streams pip's stdout from a WebSocket subscription on `deps.install.*`.

- **All styling is inline JS** (cyan accent matches the rest of the GUI but the banner shape is bespoke).
- **Modal log** is a black-on-cyan terminal-style `<pre>`; works but might want a more designed feel.

**What I'd want from you:** banner + modal style pass against `styles.css` variables. If you have a shared "in-app notification" pattern in mind, ml-deps.js + model-install.js + the loading overlay should all converge on it.

### 3. `gui/model-install.js` (NEW · ~270 LOC)
Same pattern as ml-deps but for HuggingFace model weights. Probes `GET /models/installed`; if any local-backend role is missing weights, injects a cyan banner naming the missing models. Modal walks them sequentially via `POST /model/install`. Stacks below the ml-deps banner when both are present.

**What I'd want from you:** same convergence pass — the banner color (cyan) is different from ml-deps (warn yellow) on purpose (severity is lower; the server runs fine without weights, you just can't use the local-AI features). Confirm that's the right cue.

### 4. `gui/stats.js` (NEW in zip 41 · 70 LOC)
You already wrote the consumer. Just confirming it's wired — pages with `data-stat-<key>` cells (currently `pitch.html` + `changelog.html`) are getting live counts.

### 5. Sidecar Tauri shell now has tray + auto-restart
- Close X hides the window instead of quitting (server keeps running for the Discord bot)
- System tray icon with right-click menu: Show / Hide / Restart AI server / Quit
- After ML deps install completes, the server is auto-restarted (torch can't be hot-imported)

**No GUI work required here** — it's all native shell — but worth knowing the close button doesn't actually quit anymore.

---

## What I want you to audit (full GUI sweep)

This is broader than "fix specific items" — I want you to walk every page with a fresh eye, comparing to the working-and-shipped surfaces.

### A. Cross-page visual consistency

After zip 41 you stripped `chat.html` of the fake server-rail / channels / members. Some of that mock content may still exist on other pages where it doesn't belong. Walk every surface in `gui/nav.js`'s PAGES array and flag:
- Any "Discord-mirrored" feature implications that aren't real
- Any hardcoded user lists / member counts / channel names
- Any "Saved · local" sessions that don't connect to anything

### B. MOCK badges audit

You added MOCK badges to `image-ab.html` / `mobile.html` / `boot.html` / `pitch.html` / `tour.html`. Walk every page and confirm:
- Is anything else still mock that's missing a badge?
- Is anything BADGED as mock that's actually wired now? (e.g. chat.html was MOCK in the design-time mock zip; it's LIVE now via playground.js. Make sure no stale MOCK badge survived.)
- The new banners injected by ml-deps.js / model-install.js are NOT MOCK markers — they're functional install prompts. Just confirming.

### C. Stat tiles + version cells

After the package.json bump to `10.35.0`, every `[data-version]` cell should now render `v10.35.0`. `[data-stat-*]` cells should render live numbers from `/stats/counts`. Walk every page and confirm:
- No `v10.35` literals remain in markup that aren't `[data-version]`-tagged
- No hardcoded `274 / 35 / 109 / 18` (or similar) remain on pages that don't have `[data-stat-*]` attributes
- If new pages exist that show counts, they should adopt the pattern

### D. Loading overlay style polish

`gui/seekdeep-loading.html` is functional but the visual is rough. I built it with inline styles so it'd render before the server is up. You're welcome to:
- Replace the animated SD glyph with the real brand mark (`assets/seekdeep-mark.webp` — would need to base64-embed since we can't trust the server is serving)
- Convert the inline CSS to a `<style>` block that mirrors `styles.css` variables
- Rethink the stage-hint copy — does it match the brand voice?

### E. Banner / modal pattern convergence

ml-deps.js + model-install.js both create banners + modals via inline DOM construction. If you have a vision for a unified "in-app notification" pattern (toast / popover / drawer / whatever), please mock it and I'll refactor both files to consume it. Probably wants to live in `styles.css` + a tiny shared helper.

### F. `chat.html` after-the-rebuild check

You rebuilt chat.html in zip 41. Now that it's been on main for a day and the playground is functional, walk through it again with fresh eyes:
- Does the persona pill's popover feel finished? (4 personas + Clear Override)
- Is the Tweaks panel's persona vocab clean?
- Does the "↑ to edit last" hint still exist? (I noted it's fictional — either remove the hint or flag for me to add the history stack)
- Any layout edge cases at narrow widths (≤880 px)?

### G. Surfaces that haven't been touched in this cycle

These haven't been audited since before the playground / ML installer landed. Quick sanity pass:
- `index.html` (the hub)
- `app.html` (Control Center)
- `installer.html` (the 9-step wizard)
- `docs.html`
- `api.html` (API Explorer)
- `architecture.html`
- `roadmap.html`
- `memory.html`
- `prompts.html`
- `landing.html`
- `tts.html`

Flag anything that:
- Looks stale (references features that no longer exist / are renamed)
- Promises a wire-up that doesn't exist
- Has hardcoded numbers that should be `data-stat-*`

---

## What I'm NOT asking for

- Backend changes (those are mine)
- Tauri Rust changes (those are mine)
- New endpoints (file a backend ask if you find a need)
- The `gui_endpoints.py` / `local_ai_server.py` / `index.js` / `smoke_test.mjs` files at repo root — **these are intentional**, not duplicates ([MAINTAINER.md § 2.5](MAINTAINER.md) explains the mono-repo pattern)
- Vendor-drop folders / v1 backup HTMLs that may exist in your local working copy but never landed on main

---

## When you're done

Drop a zip / PR. Claude Code will:
1. Audit against MAINTAINER.md § 1 (file overrides) + § 2 (recurring slip-up patterns)
2. Confirm the nav.js maintainer tails (`installTokenInterceptor` + `autoLoadSiblings` with all 6 sibling injects: events.js, version.js, playground.js, stats.js, ml-deps.js, model-install.js) are intact
3. Run preflight (bot smoke + gui-smoke + JS/Py syntax)
4. Merge to main
5. Push so the rolling nightly Tauri build picks it up

If you'd rather Claude Code take something on this list instead of doing it yourself — flag the item number and it's done.
