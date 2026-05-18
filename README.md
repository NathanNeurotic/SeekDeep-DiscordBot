# SeekDeep Discord Bot

SeekDeep is a local AI-powered Discord bot for chat, vision, image generation, web search, and image archiving.

## Current Local Stack

- Discord bot: `index.js`
- Local AI server: `local_ai_server.py` at `http://127.0.0.1:7865`
- Chat model: `Qwen/Qwen3-8B`
- Vision model: `Qwen/Qwen2.5-VL-3B-Instruct`
- Image model: `Lykon/dreamshaper-xl-1-0`
- Web search: local SearXNG at `http://127.0.0.1:8080`
- Model cache: `./models/huggingface`
- Launcher: `seekdeep_launcher.bat`

## Architecture

SeekDeep has two main runtime pieces:

1. The Node.js Discord bot routes messages, slash commands, buttons, memory, archive actions, and response formatting.
2. The Python FastAPI local AI server loads one local task at a time using `MODEL_KEEP_MODE=task-lru`.

The local AI server exposes:

- `GET /health`
- `POST /chat`
- `POST /vision`
- `POST /image`
- `POST /unload`

## Quick Start

1. Install dependencies:
   ```powershell
   setup_local.ps1
   npm install
   ```

2. Configure `.env`:
   ```text
   DISCORD_TOKEN=your_discord_bot_token
   LOCAL_CHAT_MODEL_ID=Qwen/Qwen3-8B
   LOCAL_VISION_MODEL_ID=Qwen/Qwen2.5-VL-3B-Instruct
   LOCAL_IMAGE_MODEL_ID=Lykon/dreamshaper-xl-1-0
   ```

3. Start the full local stack:
   ```powershell
   seekdeep_launcher.bat
   ```

4. Choose launcher option `8` for a clean start of SearXNG, local AI server, and Discord bot.

The launcher can also start only the local AI server or only the Discord bot when needed.

## Commands

SeekDeep supports both slash commands and mention commands.

Common examples:

```text
@SeekDeep help
@SeekDeep status
@SeekDeep cache status
@SeekDeep queue status
@SeekDeep ask what are you?
@SeekDeep draw me a goomba
@SeekDeep generate me
@SeekDeep archive setup here
@SeekDeep archive shared
```

Slash equivalents include:

```text
/ask
/refine
/image
/vision
/status
/help
/cachestatus
/archivestatus
/recent
```

See [COMMANDS.md](COMMANDS.md) for the full command map.

## Conversation Memory

Chat uses rolling channel memory by default, so a short sequence of requests can carry earlier goals, constraints, names, and decisions forward. Utility commands, archive commands, status/cache/queue checks, identity questions, and image prompts do not inject chat memory.

Relevant knobs (defaults shown — `.env.default` may differ from the running `.env`):

```text
SEEKDEEP_MEMORY_MODE=rolling
MAX_CONTEXT_MESSAGES=40
MAX_CONTEXT_CHARS=24000
SEEKDEEP_MEMORY_RECENT_ENTRIES=30
SEEKDEEP_MEMORY_CONTEXT_CHARS=20000
```

Set `SEEKDEEP_MEMORY_MODE=followup` to return to conservative follow-up-only memory, or `off` to disable memory injection.

Optional per-user **memory presets** layer on top: `@SeekDeep memory preset add brief` / `expert` / `no-emoji` / `formal` / `casual`, or a custom line. They're rendered as system-prompt hints whenever that user is the requester. `@SeekDeep memory preset list | remove <key> | clear`.

## Image Generation

Image requests support:

- Original prompt generation
- Dynamic AI-refined prompt generation using the local chat model
- `Original`, `Refined`, and `Both` prompt-choice buttons
- `Download`, `Archive`, and `Shared Archive` buttons
- Missing-subject follow-up flow, for example `@SeekDeep generate me`
- Optional raw/unrefined mode via `raw`, `unrefined`, `--raw`, or `no refine`

