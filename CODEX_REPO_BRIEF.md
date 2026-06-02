# Codex Repo Brief - SeekDeep Discord Bot

> **Sister docs:**
> - **[README.md](README.md)** — user-facing install / commands / tunables.
> - **[AGENTS.md](AGENTS.md)** — architecture canonical: what each agent/subsystem does. When this brief and AGENTS.md disagree about an agent's behavior, **AGENTS.md wins**; update this brief.
> - **[INTEGRATION.md](INTEGRATION.md)** — GUI ↔ FastAPI wiring.
> - **[MAINTAINER.md](MAINTAINER.md)** — designer-zip merge protocol + audit overrides.
>
> This file is the **onboarding brief**: read it first when picking up the repo cold, then dive into the specific code path. Compact map, not a replacement for reading the actual functions.

This file is a fast handoff for future repo work. It is intentionally a compact map, not a replacement for reading the touched code path. Use it first, then verify the specific functions/files involved in the task.

Line numbers below are from the snapshot when this file was created and will drift. Function names, file names, and route names are the stable lookup keys.

## Current Snapshot

- Repo root: `/mnt/c/Users/natha/SeekDeep-DiscordBot`
- Branch at snapshot: `main`
- Latest commit at snapshot: `7a73168 v10.31: context menus, mention commands, per-user memory, help rewrite` (historical; line/commit references in this brief are snapshot-time, not current)
- Package version: now `10.35.0` in `package.json` (was `10.0.0-fresh-rebuild` at snapshot). Server `FastAPI(version=...)` reads from `package.json` via `_read_pkg_version()` rather than the old hard-coded literal.
- Pre-existing dirty files before this brief was created:
  - `index.js`
  - `seekdeep_launcher.bat`
- Do not overwrite or revert those pre-existing changes unless the user explicitly asks.
- This brief is the only file created for the "DO NOT CHANGE ANY CODE" request.

## Prime Directive For This Repo

- Work evidence-first. Use actual files, logs, errors, and runtime behavior.
- Prefer minimal bounded diffs that preserve the single-file bot architecture.
- Do not touch `.env`, `keys.txt`, logs, model cache, generated outputs, or runtime data unless specifically needed and safely redacted.
- Preserve working launch flows, Discord routing, local model behavior, archive behavior, and prior fixes.
- Keep docs aligned when behavior changes: `README.md`, `COMMANDS.md`, `REQUIREMENTS.md`, `AGENTS.md`, `SMOKE_TEST.md`, `PLANNED.md`, `.env.default`, and `SECURITY.md`.

## Repo Shape

Core files:

- `index.js` - main Node ESM Discord bot, about 17.3k lines at snapshot.
- `local_ai_server.py` - FastAPI local model server, about 1.4k lines.
- `smoke_test.mjs` - automated regression smoke tests against real helper functions.
- `scripts/preflight.mjs` - one-command JS/Python/smoke preflight runner.
- `seekdeep_launcher.bat` - Windows launcher for SearXNG, local AI server, and bot.
- `.env.default` - committed configuration template. `.env` is local secret state.
- `searxng/settings.yml` - local SearXNG config.
- `warmup_local_cache.py` - Hugging Face model cache warmup/audit/prune utility.
- `requirements-local.txt` - Python deps, including CUDA PyTorch from cu128 extra index.

Docs:

- `AGENTS.md` - subsystem map and helper entry points.
- `README.md` - architecture, setup, env knobs, feature flags, release notes.
- `COMMANDS.md` - user-facing command map with permissions.
- `REQUIREMENTS.md` - runtime requirements, env shape, verification.
- `SMOKE_TEST.md` - automated and live Discord smoke checklist.
- `PLANNED.md` - shipped history, deferred work, optional features.
- `CONTRIBUTING.md` - local setup and coding rules.
- `SECURITY.md` - secrets, local services, user URL fetch policy.

Large/runtime/local dirs:

- `models/`, `outputs/`, `saved_generations/`, `temp/`, `logs/`, `backups/`, `checkpoints/`, `diagnostics/`, `.venv/`, `node_modules/` are local/runtime and gitignored.
- All runtime `data/*.json` files are gitignored (current policy — `archive-guild-config.json` was briefly tracked at snapshot but contains Discord IDs and is now ignored). What's actually tracked: `data/.gitkeep` and `data/archive-guild-config.sample.json` (schema reference only).

