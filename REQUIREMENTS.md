# Requirements

SeekDeep runs as a local Discord bot plus a local Python AI server. The launcher starts the full local stack: SearXNG, `local_ai_server.py`, and `index.js`.

## System Requirements

- Windows 10/11 64-bit
- NVIDIA GPU with CUDA-capable PyTorch support
- Recommended: 16 GB+ system RAM and enough VRAM for the selected local models
- Storage for model cache under `./models/huggingface`
- Docker Desktop for local SearXNG web search

The current verified machine reports:

- GPU: NVIDIA GeForce RTX 5090 Laptop GPU
- CUDA: available

## Runtime Dependencies

- Node.js 20 or newer
- npm
- Python 3.11+
- pip
- Docker Desktop

Node version is intentionally `>=20` to match `package.json`.

## Node Packages

Install with:

```powershell
npm install
```

Current direct dependencies from `package.json`:

- `discord.js` ^14.18.0
- `dotenv` ^16.4.7
- `node-fetch` ^3.3.2
- `form-data` ^4.0.1
- `jszip` ^3.10.1 — used by the emoji vault to build/parse the image ZIP backup (feature-flagged off by default since v10.4.3)

## Python Packages

Install with:

```powershell
.\.venv\Scripts\python.exe -m pip install -r .\requirements-local.txt
```

The local requirements file includes PyTorch CUDA wheels plus FastAPI, Transformers, Diffusers, Qwen vision utilities, and image/video support packages.

## External Services

SearXNG runs locally through Docker at:

```text
http://127.0.0.1:8080
```

The local AI server runs at:

```text
http://127.0.0.1:7865
```

## Environment Variables

Copy `.env.default` to `.env` for a fresh setup, then add the Discord token.

A complete list of supported env vars lives in `.env.default` (the template `.env` is copied from). The most-touched are:

> Canonical values live in `.env.default`; this list is illustrative — verify against `.env.default` before relying on a value.

```text
# Required
DISCORD_TOKEN=

# Backend providers
CHAT_PROVIDER=nvidia-local
IMAGE_PROVIDER=nvidia-local
VISION_PROVIDER=nvidia-local
WEB_SEARCH_PROVIDER=searxng

# Local endpoints
LOCAL_AI_BASE_URL=http://127.0.0.1:7865
SEARXNG_BASE_URL=http://127.0.0.1:8080

# Models
LOCAL_CHAT_MODEL_ID=meta-llama/Llama-3.1-8B-Instruct
LOCAL_VISION_MODEL_ID=Qwen/Qwen2.5-VL-3B-Instruct
LOCAL_IMAGE_MODEL_ID=Lykon/dreamshaper-xl-1-0

# Role-aware chat models (v10.1)
LOCAL_CHAT_FALLBACK_MODEL_ID=ibm-granite/granite-3.3-8b-instruct
LOCAL_CHAT_QUALITY_MODEL_ID=mistralai/Mistral-Nemo-Instruct-2407
LOCAL_CHAT_REASONING_MODEL_ID=microsoft/phi-4
LOCAL_CHAT_LIGHTWEIGHT_MODEL_ID=google/gemma-3n-E4B-it

# Quantization
LOCAL_CHAT_QUANT=4bit
LOCAL_CHAT_QUANT_FULL_ROLES=                # empty since v10.15 — fp16 on a 24GB GPU thrashes shared memory

# Model cache + offline
LOCAL_MODEL_CACHE_DIR=./models/huggingface
MODEL_KEEP_MODE=task-lru
LOCAL_VISION_KEEP_RESIDENT=off             # off by default; pin only with VRAM headroom
LOCAL_IMAGE_KEEP_RESIDENT=off             # off by default; pin SDXL only with VRAM headroom
HF_LOCAL_FILES_ONLY=false                  # online until first warmup completes; lock offline afterward
HF_HUB_OFFLINE=0
TRANSFORMERS_OFFLINE=0

# Web search
WEB_AUTO_SEARCH=true
WEB_SEARCH_STRICT_ROUTING=true
WEB_SEARCH_FAIL_OPEN=true
WEB_APPEND_SOURCES=true

# Memory + chunking
MAX_DISCORD_CHARS=1900
SEEKDEEP_MEMORY_MODE=rolling
MAX_CONTEXT_MESSAGES=50
MAX_CONTEXT_CHARS=36000
SEEKDEEP_MEMORY_RECENT_ENTRIES=40
SEEKDEEP_MEMORY_CONTEXT_CHARS=28000

# Image generation
SEEKDEEP_IMAGE_PROMPT_MAX_CHARS=650
SEEKDEEP_IMAGE_PROMPT_DYNAMIC_REFINEMENT=true
SEEKDEEP_IMAGE_PROMPT_DYNAMIC_TIMEOUT_MS=180000
SEEKDEEP_IMAGE_COOLDOWN_MS=15000

# TTLs
SEEKDEEP_PENDING_IMAGE_PROMPT_TTL_MS=900000
SEEKDEEP_PENDING_IMAGE_SUBJECT_TTL_MS=900000
SEEKDEEP_RECENT_VISION_TARGET_TTL_MS=600000
SEEKDEEP_LAST_SUBJECT_TTL_MS=900000
SEEKDEEP_DYNAMIC_REFINE_CACHE_TTL_MS=600000
SEEKDEEP_EMERGENCY_SEEN_TTL_MS=300000      # v10.5 — naming the 5-min Set TTLs

# Feature flags (all default off — see README "Feature Flags")
SEEKDEEP_FEATURE_EMOJI_VAULT=off           # demonbot coexistence
SEEKDEEP_FEATURE_FORCE_REACT=off           # demonbot coexistence
SEEKDEEP_FEATURE_IMG2IMG=off               # default off; reuses Dreamshaper-XL, no extra download
SEEKDEEP_FEATURE_UPSCALE_REALESRGAN=off    # scaffold only
SEEKDEEP_FEATURE_NSFW_GATE=off             # scaffold only
SEEKDEEP_FEATURE_TTS_VOICE=off             # scaffold only

# Channel gating + admin IDs
SEEKDEEP_ALLOWED_CHANNELS=
SEEKDEEP_BLOCKED_CHANNELS=
SEEKDEEP_ADMIN_IDS=

# Context-menu reply visibility (off = public, on = ephemeral)
SEEKDEEP_CONTEXT_REFINE_EPHEMERAL=off
SEEKDEEP_CONTEXT_TRANSLATE_EPHEMERAL=off
SEEKDEEP_CONTEXT_COMPARE_EPHEMERAL=off

# Daily digest
SEEKDEEP_DAILY_DIGEST=off
SEEKDEEP_DAILY_DIGEST_HOUR=9

# Logging
SEEKDEEP_FILE_LOGGING=on
MODEL_ROUTER_LOG=true
MODEL_LOG_VRAM=false                       # off in .env.default to keep startup quiet

# Fetch safety (v10.5; SSRF policy added AUD-002 — see SECURITY.md)
SEEKDEEP_FETCH_DEFAULT_TIMEOUT_MS=30000
SEEKDEEP_FETCH_DEFAULT_MAX_BYTES=52428800
SEEKDEEP_FETCH_MAX_REDIRECTS=5
SEEKDEEP_FETCH_ALLOW_PRIVATE=off   # off = block private/loopback/metadata targets + re-check each redirect
```

