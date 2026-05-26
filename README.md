<img width="1672" height="941" src="https://github.com/user-attachments/assets/41d77e75-59db-437a-b45f-c28905ff6abc" />


# SeekDeep Discord Bot

SeekDeep is a local AI-powered Discord bot for chat, vision, image generation, web search, and image archiving.

> **Privacy note.** SeekDeep itself does not collect or transmit telemetry. The repo ships nothing that phones home. However, SeekDeep necessarily talks to third-party services you opt into, and **each of those services has its own privacy policy and may collect data per its own terms** — not under SeekDeep's control. The relevant third parties are:
> - **Discord** — every message your bot sends and every interaction it serves passes through Discord's API.
> - **HuggingFace Hub** — when you download a model via `huggingface_hub` (or `POST /model/install` with `backend=hf`), HF observes the model-download request. If you set `HF_TOKEN`, that token is sent on each download.
> - **Ollama** — runs as a local daemon by default (no outbound network), but Ollama's own `ollama pull` reaches out to `registry.ollama.ai`. If you set custom OLLAMA env vars to point at a remote daemon, your prompts go there instead.
> - **SearXNG** — local by default; the web queries you make then go out to whichever upstream search engines your SearXNG instance is configured to use.
> - **Optional remote chat backends** (`openai-compat`, `anthropic`, `gemini`) — when a chat role is configured for one of these, prompts for that role leave the box to whichever provider you point it at. Off by default; opt-in per role via env. Covered providers:
>   - `openai-compat` — OpenAI, DeepSeek, Groq, **xAI / Grok**, OpenRouter, Together, Mistral La Plateforme, Perplexity, plus any local proxy in openai-mode (LM Studio, vLLM, tgwui).
>   - `anthropic` — native Claude API (`api.anthropic.com`).
>   - `gemini` — native Google Gemini API (`generativelanguage.googleapis.com`).
>
>   Each remote provider has its own privacy / data-retention / training policy. SeekDeep cannot influence what they do with prompts you send via these backends. Stay on `hf` / `ollama` (or use a local openai-compat proxy) for anything you want to keep off-network. See `.env.example` and `INTEGRATION.md § 3.4`.
>
> Anything collected by those services is governed by *their* terms, not SeekDeep's. Run with the defaults (loopback FastAPI + local SearXNG + local Ollama + 127.0.0.1 binding on port 7865) to minimize the surface area.

> **Sister docs in this repo:**
> - **[AGENTS.md](AGENTS.md)** — architecture reference: what each subsystem (chat / vision / image / web search / archive / routing) does and how they connect.
> - **[CODEX_REPO_BRIEF.md](CODEX_REPO_BRIEF.md)** — onboarding brief for an AI assistant picking up the repo cold.
> - **[INTEGRATION.md](INTEGRATION.md)** — how the GUI mounts onto the FastAPI server (`gui/` static mount, write endpoints, WebSocket bridge, archive bot bridge).
> - **[MAINTAINER.md](MAINTAINER.md)** — playbook for merging designer-shipped GUI zips without losing audit/auth overrides.
>
> This file is the **user-facing canonical**: install, configure, run, commands, feature flags. Internal architecture details live in `AGENTS.md`.

## Current Local Stack

- Discord bot: `index.js`
- Local AI server: `local_ai_server.py` at `http://127.0.0.1:7865`
- Chat model: `meta-llama/Llama-3.1-8B-Instruct`
- Vision model: `Qwen/Qwen2.5-VL-3B-Instruct`
- Image model: `Lykon/dreamshaper-xl-1-0`
- Web search: local SearXNG at `http://127.0.0.1:8080`
- Model cache: `./models/huggingface`
- Launcher: `seekdeep_launcher.bat`

## Architecture