Dynamic refinement is enabled by default:

```text
SEEKDEEP_IMAGE_PROMPT_MAX_CHARS=650
SEEKDEEP_IMAGE_PROMPT_DYNAMIC_REFINEMENT=true
SEEKDEEP_IMAGE_PROMPT_DYNAMIC_TIMEOUT_MS=180000
```

While dynamic refinement runs, SeekDeep shows a visible prompt-refinement status and then edits it into the Original / Refined / Both choice. If dynamic refinement fails or times out, SeekDeep falls back to its local static prompt cleanup instead of failing the image request.

## Archive System

SeekDeep can archive generated images into server archive threads.

Admin setup examples:

```text
@SeekDeep archive setup here
@SeekDeep setup archive here
@SeekDeep archive setup #channel
```

User examples:

```text
@SeekDeep archive me
@SeekDeep archive @user
@SeekDeep archive shared
@SeekDeep archive status
@SeekDeep archive status @user
```

Natural-language archive of the most recent SeekDeep image in the channel (no button click required):

```text
@SeekDeep archive this | archive it | archive too | archive that | archive the image
@SeekDeep save this | save it | save the image
@SeekDeep add this to my archive | put it in my archive | make it archive too
@SeekDeep share this | shared archive this | save to shared archive
```

Each archive entry in the thread now has:

- A **Download** link to the full-resolution image (direct CDN URL).
- A grey **Delete from Archive** button that removes that single entry and updates the thread's count.

Browse the newest 10 entries in your archive thread via slash command:

```text
/recent kind:archive
```

Archive thread names track archived generation entries, not general messages. Archive actions require Discord thread storage to be configured and working.

## Right-click Context Menu Commands

Right-click any Discord message → **Apps** → SeekDeep submenu. Five message context menu commands ship by default; a sixth is flag-gated off.

| Command | Action |
|---|---|
| **Generate Image from this** | Use the message text as an image prompt, queue Original generation. |
| **Refine as Image Prompt** | Rewrite the message text as a stronger image prompt. Refuses non-image input. |
| **Inspect (SeekDeep)** | Ephemeral debug card: IDs, timestamps, attachments, buttons, and any cached SeekDeep image state. |
| **Translate (SeekDeep)** | Translate / decode the message text to plain English. |
| **Compare with previous** | Compare this message against the prior non-bot message in the channel. |
| **Force React (SeekDeep)** *(disabled by default)* | Paginated emoji picker — pick up to 5 custom emoji from a 4-select-menu grid, applied as reactions to the target message. Enable with `SEEKDEEP_FEATURE_FORCE_REACT=on` in `.env`. Off by default so SeekDeep doesn't fight demonbot for the same slot in shared servers. |

By default the **Refine / Translate / Compare** results post publicly so everyone in the channel sees them. Flip the corresponding `SEEKDEEP_CONTEXT_*_EPHEMERAL=on` env var to make any one of them ephemeral (only the clicker sees it).

## Chat Model Roles

Chat responses are routed to a role-specific model. Image generation still uses `/image` and vision still uses `/vision`; only chat-style inference is role-aware.

Roles:

- `default_chat` — normal conversation, image prompt refinement, casual/simple questions, default fallback path.
- `quality_text` — detailed explanations, comparisons, pros/cons, planning, strategy, long-form answers.
- `reasoning_code` — code, stack traces, logs, debugging, architecture, repo edits, PowerShell/Python/JavaScript/TypeScript/Node/FastAPI/Transformers/CUDA/VRAM questions.
- `fallback_chat` — used automatically when the selected role fails to load or generate.
- `lightweight_chat` — optional low-VRAM fallback, only loaded if `LOCAL_CHAT_LIGHTWEIGHT_MODEL_ID` is set and `--include-optional` is passed to warmup.

Configure role models in `.env`:

```text
LOCAL_CHAT_MODEL_ID=Qwen/Qwen3-8B
LOCAL_CHAT_FALLBACK_MODEL_ID=ibm-granite/granite-3.3-8b-instruct
LOCAL_CHAT_QUALITY_MODEL_ID=mistralai/Mistral-Nemo-Instruct-2407
LOCAL_CHAT_REASONING_MODEL_ID=microsoft/phi-4
LOCAL_CHAT_LIGHTWEIGHT_MODEL_ID=google/gemma-3n-E4B-it
MODEL_AUTO_FALLBACK=true
MODEL_ROUTER_LOG=true
MODEL_LOG_VRAM=false
```

To disable role routing, set `LOCAL_CHAT_FALLBACK_MODEL_ID`, `LOCAL_CHAT_QUALITY_MODEL_ID`, and `LOCAL_CHAT_REASONING_MODEL_ID` to the same value as `LOCAL_CHAT_MODEL_ID`. Image prompt refinement always uses `default_chat` regardless of prompt text.

The local AI server keeps a single chat model in VRAM at a time. Switching chat roles unloads the previous chat model (CUDA cache is cleared), then loads the new one through the existing `AutoTokenizer` + `AutoModelForCausalLM` path.

## Model Cache

Models are cached locally under:

```text
./models/huggingface
```

This is the SSD model library SeekDeep loads from. VRAM is only the temporary active workspace — models load from the SSD cache into VRAM when needed and unload when switching tasks. After the first online warmup, no internet is required for model loading; only SearXNG/web search needs internet.

### Online setup phase (one-time)

Make sure online mode is on (default in `.env.default`), then warm the configured models:

```powershell
unlock_seekdeep_model_cache_online.ps1
python warmup_local_cache.py
```

Targeted warmup variants:

```powershell
python warmup_local_cache.py --chat-only
python warmup_local_cache.py --chat-only --include-optional
python warmup_local_cache.py --include-optional
python warmup_local_cache.py --skip-image
python warmup_local_cache.py --skip-vision
```

When a model fails to download, the warmup prints a hint about `HF_TOKEN` and accepting the model's terms on Hugging Face for gated models, then continues with the remaining models. The script exits nonzero if any required model failed.

**Optional: pin a model to a specific commit / tag / branch.** Set `<ENV_VAR>_REVISION` in `.env` to lock the downloaded files so future warmups don't pick up silent upstream updates that change behavior:

```text
LOCAL_CHAT_MODEL_ID_REVISION=8a5f2c0
LOCAL_CHAT_REASONING_MODEL_ID_REVISION=main
LOCAL_IMAGE_MODEL_ID_REVISION=v1.0
```

Look up commit SHAs on the model's Hugging Face page under "Files and versions" → click a commit. Leaving the `_REVISION` var unset takes the latest default branch.

### Offline runtime phase

After warmup succeeds for the active models, lock the bot to local cache only:

```powershell
lock_seekdeep_model_cache_offline.ps1
```

This sets `HF_LOCAL_FILES_ONLY=true` (and related offline env flags). SeekDeep will then load every model from the SSD cache without contacting Hugging Face. If a configured model is not in the SSD cache while offline, the server returns a clean error asking you to unlock and rerun warmup. SearXNG/web search may still need internet.

### Cache audit and cleanup

Audit only — never deletes anything:

```powershell
python warmup_local_cache.py --audit-cache --show-unused
```

The audit lists configured active models, cached models still in use, cached models that look unused, optional models that are configured but missing, and reclaimable disk if unused models are quarantined.

Move unused cached repos to quarantine (safe, reversible — folders are moved to `models/_quarantine/YYYYMMDD-HHMMSS/`, never deleted):

```powershell
python warmup_local_cache.py --prune-unused --quarantine
```

After confirming the bot still starts and `/chat`, `/image`, `/vision` still work, permanently delete the quarantined folders:

```powershell
python warmup_local_cache.py --purge-quarantine
```

