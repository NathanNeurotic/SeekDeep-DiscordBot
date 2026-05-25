# Planned Work & Deferred Improvements

This file tracks everything that's been discussed, scoped, or partially scaffolded but not yet shipped. Items here are not commitments — they're a parking lot for "next time we sit down with this codebase, here's what's on deck."

Last full audit: 2026-05-24 (GUI + backend stack)

---

## GUI / Backend Stack — Post-`5cd770b` Queue (2026-05-24)

The "GUI shipped + backend wired" arc landed across ~40 commits ending at `5cd770b`. Token auth, WebSocket bridge, 7 live event topics, CI, version SoT, VRAM hardening, **all 5 chat backends (hf / ollama / openai-compat / anthropic / gemini)**, `POST /model/install`, telemetry disclaimer, etc. — all live.

What's left, split by who owns it.

### Claude Code queue (backend / repo work)

Sorted by readiness to start.

#### Can ship anytime (no blockers)

All four "ready anytime" items shipped 2026-05-25 in commits `3e4a0fa`, `3878ba4`, `7a3368d`:

- ✅ **`GET /route/debug?role=...`** — read-only diagnostic at `local_ai_server.py:2098`. Returns `{ok, prompt_preview, role_requested, role_resolved, backend, model_id, endpoint, fallback_chain, auto_fallback_enabled, note}`. The bot's regex-based role selector still lives in `seekdeepSelectChatModelRole` (index.js); the endpoint is honest about that boundary in its `note` field. Pass the role the bot WOULD pick (or what the user requested) as the `role` query param.
- ✅ **Memory recall: write-side** — bot-side `@SeekDeep remember <fact>` / `recall` / `forget #N | <substring> | all` commands, persisted to `data/user-facts.json` (gitignored, atomic writes), injected into the chat system prompt via new `seekdeepComposeUserSystemBlock` helper. Caps: 25 facts/user, 500 chars/fact. Both chat call sites updated.
- ✅ **`POST /model/uninstall`** — counterpart to `/model/install` at `local_ai_server.py:2031`. HF cache delete via `huggingface_hub.scan_cache_dir().delete_revisions()`, Ollama `DELETE /api/delete`, no-op for remote backends. Optional `role` param blanks per-role `LOCAL_CHAT_<ROLE>_*` env keys via `_seekdeep_merge_env`.
- ✅ **Extended `gui-smoke`** — 20 new checks in `scripts/smoke_gui_endpoints.py` covering `/route/debug` (response shape, default role, bogus-role fallback, prompt-preview truncation), `/model/install` (auth + Pydantic validation), `/model/uninstall` (auth + hf-absent idempotency + remote no-op + unknown-role 400 with env_patched=False). `gui-smoke` is now 52 checks (was 32). Bot smoke is 501 checks (was 493).

#### Needs a "go" from the user

5. **`index.js` split** into `lib/image-pipeline.js`, `lib/archive.js`, `lib/persona.js`, `lib/router.js`, `lib/commands.js`, `lib/reactrules.js`, `lib/discord-presence.js`. Designer's HANDOFF Task 6.
   - Effort: 1–2 days dedicated. Risk: high — touches 100+ handlers. CI's `preflight` (493 smoke tests) is the safety net. Recommended: do one module per commit, run preflight between each. Don't half-do.

6. **`smoke_test.mjs` split** into `tests/smoke/{archive,image-pipeline,router,persona,reactrules,commands,gpu-health}.mjs` with an index runner. Designer's HANDOFF Task 7.
   - Effort: ~half-day. Easier after #5.