```text
                        Discord Gateway
                             |
                    +--------+--------+
                    |  index.js (Node) |
                    |  Discord bot     |
                    |  ~16k lines ESM  |
                    +--------+--------+
                             |
              +--------------+--------------+
              |              |              |
   messageCreate    interactionCreate   reactionAdd
              |              |              |
       +------+------+ +----+----+ +-------+-------+
       | Pre-address  | | Slash   | | Archive/      |
       | routes       | | router  | | Delete/Regen  |
       | (archive,    | | (/ask,  | | shortcuts     |
       |  stats,      | |  /image,| | (inbox,trash, |
       |  persona,    | |  /stats | |  counterclkw) |
       |  reactrule)  | |  etc.)  | +---------------+
       +------+-------+ +----+---+
              |               |
              +-------+-------+
                      |
           +----------+----------+
           | Address dispatcher   |
           | seekdeepDispatch*    |
           +----------+----------+
                      |
         +------------+------------+
         |            |            |
    Chat agent   Image agent  Vision agent
         |            |            |
         v            v            v
    +----+---------------------------+
    |  local_ai_server.py (FastAPI)  |
    |  http://127.0.0.1:7865         |
    |  Task-LRU: one model at a time |
    +----+---+---+---+---+---+------+
         |   |   |   |   |   |
       /chat /image /vision  |
             /img2img /upscale
          /instruct-pix2pix  |
             /inpaint /gpu /chart
                      |
    +-----------------+--+
    |   SearXNG (Docker)  |
    |  http://127.0.0.1:8080
    +---------------------+

    Persistence (data/*.json):
    archive-guild-config.json   persona-overrides.json
    server-stats.json           memory-presets.json
    prompt-templates.json       auto-reactions.json
```

SeekDeep has two main runtime pieces:

1. The **Node.js Discord bot** (`index.js`) routes messages, slash commands, buttons, modals, memory, archive actions, auto-reactions, auto-translate, and response formatting.
2. The **Python FastAPI local AI server** (`local_ai_server.py`) loads one model at a time using `MODEL_KEEP_MODE=task-lru` with singleflight request serialization.

The local AI server exposes:

- `GET /health` — model status, VRAM stats, loaded/keep-resident state
- `GET /gpu` — one-shot VRAM snapshot
- `POST /chat` — role-routed text generation (Llama-3.1-8B)
- `POST /vision` — image/video analysis (Qwen2.5-VL-3B)
- `POST /image` — SDXL image generation (Dreamshaper-XL)
- `POST /img2img` — image-to-image transformation (shared SDXL weights)
- `POST /instruct-pix2pix` — natural-language image editing (InstructPix2Pix)
- `POST /inpaint` — object removal via CLIPSeg auto-mask + SDXL inpainting
- `POST /upscale` — PIL upscale (Lanczos by default) with optional mild sharpening; Real-ESRGAN scaffolded
- `POST /chart` — matplotlib stats chart rendering
- `POST /unload` — force-unload current model

## Quick Start

1. Install dependencies:
   ```powershell
   setup_local.ps1
   npm install
   ```

2. Configure `.env`:
   ```text
   DISCORD_TOKEN=your_discord_bot_token
   LOCAL_CHAT_MODEL_ID=meta-llama/Llama-3.1-8B-Instruct
   LOCAL_VISION_MODEL_ID=Qwen/Qwen2.5-VL-3B-Instruct
   LOCAL_IMAGE_MODEL_ID=Lykon/dreamshaper-xl-1-0
   ```

3. Start the full local stack:
   ```powershell
   seekdeep_launcher.bat
   ```

4. Choose launcher option `8` for a clean start of SearXNG, local AI server, and Discord bot.

The launcher can also start only the local AI server or only the Discord bot when needed.

## Standalone Mode (no Discord required)

