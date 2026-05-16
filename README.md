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

Chat now uses rolling channel memory by default, so a short sequence of requests can carry earlier goals, constraints, names, and decisions forward. Utility commands, archive commands, status/cache/queue checks, identity questions, and image prompts do not inject chat memory.

Relevant knobs:

```text
SEEKDEEP_MEMORY_MODE=rolling
MAX_CONTEXT_MESSAGES=28
MAX_CONTEXT_CHARS=14000
SEEKDEEP_MEMORY_RECENT_ENTRIES=18
SEEKDEEP_MEMORY_CONTEXT_CHARS=12000
```

Set `SEEKDEEP_MEMORY_MODE=followup` to return to conservative follow-up-only memory, or `off` to disable memory injection.

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

Right-click any Discord message → **Apps** → SeekDeep submenu. Five message context menu commands:

| Command | Action |
|---|---|
| **Generate Image from this** | Use the message text as an image prompt, queue Original generation. |
| **Refine as Image Prompt** | Rewrite the message text as a stronger image prompt. Refuses non-image input. |
| **Inspect (SeekDeep)** | Ephemeral debug card: IDs, timestamps, attachments, buttons, and any cached SeekDeep image state. |
| **Translate (SeekDeep)** | Translate / decode the message text to plain English. |
| **Compare with previous** | Compare this message against the prior non-bot message in the channel. |

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

## Health Checks

Local AI server:

```powershell
curl http://127.0.0.1:7865/health
```

Bot syntax:

```powershell
node --check index.js
```

Python syntax:

```powershell
.\.venv\Scripts\python.exe -m py_compile .\local_ai_server.py
```

## Troubleshooting

- If `@SeekDeep status` reports `ECONNREFUSED`, start the local AI server from the launcher.
- If image generation is slow after chat/refinement, the server may be switching from the chat model back to the image model.
- If SearXNG fails, check the Docker container on port `8080`.
- If archive setup fails, verify the bot has access to the chosen archive channel and can create/manage threads.
- If `Fallback used: role=fallback_chat ...` appears in a chat reply footer, the originally-routed role failed to load (typically CUDA OOM) and the server fell back to `fallback_chat`. Check `LOCAL_CHAT_QUANT` and consider pinning more roles in `LOCAL_CHAT_QUANT_FULL_ROLES`.

## Development Notes

The project is git-tracked from `v10.0-baseline` onward. The old, broken `.git/` directory was renamed to `.git.broken_*` on init. Checkpoints under `checkpoints/` remain as historical snapshots from before git was set up.

```powershell
git log --oneline
git tag                 # v10.0-baseline tags the first commit
git status              # see local changes
```

For internal component notes, see [AGENTS.md](AGENTS.md).
For system requirements, see [REQUIREMENTS.md](REQUIREMENTS.md).