Purge only ever touches folders already under `models/_quarantine/`. It never deletes active configured models, source code, `.env`, `outputs/`, `saved_generations/`, `logs/`, `backups/`, `checkpoints/`, `node_modules/`, or `.venv/`. Cache entries that cannot be confidently mapped to a Hugging Face repo are always skipped by both prune and purge.

### npm script shortcuts

```text
npm run setup:models
npm run setup:chat-models
npm run setup:models:optional
npm run setup:chat-models:optional
npm run audit:model-cache
npm run prune:model-cache
npm run purge:model-cache-quarantine
```

## Tunables

Common `.env` knobs added since the role-routing refactor:

```text
# Chat-model quantization. 4bit fits 12-14B models on 24GB VRAM; ~1-2% quality drop.
LOCAL_CHAT_QUANT=4bit                     # options: 4bit | 8bit | none
LOCAL_CHAT_QUANT_FULL_ROLES=default_chat,fallback_chat   # roles that skip quant (8B models)

# Context / output
MAX_CONTEXT_MESSAGES=40                   # rolling memory turns kept
MAX_CONTEXT_CHARS=24000                   # rolling memory chars kept
SEEKDEEP_MEMORY_RECENT_ENTRIES=30         # injected context turns
SEEKDEEP_MEMORY_CONTEXT_CHARS=20000       # injected context chars
CHAT_MAX_NEW_TOKENS=2400                  # default max output tokens for askChat
CHAT_TEMPERATURE=0.7                      # default chat creativity

# Web search
MAX_WEB_RESULTS=12                        # SearXNG hits passed to the model

# Image generation
SEEKDEEP_IMAGE_COOLDOWN_MS=15000          # per-user image cooldown (15s default)
SEEKDEEP_PENDING_IMAGE_PROMPT_TTL_MS=900000   # Original/Refined/Both button TTL (15min)
SEEKDEEP_PENDING_IMAGE_SUBJECT_TTL_MS=900000  # 'generate me' follow-up TTL (15min)
SEEKDEEP_DYNAMIC_REFINE_CACHE_TTL_MS=600000   # refined-prompt reuse window (10min)

# Logging
SEEKDEEP_FILE_LOGGING=on                  # mirror console output to logs/seekdeep-YYYY-MM-DD.log
MODEL_ROUTER_LOG=true                     # [SeekDeep Model Router] role decision lines
MODEL_LOG_VRAM=false                      # log VRAM allocated/reserved before/after model load
```

The bot console mirrors to `logs/seekdeep-YYYY-MM-DD.log` by default; set `SEEKDEEP_FILE_LOGGING=off` to disable. Token-like strings (`hf_*`, `sk-*`, Discord token shape) are redacted in the file.

Admin user IDs with priority queue access:

```text
SEEKDEEP_ADMIN_IDS=123456789012345678,234567890123456789
```

Image generation jobs from listed admins get queue priority (jump ahead of non-admin pending jobs).

## Feature Flags

Optional features are gated behind `SEEKDEEP_FEATURE_*` env vars in `.env`. All default to `off`. Flip to `on` and restart to enable.