Security-sensitive files present locally:

- `.env`
- `keys.txt`
- `logs/`
- `data/*.json`

Do not print these contents into chat unless the task explicitly requires it and secrets/IDs are redacted.

## Runtime Architecture

SeekDeep has two main runtime pieces:

1. `index.js`
   - Discord gateway client.
   - Routes `messageCreate`, `interactionCreate`, and `messageReactionAdd`.
   - Owns command parsing, memory, archive, buttons, context menus, response formatting, and calls to local services.

2. `local_ai_server.py`
   - FastAPI server at `http://127.0.0.1:7865`.
   - Loads local models from `./models/huggingface`.
   - Uses `MODEL_KEEP_MODE=task-lru` by default so active task models replace each other unless keep-resident flags are on.
   - Exposes local chat, vision, image, img2img, upscale, pix2pix, inpaint, chart, GPU, health, and unload endpoints.

External local service:

- SearXNG at `http://127.0.0.1:8080`, called by `searchWeb()` for grounded chat replies.

Model defaults from docs/template:

- Chat: `meta-llama/Llama-3.1-8B-Instruct`
- Fallback chat: `ibm-granite/granite-3.3-8b-instruct`
- Quality text: `mistralai/Mistral-Nemo-Instruct-2407`
- Reasoning/code: `microsoft/phi-4`
- Optional lightweight: `google/gemma-3n-E4B-it`
- Vision: `Qwen/Qwen2.5-VL-3B-Instruct`
- Image: `Lykon/dreamshaper-xl-1-0`
- Pix2Pix optional: `timbrooks/instruct-pix2pix`
- Inpaint mask optional: `CIDAS/clipseg-rd64-refined`

## Node Entry Points

Search these names before editing:

- `client.on('messageCreate'...)` - `index.js:13575`
- `seekdeepProcessPreAddressMessageRoutes(message)` - `index.js:13708`
- `seekdeepDispatchAddressedMessage(message, ctx)` - `index.js:14066`
- Main slash/context interaction router - `index.js:15908`
- Emergency prompt-choice button listener - `index.js:16907`
- Emergency generated-image button listener - `index.js:17312`
- Archive delete button listener - `index.js:17337`
- `client.on('messageReactionAdd'...)` - `index.js:12950`
- `client.on('error'...)` - `index.js:7929`
- Test-mode export block, `globalThis.__seekdeepTest` - `index.js:16579`

Important implementation areas:

- File logging and recent error ring: top of `index.js`.
- Channel allow/block gates: around `SEEKDEEP_ALLOWED_CHANNELS` and `SEEKDEEP_BLOCKED_CHANNELS`.
- SearXNG config: `SEARXNG_BASE_URL`, `WEB_SEARCH_PROVIDER`, `WEB_APPEND_SOURCES`.
- Discord text splitting: `splitDiscordText()`.
- Fetch safety: `seekdeepFetchWithLimits()`. Use this for user-supplied URLs, not bare `fetch`.
- Command registration list: starts near `new SlashCommandBuilder()` at `index.js:7573`.
- Help rendering: `seekdeepHelpText(source)` at `index.js:6468`.
- Feature flag constants: around `index.js:11974`.

## Main Message Routing

Message flow:

1. `messageCreate` marks request start and dedupes by message ID.
2. Bot-authored messages and disallowed channels return early.
3. Auto-reactions run fire-and-forget for every allowed human message.
4. Auto-translate runs fire-and-forget for designated non-Latin channel messages.
5. `seekdeepProcessPreAddressMessageRoutes(message)` handles routes that can fire before/without address-gate.
6. Bot mention/addressing is checked.
7. Pending image-subject replies can be consumed even without another mention.
8. Prompt is normalized, reply context can be injected, duplicate prompt/final-reply guards run.
9. Typing/loading state starts.
10. `seekdeepDispatchAddressedMessage(message, ctx)` runs the addressed-message cascade.

Pre-address routes include:

