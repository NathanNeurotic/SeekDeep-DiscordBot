# Planned Work & Deferred Improvements

This file tracks everything that's been discussed, scoped, or partially scaffolded but not yet shipped. Items here are not commitments — they're a parking lot for "next time we sit down with this codebase, here's what's on deck."

Last full audit: 2026-05-19

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

## Deferred

- **`shouldAutoSearch` refactor** -- only worth doing if a second consumer needs the same lists.
- **`seekdeepLegacyArchiveUserThreadName` migration** -- needs one-time migration tool.

## Won't Do

- **Quote Cards** (from demonbot) -- explicitly skipped.
- **Game Lookup** (from demonbot) -- explicitly skipped.
- **Further messageCreate handler extraction** -- remaining lines ARE orchestration.