| Flag | Default | What it gates |
|---|---|---|
| `SEEKDEEP_FEATURE_EMOJI_VAULT` | off | `@SeekDeep emoji backup/import/count/list` commands. Off so SeekDeep doesn't fight demonbot for the same vault thread in shared servers. |
| `SEEKDEEP_FEATURE_FORCE_REACT` | off | Right-click "Force React (SeekDeep)" context menu + paginated emoji picker. Same demonbot-coexistence reason. |
| `SEEKDEEP_FEATURE_IMG2IMG` | off | `/image style:img2img` and right-click "Vary this". Requires SDXL pipeline exposing img2img (works in `diffusers >= 0.27`). Scaffolded but not wired into a UI yet. |
| `SEEKDEEP_FEATURE_UPSCALE_REALESRGAN` | off | Right-click "Upscale 2x" on a generated image. Requires Real-ESRGAN weights + a Python endpoint. Scaffolded. |
| `SEEKDEEP_FEATURE_NSFW_GATE` | off | Scores generated images via a CLIP NSFW classifier and either spoiler-wraps or refuses based on threshold. Scaffolded. |
| `SEEKDEEP_FEATURE_TTS_VOICE` | off | Voice-channel TTS reader (Piper / XTTS). Scaffolded. |
| `LOCAL_VISION_KEEP_RESIDENT` | on (in your `.env`) / off (in `.env.default`) | Pins the vision model in VRAM across task switches. |
| `LOCAL_IMAGE_KEEP_RESIDENT` | off | Same for the SDXL image pipeline. Image is bursty enough that pinning it usually isn't worth the VRAM. |

## Health Checks

Local AI server:

```powershell
curl http://127.0.0.1:7865/health
```

Full preflight (recommended after any source change):

```powershell
npm run preflight
```

Runs `node --check` on the JS files, `python -m py_compile` on the Python files, and `npm run smoke` in one go. ~1 second total. Exit code 0 only when every stage passes.

Individual checks:

```powershell
node --check index.js
.\.venv\Scripts\python.exe -m py_compile .\local_ai_server.py
npm run smoke
```

## Troubleshooting

- If `@SeekDeep status` reports `ECONNREFUSED`, start the local AI server from the launcher.
- If image generation is slow after chat/refinement, the server may be switching from the chat model back to the image model.
- If SearXNG fails, check the Docker container on port `8080`.
- If archive setup fails, verify the bot has access to the chosen archive channel and can create/manage threads.
- If `Fallback used: role=fallback_chat ...` appears in a chat reply footer, the originally-routed role failed to load (typically CUDA OOM) and the server fell back to `fallback_chat`. Check `LOCAL_CHAT_QUANT` and consider pinning more roles in `LOCAL_CHAT_QUANT_FULL_ROLES`.

## Release Notes

### v10.15 — .env.default quantization fix

`.env.default` shipped `LOCAL_CHAT_QUANT_FULL_ROLES=default_chat,fallback_chat` since v10.1, forcing Qwen3-8B to load at fp16 (~15.6 GB VRAM). On a 24 GB laptop GPU that leaves zero headroom for the task-LRU swap to SDXL during image generation — the transient peak exceeds 24 GB, NVIDIA's Windows driver spills into shared system memory, and the entire desktop locks up. Fix: ship the list empty so `default_chat` gets 4-bit-quantized (~5 GB VRAM), leaving ~10 GB of headroom. Quality cost is ~1–2% on benchmarks (NF4 + double-quant + bf16 compute). Desktop users with 32 GB+ VRAM can re-add `default_chat,fallback_chat` to the list if they want fp16 nuance back.

### v10.14 — subject-preservation threshold loosened

v10.13's rejection logging exposed the real cause of a user-reported "static rules after AI refinement was unavailable" message: the subject-preservation validator was rejecting good refinements like "a vanilla colored ant from the movie antz" because unfilmable franchise words ("antz", "bugs", "life") inflated the keyword count. The old threshold `max(2, ceil(N * 0.45))` required 4 of 8 keywords; the refinement correctly kept 3 (vanilla, colored, ant) and intelligently translated the franchise references into visual style cues. New threshold: `max(2, min(ceil(N * 0.25), 3))` — caps required matches at 3 for medium/long prompts so subject-relevant keywords aren't drowned out by non-visual filler. 8 new smoke checks test the boundary cases.

### v10.13 — dynamic image refine: preamble stripping + rejection logging