- Removed archive command notices.
- Archive config/status/open/search/clean.
- Persona command.
- Memory preset command.
- Server stats.
- img2img, pix2pix, inpaint, upscale mention commands.
- Prompt templates.
- Conversation search.
- Digest channel admin.
- Auto-translate channel admin.
- React rules.
- Emoji vault.
- Natural archive followups.

Addressed-message cascade includes:

- Reply translation.
- Explicit `ask`.
- Removed archive notices.
- Conversational image edit detection.
- Direct image alias.
- Pending/missing image subject.
- Local utility commands: ping/pong, archive, regen, status, GPU, help, recent, etc.
- Vision on replied/attached/cached images.
- Research table/followup routes.
- Proper noun lookup with web search.
- Chat fallback.

## Core Agents And Helpers

Chat:

- `askChat(prompt, options)` - `index.js:1903`
- `shouldAutoSearch(prompt)` - auto SearXNG trigger logic.
- `searchWeb(query, options)` and `formatSources(sources)`.
- `seekdeepResolveChatRoleForPrompt(prompt, opts)`.
- `seekdeepBuildSystemPrompt(personaOverride, extra)`.
- Memory helpers: `memoryKeyFrom`, `remember`, `getRecentContext`, `shouldUseMemory`, `buildPromptWithMemory`.
- Post-processing: `cleanLoopingReply`, `stripQwenThinkingBlocks`.

Vision:

- `askVision(attachment, prompt, { systemHint })` - `index.js:1981`
- `seekdeepLooksLikeVisionPrompt`
- `seekdeepLooksLikeVisualAttachment`
- `firstVisualAttachmentFrom`
- `fetchRepliedMessage`
- `seekdeepGetReplyVisualAttachment`
- `seekdeepRememberRecentVisionTarget` / `seekdeepConsumeRecentVisionTarget`
- OCR mode uses `SEEKDEEP_OCR_SYSTEM_PROMPT`.

Image:

- `makeImageResult(prompt, width, height, seed, imageOptions)` - `index.js:3096`
- `seekdeepSendImageWithButtons`
- `seekdeepSendImagePromptChoice`
- `seekdeepEnqueueImageJob`
- `seekdeepImageCooldownRemaining` / `seekdeepRememberImageCooldown`
- `seekdeepBuildImagePromptChoice`
- `seekdeepImageModeOptionsFromPrompt`
- `seekdeepPrepareImagePromptDynamic`
- `seekdeepPrepareImagePrompt`
- `seekdeepRefinedPromptCacheGet` / `seekdeepRefinedPromptCacheSet`
- `seekdeepRememberTempImageState` / `seekdeepGetTempImageState`
- `seekdeepAttachDownloadButton`

Image editing:

- `seekdeepHandleImg2Img`
- `seekdeepHandleUpscale`
- `seekdeepHandleInstructPix2Pix`
- `seekdeepHandleInpaint`
- `seekdeepResolveSourceImage`
- `seekdeepFetchImageAsBase64`
- Query extractors: `seekdeepImg2ImgQueryFromMessage`, `seekdeepUpscaleQueryFromMessage`, `seekdeepPix2PixQueryFromMessage`, `seekdeepInpaintQueryFromMessage`.
- Conversational edit detector: `seekdeepLooksLikeConversationalImageEditFollowup`.
- Context-menu prompt cleanup: `seekdeepExtractContextMenuPromptText`, `seekdeepStripImageMetadataLines`, `seekdeepExtractEditResultPrompt`.

Archive:

- `seekdeepArchiveImageStateToDiscordThread`
- `seekdeepArchiveImageStateToSharedDiscordThread`
- `seekdeepGetOrCreateSharedArchiveThread`
- `seekdeepArchiveThreadReadConfig`
- `seekdeepArchiveThreadSaveUserProfile`
- `seekdeepArchiveThreadCountExistingEntries`
- `seekdeepArchiveThreadBuildName`
- `seekdeepLegacyArchiveUserThreadName` - keep for backward-compatible discovery.
- `seekdeepHandleArchiveOpenMessage`
- `seekdeepHandleArchiveConfigMessage`
- `seekdeepHandleArchiveStatusMessage`
- `seekdeepHandleNaturalArchiveImageFollowup`
- `seekdeepSearchArchiveByPrompt`
- `seekdeepBuildRecentArchiveReport`
- Trusted per-user count source: `seekdeep-archive-posts-v3`.
- Shared archive count source: `seekdeep-shared-archive-posts-v1`.