## Current Local Models

- Chat: `meta-llama/Llama-3.1-8B-Instruct`
- Vision: `Qwen/Qwen2.5-VL-3B-Instruct`
- Image: `Lykon/dreamshaper-xl-1-0`

The server uses task-LRU model loading, so switching from chat refinement to image generation can unload one task and load another.

## Installation

1. Install Node.js 20+, Python 3.11+, and Docker Desktop.
2. From the repo root, install Node dependencies:
   ```powershell
   npm install
   ```
3. Create or activate the Python virtual environment, then install Python dependencies:
   ```powershell
   .\.venv\Scripts\python.exe -m pip install -r .\requirements-local.txt
   ```
4. Copy `.env.default` to `.env` if `.env` does not exist.
5. Set `DISCORD_TOKEN` in `.env`.
6. Run the launcher:
   ```powershell
   .\seekdeep_launcher.bat
   ```
7. Use the clean-start option to start SearXNG, the local AI server, and the bot.

`setup_local.ps1` can also be used for local setup/bootstrap flows already present in the repo.

## Verification

Run the full preflight after code changes:

```powershell
npm run preflight
```

Runs 8 stages in order: `js` (`node --check` on shipped JS), `html-js` (inline `<script>` blocks in `gui/*.html`), `py` (`python -m py_compile` on the Python files — `local_ai_server.py`, `warmup_local_cache.py`, `gui_endpoints.py`, `release_signing.py`, and the two release-signing scripts), `smoke` (`node smoke_test.mjs`), `gui-smoke`, `rust` (`cargo check`, skip-with-warn when cargo/GTK absent), `docs` (drift guards), and `coverage` (endpoint map). Exit code 0 only when every stage passes (or was skipped).

Individual checks:

```powershell
node --check .\index.js
.\.venv\Scripts\python.exe -m py_compile .\local_ai_server.py
npm run smoke
```

The smoke test (`smoke_test.mjs`) sets `SEEKDEEP_TEST_MODE=1` before importing `index.js`, so it exercises real helpers (chunker, frustration filter, help text, emoji vault math, force-react picker math, etc.) without spinning up a Discord connection or loading any local models.

Check local AI health:

```powershell
curl http://127.0.0.1:7865/health
```

Core Discord smoke tests:

```text
@SeekDeep status
@SeekDeep help
@SeekDeep cache status
@SeekDeep show me a banana eating a monkey
@SeekDeep draw me a goomba
@SeekDeep generate a goomba
@SeekDeep generate me
@SeekDeep ask what are you?
```

Archive smoke tests:

```text
@SeekDeep archive shared
@SeekDeep archive setup here
@SeekDeep setup archive here
@SeekDeep archive status
@SeekDeep archive status @user
```

Then click `Archive` and `Shared Archive` on a generated image.

Archive writes use Discord threads only. Configure the archive channel before testing `Archive` and `Shared Archive`.

## Offline Model Cache

After all required models have loaded successfully once, the cache can be locked for offline use:

```powershell
.\lock_seekdeep_model_cache_offline.ps1
```

Unlock before downloading or changing models:

```powershell
.\unlock_seekdeep_model_cache_online.ps1
```

## Troubleshooting

- `ECONNREFUSED 127.0.0.1:7865`: local AI server is not running.
- SearXNG web failures: check Docker and port `8080`.
- Slow first image after chat/refinement: the server may be switching loaded tasks.
- Archive setup failures: check channel permissions and thread permissions.
- Discord command oddities during smoke tests: send one command per message so routes do not merge.
