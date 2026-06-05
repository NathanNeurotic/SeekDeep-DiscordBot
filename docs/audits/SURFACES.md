# SeekDeep GUI surface audit — 2026-05-29

> **Status update — most recommendations have since landed.** The promote/cut
> calls from the "Recommended sequence" below were acted on in `gui/nav.js`:
> the ⌘K palette now drops `tts` / `landing` / `pitch` / `tour` / `mobile` (the
> self-labeled mocks/marketing pages) and surfaces the real hidden features.
> New real surfaces have also shipped since this audit — `settings.html`
> ("All Settings", the typed `.env` editor), `personas.html`, `setup-wizard.html`
> — so the page inventory below is the 2026-05-29 snapshot, not the live count.
> The repo now carries **24 top-level `gui/*.html` pages plus the Discord Activity
> at `gui/activity/index.html` (DataDash)**. The cut pages still ship in the bundle
> (`gui/**/*` globs everything) for the web/marketing context; they're just no
> longer offered as in-app navigation targets. Re-run the method below before
> trusting any specific row.

The desktop GUI shipped **~21 HTML page surfaces** at audit time (now 24 + the
Activity), but the top nav exposes only **~8**. The rest are reachable only via
the ⌘K jump palette, so real features were undiscoverable and non-functional
demo/mock pages shipped alongside them. This table classifies every page so
keep / cut / promote calls can be made deliberately, per-page.

Method: live-wiring = count of real endpoint/`fetch()` references; mock-signal
= count of mock/placeholder/demo markers; plus a read of the ambiguous ones
(`memory`, `image-ab`, `tts`). No code changed — this is inventory only.

## Legend
- **NAV** — currently in the top navigation
- **PROMOTE** — real, working feature that's hidden (only via ⌘K) → consider nav/More menu
- **CUT** — non-functional demo/marketing/mock → consider removing from the bundled desktop build (can stay in-repo for web/GitHub)
- **INFRA** — not a user-navigable "feature" (splash/loading); keep
- **KEEP** — reference page, fine where it is

## In the top nav (8) — all real or reference

| Page | Purpose | Live wiring | Verdict |
|---|---|---|---|
| `index.html` | Hub / About landing inside the shell | live (10) | KEEP (nav) |
| `app.html` | **Control Center** — launcher, GPU, models, bot config, logs, playgrounds, archive, reacts, stats | live (133) — the core | KEEP (nav) |
| `chat.html` | Chat playground (live `/chat`) | live (19) | KEEP (nav) |
| `installer.html` | 9-step setup wizard / launch+smoke | live (43) | KEEP (nav) |
| `docs.html` | Command reference (COMMANDS.md mirror) | static (3) | KEEP (nav) |
| `api.html` | API explorer (live + offline modes) | live (12) | KEEP (nav) |
| `architecture.html` | System-map reference | static (6) | KEEP (nav) |
| `roadmap.html` | Roadmap (PLANNED.md) | static (7) | KEEP (nav) |

## Hidden but REAL features — PROMOTE candidates

| Page | Purpose | Evidence it's real | Verdict |
|---|---|---|---|
| `memory.html` | Per-user memory / facts editor | live `fetch` to `/memory/*` (lines 390, 427); `MOCK_USERS` is only an offline fallback (`state.isMock`) | **PROMOTE** — real, useful, undiscoverable |
| `image-ab.html` | 4-pipeline image A/B compare | live `fetch` to `/image`, `/img2img`, `/instruct-pix2pix`, `/inpaint` (lines 368, 444) | **PROMOTE** |
| `prompts.html` | Prompt-template marketplace (the `#prompts` channel surface) | live `/prompts` wiring (8); ships `@offline-demo` sample rows in the preview | **PROMOTE** (and consider replacing the demo sample rows with empty-state) |
| `add-model.html` | Model-install wizard (`POST /model/install`) | live (15) | **PROMOTE** or deep-link from Control Center → Model manager |
| `changelog.html` | Release history | static (4) | optional promote (low priority) |

## Hidden — DEMO / MARKETING / MOCK — CUT-from-desktop candidates

| Page | What it actually is | Evidence | Verdict |
|---|---|---|---|
| `tts.html` | **Pure design-time mock.** Self-labeled "⚠ DESIGN-TIME MOCK · TTS backend (Piper/XTTS) deferred indefinitely · none of the controls dispatch" (lines 210, 225, 433). No audio, no endpoint. | 0 live, self-labeled mock | **CUT** from desktop (a user who opens it via ⌘K hits a dead page). Keep in-repo as a design ref if wanted. |
| `mobile.html` | Phone-frame mockups (marketing/design) | 1 live, 6 mock | **CUT** from desktop bundle (web/marketing only) |
| `pitch.html` | 9-slide marketing/investor deck | 0 live | **CUT** from desktop bundle (keep for GitHub/web) |
| `landing.html` | Marketing landing page | 0 live | **CUT** from desktop bundle (keep for web) |
| `tour.html` | Guided product tour | 1 live, 11 mock | **REVIEW** — keep if it's real onboarding, cut if it's a static mock; mostly mock today |

## Infrastructure (not navigable features) — KEEP

| Page | Purpose | Verdict |
|---|---|---|
| `boot.html` | Startup splash | INFRA — keep |
| `seekdeep-loading.html` | Tauri loading splash (polls `/health`, 17 live) | INFRA — keep |

## Recommended sequence (status noted inline)

1. **[DONE] Lowest-risk, highest-value:** promote the real hidden features into
   the ⌘K palette / nav (purely additive). `memory`, `image-ab`, `prompts`,
   `add-model` — plus the newer `settings` / `personas` / `setup-wizard` — are
   now offered as in-app navigation targets in `nav.js`.
2. **[PARTIAL] De-clutter:** `tts`, `mobile`, `pitch`, `landing` (and `tour`)
   were pruned from the ⌘K palette list in `nav.js` so they no longer appear as
   jump targets. They are **still bundled** — the Tauri `resources` glob is
   `gui/**/*`, which ships every page; dropping them from the desktop bundle was
   *not* done (kept in-repo + bundled for the web/marketing context).
3. **[DONE] Decide `tour`:** cut from in-app navigation (removed from the ⌘K
   palette alongside the marketing mocks); file retained in-repo.
4. **`prompts` polish:** swap the `@offline-demo` sample rows for a proper
   empty-state so the marketplace doesn't look pre-populated with fake data.
   (Verify against the current `prompts.html` before acting.)

Each of these is independently shippable and behavior-preserving except the
deliberate cuts. None block the deferred de-monolith or the canonical-
status-file migration.