Two fixes to the dynamic image-prompt refiner. (1) `seekdeepCleanDynamicImagePrompt` now strips benign chat-model openers ("Sure, here's the refined prompt:", "Okay!", "Here you go:") before the refusal check. Small chat models often answer correctly but lead with conversational preamble, and the old refusal-detector regex matched the first word of these replies and discarded the entire refined prompt. Real refusals ("I can't help with that", "As an AI…") survive because they don't fit the opener + separator + payload shape. (2) Every rejection now logs its reason (`[SeekDeep] dynamic refine rejected (reason) for "original" -> "candidate"`) so silent fallbacks to static rules are diagnosable instead of invisible. 12 new smoke checks cover preamble stripping, refusal detection, and the logging path.

### v10.12 — live GPU / VRAM monitoring

Built in response to an observed lag pattern: the host would severely lag after a couple of image generations, likely VRAM thrashing into Windows shared memory once chat + pinned vision + SDXL coexisted past the GPU's hardware VRAM budget.

- `local_ai_server.py` exposes `gpu_stats()` via new `/gpu` endpoint and a `gpu` sub-object on `/health`. Returns `allocated_mb`, `reserved_mb`, `free_mb`, `total_mb`, `used_mb`, `used_pct`, `reserved_pct`, plus `loaded` and `keep_resident` state.
- `@SeekDeep gpu` / `@SeekDeep vram` natural commands and `/gpu` slash command.
- Live-tail mode: `@SeekDeep gpu watch [N]` or `/gpu watch:true interval:N`. Edits one message every N seconds (clamped 2–60). Auto-stops after 2 minutes. React ✋ to stop early. Per-channel single-active-watcher lock.
- `@SeekDeep status` now shows a one-line GPU summary at the top plus a thrashing warning when PyTorch's reserved pool ≥ 90% of total VRAM.
- 17 new smoke checks covering the bar renderer, formatter, thrashing detector, and watch-interval parser.

### v10.11 — documentation pass

Audit and rewrite of all project documentation. Created `PLANNED.md` to track deferred work, scaffolded features, QoL wishlist, and won't-do decisions. Pruned 4 legacy text files (42.5k lines of stale inventory and readme fragments). Updated `AGENTS.md`, `COMMANDS.md`, `CONTRIBUTING.md`, `REQUIREMENTS.md`, `SECURITY.md`, and `SMOKE_TEST.md` to reflect v10.0–v10.10 changes.

### v10.10 — visual-attachment helper dedup

Final audit cleanup. Replaced `seekdeepAttachmentLooksVisual` and `seekdeepFirstVisualAttachment` with the stricter, more thorough `seekdeepLooksLikeVisualAttachment` and `firstVisualAttachmentFrom` (handles forwarded-message snapshots + embed image URLs). Simplified `seekdeepGetReplyVisualAttachment` from 10 lines to 2 via `fetchRepliedMessage` + `firstVisualAttachmentFrom`. Documented `seekdeepLegacyArchiveUserThreadName` as intentional backward-compat for pre-v10 archive threads.

### v10.9 — messageCreate handler split (632 → 112 lines)

The anonymous `client.on('messageCreate', ...)` handler was the largest construct in `index.js`. Now extracted into two named helpers:

- `seekdeepDispatchAddressedMessage(message, ctx)` — the ~370-line route dispatcher (reply-translate, chat-ask, image-direct-alias, pending-image-subject V1/V2, vision, raw-image, research-table, chat fallback, and all utility routes).
- `seekdeepProcessPreAddressMessageRoutes(message)` — the ~140-line pre-mention archive routes (config, status, search, persona, memory presets, stats, digest, reactrule, emoji vault, natural-archive followups).

The remaining 112 lines in `messageCreate` are gate checks + address-validation + dispatcher calls. Route order and error handling preserved bit-identically.

### v10.8 — SendImageWithButtons consolidation

The 4th and final Message/Interaction send-pair merged. `seekdeepSendImageWithButtons(target, ...)` replaces the 219-line Message variant + 126-line Interaction variant. 20 call sites rewritten. Two latent bugs fixed in passing (an undefined-`message` ref in the Interaction variant; a dead-code empty `seekdeepRefinedPromptLine` call in the Message variant).