SeekDeep runs as a standalone local AI client — chat, image generation, vision, and persistent memory — without needing a Discord bot account. The Discord bot is one client of the local AI server; the browser GUI is another. They run independently and use the same local models (and the same opt-in remote backends, if you've configured any).

```powershell
seekdeep_standalone_launcher.bat
```

Or via npm:

```powershell
npm run start:standalone
```

### Desktop App (Tauri)

A native desktop wrapper is auto-built on every push to `main` via GitHub Actions. Grab the latest installer from the [**rolling nightly release**](https://github.com/NathanNeurotic/SeekDeep-DiscordBot/releases/tag/nightly):

| Platform | File |
|---|---|
| Windows | `SeekDeep_10.35.0_x64_en-US.msi` or `_x64-setup.exe` (NSIS) |
| macOS   | `SeekDeep_10.35.0_universal.dmg` |
| Linux   | `SeekDeep_10.35.0_amd64.AppImage`, `_amd64.deb`, or `_1.x86_64.rpm` |

Double-click to install. On first launch the app spawns SeekDeep's Python AI server itself — no `.bat` file, no terminal, no setup script. The only required system dependency is **Python 3.11+** (the app will surface a "Get Python 3.11+" button in the loading overlay if it's missing). If you've configured any chat role to use the Ollama backend, the app will also offer a **"Get Ollama ↗"** button when the daemon isn't reachable. The Tauri bundle carries our code + the boot dependencies list, not a Python runtime, so the installer stays ~45 MB.

**What happens on first launch:**
1. Loading overlay appears, polls `127.0.0.1:7865/health`.
2. Rust shell finds your system Python, copies bundled `local_ai_server.py` + `gui/` to `%APPDATA%/SeekDeep/app/` (or platform equivalent), and probes whether the boot dependencies (fastapi/uvicorn/pydantic/etc) are importable.
3. If they aren't: click **Install Python deps** in the overlay. The app runs `pip install --user -r requirements-local.txt` for you (~30 MB, ~30 seconds), in-app, no terminal.
4. Server boots, page redirects to the playground.
5. When you first open `/image`, `/vision`, or use local-model `/chat`, a banner offers to install the heavy ML libraries (torch + transformers + diffusers, ~2 GB). Pip output streams live in a progress modal.

Remote-only setups (OpenAI-compatible / Anthropic / Gemini) skip the 2 GB ML download entirely — those backends are HTTP-only.

Build it yourself:

```powershell
npm install
npm run tauri:dev    # dev mode with hot reload
npm run tauri:build  # produces an installer in src-tauri/target/release/bundle/
```

Note: first-time builds require [Rust](https://rustup.rs/) and the Tauri platform-specific build deps (see [Tauri's prereqs](https://v2.tauri.app/start/prerequisites/)).

Once the server boots, open **`http://127.0.0.1:7865/gui/chat.html`** in your browser. The composer is wired to `/chat` with persistent conversation memory keyed to the local owner. Slash commands cover everything the bot does (minus Discord-specific features like server-stats / auto-reactions):

- `/image <prompt>` — generate an image inline
- `/vision <prompt>` — describe a dropped or pasted image
- `/remember <fact>` / `/recall` / `/forget #N | text | all` — persistent facts
- `/route <prompt>` — show which model/backend would handle the prompt
- `/help` — full command list

No `DISCORD_TOKEN` required for this mode. The rest of `.env` (model IDs, SearXNG URL, etc.) is still read as usual.

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

Chat uses rolling memory by default, scoped per channel and user unless `SEEKDEEP_MEMORY_SCOPE=channel` is set. Short follow-ups can carry earlier goals, constraints, names, and decisions forward without borrowing another user's intent in a busy channel. Explicit Discord replies add the replied-to message as bounded context for that turn; the current user message still wins over remembered context.

Relevant knobs (defaults shown — `.env.default` may differ from the running `.env`):

```text
SEEKDEEP_MEMORY_MODE=rolling
MAX_CONTEXT_MESSAGES=80
MAX_CONTEXT_CHARS=48000
SEEKDEEP_MEMORY_RECENT_ENTRIES=60
SEEKDEEP_MEMORY_CONTEXT_CHARS=36000
```

Set `SEEKDEEP_MEMORY_MODE=followup` to return to conservative follow-up-only memory, or `off` to disable memory injection.

Optional per-user **memory presets** layer on top: `@SeekDeep memory preset add brief` / `expert` / `no-emoji` / `formal` / `casual`, or a custom line. They're rendered as system-prompt hints whenever that user is the requester. `@SeekDeep memory preset list | remove <key> | clear`.

Free-form **user facts** are also available — distinct from presets in that they're arbitrary text the user asserts about themselves. Persisted to `data/user-facts.json` (gitignored) and injected into every chat call from that user:

- `@SeekDeep remember <fact about you>` — store a fact (e.g. "I work in PST timezone", "I prefer Python")
- `@SeekDeep recall` — list current facts with 1-based indices
- `@SeekDeep forget #N` — remove fact at index N
- `@SeekDeep forget <substring>` — remove any fact containing substring (case-insensitive)
- `@SeekDeep forget all` — clear every fact for this user

Caps: 25 facts per user, 500 chars per fact (configurable via `SEEKDEEP_USER_FACTS_MAX` and `SEEKDEEP_USER_FACT_MAX_CHARS`).

## Image Generation

Image requests support:

- Original prompt generation
- Dynamic AI-refined prompt generation using the local chat model
- `Original`, `Refined`, `RE-REFINE`, and `Both` image buttons
- `Download`, `Archive`, and `Shared Archive` buttons
- Missing-subject follow-up flow, for example `@SeekDeep generate me`
- Optional raw/unrefined mode via `raw`, `unrefined`, `--raw`, or `no refine`

Dynamic refinement is enabled by default:

```text
SEEKDEEP_IMAGE_PROMPT_MAX_CHARS=650
SEEKDEEP_IMAGE_PROMPT_DYNAMIC_REFINEMENT=true
SEEKDEEP_IMAGE_PROMPT_DYNAMIC_TIMEOUT_MS=180000
SEEKDEEP_IMAGE_PROMPT_DYNAMIC_MAX_TOKENS=160
SEEKDEEP_IMAGE_PROMPT_DYNAMIC_MAX_WORDS=45
SEEKDEEP_IMAGE_PROMPT_DYNAMIC_MAX_CHARS=360
```

While dynamic refinement runs, SeekDeep shows a visible prompt-refinement status and then edits it into the Original / Refined / Both choice. Dynamic image refinement and `/refine` are pinned to the `default_chat` role so router keywords inside the prompt do not accidentally select code/reasoning models. If AI refinement fails or times out, SeekDeep logs the reason and visibly marks the output as static-rule fallback instead of silently using an empty or bad prompt.

`RE-REFINE` re-runs refinement from the original prompt/context and then generates from that new refined prompt. It bypasses the refined-prompt cache, preserves the original width/height/seed/quality/style settings, and suppresses repeated clicks while one RE-REFINE job is already queued.

### Image Reply Intent

When you reply to an image, SeekDeep classifies the request before acting:

- questions like `what is this?`, OCR/read-text requests, or `describe it` go to vision
- `upscale 2x/3x/4x` goes to upscale
- edit instructions like `make it darker`, `remove the cat`, or `add snow` go to inpaint/pix2pix/img2img depending on enabled features
- `make a new image inspired by this` generates a fresh image using the replied image as visual reference
- `RE-REFINE`, `refine this`, or `regenerate this` on generated images reuses the original generation context

If the reply is genuinely ambiguous, SeekDeep asks one short clarification instead of guessing.

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

Each archived generation now carries a stable `Archive Key` derived from the image bytes when available. Personal and shared archive writes scan for that key and suppress duplicates, so retries, repeated button clicks, edited archive messages, restarts, and reaction shortcuts do not increment counts twice for the same image. Counts are serialized per archive thread and increment only after a Discord archive post succeeds.

## Web Search And Sources

Web-backed answers use SearXNG results as evidence inside the chat prompt. Search query cleanup removes conversational lead-ins, resolves relative dates like "today" to the current date, and keeps follow-up searches tied to the user's own recent topic. Source footers stay compact:

```text
Sources:
[1] Title - <https://example.com/article>
```

Source URLs are wrapped in angle brackets so Discord does not create giant link-preview embeds.

## Right-click Context Menu Commands

Right-click any Discord message, then **Apps**, then the SeekDeep submenu.

| Command | Action |
|---|---|
| **Generate Image from this** | Use the message text as an image prompt. |
| **Refine as Image Prompt** | Rewrite the message text as a stronger image prompt. |
| **Describe Image (SeekDeep)** | Run vision analysis on an image attachment (ephemeral). |
| **Upscale Image (SeekDeep)** | Upscale an image attachment 2x (ephemeral). |
| **img2img from this** | Opens a modal for img2img prompt. Auto-routes instruction-like prompts to pix2pix/inpaint when enabled. Requires `SEEKDEEP_FEATURE_IMG2IMG=on`. |
| **Edit Image (SeekDeep)** | Opens a modal for InstructPix2Pix editing. Requires `SEEKDEEP_FEATURE_INSTRUCT_PIX2PIX=on`. |
| **Remove Object (SeekDeep)** | Opens a modal for CLIPSeg + inpaint removal. Requires `SEEKDEEP_FEATURE_INPAINT=on`. |
| **Inspect (SeekDeep)** | Ephemeral debug card: IDs, timestamps, attachments, cached image state. |
| **Translate (SeekDeep)** | Translate / decode the message text to plain English. |
| **Compare with previous** | Compare this message against the prior non-bot message. |
| **Force React (SeekDeep)** | Paginated emoji picker. Requires `SEEKDEEP_FEATURE_FORCE_REACT=on`. |

By default **Refine / Translate / Compare** results post publicly. Flip the corresponding `SEEKDEEP_CONTEXT_*_EPHEMERAL=on` env var to make any ephemeral.

## Chat Model Roles

Chat responses are routed to a role-specific model. Image generation still uses `/image` and vision still uses `/vision`; only chat-style inference is role-aware.

Roles:

- `default_chat` — normal conversation, image prompt refinement, casual/simple questions, default fallback path.
- `quality_text` — detailed explanations, comparisons, pros/cons, planning, strategy, long-form answers.
- `reasoning_code` — code, stack traces, logs, debugging, architecture, repo edits, PowerShell/Python/JavaScript/TypeScript/Node/FastAPI/Transformers/CUDA/VRAM questions.
- `fallback_chat` — used automatically when the selected role fails to load or generate.
- `lightweight_chat` — auto-routed for translations, greetings, and trivial queries when `LOCAL_CHAT_LIGHTWEIGHT_MODEL_ID` is set. Saves VRAM by not loading the full 8B model for throwaway tasks.

Configure role models in `.env`:

```text
LOCAL_CHAT_MODEL_ID=meta-llama/Llama-3.1-8B-Instruct
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
MAX_CONTEXT_MESSAGES=80                   # rolling memory turns kept
MAX_CONTEXT_CHARS=48000                   # rolling memory chars kept
SEEKDEEP_MEMORY_RECENT_ENTRIES=60         # injected context turns
SEEKDEEP_MEMORY_CONTEXT_CHARS=36000       # injected context chars
CHAT_MAX_NEW_TOKENS=1024                  # default max output tokens for askChat
CHAT_TEMPERATURE=0.7                      # default chat creativity

# Web search
MAX_WEB_RESULTS=12                        # SearXNG hits passed to the model

# Image generation
SEEKDEEP_IMAGE_COOLDOWN_MS=15000          # per-user image cooldown (15s default)
IMAGE_IMG2IMG_GUIDANCE_SCALE=5.0          # img2img guidance (lower than txt2img for better edits)
SEEKDEEP_PENDING_IMAGE_PROMPT_TTL_MS=900000   # Original/Refined/Both button TTL (15min)
SEEKDEEP_PENDING_IMAGE_SUBJECT_TTL_MS=900000  # 'generate me' follow-up TTL (15min)
SEEKDEEP_DYNAMIC_REFINE_CACHE_TTL_MS=3600000  # refined-prompt reuse window (RE-REFINE bypasses it)
SEEKDEEP_IMAGE_PROMPT_DYNAMIC_MAX_WORDS=45    # SDXL-friendly refinement clamp
SEEKDEEP_IMAGE_PROMPT_DYNAMIC_MAX_CHARS=360   # SDXL-friendly refinement clamp

# Upscale
SEEKDEEP_UPSCALE_METHOD=lanczos           # lanczos | realesrgan (scaffolded)
SEEKDEEP_UPSCALE_RESAMPLE=lanczos         # lanczos | bicubic | nearest
SEEKDEEP_UPSCALE_SHARPEN=true             # mild UnsharpMask after resize
SEEKDEEP_UPSCALE_SHARPEN_RADIUS=1.1
SEEKDEEP_UPSCALE_SHARPEN_PERCENT=115
SEEKDEEP_UPSCALE_SHARPEN_THRESHOLD=3
SEEKDEEP_UPSCALE_MAX_OUTPUT_PIXELS=20000000

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
| `SEEKDEEP_FEATURE_AUTO_REACT` | off | Persistent auto-reaction rules per guild (custom `@SeekDeep reactrule add/list/remove` + 5 built-in stacking rules: long_message, forwarded, code_block, image_only, link_only). Same demonbot-coexistence reason. When off, the per-message rule scan is skipped entirely (saves disk I/O on every guild message) and the `reactrule` admin commands stay out of the dispatch chain. |
| `SEEKDEEP_FEATURE_IMG2IMG` | on | `@SeekDeep img2img <prompt>` and `/img2img`. Transform an attached/replied image with a text prompt. Reuses the Dreamshaper-XL pipeline — no extra model download. |
| `SEEKDEEP_FEATURE_INSTRUCT_PIX2PIX` | on | `@SeekDeep pix2pix <instruction>` and `/pix2pix`. Natural-language image editing ("make it darker", "add snow"). Uses `timbrooks/instruct-pix2pix`. |
| `SEEKDEEP_FEATURE_INPAINT` | on | `@SeekDeep inpaint <target>` and `/inpaint`. Object removal via CLIPSeg auto-mask + SDXL inpainting. |
| `SEEKDEEP_FEATURE_UPSCALE_REALESRGAN` | off | Right-click "Upscale 2x" on a generated image. Requires Real-ESRGAN weights + a Python endpoint. Scaffolded. |
| `SEEKDEEP_FEATURE_NSFW_GATE` | off | Scores generated images via a CLIP NSFW classifier and either spoiler-wraps or refuses based on threshold. Scaffolded. |
| `SEEKDEEP_FEATURE_TTS_VOICE` | off | Voice-channel TTS reader (Piper / XTTS). Scaffolded. |
| `LOCAL_VISION_KEEP_RESIDENT` | off | Pins the vision model in VRAM across task switches. Off saves ~6 GB VRAM; pay a one-time reload on rare vision follow-ups. |
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
- If refinement says `static rules; AI refine unavailable`, check `logs/seekdeep-YYYY-MM-DD.log` for the exact validator/timeout/model-load reason. RE-REFINE intentionally bypasses the cached refined prompt.
- If archive counts look wrong, run `@SeekDeep archive status`. New writes use `Archive Key` dedupe and only increment after a successful thread post; manual `archive count set` should be reserved for repairing corrupted historical profiles.
- If an upscale loading GIF remains visible, the final edit likely failed due to a Discord interaction timeout. Retrying should now edit the status to success/failure and clear prior attachments; check the console for `[SeekDeep] upscale failed` if it does not.

## Release Notes

### v10.35 — repair/audit pass

Archive writes now include stable `Archive Key` metadata, duplicate suppression, and per-thread count locking so a successfully archived image increments exactly once. Prompt refinement is pinned to `default_chat`, reports AI-refine fallback reasons, clamps SDXL prompts, and adds the generated-image **RE-REFINE** button for a fresh refinement pass from the original prompt. Upscale now clears loading attachments on success/failure and defaults to Lanczos plus configurable mild sharpening. Image replies are classified as edit, fresh inspired image, vision, upscale, regenerate, or RE-REFINE; ambiguous replies ask a short clarification. Web source URLs are wrapped in Discord-safe angle brackets to suppress preview spam. New smoke checks cover archive keys, source formatting, image-reply intent, and RE-REFINE settings.

### v10.34 — archive perf, persona crash, ephemeral migration, image pipeline tuning, lightweight routing

13 fixes from a full live-testing audit. Archive buttons no longer scan 1000+ messages on every click (was 77–637s, now instant via trusted JSON profile counts). Archive delete no longer hits `50027 Invalid Webhook Token` from expired interaction tokens. Persona modal crash fixed (label was 52 chars, Discord max 45). All 11 `ephemeral: true` migrated to `flags: MessageFlags.Ephemeral`. Inpaint prompt extraction now captures the removal target instead of generic fill text. Pix2Pix adaptive `image_guidance_scale` (heavy edits 1.2, light edits 2.0, default 1.5). img2img gets its own `IMAGE_IMG2IMG_GUIDANCE_SCALE` (default 5.0, was inheriting txt2img 7.0). img2img modal auto-routes instruction-like prompts to pix2pix/inpaint. Adaptive strength adds 0.80 tier for scene/environment transforms. `lightweight_chat` now actively routes translations, greetings, and trivial queries to gemma-3n when configured. Thread rename debounce (30s cooldown). Inpaint now sends negative prompt. 14 new smoke tests (274 total).

### v10.33 — loading gif + bug fixes

Loading gif added to 8 context menu handlers + 3 slash commands for visible wait feedback. Ephemeral modal ack fixed (context menu modal submits no longer produce two messages). Pix2Pix output fixed (non-square input no longer stretches to wrong aspect ratio — always 512→1024 square). Context menu embed image fallback (images in embeds now found by vision/upscale/img2img). Stats chart orphan loading gif fix. Context menu upscale + img2img changed to ephemeral defer. 7 new smoke tests (256 total).

### v10.32 — context menu modals + adaptive img2img + pix2pix tuning

Context menu Edit Image and Remove Object commands now open Discord modals for prompt/target input instead of using the message text. Adaptive img2img strength: style keywords (0.65), scene transforms (0.70), color/lighting (0.45), default (0.55). Pix2Pix adaptive `image_guidance_scale` initial pass. img2img modal auto-routing scaffolded.

### v10.31 — InstructPix2Pix + Inpainting + routing overhaul

Two new image-editing pipelines with auto-routing from conversational replies. `/pix2pix instruction:<text> image:<file>` edits images with natural-language instructions via `timbrooks/instruct-pix2pix`. `/inpaint remove:<text> prompt:<text> image:<file>` removes objects using CLIPSeg auto-mask (`CIDAS/clipseg-rd64-refined`) + SDXL inpainting. Both are gated behind `SEEKDEEP_FEATURE_*` flags. Conversational image edit detection: reply to a generated image with "make it darker" or "remove the wizard" and SeekDeep auto-routes to the best pipeline (inpaint for removals, pix2pix for modifications, img2img fallback). Major fix to context-menu prompt extraction — "Generate Image from this" no longer leaks metadata (Refinement, Queue Wait, Job ID) into the prompt. New `seekdeepExtractEditResultPrompt` handles img2img/pix2pix/inpaint result formats. 15 new smoke tests (226 total).

### v10.30 — image quality tuning

Scheduler, negative prompt, and guidance scale defaults tuned for Dreamshaper-XL to reduce artifacts.

### v10.29 — auto-translate channel

`@SeekDeep translate channel here` (admin) designates one channel per server where every non-bot message containing non-Latin script (Cyrillic, CJK, Arabic, Devanagari, Thai, Korean) gets an automatic English translation reply. Uses a fast regex detector for non-Latin Unicode ranges — intentionally conservative, so Latin-script languages like French or Spanish aren't false-positively translated. 3-second per-channel cooldown prevents spam on rapid messages. Fire-and-forget: the message doesn't need to mention the bot. 9 new smoke checks.

### v10.28 — refinement retry + analytics chart + token budget bump

Two fixes to the dynamic image-prompt refiner, plus a new analytics feature. (1) When the validator rejects the chat model's first output (subject drift, generic phrasing, empty-after-cleanup), the refiner now retries once at +0.15 temperature before falling back to static rules. This recovers most rejections that were previously invisible fallbacks. (2) Max refinement tokens bumped 360 → 512 as insurance against small models' internal reasoning eating the budget. (3) `@SeekDeep stats chart` / `/stats scope:chart` renders the 30-day `dayBuckets` data as a matplotlib line chart — Discord dark theme, area fills, three color-coded series (images, chats, vision). New `POST /chart` endpoint on the Python server; falls back to text-only stats if matplotlib isn't installed.

### v10.27 — COMMANDS.md permission column + new command docs

Complete rewrite of `COMMANDS.md` to add a Permission column to every command table so users can tell at a glance what each command requires (Everyone, Admin, Manage Msgs, Manage Guild, or Requester/Admin). Also documents all commands added in v10.16–v10.26: conversation search, prompt templates, img2img, upscale, `/persona` modal, GPU/VRAM monitoring, right-click context menu actions, and reaction shortcuts.

### v10.26 — persona editor modal

`/persona` now opens a Discord modal (popup form) instead of requiring you to memorize the command syntax. Admin-only via `ManageGuild`. The modal has three fields: Persona (neurotic / unsettling / clinical / chaotic / reset), Scope (channel / server), and a read-only Info field showing the current state. Submit validates the persona name, persists to `persona-overrides.json`, and replies with an ephemeral confirmation.

### v10.25 — img2img + upscale

**img2img** transforms an existing image with a text prompt using the same Dreamshaper-XL model already loaded in VRAM — zero additional download. Uses diffusers' `AutoPipelineForImage2Image.from_pipe()` to share model weights. Source image resolved via a 3-step waterfall: direct attachment → replied message → most recent bot image in the channel. `@SeekDeep img2img <prompt>` or `/img2img image:<file> prompt:<text> strength:0.6`.

**Upscale** enlarges an image using Lanczos resampling (PIL, no model needed). Real-ESRGAN endpoint is scaffolded for future opt-in. `@SeekDeep upscale [2x|3x|4x]` or `/upscale image:<file> scale:2|3|4`. Both new endpoints are singleflight-locked on the Python server. 9 new smoke checks.

### v10.24 — saved prompt templates

Per-user prompt templates persisted to `data/prompt-templates.json`. Save frequently-used image prompts and regenerate with one command. `@SeekDeep template save <name>: <prompt>`, `template list`, `template use <name>`, `template delete <name>`, plus a `/template` slash command. Max 25 templates per user, names auto-sanitized to lowercase alphanumeric + hyphens (max 30 chars). Each template tracks a use count and last-used timestamp. `template use` dispatches directly to `seekdeepSendImageWithButtons`. 7 new smoke checks.

### v10.23 — conversation search

`@SeekDeep search <query>` and `/search query:<keywords>` page through recent channel messages (up to 500) and match user→bot exchange pairs where all query words appear. Results show a timestamp, snippet, and jump-to-message link. The query extractor is careful to avoid false-matching `archive search` which is a separate feature. 9 new smoke checks.

### v10.22 — archive numbering reliability

Three bugs worked in concert to cause archive thread counts to drift from the actual entry count. (1) `seekdeepArchiveThreadRecordPost` rescanned the thread after posting, finding the just-posted entry, then added +1 — inflating by 1 per post. Fix: use the trusted count from profile + 1. (2) `seekdeepGetOrCreateUserArchiveThread` called a `Math.max(trusted, scanned)` ratchet that prevented counts from ever correcting downward. Fix: single authoritative scan only. (3) `archive clean confirm` subtracted deleted from `profile.count` instead of rescanning, preserving any prior inflation. Fix: rescan thread after deletion. Also fixed duplicate suite 17 numbering in smoke tests. 20 new smoke checks for archive counting.

### v10.21 — repo cleanup

Tracked files: 473 → 27. Removed all pre-git patch scripts, backup snapshots, temp artifacts, and the secrets file from git tracking. Updated `.gitignore` to prevent recurrence, covering secrets, models, venv, `node_modules`, runtime state, Claude workspace, and all legacy backup/patch naming patterns.

### v10.20 — context-aware Discord status

While the bot is doing real work (generating an image, running chat inference, analyzing a photo, extracting text), the Discord presence now shows what it's actually doing ("Thinking…", "Generating your image…", "Analyzing image…", "Extracting text…") instead of the fun rotating status. Uses a reference-counted override so concurrent tasks don't clobber each other. Reverts to the fun bank automatically when the last active task finishes.

### v10.19 — archive clean

Prune old entries from your archive thread with a two-step preview + confirm flow. `@SeekDeep archive clean older than 7d` scans the thread and shows a preview of matching entries. `@SeekDeep archive clean confirm` executes the deletion (2-minute TTL on the pending confirmation). Supports duration units `h`, `d`, `w`, `m`. After deletion, rescans the thread and updates the count and thread name. 6 new smoke checks for duration parsing.

### v10.18 — OCR mode for vision

`/vision mode:ocr` and natural-language triggers like "extract text", "read this", "what does it say", and "transcribe this" switch the vision model to a focused OCR system prompt that extracts text exactly as it appears instead of describing the image. Max output tokens raised to 1500 in OCR mode (vs. 700 for describe) to handle text-heavy images. 6 new smoke checks for the OCR prompt detector.

### v10.17 — help search

`@SeekDeep help search <query>` and `/help search:<query>` fuzzy-match across all help sections. Splits the rendered help text into `## ` sections and returns every section where any line substring-matches all query words. Returns a "No results" hint with a suggestion to try a shorter keyword when nothing matches. 5 new smoke checks.

### v10.16 — rotating Discord status

52 fun statuses across four Discord activity types (Playing, Watching, Listening, Competing, plus one Custom) that shuffle on boot and rotate every 10 minutes. Statuses range from "Playing with 24GB of VRAM" to "Competing in the overthinking world finals." Fisher-Yates shuffle ensures no repeats within a cycle. 4 new smoke checks for the status bank and shuffle logic.

### v10.15 — .env.default quantization fix

`.env.default` shipped `LOCAL_CHAT_QUANT_FULL_ROLES=default_chat,fallback_chat` since v10.1, forcing the default chat model to load at fp16 (~16 GB VRAM). On a 24 GB laptop GPU that leaves zero headroom for the task-LRU swap to SDXL during image generation — the transient peak exceeds 24 GB, NVIDIA's Windows driver spills into shared system memory, and the entire desktop locks up. Fix: ship the list empty so `default_chat` gets 4-bit-quantized (~5 GB VRAM), leaving ~10 GB of headroom. Quality cost is ~1–2% on benchmarks (NF4 + double-quant + bf16 compute). Desktop users with 32 GB+ VRAM can re-add `default_chat,fallback_chat` to the list if they want fp16 nuance back.

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