~~7. **GIF history eviction**~~ — DONE 2026-05-25. Used `git filter-repo --strip-blobs-with-ids` to evict blob `991d748b` (17.5 MB) from every commit reachable from `main` and every tag. Force-pushed `origin/main` from `3756e35` → `a0bbf93`. Fresh `git clone --depth=1` of `origin/main` is now **23 MB** (was ~36 MB before). Same blob appeared under 4 paths in history (`docs/uploads/`, `gui/uploads/`, `gui/assets/seekdeep-mark.gif`, `SeekDeepOnline/uploads/`) — stripping by blob ID killed all four at once. Safety net: remote tag `pre-gif-evict-2026-05-25` still pins the original main commit; safe to delete once you're confident.

   Local `.git/` is still 42 MB because the local pack file doesn't fully reclaim unreachable blobs without a manual re-clone. Doesn't affect remote, doesn't affect fresh clones. If you want a smaller local repo, re-clone fresh from origin.

   v10.x tags were left alone by filter-repo (they pointed at commits that already didn't contain the blob in their tree snapshot), so all tag SHAs match between local and remote.

### Designer queue (UI work)

All have backend ready unless noted.

#### Backend ready — designer just builds UI

1. **"Add a Model" wizard** — 3–4 step picker. Step 1: backend (hf/ollama/openai-compat/anthropic/gemini). Step 2: model ID (with provider-specific helper text — link to HF Hub for hf, list of installed tags for ollama, model dropdowns for the remotes). Step 3: API URL + key when remote. Step 4: assign to role + confirm. Backend: `POST /model/install`.

2. **Settings / paths UI** in the Config pane — fields for `HF_HOME`, `OLLAMA_MODELS`, `LOCAL_MODEL_CACHE_DIR`, `OLLAMA_KEEP_ALIVE`, plus per-role API URL + key. Backend: existing `POST /config`.

3. **Wire Hub "Local stack" panel** to live data and remove "Example readout · awaiting live wiring" label. Backend: `SeekDeepEvents.on('vram.sample', ...)`, `('model.loaded', ...)`, `('queue.depth', ...)`.

4. **Wire Models pane** RESIDENT / PINNED / CACHED badges + HF / Ollama / Remote ⚠ backend badges. Backend: `/health.chat_backends` + `/health.remote_chat_endpoints` + `model.loaded` / `model.evicted` events.

5. **Wire Logs viewer** to live `log.line` events (currently polls `/logs/tail`). Backend: `SeekDeepEvents.on('log.line', ...)`. Note: opt-in via `SEEKDEEP_EMIT_LOG_LINES=on`.

6. **Title-bar LIVE pill** flips on WS connect / disconnect. Backend: `SeekDeepEvents.connected` + `'_open' / '_close'` pseudo-events.

7. **`data-version` attribute** added to every `v10.x` cell in titlebars / footers / sidebars. Backend: `version.js` auto-rewrites once marked; no JS needed on designer side. Cells in: `index.html`, `app.html`, `chat.html`, `landing.html`, `pitch.html`, `docs.html`, `api.html`, `architecture.html`, `roadmap.html`, `changelog.html`, `memory.html`, `mobile.html`, `boot.html`, `installer.html`, `nav.js`.

8. **Image pipeline A/B view** — same prompt + seed across `/image`, `/img2img`, `/instruct-pix2pix`, `/inpaint`. Four panels side by side. Backend: 4 endpoints already exist.

9. **API Explorer offline state** — surface the "falls back to canned mocks when offline" UX as a labeled state on each endpoint card.

10. **Quiet the bubbles** on `docs.html` + `api.html` (text-dense surfaces). CSS-only, opacity reduction on `.abyss` + `.bubbles` for those pages.

11. **Mobile mocks → real PWA** — `manifest.json` + service worker on `chat.html` if they want the mobile mock to become a real installable companion app.

#### Designer designs first, Claude Code builds backend after

12. **Memory recall UI** in `memory.html` — review / edit / export / clear the bot's per-user memories. Needs my #2 above (write-side commands + JSON store) shipped first, OR can be designed as a clickable prototype against mock data while I build the backend in parallel.

13. **Route Inspector panel** in `api.html` — renders the `/route/debug` debug payload. Needs my #1 above shipped first, OR can mock the JSON shape from this PLANNED entry while I build the endpoint in parallel.

14. **TTS preview UI** — voice channel picker + voice picker + queue mockup. Backend (Piper / XTTS / etc.) is deferred indefinitely; designer can mock now so when TTS finally lands, the integration target is clear.

15. **Prompt template marketplace** — Import-from-URL / share button. **Blocked on hosting decision** (see "Needs decision" below).

### Needs decision before either of us starts

| Item | Decision needed |
|---|---|
| **Prompt template marketplace** | Where do shared templates live? gist / your domain / signed URLs / nothing remote (export-import .json only)? |
| **Streaming chat responses** | Big refactor (`/chat` → SSE, bot handler restructures, Discord edits token-by-token). Worth the win? |
| **Per-message cost tracking for remote backends** | Useful to prevent surprise bills on `openai-compat` / `anthropic` / `gemini`. Where to store? How to display? |

### Already shipped — for cross-reference

The "what's now live" snapshot lives in the commit log; the canonical entry points to read are:

- `MAINTAINER.md § 1` — files we own and that designer zips would clobber (audit-overrides catalog)
- `INTEGRATION.md § 3.4` — chat-backend matrix, per-role config, `/model/install`, `/health.remote_chat_endpoints`
- `INTEGRATION.md § 3.5` — WebSocket event bridge (7 live topics)
- `INTEGRATION.md § 3.6` — Version SoT (`/health.version` + `data-version`)
- `INTEGRATION.md § 4` — Archive bot bridge snippet
- `README.md` privacy block — third-party disclosure (Discord / HF / Ollama / SearXNG / `openai-compat` / `anthropic` / `gemini`)
- `.env.example` — every supported env var with inline explainers

---

## v10.34 Sprint — All Fixed (pending commit)

All confirmed bugs from live testing on 2026-05-19. 274 smoke tests pass.

### 1. Persona modal crash ✅ fixed
Label shortened from 52 to 25 chars (`'Persona name (or reset)'`).

### 2. Deprecated `ephemeral: true` ✅ fixed
All 11 occurrences migrated to `flags: MessageFlags.Ephemeral`.

### 3. Shared archive button 77s-637s ✅ fixed
Removed O(n) full thread scan (`seekdeepScanThreadArchiveEntryStats`) from shared archive button path. Now trusts the JSON profile fast count. Verification scans reserved for `archive status`.

### 4. Archive delete button `50027` ✅ fixed
Removed full thread scan from delete path. Now decrements profile count atomically. Final `editReply` wrapped in try/catch with fallback to `channel.send`.

### 5. Inpaint prompt extraction ✅ fixed
Now extracts removal target ("the small houses") instead of generic fill prompt. Combines target+scene when scene is non-generic.

---

## Image Pipeline Quality — Priority Improvements

Audited all 5 image pipelines on 2026-05-19. Parameters listed are what the Node side sends (not just Python defaults).

### Pipeline Parameter Summary

| Pipeline | Steps | Guidance | Strength | Resolution | Neg Prompt |
|----------|-------|----------|----------|------------|------------|
| txt2img (`/image`) | env `IMAGE_STEPS` (28) | env `IMAGE_GUIDANCE_SCALE` (7.0) | n/a | 1024x1024 | env `IMAGE_NEGATIVE_PROMPT` |
| img2img | env `IMAGE_STEPS` (28) | env `IMAGE_GUIDANCE_SCALE` (7.0) | adaptive 0.45-0.80 | 1024x1024 | env `IMAGE_NEGATIVE_PROMPT` |
| pix2pix | 30 hardcoded | 9.0 hardcoded | n/a | 512->1024 upscale | env fallback |
| inpaint | 30 hardcoded | 5.0 hardcoded | 0.95 hardcoded | 1024x1024 | none sent |
| upscale | n/a | n/a | n/a | Lanczos NxN | n/a |

### 6. Inpainting quality improvements ✅ tuned
CLIPSeg mask: threshold 0.4->0.3, MaxFilter(21) dilation, GaussianBlur(8) feathering. Inpaint params: strength 0.95, guidance 5.0, steps 30, negative prompt now sent. CLIPSeg remains a lightweight model — future upgrade path is SAM/GroundingDINO.
**Remaining improvement ideas:**
  - [ ] Mask preview option (`mask_preview:true`)
  - [ ] Multi-prompt CLIPSeg for complex targets
  - [ ] Stronger segmentation model (SAM, GroundingDINO)

### 7. Pix2Pix image_guidance_scale ✅ fixed
Now adaptive: heavy edits (scene/style transforms) get 1.2, light edits (brightness/color tweaks) get 2.0, default 1.5. Was hardcoded at 1.0.

### 8. img2img guidance_scale ✅ fixed
Changed from `IMAGE_GUIDANCE_SCALE` (txt2img's 7.0) to `IMAGE_IMG2IMG_GUIDANCE_SCALE` (default 5.0).

### 9. Context menu img2img modal auto-routing ✅ fixed
Instruction-like prompts auto-route to pix2pix (modifications) or inpaint (removals) when features are enabled.

### 10. Adaptive strength scene/environment tier ✅ fixed
Added 0.80 tier for scene keywords. Generic "make it" bumped 0.65->0.70.

---

## Model Router Gaps

### 11. `lightweight_chat` routing ✅ fixed
Model router now routes to `lightweight_chat` (gemma-3n-E4B-it) for: translation tasks, greetings (hi/hello/thanks/bye), short trivial prompts (who are you, what time, ping). Only activates when `LOCAL_CHAT_LIGHTWEIGHT_MODEL_ID` env var is set. Falls back to `default_chat` on Python side if model unavailable.

---

## Performance

### 12. Archive thread scan removed ✅ fixed (same as #3/#4)

### 13. Thread rename debounce ✅ fixed
`seekdeepMaybeRenameArchiveThread` now tracks last rename time per thread with 30-second cooldown. Rapid archive clicks no longer queue up rename API calls.

---

## Recently Shipped

### v10.33 -- Bug fixes + loading gif + image edit routing
- Ephemeral modal ack (fixed double-message on context menu modal submits).
- Pix2Pix output: fixed aspect ratio stretch on non-square images (now always 512->1024 square).
- Context menu embed image fallback (images in embeds now found by vision/upscale/img2img).
- Loading gif added to 8 context menu handlers + 3 slash commands.
- Stats chart orphan loading gif fix.
- Context menu upscale + img2img text-path changed to ephemeral defer.
- 7 new smoke tests (249->256).

### v10.32 -- Context menu modals + adaptive img2img + pix2pix tuning
### v10.31 -- InstructPix2Pix + Inpainting + routing overhaul
### v10.30 -- Image quality tuning (Dreamshaper-XL defaults)
### v10.29 -- Auto-translate channel
### v10.28 -- Refinement retry + analytics chart
### v10.27 -- COMMANDS.md permission column
### v10.22-v10.26 -- Phase 2 features (archive fix, search, templates, img2img, persona modal)
### v10.16-v10.21 -- QoL + maintenance (status rotation, help search, OCR, archive clean, repo cleanup)
### v10.12 -- GPU / VRAM live monitoring

---

## Next Up

- **Real-ESRGAN model download** -- scaffolded in v10.25 but needs user approval for the model cache.
- **TTS voice channel** -- Piper or XTTS. Biggest remaining lift. Requires model download.

## Optional Features (Scaffolded, Off By Default)

### `SEEKDEEP_FEATURE_INSTRUCT_PIX2PIX` -- shipped v10.31
### `SEEKDEEP_FEATURE_INPAINT` -- shipped v10.31

### `SEEKDEEP_FEATURE_NSFW_GATE`
CLIP-based NSFW scorer on generated images. Needs model, scoring step, thresholds, `.env` knobs.

### `SEEKDEEP_FEATURE_TTS_VOICE`
Voice-channel TTS reader (Piper or XTTS). Voice connection, model setup, per-channel opt-in.

## Quality-of-Life Wishlist

- **GPU logging** -- optional background sampler, `SEEKDEEP_GPU_LOGGING=on`.
- **VRAM budget table** -- document which model combinations fit a 24 GB card.
- **Latin-script language detection** -- extend auto-translate to detect French, Spanish, etc.
- **Inpaint mask preview** -- ✅ shipped in Phase C. Exposes mask preview bypass command to check CLIPSeg outputs.

## Segmentation Roadmap: CLIPSeg to SAM/GroundingDINO

### Current CLIPSeg Behavior & Features
- **Model**: `CIDAS/clipseg-rd64-refined` (under 200MB, quick startup, fits within general VRAM budget).
- **Function**: Takes a text query (e.g. "the wizard") and returns a low-resolution heatmap of pixel probabilities, which is resized and thresholded (> 0.3) into a binary mask.
- **Feathering**: Extends mask bounds using `MaxFilter(21)` dilation and `GaussianBlur(8)` blur.

### Limitations of Current CLIPSeg
- **Spatial / Object Resolution**: Resolution is extremely low (64x64 internally), causing jagged boundaries or missing fine details (e.g., thin poles, fingers).
- **Semantic Overlap**: Often struggles to segment one object when multiple similar ones overlap or are near each other.
- **Scale Issues**: Very small objects or background elements fail to excite the text encoder, returning empty or incomplete masks.

### Future Path: SAM & GroundingDINO Integration
- **GroundingDINO**: A zero-shot object detector that will generate high-quality bounding boxes from text queries.
- **Segment Anything Model (SAM)**: Uses GroundingDINO's bounding boxes as prompts to produce high-resolution, pixel-perfect instance segmentations.
- **Expected Benefits**: Sharp, high-fidelity mask edges, distinct object separation, and robust detection of small/obscured objects.

### Implementation Dependencies & Deferred Rationale
- **Footprint**: SAM + GroundingDINO models are significantly larger (1.5GB to 3GB+ combined), adding heavy startup overhead.
- **Dependencies**: Requires extra complex libraries (`torchvision`, `supervision`, or custom CUDA extensions) which complicate multi-platform installation (especially on Windows).
- **VRAM Constraints**: Running SAM alongside SDXL, LLM chat, and vision models easily exceeds standard consumer GPU limits (e.g., 8-16 GB).
- **Role of Mask Preview**: Exposing the mask preview helper command (`@SeekDeep mask preview <target>`) allows testing/debugging CLIPSeg boundaries locally before spending GPU cycles on full diffusion inpainting.

## Persistent Memory Roadmap

### 1. Current State: Rolling Memory
Currently, SeekDeep utilizes in-memory rolling buffers (`getRecentContext`, `remember`) which maintain conversational state in RAM per-channel/thread. When the bot restarts, or after active contexts expire from memory, this state is lost.

### 2. Proposed Persistence: Per-User and Per-Channel JSON
To support long-term context retention across restarts, we propose a JSON-based file persistence layer:
- **Scope**: User-specific memories (e.g., preference overrides, user profile notes) stored in `data/user-memories.json` and channel-specific memories (e.g., context summaries, pinned facts) in `data/channel-memories.json`.
- **Atomic Operations**: Read-on-demand with atomic writes to guarantee file integrity, matching the patterns in `auto-reactions.json` and `prompt-templates.json`.

### 3. Privacy Controls & Opt-Outs
- **Per-Server Disable Switch**: Server admins can completely disable memory storage for their guild using `@SeekDeep memory feature off` (stored in `persona-overrides.json`).
- **Privacy Controls**: Opt-in/opt-out configuration for individual users so they can request SeekDeep not to record any long-term memories about them.

### 4. Memory Administration Commands
- **Remember/Forget**: Users can instruct the bot to store or purge facts explicitly:
  - `@SeekDeep remember that I prefer Python over JavaScript`
  - `@SeekDeep forget my coding preferences`
- **Export/Clear**: Commands to inspect and wipe all recorded data:
  - `@SeekDeep memory export` (returns a JSON file of stored data for that user).
  - `@SeekDeep memory clear` (wipes all personal data).

### 5. Retention Limits & Optimization
- **Limits**: Stored memories will be capped at a maximum of 25 facts per user/channel, or 10 KB per profile, to prevent unbounded file growth.
- **Pruning**: Least-recently-used (LRU) entries or oldest timestamps will be pruned automatically when limits are reached.

### 6. Why Deferred
- **Context Injection Cost**: Persisting memories requires semantic search (e.g., local vector store/embeddings) or model-based summarization to decide when to inject memories into the LLM system prompt.
- **Model Attention Spans**: Randomly injecting long lists of facts burns context window tokens and degrades attention/performance on lightweight models (Gemma-2B/3B).
- **Scope Isolation**: Deferred to a future release to keep Phase D focused on admin telemetry, permission diagnostics, and search safety controls.

## Deferred

- **`shouldAutoSearch` refactor** -- only worth doing if a second consumer needs the same lists.
- **`seekdeepLegacyArchiveUserThreadName` migration** -- needs one-time migration tool.

## Won't Do

- **Quote Cards** (from demonbot) -- explicitly skipped.
- **Game Lookup** (from demonbot) -- explicitly skipped.
- **Further messageCreate handler extraction** -- remaining lines ARE orchestration.