### v10.7 — Message/Interaction send-pair consolidation (3/4)

New `seekdeepReplyToTarget(target, payload, options?)` helper sniffs whether the target is a `Message` or an `Interaction` and dispatches to the appropriate reply API. Three near-identical Message/Interaction pairs collapsed:

- `seekdeepPostArchive(target)` ← `…FromMessage` + `…FromInteraction`
- `seekdeepPostRecentImages(target, limit)` ← same pattern
- `seekdeepSendImagePromptChoice(target, ...)` ← same pattern

The `previousReply` option lets the Message path edit a prior reply handle, matching `Interaction.editReply` semantics for the "preparing → final" flow.

### v10.6 — V13/V14/V15 wrapper consolidation

Deleted six passthrough wrappers (`seekdeepRememberSafeV13`, `seekdeepMemoryKeyFromSafeV13`, `seekdeepGetRecentContextSafeV13`, `seekdeepShouldUseMemorySafeV13`, `seekdeepBuildPromptWithMemorySafeV14`, `seekdeepBuildSearchQuerySafeV15`) that were one-liner `return realFn(...)` forwarders. 87 call sites rewritten to invoke `remember`, `memoryKeyFrom`, etc. directly.

### v10.5 — hygiene pass + Discord-mock test harness

- 25 dead top-level functions deleted (~700 LOC).
- New `SEEKDEEP_TEST_MODE=1` gate. When set, `index.js` skips `client.login()` and exposes whitelisted pure helpers on `globalThis.__seekdeepTest` so smoke tests can exercise the **real** functions instead of mirrored copies.
- `smoke_test.mjs` refactored to import index.js with test mode and route checks through real helpers. 55 → 61 checks.
- `scripts/preflight.mjs` + `npm run preflight` — runs `node --check` + `python -m py_compile` + smoke test in ~1 second.
- New `seekdeepFetchWithLimits(url, { timeoutMs, maxBytes })` helper. Replaces 3 raw `fetch(attachment.url)` calls (vision, reactrule import, emoji vault import) with timeout + Content-Length precheck. Env knobs: `SEEKDEEP_FETCH_DEFAULT_TIMEOUT_MS`, `SEEKDEEP_FETCH_DEFAULT_MAX_BYTES`.
- 9 hardcoded `.slice(0, 1900)` → `.slice(0, MAX_DISCORD_CHARS)`; 2 duplicate hardcoded 5-min TTLs → `SEEKDEEP_EMERGENCY_SEEN_TTL_MS`.

### v10.4.4 — feature-flag Force React, default off

`SEEKDEEP_FEATURE_FORCE_REACT=off` (default) hides the right-click "Force React (SeekDeep)" entry, refuses the dispatcher route, and tears down any stale picker UI. Set to `on` to re-enable. The reason: demonbot ships an identical feature in shared servers and we don't want to fight over the right-click slot.

### v10.4.3 — feature-flag the emoji vault, default off

`SEEKDEEP_FEATURE_EMOJI_VAULT=off` (default) suppresses the `@SeekDeep emoji backup/import/count/list` commands and hides their block from `@SeekDeep help`. Same demonbot-coexistence reason.

### v10.4.2 — Emoji vault thread + ZIP backup

`@SeekDeep emoji backup` (when the feature flag is on) finds or creates a dedicated `<Guild> — Emojis` thread, posts paginated emoji previews (Animated section then Standard section, 20 per page with previews + names + IDs), attaches a JSON manifest, and attaches a ZIP containing every emoji image for portable restore. `emoji import` accepts either the JSON or the ZIP. New dep: `jszip ^3.10.1`.

### v10.4.1 — Force React paginated emoji picker

Replaced the text-input modal with a paginated picker matching demonbot.win's UX: 4 collapsible select menus × 25 emoji per page, nav row with Prev/Next/Apply/Cancel buttons, per-user-per-target-message TTL state with 5-emoji cap.