Persona/memory/stats/digest:

- Persona storage: `data/persona-overrides.json`.
- `seekdeepGetEffectivePersona(channelId, guildId)`.
- `seekdeepHandlePersonaCommand`.
- `seekdeepHandlePersonaModalSubmit`.
- Memory presets storage: `data/memory-presets.json`.
- Server stats storage: `data/server-stats.json`.
- `seekdeepTrackStatEvent`.
- Chart mode calls Python `/chart`.
- Daily digest is gated by `SEEKDEEP_DAILY_DIGEST=on`.

Auto-reactions/emoji vault/force react:

- Auto-reactions storage: `data/auto-reactions.json`.
- `seekdeepApplyAutoReactions`
- `seekdeepHandleReactRuleCommand`
- `seekdeepCompileReactionPattern`
- Emoji vault is gated by `SEEKDEEP_FEATURE_EMOJI_VAULT=on`.
- Force React is gated by `SEEKDEEP_FEATURE_FORCE_REACT=on`.

## Slash Commands And Context Menus

Command registration starts near `index.js:7573`.

Slash commands registered in snapshot:

- `/ask`
- `/refine`
- `/image`
- `/vision`
- `/help`
- `/cachestatus`
- `/archivestatus`
- `/recent`
- `/regen`
- `/changelog`
- `/gpu`
- `/persona`
- `/say`
- `/status`
- `/search`
- `/img2img`
- `/upscale`
- `/pix2pix`
- `/inpaint`
- `/template`
- `/stats`

Message context menu commands registered by default:

- `Generate Image from this`
- `Refine as Image Prompt`
- `Inspect (SeekDeep)`
- `Translate (SeekDeep)`
- `Compare with previous`
- `Describe Image (SeekDeep)`
- `Upscale Image (SeekDeep)`

Flag-gated context menus:

- `img2img from this` when `SEEKDEEP_FEATURE_IMG2IMG=on`
- `Edit Image (SeekDeep)` when `SEEKDEEP_FEATURE_INSTRUCT_PIX2PIX=on`
- `Remove Object (SeekDeep)` when `SEEKDEEP_FEATURE_INPAINT=on`
- `Force React (SeekDeep)` when `SEEKDEEP_FEATURE_FORCE_REACT=on`

Note: Discord context menu command propagation can take up to about an hour after registration.

## Python Local AI Server

Server app:

- `FastAPI(title="SeekDeep Local AI Server", version=_read_pkg_version())` — version is sourced from package.json at boot, not a hard-coded literal.
- Defaults model cache to `./models/huggingface`, creates `outputs/` and `temp/`.
- `MODEL_KEEP_MODE=task-lru` by default.
- Keep-resident flags: `LOCAL_VISION_KEEP_RESIDENT`, `LOCAL_IMAGE_KEEP_RESIDENT`.
- Chat role map is resolved from `LOCAL_CHAT_*` env vars.
- Quantization controlled by `LOCAL_CHAT_QUANT` and `LOCAL_CHAT_QUANT_FULL_ROLES`.
- Singleflight middleware serializes non-health model endpoints.

Routes at snapshot:

- `GET /health` - `local_ai_server.py:496`
- `POST /unload` - `local_ai_server.py:524`
- `GET /gpu` - `local_ai_server.py:531`
- `POST /chat` - `local_ai_server.py:731`
- `POST /vision` - `local_ai_server.py:914`
- `POST /image` - `local_ai_server.py:995`
- `POST /img2img` - `local_ai_server.py:1063`
- `POST /upscale` - `local_ai_server.py:1125`
- `POST /instruct-pix2pix` - `local_ai_server.py:1216`
- `POST /inpaint` - `local_ai_server.py:1305`
- `POST /chart` - `local_ai_server.py:1378`

Important Python helpers:

- `chat_role_map`
- `resolve_chat_role`
- `gpu_stats`
- `unload_chat_model`
- `unload_all`
- `prepare_task`
- `load_chat_model`
- `load_vision_model`
- `load_image_pipe`
- `load_media_frames`
- `generate_vision_answer`
- `load_instruct_pix2pix`
- `load_clipseg`
- `generate_mask_clipseg`

## Data Persistence

The docs describe JSON runtime state in `data/*.json`. Actual current write helpers use direct `fs.writeFileSync(...)` at the snapshot, not an obvious temp-file-plus-rename pattern. Verify before relying on atomic write semantics.

Known data files:

- `data/archive-guild-config.json`
  - Tracked by git.
  - Per-guild archive channel config and per-user/shared archive thread profiles.
  - Per-user count source: `seekdeep-archive-posts-v3`.
  - Shared count source: `seekdeep-shared-archive-posts-v1`.

- `data/persona-overrides.json`
  - Per-channel and per-guild persona overrides.
  - Also stores digest and auto-translate channel IDs.

- `data/server-stats.json`
  - Ignored by git.
  - Per-guild totals, per-user counts, 30-day day buckets.

- `data/memory-presets.json`
  - Per-user prompt behavior presets.

- `data/prompt-templates.json`
  - Per-guild per-user image prompt templates.
  - Max templates default: 25.
  - Template names: lowercase alnum, hyphen/underscore, max 30.
  - Prompt max: 2000 chars.

- `data/auto-reactions.json`
  - Per-guild custom reaction rules and built-in rule toggles.

## Environment And Feature Flags

`.env.default` is tracked and safe to inspect. `.env` is local secret state.

Important defaults from `.env.default`:

- `LOCAL_AI_BASE_URL=http://127.0.0.1:7865`
- `SEARXNG_BASE_URL=http://127.0.0.1:8080`
- `LOCAL_CHAT_QUANT=4bit`
- `LOCAL_CHAT_QUANT_FULL_ROLES=` in template.
- `MODEL_KEEP_MODE=task-lru`
- `LOCAL_VISION_KEEP_RESIDENT=off`
- `LOCAL_IMAGE_KEEP_RESIDENT=off`
- `SEEKDEEP_MEMORY_MODE=rolling`
- `SEEKDEEP_MEMORY_SCOPE=user`
- `MAX_DISCORD_CHARS=1900`
- `IMAGE_SCHEDULER=dpmsolver++`
- `IMAGE_STEPS=28`
- `IMAGE_GUIDANCE_SCALE=7.0`
- `SEEKDEEP_LOADING_GIF=assets/loading.gif`
- `SEEKDEEP_FILE_LOGGING=on`

Feature flags:

- `SEEKDEEP_FEATURE_IMG2IMG=off` (code + `.env.default` default; `.env.example` flips it on as a feature demo).
- `SEEKDEEP_FEATURE_INSTRUCT_PIX2PIX=off` in `.env.default`.
- `SEEKDEEP_FEATURE_INPAINT=off` in `.env.default`.
- `SEEKDEEP_FEATURE_UPSCALE_REALESRGAN=off`.
- `SEEKDEEP_FEATURE_NSFW_GATE=off`.
- `SEEKDEEP_FEATURE_TTS_VOICE=off`.
- `SEEKDEEP_FEATURE_EMOJI_VAULT=off`.
- `SEEKDEEP_FEATURE_FORCE_REACT=off`.
- `SEEKDEEP_DAILY_DIGEST=off`.

Gating rule: if you add a new `SEEKDEEP_FEATURE_*`, default it to `off` unless the existing docs/user explicitly require otherwise.

## Verification

Fast automated preflight after source edits:

```powershell
npm run preflight
```

What it runs:

- `node --check` on `index.js`, `smoke_test.mjs`, `scripts/preflight.mjs`
- `python -m py_compile` on `local_ai_server.py`, `warmup_local_cache.py`
- `node smoke_test.mjs`

Individual checks:

```powershell
node --check index.js
.\.venv\Scripts\python.exe -m py_compile .\local_ai_server.py
npm run smoke
```

Smoke test architecture:

