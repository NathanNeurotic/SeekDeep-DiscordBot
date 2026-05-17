# Planned Work & Deferred Improvements

This file tracks everything that's been discussed, scoped, or partially scaffolded but not yet shipped. Items here are not commitments — they're a parking lot for "next time we sit down with this codebase, here's what's on deck."

## Recently Shipped

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

(open — propose what to tackle next.)

## Deferred From the v10.5 Audit

These were flagged in the audit but deliberately not pursued during v10.5–v10.10 because the risk/reward didn't justify the work in those passes. Revisit when there's a focused reason.

- **`shouldAutoSearch` refactor** — 200-line function but ~180 lines are inline data arrays (`noSearchPatterns`, `explicitSearch`, `currentInfoHints`, `highChangeTopics`). Extracting to module-level constants would scatter the data away from where it's used. Only worth doing if we add a second consumer that needs the same lists.
- **`seekdeepLegacyArchiveUserThreadName` migration** — kept in v10.10 as backward-compat. Could be deleted IF we run a one-time migration that renames every legacy `archive-<user>-<id>` thread to the coin format `🪙 • Archive • <user> • <count>` first. Migration tool not yet written.

## Optional Features (Scaffolded, Off By Default)

Each is gated behind a `SEEKDEEP_FEATURE_*` flag. Code paths exist but the underlying model/endpoint isn't wired up.

### `SEEKDEEP_FEATURE_IMG2IMG`

Right-click an existing image → "Vary this" → tweak prompt → regenerate using the original as init image. Diffusers ≥ 0.27 exposes img2img on SDXL natively. Work needed:

- New `/image` route flag or `/image-edit` slash command.
- Plumbing through the Python server's `/image` endpoint to accept `init_image_b64` + `strength`.
- UI: a "Vary" button on existing image attachments and a right-click context menu entry.
- Tests in `smoke_test.mjs` for the new prompt/strength options.

### `SEEKDEEP_FEATURE_UPSCALE_REALESRGAN`

Right-click any generated image → "Upscale 2x" via Real-ESRGAN. Work needed:

- Download Real-ESRGAN weights (~80 MB), add to warmup.
- New `/upscale` endpoint in `local_ai_server.py`.
- Right-click context menu entry that grabs the most-recent generated PNG from the temp image cache.
- Cooldown + queue handling so upscale jobs don't starve image gen.

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

- **Conversation search** — full-text search across `CHANNEL_MEMORY`. "What did we talk about Mario for?"
- **Saved prompt templates per user** — `@SeekDeep template save cyberpunk_portrait <text>`, then `@SeekDeep draw using cyberpunk_portrait subject=alien queen`.
- **`/help search query:<text>`** — fuzzy-match across all commands instead of a topic-name lookup.
- **Persona editor modal** — `@SeekDeep persona edit` opens a Discord modal where you type custom persona instructions, stored per-server.
- **Analytics dashboard** — render the existing server-stats data as a chart image (matplotlib via local AI server) instead of just text.
- **Auto-translate channel** — set a channel to auto-translate every non-English message to English.
- **OCR mode for vision** — explicit "extract text from this image" path that prompts the vision model differently.
- **Archive housekeeping** — `@SeekDeep archive clean older than 7 days` or similar.

## Documentation Backlog

- [ ] One-page architecture diagram showing Node bot ↔ Python AI server ↔ SearXNG ↔ Discord. Goes in the README between "Architecture" and "Quick Start".
- [ ] AGENTS.md needs a section on `data/*.json` persistence files (auto-reactions, archive guild config, persona overrides, memory presets, server stats) and their schema.
- [ ] COMMANDS.md could grow a "Permission requirements" column on each table — right now permissions are mentioned in prose.

## Won't Do (Decided Against)

- **Quote Cards** (from demonbot) — explicitly skipped per user direction.
- **Game Lookup** (from demonbot) — explicitly skipped per user direction.
- **Single-line extraction of `seekdeepLegacyArchiveUserThreadName`** — it's backward-compat code, not dead. See v10.10 audit notes.
- **Further messageCreate handler extraction (Phase 3-4 address-gate)** — the remaining 112 lines ARE the high-level orchestration. Extracting further would be cosmetic.