### v10.4 — help topics, vision pin, chunker hardening

- **`@SeekDeep help <topic>`** slices the help to a single section. Topics: `chat`, `image`, `vision`, `archive`, `model`, `recent`, `admin`, `reactrule`, `emoji`, `context`, `all`. Both `help chat` and `chat help` work. `/help` gained a `topic:` option with the same choices.
- **Vision keep-resident**: set `LOCAL_VISION_KEEP_RESIDENT=on` in `.env` to pin the vision model in VRAM across task switches. Eliminates unload/reload cost when alternating chat ↔ vision. On a 24GB GPU, chat 8B at 4-bit + vision 3B at fp16 is a comfortable budget. `LOCAL_IMAGE_KEEP_RESIDENT=on` does the same for the SDXL pipe. Explicit `POST /unload` still clears everything regardless of pins.
- **Fence-aware Discord chunker** (v10.3.1): `splitDiscordText` now tracks open code fences. When a long reply needs to be split across multiple Discord messages, the chunker closes the open ` ``` ` on the cut chunk and reopens with the same language hint on the next. Fixes mangled `@SeekDeep help` output where `## Section` headers appeared between fences as raw markdown.

### v10.3 — demonbot-inspired features

Ports five features from [demonbot.win](https://www.demonbot.win/). Quote Cards and Game Lookup intentionally skipped.

- **Auto Reactions**: per-guild rules in `data/auto-reactions.json`. Substring match by default, or `/regex/flag` form. Built-in stacking triggers (`long_message`, `forwarded`, `code_block`, `image_only`, `link_only`) can be toggled individually. Manage with `@SeekDeep reactrule add/list/remove/toggle/builtin/export/import`.
- **Force React** *(disabled by default since v10.4.4)* — paginated emoji picker.
- **`/say`**: admin-only anonymous posting. `Manage Messages` required. Strips `@everyone`, `@here`, and role mentions.
- **Emoji Vault** *(disabled by default since v10.4.3)* — thread-based backup with ZIP.

### v10.2

Tier-1 UX wins, strengthening, polish, and several T2/T3 features. Highlights: persona overrides, memory presets, server stats, daily digest, did-you-mean fuzzy suggestions, frustration filter with word-count guards, refined-prompt cache for the regenerate buttons, vision follow-up auto-route, KK-Slider-style proper-noun lookups, image quality/style presets on `/image`.

### v10.1

23-item polish pass: cooldown progress bar, prompt-choice TTL extension, refined-prompt cache, archive numbering fix, full-res Download button + grey Delete-from-Archive button on archive entries, audit/quarantine/purge for the HF cache, role-aware chat model selection (`default_chat` / `quality_text` / `reasoning_code` / `fallback_chat` / `lightweight_chat`) with 4-bit quantization for the big roles on 24GB VRAM.

## Development Notes

The project is git-tracked from `v10.0-baseline` onward. The old, broken `.git/` directory was renamed to `.git.broken_*` on init. Checkpoints under `checkpoints/` remain as historical snapshots from before git was set up.

```powershell
git log --oneline
git tag                 # v10.0-baseline tags the first commit
git status              # see local changes
npm run preflight       # node --check + py_compile + smoke test, ~1 second total
npm run smoke           # smoke test only (no Discord, no model load)
```

The smoke test imports `index.js` with `SEEKDEEP_TEST_MODE=1` so it can exercise real helpers (chunker, frustration filter, regex predicates, help text renderer, emoji-vault math, force-react picker math) instead of inline mirrors. See `globalThis.__seekdeepTest` in `index.js` for the whitelisted exports.

For internal component notes, see [AGENTS.md](AGENTS.md).
For system requirements, see [REQUIREMENTS.md](REQUIREMENTS.md).
For planned work and deferred improvements, see [PLANNED.md](PLANNED.md).