- `smoke_test.mjs` sets `process.env.SEEKDEEP_TEST_MODE = '1'` before importing `index.js`.
- In test mode, `index.js` skips `client.login()`.
- Pure helper functions are exposed on `globalThis.__seekdeepTest`.
- If adding a pure helper worth testing, add it to the whitelist near the bottom of `index.js`, then add smoke assertions.

At snapshot, smoke coverage includes:

- `splitDiscordText`
- frustration prompt detection
- reactrule pattern compile
- help text/topic/search
- force-react picker math
- emoji vault formatting
- GPU bar/status/watch parser
- dynamic image prompt cleaning and subject preservation
- archive clean duration parsing
- OCR detector
- archive count/name/entry helpers
- conversation search query/format helpers
- template name handling
- img2img/upscale/pix2pix/inpaint query parsing
- rotating status bank
- non-Latin detector
- loading GIF helper
- research followup detector
- response footer and image metadata stripping
- context-menu prompt extraction
- conversational image edit detection/cleaning

Live Discord smoke checklist lives in `SMOKE_TEST.md`.

## Launch And Operations

Install/update dependencies:

```powershell
npm install
.\.venv\Scripts\python.exe -m pip install -r .\requirements-local.txt
```

Start full stack:

```powershell
.\seekdeep_launcher.bat
```

Launcher option `8` is documented as clean start for SearXNG, local AI server, and Discord bot.

Health checks:

```powershell
curl http://127.0.0.1:7865/health
curl http://127.0.0.1:7865/gpu
```

Model cache operations:

```powershell
python warmup_local_cache.py
python warmup_local_cache.py --chat-only
python warmup_local_cache.py --include-optional
python warmup_local_cache.py --audit-cache --show-unused
python warmup_local_cache.py --prune-unused --quarantine
python warmup_local_cache.py --purge-quarantine
```

npm script equivalents:

- `npm run setup:models`
- `npm run setup:chat-models`
- `npm run setup:models:optional`
- `npm run setup:chat-models:optional`
- `npm run audit:model-cache`
- `npm run prune:model-cache`
- `npm run purge:model-cache-quarantine`

Offline/online cache scripts:

- `lock_seekdeep_model_cache_offline.ps1`
- `unlock_seekdeep_model_cache_online.ps1`

## Common Editing Playbooks

Add or change a mention command route:

1. Locate whether it belongs before address-gate in `seekdeepProcessPreAddressMessageRoutes` or after mention in `seekdeepDispatchAddressedMessage`.
2. Prefer reusing existing parser helpers and target-agnostic reply helpers.
3. Add a pure parser/helper smoke test if possible.
4. Update `COMMANDS.md`, `README.md`, `AGENTS.md`, and `SMOKE_TEST.md` if user-visible.
5. Run `npm run preflight`.

Add or change a slash command:

1. Update command registration near `new SlashCommandBuilder()` in `index.js`.
2. Update the slash router in the main `interactionCreate` handler.
3. For shared message/slash behavior, use target-agnostic helpers (`seekdeepReplyToTarget`, `safeEditOrReply`, `sendLongInteractionReply`, `sendLongMessageReply`).
4. Update docs and smoke tests.
5. Run `npm run preflight`.

Add or change a context menu:

1. Update context menu registration near the existing `ContextMenuCommandBuilder` list.
2. Route through `seekdeepHandleMessageContextMenu` and a focused handler.
3. Respect existing ephemeral env knobs or add a default-off knob if appropriate.
4. If it processes image-result text, reuse `seekdeepExtractContextMenuPromptText` and metadata strippers.
5. Update `COMMANDS.md`, `README.md`, `SMOKE_TEST.md`.

Add or change a pure helper:

1. Keep helper top-level if shared across routes.
2. Expose only if pure and useful under `globalThis.__seekdeepTest`.
3. Add smoke assertions in `smoke_test.mjs`.
4. Run `npm run preflight`.

Add or change a Python model endpoint:

1. Add/adjust Pydantic request model in `local_ai_server.py`.
2. Add/adjust endpoint.
3. Ensure model switching goes through `prepare_task`.
4. Respect singleflight behavior and cleanup CUDA on failures.
5. Add Node caller through `fetchLocalAi` or equivalent existing wrapper.
6. Update `/health` or `/gpu` only if operational state changes.
7. Run Python compile and `npm run preflight`.

