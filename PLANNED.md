# Planned Work & Deferred Improvements

This file tracks everything that's been discussed, scoped, or partially scaffolded but not yet shipped. Items here are not commitments — they're a parking lot for "next time we sit down with this codebase, here's what's on deck."

## Recently Shipped

### v10.29 — Auto-translate channel ✅ shipped
`@SeekDeep translate channel here` designates one channel per server where every non-bot message containing non-Latin script gets an automatic English translation reply. Fast regex detector for CJK, Cyrillic, Arabic, Devanagari, Thai, Korean. 3-second cooldown per channel. 9 smoke checks.

### v10.28 — Refinement retry + analytics chart ✅ shipped
Dynamic refinement retries once at a higher temperature on validator rejection before falling back to static rules. Token budget bumped 360 → 512. `@SeekDeep stats chart` / `/stats scope:chart` renders a matplotlib 30-day activity chart via the Python server's new `/chart` endpoint.

### v10.27 — COMMANDS.md permission column ✅ shipped
Added Permission column to every command table. Documented all v10.16–v10.26 additions.

### v10.22–v10.26 — Phase 2 features ✅ shipped
- v10.22: Archive numbering reliability fix (off-by-one, ratchet, clean arithmetic)
- v10.23: Conversation search (`@SeekDeep search <query>` / `/search`)
- v10.24: Saved prompt templates (`@SeekDeep template save/list/use/delete` / `/template`)
- v10.25: img2img + upscale (zero extra model download for img2img; Lanczos upscale)
- v10.26: Persona editor modal (`/persona` opens a Discord popup form)

### v10.16–v10.21 — QoL + maintenance ✅ shipped
- v10.16: Rotating Discord status (52 statuses, 10-min shuffle)
- v10.17: `/help search` fuzzy-match across all commands
- v10.18: OCR mode for vision
- v10.19: Archive clean (prune old entries with preview + confirm)
- v10.20: Context-aware Discord status during inference
- v10.21: Repo cleanup (473 → 27 tracked files)

### v10.12 — GPU / VRAM live monitoring ✅ shipped

Built in response to an observed lag pattern: host began to severely lag after a couple of image generations, likely VRAM thrashing into Windows shared memory once chat + pinned vision + SDXL coexisted past the GPU's hardware VRAM budget.

- ✅ `local_ai_server.py` exposes `gpu_stats()` via new `/gpu` endpoint and a `gpu` sub-object on `/health`. Returns `allocated_mb`, `reserved_mb`, `free_mb`, `total_mb`, `used_mb`, `used_pct`, `reserved_pct`, plus `loaded` + `keep_resident` state.
- ✅ `@SeekDeep gpu` / `@SeekDeep vram` natural commands and `/gpu` slash command.
- ✅ Live-tail mode: `@SeekDeep gpu watch [N]` or `/gpu watch:true interval:N`. Edits one message every N seconds (clamped 2–60). Auto-stops after 2 minutes. React ✋ to stop early. Per-channel single-active-watcher lock.
- ✅ `@SeekDeep status` now shows a one-line GPU summary at the top + a thrashing warning when PyTorch's reserved pool ≥ 90% of total VRAM.
- ✅ 17 new smoke checks in `smoke_test.mjs` covering the bar renderer, formatter, thrashing detector, and watch-interval parser.

What was scoped but NOT shipped:
- Optional background sampler that writes `logs/gpu-YYYY-MM-DD.log` every 30s when `SEEKDEEP_GPU_LOGGING=on`. Could add later if retrospective debugging needs it.
- A "VRAM budget" table in README documenting which model combinations fit a 24 GB card. Worth adding after observing real-world numbers from the live watcher.

## Next Up

- **TTS voice channel** — Piper or XTTS. Biggest remaining lift. Requires model download (user approval needed, limited SSD space).
- ~~**Architecture diagram**~~ — shipped in docs commit, ASCII diagram in README.
- ~~**data/*.json schema docs**~~ — shipped in docs commit, full schemas in AGENTS.md.
- **Real-ESRGAN model download** — scaffolded in v10.25 but needs user approval.

## Deferred From the v10.5 Audit

These were flagged in the audit but deliberately not pursued during v10.5–v10.10 because the risk/reward didn't justify the work in those passes. Revisit when there's a focused reason.

- **`shouldAutoSearch` refactor** — 200-line function but ~180 lines are inline data arrays (`noSearchPatterns`, `explicitSearch`, `currentInfoHints`, `highChangeTopics`). Extracting to module-level constants would scatter the data away from where it's used. Only worth doing if we add a second consumer that needs the same lists.
- **`seekdeepLegacyArchiveUserThreadName` migration** — kept in v10.10 as backward-compat. Could be deleted IF we run a one-time migration that renames every legacy `archive-<user>-<id>` thread to the coin format `🪙 • Archive • <user> • <count>` first. Migration tool not yet written.

## Optional Features (Scaffolded, Off By Default)

Each is gated behind a `SEEKDEEP_FEATURE_*` flag. Code paths exist but the underlying model/endpoint isn't wired up.

### `SEEKDEEP_FEATURE_NSFW_GATE`

CLIP-based NSFW scorer on generated images. Work needed:

- Add `compel-ml/clip-vit-base-patch32` (or similar) to the model cache.
- New scoring step in `makeImageResult` after the image is generated.
- Thresholds + behavior split: spoiler-wrap, refuse with text-only notice, or pass through.
- `.env` knobs for the threshold and the spoiler-vs-refuse boundary.

### `SEEKDEEP_FEATURE_TTS_VOICE`

Voice-channel TTS reader (Piper or XTTS). Biggest lift of the four:

- Voice connection management.
- Piper / XTTS model setup + warmup.
- Per-channel opt-in.
- Probably needs a dedicated VoiceAgent in `AGENTS.md`.

## Quality-of-Life Wishlist

Lower-priority polish ideas. Pull when there's an itch.

- **GPU logging** — optional background sampler that writes `logs/gpu-YYYY-MM-DD.log` every 30s. Env: `SEEKDEEP_GPU_LOGGING=on`.
- **VRAM budget table** — document which model combinations fit a 24 GB card.
- **Latin-script language detection** — extend auto-translate to detect French, Spanish, etc. Harder because the regex approach doesn't work for Latin-based scripts.

## Documentation Backlog

- [x] ~~One-page architecture diagram~~ — shipped in docs commit. ASCII diagram in README between "Architecture" and "Quick Start".
- [x] ~~data/*.json schema docs~~ — shipped in docs commit. Full schemas for all 6 persistence files in AGENTS.md.
- [x] ~~COMMANDS.md could grow a "Permission requirements" column on each table~~ — shipped in v10.27.

## Won't Do (Decided Against)

- **Quote Cards** (from demonbot) — explicitly skipped per user direction.
- **Game Lookup** (from demonbot) — explicitly skipped per user direction.
- **Single-line extraction of `seekdeepLegacyArchiveUserThreadName`** — it's backward-compat code, not dead. See v10.10 audit notes.
- **Further messageCreate handler extraction (Phase 3-4 address-gate)** — the remaining 112 lines ARE the high-level orchestration. Extracting further would be cosmetic.