Archive changes:

1. Be careful with trusted count sources and thread renames.
2. Do not remove `seekdeepLegacyArchiveUserThreadName` unless a real migration exists.
3. Verify personal archive and shared archive separately.
4. Check natural-language archive, buttons, reactions, `/recent kind:archive`, and delete button flows.

Image generation/edit changes:

1. Respect image cooldown and queue behavior.
2. Preserve Original/Refined/Both prompt-choice flow.
3. Keep prompt refinement fallback path working.
4. For user-supplied images, use `seekdeepFetchWithLimits` or existing image fetch helpers.
5. Verify both message and interaction targets.
6. Run smoke tests and relevant live Discord image tests.

## Known Gotchas

- `index.js` is intentionally huge and organized by top-level helpers plus comment markers. Avoid broad refactors unless explicitly requested.
- Multiple `interactionCreate` listeners exist. The main router is not the only listener; there are emergency button listeners near the end.
- Some docs say all data writes are atomic, but current observed write helpers use direct `fs.writeFileSync`. Verify if atomicity matters.
- `archive-guild-config.json` is gitignored to keep Discord IDs out of the repo (current policy); only `archive-guild-config.sample.json` is tracked.
- Feature flags affect command registration and help text. If a command appears missing, check `.env` and whether registration has propagated.
- `.env.default` defaults `SEEKDEEP_FEATURE_IMG2IMG=off` (code default in `index.js` is `off`); pix2pix and inpaint also default off even though v10.31 shipped their implementation. `.env.example` (the all-on reference) flips these on.
- `LOCAL_CHAT_QUANT=4bit` is important on 24 GB laptop GPUs. Full precision 8B plus SDXL and overhead can push Windows into shared-memory thrashing.
- `SEEKDEEP_TEST_MODE=1` avoids Discord login but still evaluates top-level module code.
- `assets/loading.gif` is optional and cached at startup if present.
- Context-menu prompt extraction was fixed in v10.31 to avoid leaking image metadata into prompts. Do not regress this path.
- SearXNG failures should not break local-only chat if routing says web is off or fail-open is enabled.

## Fast Grep Commands

```bash
rg -n "async function seekdeepDispatchAddressedMessage|async function seekdeepProcessPreAddressMessageRoutes|client\\.on\\('messageCreate'|client\\.on\\('interactionCreate'|client\\.on\\('messageReactionAdd'" index.js
rg -n "new SlashCommandBuilder|ContextMenuCommandBuilder|client\\.application\\.commands\\.set" index.js
rg -n "SEEKDEEP_FEATURE|SEEKDEEP_TEST_MODE|__seekdeepTest" index.js
rg -n "askChat|askVision|makeImageResult|searchWeb|seekdeepFetchWithLimits" index.js
rg -n "archive|Archive|seekdeepArchive" index.js AGENTS.md COMMANDS.md
rg -n "^@app\\.(get|post)|def load_|def prepare_task|class .*Request" local_ai_server.py
git status --short
npm run preflight
```

## Recent History At Snapshot

```text
7a73168 v10.31: context menus, mention commands, per-user memory, help rewrite
a421fbb v10.30: reduce image artifacts - scheduler, negative prompt, guidance
8ec7c62 docs: architecture diagram, data schema docs, v10.28-v10.29 notes
b16808e docs: update PLANNED.md + COMMANDS.md for v10.28-v10.29
be9f112 v10.29: auto-translate channel for non-Latin messages
ab74753 v10.28: refinement retry + analytics chart + token budget bump
686d946 README: append v10.16-v10.27 release notes
41aee15 v10.27: COMMANDS.md permission column + new command docs
93d0134 v10.26: persona editor modal - /persona opens an interactive popup
5a970d6 v10.25: img2img + upscale - transform and enlarge images
```

## When Resuming Work

1. Read this file first.
2. Run `git status --short`.
3. Inspect the exact touched functions with `rg` and `sed`.
4. Check whether dirty files are user changes before editing.
5. Make the smallest correct change.
6. Run `npm run preflight` after source edits.
7. Update docs/tests when behavior changes.
