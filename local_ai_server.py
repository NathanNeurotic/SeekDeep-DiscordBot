from __future__ import annotations

import base64
import binascii
import gc
import io
import json
import os
import math
import re
import tempfile
import time
import traceback
from pathlib import Path
from typing import Any, Literal, Optional

# python-dotenv is preferred but optional. The bot launcher always installs
# it via requirements-local.txt, but CI's gui-smoke stage only installs the
# minimal fastapi/httpx/pydantic subset; the module-level import would fail
# there and break the entire test client. Fall back to a no-op when missing.
try:
    from dotenv import load_dotenv
except ImportError:
    def load_dotenv(*_args, **_kwargs):
        return False
from fastapi import FastAPI, HTTPException, Depends
from fastapi.responses import JSONResponse
from PIL import Image, ImageFilter, ImageOps, UnidentifiedImageError
from pydantic import BaseModel, Field



# SEEKDEEP_UPSCALE_CLAMP_HELPER_V1
def seekdeep_fit_upscale_input_to_output_cap(image, upscale_factor, max_output_pixels):
    """
    If image * upscale_factor would exceed max_output_pixels, shrink the input
    before upscaling so the final output is the largest legal same-aspect result.

    This changes oversized upscale requests from hard-fail HTTP 400 behavior into
    clamp-to-max behavior.
    """
    src_w, src_h = image.size
    upscale_factor = float(upscale_factor)

    requested_w = int(round(src_w * upscale_factor))
    requested_h = int(round(src_h * upscale_factor))
    requested_pixels = requested_w * requested_h

    if requested_pixels <= int(max_output_pixels):
        return image, {
            "clamped": False,
            "source_width": src_w,
            "source_height": src_h,
            "requested_width": requested_w,
            "requested_height": requested_h,
            "requested_pixels": requested_pixels,
            "output_width": requested_w,
            "output_height": requested_h,
            "output_pixels": requested_pixels,
            "max_output_pixels": int(max_output_pixels),
        }

    max_output_pixels = int(max_output_pixels)
    max_input_pixels = max_output_pixels / (upscale_factor * upscale_factor)
    resize_ratio = math.sqrt(max_input_pixels / float(src_w * src_h))

    fit_w = max(1, int(math.floor(src_w * resize_ratio)))
    fit_h = max(1, int(math.floor(src_h * resize_ratio)))

    while int(round(fit_w * upscale_factor)) * int(round(fit_h * upscale_factor)) > max_output_pixels:
        if fit_w >= fit_h and fit_w > 1:
            fit_w -= 1
        elif fit_h > 1:
            fit_h -= 1
        else:
            break

    resampling = getattr(Image, "Resampling", Image).LANCZOS
    fitted = image.resize((fit_w, fit_h), resampling)

    out_w = int(round(fit_w * upscale_factor))
    out_h = int(round(fit_h * upscale_factor))
    out_pixels = out_w * out_h

    return fitted, {
        "clamped": True,
        "source_width": src_w,
        "source_height": src_h,
        "requested_width": requested_w,
        "requested_height": requested_h,
        "requested_pixels": requested_pixels,
        "input_width_after_clamp": fit_w,
        "input_height_after_clamp": fit_h,
        "output_width": out_w,
        "output_height": out_h,
        "output_pixels": out_pixels,
        "max_output_pixels": max_output_pixels,
    }


load_dotenv()

ROOT = Path(__file__).resolve().parent

# Mirror stdout+stderr to logs/seekdeep-YYYY-MM-DD.log so the Control Center
# Logs viewer (which globs seekdeep-*.log) has something to read when the
# Discord bot isn't running. Same filename pattern as index.js. Opt out via
# SEEKDEEP_FILE_LOGGING=off.
def _seekdeep_install_file_logging() -> None:
    flag = (os.getenv("SEEKDEEP_FILE_LOGGING", "on") or "on").strip().lower()
    if flag in {"off", "false", "0", "no"}:
        return
    import sys
    logs_dir = ROOT / "logs"
    try:
        logs_dir.mkdir(parents=True, exist_ok=True)
    except Exception:
        return
    day = time.strftime("%Y-%m-%d")
    log_path = logs_dir / f"seekdeep-{day}.log"
    try:
        sink = open(log_path, "a", encoding="utf-8", buffering=1)
    except Exception:
        return
    _re_token = re.compile(r"[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{20,}")
    _re_bearer = re.compile(r"(authorization\s*[:=]\s*['\"]?bearer\s+)[^'\"\s]+", re.IGNORECASE)
    _re_apikey = re.compile(r"\b(hf_|sk-|nvapi-)[A-Za-z0-9_-]{16,}\b")
    def _redact(s: str) -> str:
        s = _re_token.sub("[redacted-token]", s)
        s = _re_bearer.sub(r"\1[redacted]", s)
        s = _re_apikey.sub(r"\1[redacted]", s)
        return s
    _re_py_warning = re.compile(r":\s*\d+:\s*\w+Warning\b")  # 'file.py:765: DeprecationWarning'
    # tqdm-style progress lines look like 'Loading weights: 100%|██…| 5/5'.
    # huggingface_hub writes them to stderr; without this they spam [ERR]
    # all over a healthy model load and make the Logs viewer look on fire.
    _re_progress = re.compile(r"\b\d+%\|[█▉▊▋▌▍▎▏ #\->= ]*\|")
    class _Tee:
        def __init__(self, real, level):
            self.real = real
            self.level = level  # default severity if no inline marker
            self._sticky = None  # carries severity across continuation lines
        def write(self, data):
            try:
                self.real.write(data)
            except Exception:
                pass
            try:
                if data and data.strip():
                    ts = time.strftime("%Y-%m-%dT%H:%M:%S")
                    for line in str(data).splitlines():
                        if not line:
                            # Blank line — keep sticky state. Python warning
                            # blocks contain blank lines inside the message;
                            # resetting on blank would split a single warning
                            # across [WARN]+[ERR] tags. Sticky is broken
                            # only when a NEW level marker arrives.
                            continue
                        # Sniff per-line severity. Uvicorn + Python warnings
                        # write to stderr too; blindly tagging everything from
                        # stderr as [ERR] made the logs viewer look like a fire
                        # when nothing's wrong.
                        lvl = self.level
                        stripped = line.lstrip()
                        new_sticky = None
                        if stripped.startswith("INFO:") or stripped.startswith("INFO "):
                            lvl = "INFO"
                            new_sticky = None  # info marker breaks sticky warning
                            self._sticky = None
                        elif (stripped.startswith("WARNING:")
                              or stripped.startswith("WARN:")
                              or stripped.startswith("UserWarning")
                              or _re_py_warning.search(line)):
                            lvl = "WARN"
                            new_sticky = "WARN"
                        elif stripped.startswith("DEBUG:"):
                            lvl = "DEBUG"
                            self._sticky = None
                        elif stripped.startswith("ERROR:") or stripped.startswith("CRITICAL:"):
                            lvl = "ERR"
                        elif stripped.startswith("Traceback ") or stripped.startswith("  File "):
                            lvl = "ERR"
                            new_sticky = "ERR"
                        elif _re_progress.search(line):
                            # tqdm progress: tag as INFO regardless of stream.
                            lvl = "INFO"
                        else:
                            # Continuation line — if we're inside a sticky
                            # multi-line warning/traceback, inherit its level.
                            if self._sticky:
                                lvl = self._sticky
                        if new_sticky is not None:
                            self._sticky = new_sticky
                        sink.write(f"[{ts}] [{lvl}] {_redact(line)}\n")
            except Exception:
                pass
        def flush(self):
            try: self.real.flush()
            except Exception: pass
            try: sink.flush()
            except Exception: pass
        def __getattr__(self, name):
            return getattr(self.real, name)
    sys.stdout = _Tee(sys.stdout, "INFO")
    sys.stderr = _Tee(sys.stderr, "ERR")
    print(f"[SeekDeep Local AI] file logging on -> {log_path}", flush=True)

_seekdeep_install_file_logging()

def _resolve_model_cache_dir() -> Path:
    """Pick the HF cache dir. Order:
      1. SEEKDEEP_MODEL_CACHE_DIR env override (absolute path)
      2. LOCAL_MODEL_CACHE_DIR resolved against ROOT (legacy)
      3. If #2 resolves to a path inside Tauri's runtime dir AND a
         valid cache exists at ~/SeekDeep-DiscordBot/models/huggingface,
         use that instead (Tauri install hits WinError 448 on its own
         models/ symlinks; the user's repo cache is the safe one).

    The third path matters because Tauri's runtime dir
    %APPDATA%/SeekDeep/app/models/huggingface/ ends up with
    OS-untrusted symlinks that crash huggingface_hub.scan_cache_dir.
    """
    override = (os.getenv("SEEKDEEP_MODEL_CACHE_DIR") or "").strip()
    if override:
        p = Path(override).expanduser().resolve()
        try: p.mkdir(parents=True, exist_ok=True)
        except OSError: pass
        return p
    raw = Path(os.getenv("LOCAL_MODEL_CACHE_DIR", "./models/huggingface"))
    cfg = raw if raw.is_absolute() else (ROOT / raw)
    cfg = cfg.resolve()
    # Heuristic: configured path lives under an AppData/Roaming/.../app/ tree?
    # If so, prefer the user's repo cache when it exists and has content.
    cfg_str = str(cfg).replace("\\", "/").lower()
    looks_tauri = ("appdata/roaming/" in cfg_str and "/app/" in cfg_str)
    if looks_tauri:
        candidate = (Path.home() / "SeekDeep-DiscordBot" / "models" / "huggingface").resolve()
        try:
            if candidate.is_dir() and any(candidate.iterdir()):
                print(f"[SeekDeep Local AI] LOCAL_MODEL_CACHE_DIR -> auto-redirect to repo cache {candidate} "
                      f"(Tauri runtime path {cfg} caused WinError 448 on HF symlinks)", flush=True)
                return candidate
        except OSError:
            pass
    try: cfg.mkdir(parents=True, exist_ok=True)
    except OSError: pass
    return cfg

MODEL_CACHE_DIR = _resolve_model_cache_dir()
# Reflect the resolved dir back into the env so huggingface_hub picks it up.
os.environ["LOCAL_MODEL_CACHE_DIR"] = str(MODEL_CACHE_DIR)

def _convert_hf_symlinks_to_hardlinks(cache_root) -> None:
    # On this Windows install the running server process can't follow
    # symlinks (OSError 22 / WinError 448) even though subprocesses of the
    # same Python can. transformers' cached_file then can't see config.json
    # / model.safetensors and raises misleading errors. Same blocker hits
    # diffusers for image models (which have nested subdirs: vae/, unet/,
    # text_encoder/, tokenizer/...) so we recurse through every snapshot.
    # Replace every symlink with a hardlink to its blob target. Hardlinks
    # aren't blocked by the symlink-privilege requirement and Python +
    # transformers + diffusers open them transparently as files.
    import pathlib
    try:
        root = pathlib.Path(cache_root)
        if not root.is_dir():
            return
        converted = 0
        for repo in root.glob("models--*"):
            snap_root = repo / "snapshots"
            if not snap_root.is_dir():
                continue
            for snap in snap_root.iterdir():
                if not snap.is_dir():
                    continue
                # Walk ALL nested entries. Diffusers models have subdirs
                # (vae/, unet/, etc.); a flat iterdir would miss them.
                for dirpath, _dirs, files in os.walk(str(snap)):
                    for fname in files:
                        entry = pathlib.Path(dirpath) / fname
                        if not entry.is_symlink():
                            continue
                        try:
                            target_str = os.readlink(str(entry))
                        except OSError:
                            continue
                        if not os.path.isabs(target_str):
                            target = (entry.parent / target_str).resolve()
                        else:
                            target = pathlib.Path(target_str)
                        if not target.is_file():
                            continue
                        try:
                            os.unlink(str(entry))
                            os.link(str(target), str(entry))
                            converted += 1
                        except OSError:
                            if not entry.exists():
                                try: os.symlink(target_str, str(entry))
                                except OSError: pass
        if converted:
            print(f"[SeekDeep] HF cache: converted {converted} symlinks → hardlinks "
                  f"(workaround for Windows process symlink-privilege issue)", flush=True)
    except Exception as exc:
        print(f"[SeekDeep] HF cache hardlink conversion skipped: {exc!r}", flush=True)

_convert_hf_symlinks_to_hardlinks(MODEL_CACHE_DIR)
# HF_HOME points at the cache root; HF_HUB_CACHE is the same path with /hub
# semantics. Setting both keeps every HF caller (transformers, diffusers,
# huggingface_hub) on the same resolved cache.
os.environ.setdefault("HF_HOME", str(MODEL_CACHE_DIR.parent))
os.environ.setdefault("HF_HUB_CACHE", str(MODEL_CACHE_DIR))

OUTPUT_DIR = ROOT / "outputs"
OUTPUT_DIR.mkdir(exist_ok=True)
TEMP_DIR = ROOT / "temp"
TEMP_DIR.mkdir(exist_ok=True)

# PYS-4: cap the on-disk image scratch dirs. Every image endpoint saves a PNG to
# outputs/ that is redundant with the base64 payload we already return to the bot,
# so without a cap a long-running server grows outputs/ without bound. 0 disables
# a cap. outputs/ is bounded by count + age; temp/ is swept by age only (its files
# are short-lived, so an age sweep only reclaims orphans left by a decode failure
# and can never delete an in-flight file).
SEEKDEEP_OUTPUTS_MAX_FILES = int(os.getenv("SEEKDEEP_OUTPUTS_MAX_FILES", "200") or 0)
SEEKDEEP_OUTPUTS_MAX_AGE_HOURS = float(os.getenv("SEEKDEEP_OUTPUTS_MAX_AGE_HOURS", "72") or 0)


def _prune_dir(directory, max_files: int = 0, max_age_hours: float = 0.0) -> None:
    """Best-effort cap on a scratch directory: delete by age first, then by count
    (oldest first). Pure housekeeping -- never raises into the request path."""
    try:
        if max_files <= 0 and max_age_hours <= 0:
            return
        entries = []
        for p in directory.iterdir():
            try:
                if p.is_file():
                    entries.append((p.stat().st_mtime, p))
            except OSError:
                continue
        if max_age_hours and max_age_hours > 0:
            cutoff = time.time() - max_age_hours * 3600.0
            survivors = []
            for mtime, p in entries:
                if mtime < cutoff:
                    try:
                        p.unlink()
                        continue
                    except OSError:
                        # Locked or already removed by another process; keep it as
                        # a survivor and let a later sweep retry.
                        pass
                survivors.append((mtime, p))
            entries = survivors
        if max_files and max_files > 0 and len(entries) > max_files:
            entries.sort(key=lambda t: t[0])
            for _mtime, p in entries[: len(entries) - max_files]:
                try:
                    p.unlink()
                except OSError:
                    # Best-effort delete; a locked/already-gone file is fine to skip.
                    pass
    except Exception:
        # Pruning is pure housekeeping; never let a scratch-dir hiccup surface
        # into the image request path.
        pass


def _output_path(safe_name: str):
    """OUTPUT_DIR / safe_name, pruning stale outputs (and temp orphans) first."""
    _prune_dir(OUTPUT_DIR, SEEKDEEP_OUTPUTS_MAX_FILES, SEEKDEEP_OUTPUTS_MAX_AGE_HOURS)
    _prune_dir(TEMP_DIR, 0, SEEKDEEP_OUTPUTS_MAX_AGE_HOURS)
    return OUTPUT_DIR / safe_name

CHAT_MODEL_ID = os.getenv("LOCAL_CHAT_MODEL_ID", "meta-llama/Llama-3.1-8B-Instruct")
VISION_MODEL_ID = os.getenv("LOCAL_VISION_MODEL_ID", "Qwen/Qwen2.5-VL-3B-Instruct")
IMAGE_MODEL_ID = os.getenv("LOCAL_IMAGE_MODEL_ID", "Lykon/dreamshaper-xl-1-0")

HF_TOKEN = os.getenv("HF_TOKEN") or os.getenv("HUGGINGFACE_TOKEN") or None
HF_LOCAL_FILES_ONLY = os.getenv("HF_LOCAL_FILES_ONLY", "false").lower() in {"1", "true", "yes", "on"}
# Security (PYS-1 / deep audit): trust_remote_code lets a Hugging Face repo
# execute its OWN Python at load time. A few models genuinely need it (custom
# tokenizer / model code), but combined with /model/install it is an RCE-shaped
# footgun — installing an untrusted model_id would run its code in the server.
# Default OFF (secure-by-default): the configured default models (Llama-3.1,
# Qwen2.5-VL, Dreamshaper-XL, Granite/Mistral/Phi/Gemma) are all natively
# supported by the pinned transformers and load fine without it. A model that
# genuinely requires remote code now fails to load LOUDLY; set
# SEEKDEEP_TRUST_REMOTE_CODE=on (All Settings) only after you trust that repo.
SEEKDEEP_TRUST_REMOTE_CODE = os.getenv("SEEKDEEP_TRUST_REMOTE_CODE", "off").lower() in {"1", "true", "yes", "on"}
# PYS-3: bound chat tokenizer input so an oversized aggregated payload (e.g. 200
# messages * 20k chars) can't spike CPU/RAM during tokenization. The char cap is
# far above any legitimate prompt (memory caps top out ~36k chars); the token cap
# truncates to a generous model budget. Only abusive inputs are affected.
SEEKDEEP_CHAT_MAX_INPUT_CHARS = int(os.getenv("SEEKDEEP_CHAT_MAX_INPUT_CHARS", str(200_000)))
SEEKDEEP_CHAT_MAX_INPUT_TOKENS = int(os.getenv("SEEKDEEP_CHAT_MAX_INPUT_TOKENS", str(16384)))
MODEL_KEEP_MODE = os.getenv("MODEL_KEEP_MODE", "task-lru").lower()

# Opt-in pins to keep specific models resident in VRAM across task switches.
# The explicit POST /unload endpoint (force=True) still clears everything.
#
# VRAM budget on a 24GB GPU (4bit chat):
#   chat 8B 4bit (~5GB)  + vision 3B fp16 (~6GB) = ~11GB, comfortable.
#   chat 8B 4bit (~5GB)  + vision 3B fp16 (~6GB) + Phi-4 14B 4bit swap (~9GB) = ~20GB, fits.
#   chat 8B 4bit (~5GB)  + SDXL (~6.5GB) = ~11.5GB, comfortable.
KEEP_RESIDENT_CHAT = os.getenv("LOCAL_CHAT_KEEP_RESIDENT", "false").lower() in {"1", "true", "yes", "on"}
KEEP_RESIDENT_VISION = os.getenv("LOCAL_VISION_KEEP_RESIDENT", "false").lower() in {"1", "true", "yes", "on"}
KEEP_RESIDENT_IMAGE = os.getenv("LOCAL_IMAGE_KEEP_RESIDENT", "false").lower() in {"1", "true", "yes", "on"}

# ---------------------------------------------------------------------------
# Text-to-speech (TTS) — /tts endpoint + GUI voice reader.
# ---------------------------------------------------------------------------
# Two engines are wired:
#   piper : fast, CPU-friendly, offline ONNX voices (OHF-Voice/piper). Needs a
#           voice file — set SEEKDEEP_TTS_PIPER_VOICE to a .onnx path (the model
#           is NOT bundled; download one yourself). Optionally point
#           SEEKDEEP_TTS_PIPER_BIN at a `piper` executable to use the CLI
#           instead of the Python package.
#   xtts  : Coqui XTTS-v2 (heavier, multilingual, voice-cloning). Set
#           SEEKDEEP_TTS_MODEL_ID to the XTTS repo id.
# No voice/model is configured by default, so /tts returns 503 until you set
# one. Nothing here imports at module load — the heavy bits live in the loader.
SEEKDEEP_TTS_ENGINE = (os.getenv("SEEKDEEP_TTS_ENGINE", "piper") or "piper").strip().lower()
SEEKDEEP_TTS_PIPER_VOICE = (os.getenv("SEEKDEEP_TTS_PIPER_VOICE", "") or "").strip()
SEEKDEEP_TTS_MODEL_ID = (os.getenv("SEEKDEEP_TTS_MODEL_ID", "") or "").strip()
SEEKDEEP_TTS_PIPER_BIN = (os.getenv("SEEKDEEP_TTS_PIPER_BIN", "") or "").strip()
# Hard cap on a single /tts request's text. Above this we 400 before any
# synthesis runs (a runaway paragraph shouldn't pin the CPU).
try:
    SEEKDEEP_TTS_MAX_CHARS = int(os.getenv("SEEKDEEP_TTS_MAX_CHARS", "2000"))
except ValueError:
    SEEKDEEP_TTS_MAX_CHARS = 2000


def _tts_voice_configured() -> bool:
    """True when the selected engine has a voice/model pointed at it. This is
    the single source of truth for the 503 ('not configured') gate and the
    /health `tts.enabled` flag — it answers "could /tts possibly work?" without
    importing or loading anything heavy."""
    if SEEKDEEP_TTS_ENGINE == "piper":
        return bool(SEEKDEEP_TTS_PIPER_VOICE)
    if SEEKDEEP_TTS_ENGINE == "xtts":
        return bool(SEEKDEEP_TTS_MODEL_ID)
    return False


def _tts_configured_voice() -> str:
    """The configured voice/model identifier for the active engine ('' if none).
    Surfaced in /health and echoed back in the /tts 200 response."""
    if SEEKDEEP_TTS_ENGINE == "piper":
        return SEEKDEEP_TTS_PIPER_VOICE
    if SEEKDEEP_TTS_ENGINE == "xtts":
        return SEEKDEEP_TTS_MODEL_ID
    return ""


# ---------------------------------------------------------------------------
# VRAM budget management
# ---------------------------------------------------------------------------
# Reserve this much VRAM (MB) for Windows, desktop compositor, Discord,
# Malwarebytes, MSI Center, and other background processes.  The default
# 4 GB is generous — typical Win11 desktop overhead is 1.5-2.5 GB, but
# spikes from antivirus scans or app updates can push higher.
VRAM_SYSTEM_RESERVE_MB = int(os.getenv("VRAM_SYSTEM_RESERVE_MB", "4096"))

# Extra headroom (MB) on top of the system reserve to absorb KV cache
# growth, PyTorch allocator fragmentation, and inference-time temporaries.
VRAM_SAFETY_MARGIN_MB = int(os.getenv("VRAM_SAFETY_MARGIN_MB", "1024"))

# Behavior when even after evicting non-pinned models we'd spill into
# shared (system) memory:
#   "fallback"    : refuse the role swap; serve from the currently-loaded
#                   chat role with a note. Default -- best UX on a busy box.
#   "warn"        : allow the load anyway. Logs WARNING; clients pay the
#                   ~30-60s spilled-load cost. (Previous behavior.)
#   "force-evict" : evict pinned models too if necessary. Aggressive: may
#                   unload your pinned vision model to free space.
VRAM_PRESSURE_MODE = (os.getenv("SEEKDEEP_VRAM_PRESSURE_MODE", "fallback") or "fallback").strip().lower()
if VRAM_PRESSURE_MODE not in {"fallback", "warn", "force-evict"}:
    VRAM_PRESSURE_MODE = "fallback"

# Estimated VRAM per model (MB).  Used for pre-load budget checks.
# These are conservative (slightly over real) so the gate errs on the side
# of unloading rather than OOMing.  Override any entry via env.
_VRAM_ESTIMATE_DEFAULTS: dict[str, int] = {
    # Chat models at 4-bit quantization
    "chat:default_chat": 5500,
    "chat:fallback_chat": 5500,
    "chat:quality_text": 8000,
    "chat:reasoning_code": 9500,
    "chat:lightweight_chat": 3000,
    "chat:refine_chat": 3000,
    # Vision / image pipelines (fp16)
    "vision": 6500,
    "image": 7000,
    "instruct_pix2pix": 5000,
    # GroundingDINO (~0.7GB) + SAM ViT-H (~2.5GB) loaded fp32 for high-fidelity
    # inpaint masks; conservative so the budget gate errs toward CLIPSeg fallback.
    "sam_segment": 4400,
}

def _load_vram_estimates() -> dict[str, int]:
    """Merge env overrides (VRAM_EST_CHAT_DEFAULT_CHAT=5500) into defaults."""
    estimates = dict(_VRAM_ESTIMATE_DEFAULTS)
    prefix = "VRAM_EST_"
    for key, val in os.environ.items():
        if key.startswith(prefix):
            mapped = key[len(prefix):].lower().replace("__", ":").replace("_", "_")
            # VRAM_EST_CHAT__DEFAULT_CHAT -> chat:default_chat
            mapped = key[len(prefix):].lower()
            parts = mapped.split("__", 1)
            if len(parts) == 2:
                mapped = f"{parts[0]}:{parts[1]}"
            try:
                estimates[mapped] = int(val)
            except ValueError:
                pass
    return estimates

VRAM_ESTIMATES: dict[str, int] = _load_vram_estimates()


def vram_total_mb() -> float:
    """Total GPU VRAM in MB (0 if CUDA unavailable)."""
    if not cuda_available():
        return 0
    try:
        import torch
        _, total = torch.cuda.mem_get_info()
        return total / (1024 ** 2)
    except Exception:
        return 0


def vram_used_mb() -> float:
    """VRAM currently used (system-wide view including other processes)."""
    if not cuda_available():
        return 0
    try:
        import torch
        free, total = torch.cuda.mem_get_info()
        return (total - free) / (1024 ** 2)
    except Exception:
        return 0


def vram_budget_available_mb() -> float:
    """VRAM headroom an upcoming model can actually claim without spilling.

    Uses the real free physical GPU memory (from cudaMemGetInfo) minus the
    Windows-overhead reserve and the safety margin. PyTorch's caching pool
    is intentionally NOT subtracted: empty_cache() releases unused pool
    blocks at load time, so subtracting them here double-counts and makes
    the budget falsely tight (which was causing spurious "spill warnings"
    even when the model would actually fit).
    """
    if not cuda_available():
        return 0
    try:
        import torch
        free, _total = torch.cuda.mem_get_info()
        free_mb = free / (1024 ** 2)
        budget = free_mb - VRAM_SYSTEM_RESERVE_MB - VRAM_SAFETY_MARGIN_MB
        return max(0.0, budget)
    except Exception:
        return 0


def estimate_model_vram(task: str, role: str = "") -> int:
    """Return estimated VRAM (MB) for a model about to load."""
    if task == "chat" and role:
        key = f"chat:{role}"
        if key in VRAM_ESTIMATES:
            return VRAM_ESTIMATES[key]
        return VRAM_ESTIMATES.get("chat:default_chat", 5500)
    return VRAM_ESTIMATES.get(task, 5000)


def vram_can_fit(task: str, role: str = "") -> tuple[bool, float, int]:
    """Check whether the requested model fits in the current VRAM budget.

    Returns (fits, available_mb, estimated_mb).
    """
    available = vram_budget_available_mb()
    estimated = estimate_model_vram(task, role)
    return available >= estimated, available, estimated


# ---------------------------------------------------------------------------
# Chat model role routing
# ---------------------------------------------------------------------------
# Role -> raw env value (may be blank). Resolution happens in resolve_chat_role().
CHAT_ROLE_ENV = {
    "default_chat": "LOCAL_CHAT_MODEL_ID",
    "fallback_chat": "LOCAL_CHAT_FALLBACK_MODEL_ID",
    "quality_text": "LOCAL_CHAT_QUALITY_MODEL_ID",
    "reasoning_code": "LOCAL_CHAT_REASONING_MODEL_ID",
    "lightweight_chat": "LOCAL_CHAT_LIGHTWEIGHT_MODEL_ID",
    "refine_chat": "LOCAL_CHAT_REFINE_MODEL_ID",
}

MODEL_AUTO_FALLBACK = os.getenv("MODEL_AUTO_FALLBACK", "true").lower() in {"1", "true", "yes", "on"}
MODEL_ROUTER_LOG = os.getenv("MODEL_ROUTER_LOG", "true").lower() in {"1", "true", "yes", "on"}
MODEL_LOG_VRAM = os.getenv("MODEL_LOG_VRAM", "true").lower() in {"1", "true", "yes", "on"}

# Chat-model quantization mode: 4bit (recommended for laptops), 8bit, or none/off/fp16/bf16.
LOCAL_CHAT_QUANT = (os.getenv("LOCAL_CHAT_QUANT", "4bit") or "").strip().lower()

# Roles that always load at full precision (skip bnb quant).
# Empty by default — on a 24GB laptop GPU, loading default_chat at fp16
# (~16GB) alongside SDXL (~7GB) spills into system memory and kills
# desktop responsiveness. Set to "default_chat,fallback_chat" only if
# you have 32GB+ VRAM and want fp16 nuance back.
LOCAL_CHAT_QUANT_FULL_ROLES = {
    role.strip().lower()
    for role in (os.getenv("LOCAL_CHAT_QUANT_FULL_ROLES", "") or "").split(",")
    if role.strip()
}


def _normalized_chat_quant_mode() -> str:
    mode = LOCAL_CHAT_QUANT
    if mode in {"", "none", "off", "false", "no", "fp16", "bf16", "float16", "bfloat16", "full"}:
        return "none"
    if mode in {"4bit", "nf4", "int4", "4"}:
        return "4bit"
    if mode in {"8bit", "int8", "8"}:
        return "8bit"
    return "none"


def _build_chat_quant_config():
    """Return a BitsAndBytesConfig (or None) based on LOCAL_CHAT_QUANT.

    Falls back to None (full precision) if bitsandbytes is not importable.
    """
    mode = _normalized_chat_quant_mode()
    if mode == "none":
        return None
    try:
        from transformers import BitsAndBytesConfig
        import torch
    except Exception as exc:  # noqa: BLE001
        print(
            f"[SeekDeep Local AI] bitsandbytes unavailable ({exc}); falling back to full precision for chat.",
            flush=True,
        )
        return None

    if mode == "8bit":
        return BitsAndBytesConfig(load_in_8bit=True)

    # 4bit (NF4 + double quant + bf16 compute — the well-tested QLoRA-style preset).
    return BitsAndBytesConfig(
        load_in_4bit=True,
        bnb_4bit_quant_type="nf4",
        bnb_4bit_use_double_quant=True,
        bnb_4bit_compute_dtype=torch.bfloat16,
    )


def _env_str(name: str) -> str:
    return (os.getenv(name) or "").strip()


def chat_role_map() -> dict[str, str]:
    """Resolve every known chat role to a concrete model ID, applying fallback chains."""
    default_id = _env_str("LOCAL_CHAT_MODEL_ID") or CHAT_MODEL_ID
    fallback_id = _env_str("LOCAL_CHAT_FALLBACK_MODEL_ID") or default_id
    quality_id = _env_str("LOCAL_CHAT_QUALITY_MODEL_ID") or fallback_id or default_id
    reasoning_id = _env_str("LOCAL_CHAT_REASONING_MODEL_ID") or quality_id or fallback_id or default_id
    lightweight_id = _env_str("LOCAL_CHAT_LIGHTWEIGHT_MODEL_ID")
    refine_id = _env_str("LOCAL_CHAT_REFINE_MODEL_ID") or lightweight_id or default_id
    mapping = {
        "default_chat": default_id,
        "fallback_chat": fallback_id,
        "quality_text": quality_id,
        "reasoning_code": reasoning_id,
        "refine_chat": refine_id,
    }
    if lightweight_id:
        mapping["lightweight_chat"] = lightweight_id
    return mapping


def resolve_chat_role(role: str | None) -> tuple[str, str]:
    """Return (resolved_role, model_id) for the requested role, defaulting safely."""
    requested = (role or "default_chat").strip().lower() or "default_chat"
    mapping = chat_role_map()
    if requested not in mapping:
        if MODEL_ROUTER_LOG:
            print(f"[SeekDeep Model Router] unknown role={requested}; using default_chat", flush=True)
        requested = "default_chat"
    return requested, mapping[requested]


def _log_vram(label: str) -> None:
    if not MODEL_LOG_VRAM:
        return
    try:
        import torch
        if torch.cuda.is_available():
            alloc = torch.cuda.memory_allocated() / (1024 ** 2)
            reserved = torch.cuda.memory_reserved() / (1024 ** 2)
            print(f"[SeekDeep VRAM] {label} allocated={alloc:.0f}MiB reserved={reserved:.0f}MiB", flush=True)
    except Exception:
        pass

# Read version from package.json so we have ONE source of truth shared by
# the Node bot, the FastAPI side-car, and every GUI page. /health exposes it
# below and gui/version.js fans it out to any [data-version] placeholder.
def _read_pkg_version() -> str:
    try:
        import json as _json
        with open(os.path.join(os.path.dirname(os.path.abspath(__file__)), "package.json"),
                  "r", encoding="utf-8") as _f:
            return str(_json.load(_f).get("version") or "0.0.0")
    except Exception:
        return "0.0.0"

SEEKDEEP_VERSION = _read_pkg_version()


def _ensure_tokenizer_deps_synchronously() -> None:
    """SYNCHRONOUS at module load — blocks until tiktoken + sentencepiece
    are importable. Runs BEFORE the FastAPI app is created so port 7865
    doesn't open until /chat will actually work.

    Tradeoff: first launch after this fix is ~30s slower if either dep is
    missing (one pip install). Every subsequent launch: zero overhead (both
    imports succeed instantly, function is a no-op). The 30s shows on the
    Tauri loading screen — which is exactly the place users expect to wait.

    Was async-on-startup-hook before, which gave the server a head-start and
    let /chat 503 with tokenizer-load-failure for ~30s after boot. User
    flagged this as "chat is broken on boot." Blocking the import here makes
    that race impossible by construction."""
    import importlib, sys
    missing: list[tuple[str, str]] = []
    for mod, pkg in (("tiktoken", "tiktoken>=0.8.0"),
                     ("sentencepiece", "sentencepiece>=0.2.0")):
        try:
            importlib.import_module(mod)
        except Exception:
            missing.append((mod, pkg))
    if not missing:
        return
    pkgs = [pkg for _, pkg in missing]
    print(f"[SeekDeep] BOOT: installing missing tokenizer deps {pkgs} "
          f"(blocking; ~30s; only happens once)", flush=True)
    try:
        import subprocess as _sub
        _nw = getattr(_sub, "CREATE_NO_WINDOW", 0) if os.name == "nt" else 0
        rc = _sub.call(
            [sys.executable, "-m", "pip", "install", "--no-cache-dir",
             "--disable-pip-version-check", *pkgs],
            creationflags=_nw,
        )
        if rc != 0:
            print(f"[SeekDeep] BOOT: tokenizer pip install exited rc={rc} - "
                  f"chat will 503 until manually fixed via INSTALL TOKENIZER "
                  f"DEPS button.", flush=True)
            return
        # Re-import so the running interpreter actually sees the new modules.
        for mod, _ in missing:
            try:
                importlib.invalidate_caches()
                importlib.import_module(mod)
            except Exception as exc:
                print(f"[SeekDeep] BOOT: still can't import {mod} after install: {exc}", flush=True)
        print(f"[SeekDeep] BOOT: tokenizer deps installed; continuing startup", flush=True)
    except Exception as exc:
        print(f"[SeekDeep] BOOT: tokenizer auto-install failed: {exc} - "
              f"chat will 503 until manually fixed.", flush=True)


_ensure_tokenizer_deps_synchronously()

def _warn_about_multimodal_chat_role_configs() -> None:
    # Each multimodal model_type listed below CAN'T load via AutoModelForCausalLM.
    # When a chat role points at one of these, every /chat request to that
    # role pays an auto-fallback hop (which works — see _is_fallback_eligible_
    # exception — but adds ~5-10s of model swap if the fallback model isn't
    # already resident). Surfacing this at boot lets the user fix the binding
    # in Bot Config instead of silently paying the fallback every request.
    multimodal_types = ("gemma3n", "paligemma", "llava", "qwen2_vl", "qwen2_5_vl",
                        "qwen2_audio", "idefics", "idefics2", "idefics3")
    multimodal_id_hints = ("gemma-3n", "paligemma", "llava", "qwen2-vl", "qwen2.5-vl",
                           "qwen2-audio", "idefics")
    try:
        roles = chat_role_map()
    except Exception:
        return
    for role, model_id in roles.items():
        if not model_id:
            continue
        mid_lower = model_id.lower()
        if any(hint in mid_lower for hint in multimodal_id_hints):
            print(f"[SeekDeep Local AI] config note: chat role {role!r} -> {model_id!r} "
                  f"looks multimodal; every /chat to this role will auto-fall through to "
                  f"fallback_chat. Consider pointing this role at a text-only model "
                  f"(e.g. google/gemma-2-2b-it, microsoft/Phi-3-mini-4k-instruct) in .env.",
                  flush=True)

_warn_about_multimodal_chat_role_configs()

app = FastAPI(title="SeekDeep Local AI Server", version=SEEKDEEP_VERSION)

# ===== CORS =====
# The Tauri 2 desktop shell serves bundled pages from http://tauri.localhost
# (Windows + Linux) or http://tauri.localhost / tauri:// (macOS) — that's a
# DIFFERENT origin from the local AI server at http://127.0.0.1:7865, so the
# WebView's fetch() calls hit the cross-origin CORS path. Without permissive
# CORS headers, every probe (/health, /ml_deps, /models/installed, etc.) gets
# rejected by the browser DESPITE the server returning 200 — the response is
# delivered but JS can't read it, so the loading overlay sees no answer and
# never redirects to chat.html.
#
# CORS: allowlist-only. The old `allow_origins=["*"]` was unsafe because a
# malicious webpage in the user's browser can fetch http://127.0.0.1:7865/...
# — the TCP connection IS loopback (the browser is the local peer), so any
# loopback-host check passes. With `*`, the browser then lets the malicious
# page read the response body, exfiltrating tokens / logs / prompts.
# Allowlist below covers the FastAPI-served GUI (127.0.0.1:7865 + localhost
# variant) and the Tauri 2 shells (tauri.localhost on Windows,
# tauri://localhost on macOS/Linux). Server-to-server callers (the bot, curl)
# don't send Origin headers so CORS doesn't apply to them.
from fastapi.middleware.cors import CORSMiddleware
try:
    from gui_endpoints import TRUSTED_BROWSER_ORIGINS as _TRUSTED_ORIGINS
except Exception:
    # Fallback if gui_endpoints fails to import. Mirror of the canonical list.
    _TRUSTED_ORIGINS = (
        "http://127.0.0.1:7865",
        "http://localhost:7865",
        "http://tauri.localhost",
        "tauri://localhost",
        "https://tauri.localhost",
    )
app.add_middleware(
    CORSMiddleware,
    allow_origins=list(_TRUSTED_ORIGINS),
    allow_credentials=False,  # we use a header token, not cookies
    allow_methods=["*"],
    allow_headers=["*"],
    expose_headers=["*"],
)

# ===== Request counter + latency tracking =====
# Powers the Control Center's per-service "Reqs: 184 · Latency: 48ms" cells
# (previously hardcoded). In-memory rolling 24h counters bucketed by path
# family (e.g. /chat/* → 'chat', /image/* → 'image'). Latency is a deque
# of the last N samples; we compute p50/p95 on demand.
#
# Why not persist to disk: counters reset on every server restart, which
# is fine for a "what's happening RIGHT NOW" dashboard. The bot side
# already persists permanent totals to server-stats.json — these in-memory
# stats are complementary (live request volume vs lifetime usage).
import collections as _seekdeep_collections
import threading as _seekdeep_req_threading

_REQ_LOCK = _seekdeep_req_threading.Lock()
_REQ_TOTAL = 0
_REQ_BY_FAMILY: dict[str, int] = {}
# Web-playground chat breakdowns. Bot-side counts live in
# data/server-stats.json (written by index.js); these in-memory counters
# capture the web-playground side so /stats/snapshot can merge both into
# one "Persona usage" / "Chat model usage" view. Reset on server restart,
# which is fine — these are complementary to the persistent bot totals.
_WEB_CHAT_BY_PERSONA: dict[str, int] = {}
_WEB_CHAT_BY_MODEL: dict[str, int] = {}
# Last 24h of requests as (epoch_ts, latency_ms, path_family) tuples,
# capped at 20k entries (~13/sec sustained for a day, well above realistic).
_REQ_RECENT: _seekdeep_collections.deque = _seekdeep_collections.deque(maxlen=20_000)
_REQ_STARTED_AT = time.time()

def _seekdeep_req_family(path: str) -> str:
    """Bucket a URL path into a coarse family for the per-service tile.
    `/chat`, `/chat/whatever` → 'chat'. `/health` → 'health'. Anything
    without a slash-prefixed first segment → 'other'."""
    p = (path or "").lstrip("/").split("/", 1)[0].lower()
    return p or "root"

@app.middleware("http")
async def _seekdeep_count_requests(request, call_next):
    family = _seekdeep_req_family(request.url.path)
    t0 = time.time()
    response = await call_next(request)
    elapsed_ms = (time.time() - t0) * 1000.0
    # WS upgrade requests don't have meaningful elapsed time at this layer;
    # they'd skew the latency stats. Skip them.
    if request.scope.get("type") == "http":
        global _REQ_TOTAL
        with _REQ_LOCK:
            _REQ_TOTAL += 1
            _REQ_BY_FAMILY[family] = _REQ_BY_FAMILY.get(family, 0) + 1
            _REQ_RECENT.append((t0, elapsed_ms, family))
    return response

def _seekdeep_bump_web_chat(persona: str, model_id: str) -> None:
    """Bump web-playground chat counters by persona + model_id. Called from
    /chat after a successful generation. Empty strings collapse to 'unknown'
    so we always see SOME distribution. AUD-006 follow-on (sufficient for
    the Stats pane to show non-empty breakdowns from web-playground use)."""
    p = (persona or "").strip().lower()[:64] or "unknown"
    m = (model_id or "").strip().lower()[:128] or "unknown"
    # Collapse to last path segment so meta-llama/Llama-3.1-8B-Instruct
    # shares a bucket with the same role's local-cached version.
    m_short = m.rsplit("/", 1)[-1]
    with _REQ_LOCK:
        _WEB_CHAT_BY_PERSONA[p] = _WEB_CHAT_BY_PERSONA.get(p, 0) + 1
        _WEB_CHAT_BY_MODEL[m_short] = _WEB_CHAT_BY_MODEL.get(m_short, 0) + 1


def _seekdeep_req_stats() -> dict:
    """Snapshot of the counters for /stats/snapshot consumers. Computes
    p50/p95 latency from the in-memory deque, plus 24h-window request
    counts (filtered from the rolling deque)."""
    now = time.time()
    day_ago = now - 86400
    with _REQ_LOCK:
        recent = list(_REQ_RECENT)
        total = _REQ_TOTAL
        by_family_lifetime = dict(_REQ_BY_FAMILY)
        web_persona = dict(_WEB_CHAT_BY_PERSONA)
        web_model   = dict(_WEB_CHAT_BY_MODEL)
        started = _REQ_STARTED_AT
    # Filter to 24h window
    last_24h = [r for r in recent if r[0] >= day_ago]
    latencies_ms = sorted(r[1] for r in last_24h)
    by_family_24h: dict[str, int] = {}
    for _, _l, fam in last_24h:
        by_family_24h[fam] = by_family_24h.get(fam, 0) + 1
    p50 = latencies_ms[len(latencies_ms) // 2] if latencies_ms else None
    p95 = latencies_ms[int(len(latencies_ms) * 0.95)] if latencies_ms else None
    return {
        "uptime_seconds":   int(now - started),
        "total_requests":   total,
        "requests_24h":     len(last_24h),
        "by_family_lifetime": by_family_lifetime,
        "by_family_24h":      by_family_24h,
        # Web-playground chat breakdowns. /stats/snapshot merges these into
        # bot.by_persona / bot.by_chat_model so the dashboard reflects total
        # chat activity across both surfaces.
        "web_chat_by_persona": web_persona,
        "web_chat_by_model":   web_model,
        "latency_p50_ms":   round(p50, 1) if p50 is not None else None,
        "latency_p95_ms":   round(p95, 1) if p95 is not None else None,
    }

# ===== SeekDeep GUI · static mount =====
# Custom StaticFiles subclass that adds Cache-Control: no-store on HTML +
# JS responses. Without this, WebView2 caches index.html / app.html /
# chat.html etc. so aggressively that pushing a new gui/*.html file +
# running the new .msi still shows the OLD page until the user manually
# clears the WebView cache. no-store forces every request to re-fetch.
# We're on loopback — there's no bandwidth cost.
from fastapi.staticfiles import StaticFiles
from starlette.responses import Response as _SDResponse

# TAU-5: CSP + security headers for the browser-served GUI (loopback). Mirrors the
# desktop CSP in src-tauri/tauri.conf.json so the identical gui/*.html assets enforce
# the same policy whether opened in the Tauri webview or a normal browser. connect-src
# is loopback-only (no bare https:) so a compromised page can't exfiltrate the GUI
# token to an external host; no iframes exist anywhere in gui/, so framing is denied.
# NOTE: script-src is 'self' only — NO 'unsafe-inline'. Every GUI inline <script>
# block + on*= handler was extracted to an external file (PRs #82-#87), so the
# browser/webview rejects any inline script injection. Kept in lockstep with the
# tauri.conf.json CSP. style-src KEEPS 'unsafe-inline' on purpose (inline style=
# is pervasive + low-risk; tightening it is a separate, much larger job).
_SEEKDEEP_GUI_CSP = (
    "default-src 'self'; "
    "script-src 'self'; "
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; "
    "img-src 'self' data: blob: https:; "
    "font-src 'self' data: https://fonts.gstatic.com; "
    "connect-src 'self' http://127.0.0.1:* http://localhost:* ws://127.0.0.1:* ws://localhost:*; "
    "media-src 'self' data: blob:; "
    "worker-src 'self' blob:; "
    "frame-src 'none'; "
    "frame-ancestors 'none'"
)

class _SeekDeepNoCacheStaticFiles(StaticFiles):
    async def get_response(self, path, scope):
        resp = await super().get_response(path, scope)
        if hasattr(resp, "headers"):
            ext = (path or "").lower().rsplit(".", 1)[-1]
            # The Discord Activity (gui/activity/*) is INTENTIONALLY embedded in
            # Discord's iframe and loads its SDK from esm.sh — so it must NOT get the
            # anti-framing header or the strict GUI CSP (those would block Discord
            # from embedding it and block the cross-origin SDK import). It runs under
            # Discord's own context, not the SeekDeep GUI policy.
            is_activity = (path or "").replace("\\", "/").lstrip("/").startswith("activity/")
            # HTML/JS/CSS/JSON are everything that mutates between SeekDeep
            # releases. SeekDeep ships as a Tauri desktop app serving over
            # loopback — there is no bandwidth case for caching the GUI.
            # The only thing caching buys us is stale UIs after an update,
            # which is what we just spent hours debugging. So: hard no-store.
            # Images / fonts / webp / svg / wasm stay cacheable since they
            # rarely change and don't carry the "is this the new build?"
            # question marks.
            if ext in ("html", "htm", "js", "mjs", "css", "json"):
                resp.headers["Cache-Control"] = "no-store, max-age=0, must-revalidate"
                resp.headers["Pragma"] = "no-cache"
                resp.headers["Expires"] = "0"
                # TAU-5: security headers on the browser path (the Tauri webview
                # gets its CSP from tauri.conf.json; this loopback mount had none).
                resp.headers.setdefault("X-Content-Type-Options", "nosniff")
                resp.headers.setdefault("Referrer-Policy", "no-referrer")
                if not is_activity:
                    resp.headers.setdefault("X-Frame-Options", "DENY")
                    if ext in ("html", "htm"):
                        resp.headers.setdefault("Content-Security-Policy", _SEEKDEEP_GUI_CSP)
        return resp

_GUI_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "gui")
if os.path.isdir(_GUI_DIR):
    app.mount("/gui", _SeekDeepNoCacheStaticFiles(directory=_GUI_DIR, html=True), name="gui")
    print(f"[SeekDeep] GUI mounted at /gui  ->  {_GUI_DIR}  (no-store headers on html/js)")

# ===== SeekDeep GUI · backend endpoints (config / logs / launcher / data / model.warm) =====
# `require_gui_token` is set up by register_gui_endpoints. We import it once
# here so the destructive routes defined further down in this file (/unload,
# /warmup/chat, /warmup/image, /warmup/vision) can apply the same X-SeekDeep-
# Token check via Depends(). Defaults to a no-op if gui_endpoints isn't
# available, so the routes still work if someone runs the server without it.
try:
    from gui_endpoints import register_gui_endpoints, require_gui_token, event_bus
    register_gui_endpoints(
        app,
        log_dir="logs", data_dir="data", env_path=".env",
        # Wire /model/warm to the same loaders the /warmup/* routes use so the
        # Control Center "Warm" buttons actually load the model instead of just
        # flashing a fake success.
        warmup_handlers={
            # Backend-aware for chat: HF roles load via transformers;
            # Ollama roles call /api/pull on the daemon if the tag isn't present.
            "chat":   lambda role: warm_chat_role(role),
            "image":  lambda: load_image_pipe(),
            "vision": lambda: load_vision_model(),
        },
        # Pin /stats/snapshot to THIS process's live counters. Without the
        # callback, gui_endpoints would have to `import local_ai_server`,
        # which when local_ai_server is __main__ resolves to a different
        # module instance with its own zero-initialized counters — making
        # the dashboard show "0 requests" forever. The closure here keeps
        # us reading _seekdeep_req_stats from the running process.
        stats_provider=_seekdeep_req_stats,
        # Live-tick snapshot providers — feed the WS event bus so the GUI
        # can drop its setInterval polls on /gpu, /health, /route/debug.
        tick_providers={
            "gpu":    lambda: _build_gpu_tick_payload(),
            "health": lambda: _build_health_tick_payload(),
        },
    )
except Exception as _gui_err:
    print(f"[SeekDeep] gui_endpoints not registered: {_gui_err}")
    # FAIL CLOSED: if gui_endpoints couldn't register, the destructive routes
    # below (/unload, /model/install, /model/uninstall, /warmup/*) MUST reject
    # requests. Previously this fallback was `return None` which silently
    # disabled auth — anyone reaching the loopback port could pip-install
    # arbitrary HF repos or unload models. Now they get 503.
    #
    # If you genuinely want the routes available without auth in test/dev,
    # set SEEKDEEP_GUI_AUTH_ALLOW_OPEN=1 in the environment. Never in prod.
    if os.getenv("SEEKDEEP_GUI_AUTH_ALLOW_OPEN") == "1":
        async def require_gui_token(request=None): return None
    else:
        from fastapi import HTTPException as _HE
        async def require_gui_token(request=None):
            raise _HE(status_code=503, detail="GUI auth unavailable (gui_endpoints failed to register)")
    event_bus = None  # no-op fallback so producer hooks below don't crash


def _emit_event(event_type: str, data: dict) -> None:
    """Best-effort WebSocket event publish. Safe from sync code, no-op if the
    bus isn't ready / nobody's listening. See gui_endpoints._EventBus.publish_sync."""
    if event_bus is None:
        return
    try:
        event_bus.publish_sync({"type": event_type, "data": data})
    except Exception:
        pass


def _vram_event_payload() -> dict:
    """Snapshot for vram.sample events. Mirrors gpu_stats() but trimmed to
    the fields the GUI's Local-stack panel actually uses."""
    try:
        stats = gpu_stats()
    except Exception:
        return {}
    return {
        "used_mb":      stats.get("used_mb"),
        "total_mb":     stats.get("total_mb"),
        "free_mb":      stats.get("free_mb"),
        "allocated_mb": stats.get("allocated_mb"),
        "reserved_mb":  stats.get("reserved_mb"),
        "device":       stats.get("device_name"),
        "loaded_task":  stats.get("loaded_task"),
        "loaded_chat_role":    stats.get("loaded_chat_role"),
        "loaded_chat_model_id": stats.get("loaded_chat_model_id"),
    }


def _build_gpu_tick_payload() -> dict:
    """Same shape as GET /gpu — full gpu_stats() + vram_budget. Called by
    the live-tick loop in gui_endpoints so the GUI can stop polling /gpu."""
    try:
        stats = gpu_stats()
    except Exception:
        return {}
    try:
        stats["vram_budget"] = {
            "system_reserve_mb": VRAM_SYSTEM_RESERVE_MB,
            "safety_margin_mb": VRAM_SAFETY_MARGIN_MB,
            "available_for_models_mb": round(vram_budget_available_mb(), 0),
        }
    except Exception:
        pass
    return stats


def _build_health_tick_payload() -> dict:
    """Slim subset of GET /health for live ticks. Excludes the per-role
    remote-endpoint lookup (medium-cost) since that info only changes on
    /config writes — which already emit route.changed. Consumers needing
    the full payload can still call GET /health on demand."""
    try:
        return {
            "status": "ready",
            "version": SEEKDEEP_VERSION,
            "device": device_name(),
            "cuda_available": cuda_available(),
            "loaded_task": loaded_task,
            "loaded_chat_role": loaded_chat_role,
            "loaded_chat_model_id": loaded_chat_model_id,
            "gpu": gpu_stats(),
        }
    except Exception:
        return {"status": "ready"}


@app.on_event("startup")
async def _start_vram_sampler():
    """Emits a vram.sample event every 10 seconds while at least one GUI
    websocket is connected. Skipped silently when no subscribers, so an idle
    box doesn't pay the gpu_stats() cost or the publish overhead."""
    if event_bus is None:
        return
    import asyncio as _asyncio
    async def _loop():
        while True:
            try:
                await _asyncio.sleep(10)
                if event_bus.subscriber_count > 0:
                    await event_bus.publish({
                        "type": "vram.sample",
                        "data": _vram_event_payload(),
                    })
            except _asyncio.CancelledError:
                break
            except Exception:
                await _asyncio.sleep(10)
    loop = _asyncio.get_running_loop()
    app.state.seekdeep_vram_task = loop.create_task(_loop())


@app.on_event("shutdown")
async def _stop_vram_sampler():
    t = getattr(app.state, "seekdeep_vram_task", None)
    if t and not t.done():
        t.cancel()


# ===== queue.depth producer =====
# Counts in-flight requests per pipeline kind (chat / image / vision) so
# the GUI's queue panel reflects real load. Implemented as ASGI middleware
# so no endpoint code changes -- every matched URL bumps the counter on
# entry and decrements on exit. Unmatched paths are pass-throughs.
#
# Pipeline mapping: each route delegates to the same model class under
# the hood, so we coalesce variants into the three buckets the GUI uses.
import threading as _seekdeep_threading

_SEEKDEEP_PATH_TO_KIND = {
    "/chat":             "chat",
    "/image":            "image",
    "/img2img":          "image",
    "/inpaint":          "image",
    "/inpaint_mask_preview": "image",
    "/instruct-pix2pix": "image",
    "/upscale":          "image",
    "/chart":            "image",
    "/vision":           "vision",
}
_seekdeep_inflight_lock = _seekdeep_threading.Lock()
_seekdeep_inflight: dict[str, int] = {"chat": 0, "image": 0, "vision": 0}


def _seekdeep_emit_queue_depth() -> None:
    """Publish a snapshot of the current in-flight counts. Cheap when no
    subscribers (publish_sync's fast path skips the dispatch)."""
    with _seekdeep_inflight_lock:
        snapshot = dict(_seekdeep_inflight)
    _emit_event("queue.depth", snapshot)


@app.middleware("http")
async def _seekdeep_track_inflight(request, call_next):
    """ASGI middleware: bump the per-kind counter for known pipeline routes,
    emit queue.depth, run the handler, decrement on the way out, emit again."""
    kind = _SEEKDEEP_PATH_TO_KIND.get(request.url.path)
    if kind is None:
        return await call_next(request)
    with _seekdeep_inflight_lock:
        _seekdeep_inflight[kind] = _seekdeep_inflight.get(kind, 0) + 1
    _seekdeep_emit_queue_depth()
    try:
        return await call_next(request)
    finally:
        with _seekdeep_inflight_lock:
            _seekdeep_inflight[kind] = max(0, _seekdeep_inflight.get(kind, 0) - 1)
        _seekdeep_emit_queue_depth()


# ---------------------------------------------------------------------------
# Stable helpers must be defined before any FastAPI route uses them.
# ---------------------------------------------------------------------------

def cuda_available() -> bool:
    try:
        import torch
        return bool(torch.cuda.is_available())
    except Exception:
        return False


def device_name() -> str:
    try:
        import torch
        if torch.cuda.is_available():
            return torch.cuda.get_device_name(0)
        return "CPU"
    except Exception:
        return "unknown"


def model_dtype():
    try:
        import torch
        forced = os.getenv("LOCAL_TORCH_DTYPE", "auto").lower()
        if forced == "float16":
            return torch.float16
        if forced == "bfloat16":
            return torch.bfloat16
        if forced == "float32":
            return torch.float32
        if torch.cuda.is_available():
            return torch.bfloat16
        return torch.float32
    except Exception:
        return None


def first_model_device(model: Any):
    try:
        return next(model.parameters()).device
    except Exception:
        try:
            import torch
            return torch.device("cuda" if torch.cuda.is_available() else "cpu")
        except Exception:
            return "cpu"


def _seekdeep_nvidia_smi_probe() -> dict:
    """Probe the NVIDIA driver for GPU presence *without* needing PyTorch.

    Returns {detected: bool, name?, total_mb?, driver?, util_pct?, temp_c?,
    power_w?, power_limit_w?, fan_pct?, error?}. The point is to distinguish
    "no GPU at all" from "GPU is here, PyTorch just isn't installed yet"
    — the installer page lied as 'no GPU · CPU mode' for fresh installs
    with the hardware fine but ML deps not pulled.

    Also reports live util/temp/power/fan so the GPU pane can show real
    "Temperature: 67°C / Power Draw: 165W / Fan: 42%" instead of "—
    nvidia-smi pending" placeholders forever.

    nvidia-smi ships with the NVIDIA driver on every supported OS, so this
    works before requirements-ml.txt is ever installed. Cheap subprocess
    (~50ms on a healthy install). 2s hard timeout so a hung driver can't
    stall /gpu.
    """
    import subprocess
    # Hide the console window on Windows so /gpu polls don't flash a terminal.
    _nw = getattr(subprocess, "CREATE_NO_WINDOW", 0) if os.name == "nt" else 0
    out: dict = {"detected": False}
    try:
        r = subprocess.run(
            ["nvidia-smi",
             "--query-gpu=name,memory.total,driver_version,utilization.gpu,temperature.gpu,power.draw,power.limit,fan.speed",
             "--format=csv,noheader,nounits"],
            capture_output=True, text=True, timeout=2,
            creationflags=_nw,
        )
    except FileNotFoundError:
        out["error"] = "nvidia-smi not on PATH"
        return out
    except subprocess.TimeoutExpired:
        out["error"] = "nvidia-smi timed out (driver may be hung)"
        return out
    except Exception as exc:
        out["error"] = str(exc)[:160]
        return out
    if r.returncode != 0:
        out["error"] = (r.stderr or r.stdout or "").strip()[:160] or "non-zero exit"
        return out
    # First GPU only (most installs are single-GPU; we don't need a list
    # to answer "is there a GPU here").
    line = (r.stdout or "").strip().splitlines()
    if not line:
        return out
    parts = [p.strip() for p in line[0].split(",")]
    def _f(s):
        try:
            v = s.strip()
            if not v or v.lower() in ("[n/a]", "n/a", "not supported"):
                return None
            return float(v)
        except Exception:
            return None
    if len(parts) >= 2:
        out["detected"] = True
        out["name"] = parts[0]
        out["total_mb"] = int(_f(parts[1])) if _f(parts[1]) is not None else None
        if len(parts) >= 3: out["driver"]        = parts[2] or None
        if len(parts) >= 4: out["util_pct"]      = _f(parts[3])
        if len(parts) >= 5: out["temp_c"]        = _f(parts[4])
        if len(parts) >= 6: out["power_w"]       = _f(parts[5])
        if len(parts) >= 7: out["power_limit_w"] = _f(parts[6])
        if len(parts) >= 8: out["fan_pct"]       = _f(parts[7])
    return out


def gpu_stats() -> dict:
    """Return current GPU state. Used by /health and /gpu.

    Returns four memory numbers because together they diagnose VRAM thrashing:
    - allocated_mb: tensors PyTorch is actively using
    - reserved_mb: caching-allocator pool ceiling (memory PyTorch holds)
    - free_mb / total_mb: from torch.cuda.mem_get_info(), the GPU's own view
    - used_mb = total - free, includes Windows desktop compositor + other procs

    When reserved_mb approaches total_mb on Windows, the driver starts
    overflowing allocations into system shared memory. That's the proximate
    cause of "the bot generated 2 images and now everything is laggy".

    Includes an nvidia_smi sub-block so the installer page can distinguish
    "no GPU at all" (nvidia_smi.detected=false) from "GPU detected but
    PyTorch not installed yet" (available=false, nvidia_smi.detected=true).
    Before this, fresh installs with a 4090 + no torch showed "no GPU ·
    CPU mode" — the bug your screenshot caught.
    """
    stats: dict = {
        "available": False,
        "device_name": device_name(),
        "loaded_task": loaded_task,
        "loaded_chat_role": loaded_chat_role,
        "loaded_chat_model_id": loaded_chat_model_id,
        "nvidia_smi": _seekdeep_nvidia_smi_probe(),
    }
    try:
        import torch
        # Always surface the wheel arch + torch version so the GUI's
        # "wrong wheel" diagnostic can be honest. Previously we only
        # exposed `available` + `cuda_visible_to_torch`; chat.html and
        # installer.html had no way to tell whether the loaded wheel
        # was cu121 (probably wrong for Blackwell) or cu128 (fine).
        # /system/runtime already exposes these but only under
        # .python.* — /health.gpu.* needs them too so the chat.html
        # cell doesn't have to make a second request.
        stats["torch_version"]    = getattr(torch, "__version__", None)
        stats["torch_cuda_built"] = getattr(getattr(torch, "version", None), "cuda", None)
        if not torch.cuda.is_available():
            # torch present but no CUDA. Carry over the nvidia_smi result
            # so the GUI can still show the actual hardware.
            if stats["nvidia_smi"].get("detected"):
                stats["torch_present"] = True
                stats["cuda_visible_to_torch"] = False
            return stats
        stats["available"] = True
        stats["torch_present"] = True
        stats["cuda_visible_to_torch"] = True
        stats["allocated_mb"] = round(torch.cuda.memory_allocated() / (1024 ** 2), 1)
        stats["reserved_mb"] = round(torch.cuda.memory_reserved() / (1024 ** 2), 1)
        try:
            free_bytes, total_bytes = torch.cuda.mem_get_info()
            stats["free_mb"] = round(free_bytes / (1024 ** 2), 1)
            stats["total_mb"] = round(total_bytes / (1024 ** 2), 1)
            stats["used_mb"] = round((total_bytes - free_bytes) / (1024 ** 2), 1)
            if total_bytes > 0:
                stats["used_pct"] = round(100.0 * (total_bytes - free_bytes) / total_bytes, 1)
                stats["reserved_pct"] = round(100.0 * torch.cuda.memory_reserved() / total_bytes, 1)
        except Exception as exc:
            stats["mem_get_info_error"] = str(exc)
        # Surface what's currently loaded so the user can correlate VRAM
        # spikes with which model role / task is in residence.
        stats["loaded"] = {
            "chat_model": chat_model is not None,
            "vision_model": vision_model is not None,
            "image_pipe": image_pipe is not None,
        }
        stats["keep_resident"] = {
            "chat": KEEP_RESIDENT_CHAT,
            "vision": KEEP_RESIDENT_VISION,
            "image": KEEP_RESIDENT_IMAGE,
        }
    except ImportError:
        # torch isn't installed (typical pre-ML-deps state). Surface a
        # specific flag so the installer page can offer a "install ML
        # deps" action instead of falsely declaring "no GPU".
        stats["torch_present"] = False
        stats["cuda_visible_to_torch"] = False
    except Exception as exc:
        stats["error"] = str(exc)[:240]
    return stats


def move_inputs(value: Any, device: Any) -> Any:
    try:
        if hasattr(value, "to"):
            return value.to(device)
    except Exception as exc:
        # CRIT-1: a failed .to(device) silently falls through below and the
        # tensor stays on its current device (usually CPU) — a hard-to-spot
        # cause of "chat is slow" / device-mismatch errors downstream. Log
        # before swallowing; control flow is unchanged (we still fall through).
        print(f"[SeekDeep Local AI] move_inputs: .to({device!r}) failed, tensor left in place: {type(exc).__name__}: {exc}", flush=True)

    if isinstance(value, dict):
        return {k: move_inputs(v, device) for k, v in value.items()}
    if isinstance(value, list):
        return [move_inputs(v, device) for v in value]
    if isinstance(value, tuple):
        return tuple(move_inputs(v, device) for v in value)
    return value


def cleanup_cuda() -> None:
    gc.collect()
    if cuda_available():
        try:
            import torch
            torch.cuda.empty_cache()
            torch.cuda.ipc_collect()
        except Exception:
            pass


# ===== Ollama backend (alternative to HF transformers for chat) =====
# Ollama is a separate daemon (default localhost:11434) that runs GGUF
# models with its own VRAM management, completely independent of PyTorch.
#
# Per-role backend selection:
#   LOCAL_CHAT_BACKEND=hf|ollama          (default: hf -- the global default)
#   LOCAL_CHAT_FALLBACK_BACKEND=hf|ollama (per-role override)
#   LOCAL_CHAT_QUALITY_BACKEND=hf|ollama
#   LOCAL_CHAT_REASONING_BACKEND=hf|ollama
#   LOCAL_CHAT_LIGHTWEIGHT_BACKEND=hf|ollama
#   LOCAL_CHAT_REFINE_BACKEND=hf|ollama
#
# When a role is set to ollama, its existing LOCAL_CHAT_<...>_MODEL_ID env
# becomes an Ollama tag (e.g. "llama3:8b") instead of an HF repo ID. The
# server skips PyTorch loading entirely for ollama roles -- they cost
# nothing against the SDXL / vision VRAM budget.

import urllib.request as _seekdeep_urllib_req
import urllib.error as _seekdeep_urllib_err

OLLAMA_BASE_URL = (os.getenv("OLLAMA_BASE_URL", "http://127.0.0.1:11434") or "").rstrip("/")
# Optional bearer for Ollama Cloud (https://ollama.com -> Account -> Keys).
# When set, every _ollama_request below sends Authorization: Bearer <key>.
# Leave empty for the local daemon path (default), which doesn't require auth.
# Maps to the user's account-portal "API keys" entries (e.g. MSI / OpenCode
# slots in the user's Ollama account view).
OLLAMA_API_KEY = (os.getenv("OLLAMA_API_KEY", "") or "").strip()
OLLAMA_TIMEOUT_SECS = float(os.getenv("OLLAMA_TIMEOUT_SECS", "180"))
OLLAMA_PROBE_TIMEOUT_SECS = float(os.getenv("OLLAMA_PROBE_TIMEOUT_SECS", "2"))
OLLAMA_PULL_TIMEOUT_SECS = float(os.getenv("OLLAMA_PULL_TIMEOUT_SECS", "1800"))
# How long the Ollama daemon keeps a model in memory after a request. Same
# semantics as `OLLAMA_KEEP_ALIVE` env on the daemon side (default 5m).
# Set to "-1" or "infinity" to pin indefinitely, "0" to unload immediately.
OLLAMA_KEEP_ALIVE = (os.getenv("OLLAMA_KEEP_ALIVE", "5m") or "5m").strip()

# Per-role backend env vars, mirrored after CHAT_ROLE_ENV. default_chat uses
# the global LOCAL_CHAT_BACKEND directly.
CHAT_ROLE_BACKEND_ENV = {
    "fallback_chat":    "LOCAL_CHAT_FALLBACK_BACKEND",
    "quality_text":     "LOCAL_CHAT_QUALITY_BACKEND",
    "reasoning_code":   "LOCAL_CHAT_REASONING_BACKEND",
    "lightweight_chat": "LOCAL_CHAT_LIGHTWEIGHT_BACKEND",
    "refine_chat":      "LOCAL_CHAT_REFINE_BACKEND",
}


CHAT_BACKEND_KINDS = {"hf", "ollama", "openai-compat", "anthropic", "gemini"}


def _resolve_chat_backend(role: str) -> str:
    """Return one of CHAT_BACKEND_KINDS for the given role. Per-role env
    override beats the global LOCAL_CHAT_BACKEND. Anything unrecognized -> 'hf'."""
    role_clean = (role or "").strip().lower()
    env_key = CHAT_ROLE_BACKEND_ENV.get(role_clean)
    if env_key:
        per_role = (os.getenv(env_key, "") or "").strip().lower()
        if per_role in CHAT_BACKEND_KINDS:
            return per_role
    global_val = (os.getenv("LOCAL_CHAT_BACKEND", "hf") or "hf").strip().lower()
    return global_val if global_val in CHAT_BACKEND_KINDS else "hf"


def _ollama_request(path: str, body: dict | None = None, method: str = "POST",
                     timeout: float | None = None) -> dict:
    """Bare-metal Ollama HTTP call using stdlib urllib (no extra runtime dep).
    Returns parsed JSON. Raises on HTTP errors so the caller can decide."""
    url = f"{OLLAMA_BASE_URL}{path}"
    data = json.dumps(body).encode("utf-8") if body is not None else None
    req = _seekdeep_urllib_req.Request(url, data=data, method=method)
    if data is not None:
        req.add_header("Content-Type", "application/json")
    # Attach Ollama Cloud bearer if configured. Local daemon ignores it.
    if OLLAMA_API_KEY:
        req.add_header("Authorization", f"Bearer {OLLAMA_API_KEY}")
    t = timeout if timeout is not None else OLLAMA_TIMEOUT_SECS
    with _seekdeep_urllib_req.urlopen(req, timeout=t) as resp:
        raw = resp.read().decode("utf-8", errors="replace")
        if not raw:
            return {}
        try:
            return json.loads(raw)
        except json.JSONDecodeError:
            # Streaming endpoints can return NDJSON; take the last full object.
            for line in reversed(raw.splitlines()):
                line = line.strip()
                if not line:
                    continue
                try:
                    return json.loads(line)
                except json.JSONDecodeError:
                    continue
            return {}


_OLLAMA_PROBE_CACHE: dict[str, float | bool] = {"value": False, "checked_at": 0.0}
_OLLAMA_PROBE_TTL_SECS = 8.0

def ollama_available() -> bool:
    """Cached probe of the Ollama daemon. Hot-path /health was paying the full
    OLLAMA_PROBE_TIMEOUT_SECS (~2s) on every call, which combined with image
    generation holding the GIL pushed /health over the bot's 2.5s timeout.
    Cache the result for OLLAMA_PROBE_TTL_SECS so repeated /health calls reuse
    the last probe."""
    import time as _t
    now = _t.time()
    if (now - float(_OLLAMA_PROBE_CACHE["checked_at"])) < _OLLAMA_PROBE_TTL_SECS:
        return bool(_OLLAMA_PROBE_CACHE["value"])
    try:
        _ollama_request("/api/tags", method="GET", timeout=OLLAMA_PROBE_TIMEOUT_SECS)
        _OLLAMA_PROBE_CACHE["value"] = True
    except Exception:
        _OLLAMA_PROBE_CACHE["value"] = False
    _OLLAMA_PROBE_CACHE["checked_at"] = now
    return bool(_OLLAMA_PROBE_CACHE["value"])


def ollama_list_tags() -> list[str]:
    """Sorted list of installed Ollama model tags. Empty list if daemon down."""
    try:
        data = _ollama_request("/api/tags", method="GET", timeout=OLLAMA_PROBE_TIMEOUT_SECS + 1)
        names = [m.get("name", "") for m in (data.get("models") or [])]
        return sorted(n for n in names if n)
    except Exception:
        return []


def _ollama_chat(messages: list[dict], model_tag: str, temperature: float,
                  max_tokens: int) -> str:
    """Call /api/chat (non-streaming). Returns the assistant text. Raises on
    transport / API error so the chat handler can fall through to its existing
    HF fallback path.

    Generation parameters are mapped to honor the same env knobs the HF path
    uses (CHAT_TOP_K, CHAT_REPETITION_PENALTY), plus top_p hardcoded to
    match the HF default of 0.9. Ollama uses 'repeat_penalty' (note: no
    underscore between 'repeat' and 'penalty'), distinct from HF's
    'repetition_penalty'."""
    try:
        top_k = max(int(os.getenv("CHAT_TOP_K", "50")), 0)
    except ValueError:
        top_k = 50
    try:
        repeat_penalty = max(float(os.getenv("CHAT_REPETITION_PENALTY", "1.08")), 1.0)
    except ValueError:
        repeat_penalty = 1.08

    options: dict[str, Any] = {
        "temperature": max(0.0, min(2.0, float(temperature))),
        "num_predict": int(max_tokens),
        "top_p": 0.9,                # matches the HF generate() default
        "repeat_penalty": repeat_penalty,
    }
    # top_k=0 means "disabled" in Ollama -- omit the key when zero so we
    # use the daemon's default rather than overriding to zero.
    if top_k > 0:
        options["top_k"] = top_k

    body = {
        "model": model_tag,
        "messages": messages,
        "stream": False,
        "options": options,
        # Daemon-side: how long to keep the model in memory after this
        # request. Mirrors HF's keep-resident pin behavior at a different
        # layer (Ollama VRAM, not PyTorch VRAM).
        "keep_alive": OLLAMA_KEEP_ALIVE,
    }
    result = _ollama_request("/api/chat", body=body, timeout=OLLAMA_TIMEOUT_SECS)
    msg = result.get("message") or {}
    return str(msg.get("content") or "").strip()


def _ollama_pull(model_tag: str) -> dict:
    """Force-pull an Ollama tag (non-streaming so we wait for completion).
    Multi-GB downloads can take a while -- governed by OLLAMA_PULL_TIMEOUT_SECS."""
    return _ollama_request("/api/pull", body={"model": model_tag, "stream": False},
                            timeout=OLLAMA_PULL_TIMEOUT_SECS)


def _ollama_ensure_tag(model_tag: str, auto_pull: bool = True) -> tuple[bool, str]:
    """Return (ok, note). If tag is already present, ok=True. If not present
    and auto_pull, attempt /api/pull (blocking). Returns ok=False with a
    diagnostic string if pull fails or daemon is unreachable."""
    if not ollama_available():
        return False, f"Ollama daemon not reachable at {OLLAMA_BASE_URL}"
    tags = ollama_list_tags()
    if model_tag in tags:
        return True, "already-present"
    # Ollama tags can omit the ':latest' suffix in /api/tags responses.
    short = model_tag.split(":", 1)[0]
    if any(t == short or t.startswith(short + ":") for t in tags):
        return True, "matched-by-base-name"
    if not auto_pull:
        return False, f"tag {model_tag!r} not installed (auto_pull disabled)"
    print(f"[SeekDeep] Ollama: pulling {model_tag} (may take a while for first download)", flush=True)
    try:
        _ollama_pull(model_tag)
    except Exception as e:
        return False, f"pull failed: {e}"
    # Re-verify after pull
    tags = ollama_list_tags()
    if model_tag in tags or any(t == short or t.startswith(short + ":") for t in tags):
        print(f"[SeekDeep] Ollama: pull complete for {model_tag}", flush=True)
        return True, "pulled"
    return False, "pull-completed-but-tag-still-missing"


# ===== OpenAI-compatible remote backend (BYK / "Bring Your Own Key") =====
# This is the gateway to OpenAI itself + DeepSeek + Groq + OpenRouter + Together
# + Mistral La Plateforme + Anyscale + perplexity + most other hosted LLM
# providers, all of which expose the same /v1/chat/completions JSON shape.
#
# IMPORTANT: roles set to 'openai-compat' send your prompts OUTSIDE the box.
# Every other backend in this server runs locally. The README's privacy block
# calls this out explicitly. Treat as opt-in per role.
#
# Defaults read from OPENAI_API_BASE_URL + OPENAI_API_KEY. Per-role
# overrides via LOCAL_CHAT_<ROLE>_API_URL / _API_KEY let you point
# different roles at different providers (e.g. default_chat=DeepSeek,
# reasoning_code=OpenAI). LOCAL_CHAT_<ROLE>_MODEL_ID is the model name
# the remote provider expects (e.g. "deepseek-chat", "gpt-4o-mini",
# "anthropic/claude-3.5-sonnet" via OpenRouter).

OPENAI_COMPAT_TIMEOUT_SECS = float(os.getenv("OPENAI_COMPAT_TIMEOUT_SECS", "120"))
OPENAI_COMPAT_PROBE_TIMEOUT_SECS = float(os.getenv("OPENAI_COMPAT_PROBE_TIMEOUT_SECS", "5"))

# Per-role API endpoint + key envs, mirrored after CHAT_ROLE_BACKEND_ENV.
CHAT_ROLE_API_URL_ENV = {
    "default_chat":     "LOCAL_CHAT_API_URL",
    "fallback_chat":    "LOCAL_CHAT_FALLBACK_API_URL",
    "quality_text":     "LOCAL_CHAT_QUALITY_API_URL",
    "reasoning_code":   "LOCAL_CHAT_REASONING_API_URL",
    "lightweight_chat": "LOCAL_CHAT_LIGHTWEIGHT_API_URL",
    "refine_chat":      "LOCAL_CHAT_REFINE_API_URL",
}
CHAT_ROLE_API_KEY_ENV = {
    "default_chat":     "LOCAL_CHAT_API_KEY",
    "fallback_chat":    "LOCAL_CHAT_FALLBACK_API_KEY",
    "quality_text":     "LOCAL_CHAT_QUALITY_API_KEY",
    "reasoning_code":   "LOCAL_CHAT_REASONING_API_KEY",
    "lightweight_chat": "LOCAL_CHAT_LIGHTWEIGHT_API_KEY",
    "refine_chat":      "LOCAL_CHAT_REFINE_API_KEY",
}


def _resolve_openai_endpoint(role: str) -> tuple[str, str]:
    """Return (base_url, api_key) for a role's openai-compat config.
    Resolution: per-role override -> global OPENAI_API_BASE_URL/OPENAI_API_KEY.
    Either can be empty -- caller must check."""
    role_clean = (role or "").strip().lower()
    url = ""
    key = ""
    if role_clean in CHAT_ROLE_API_URL_ENV:
        url = (os.getenv(CHAT_ROLE_API_URL_ENV[role_clean], "") or "").strip()
    if role_clean in CHAT_ROLE_API_KEY_ENV:
        key = (os.getenv(CHAT_ROLE_API_KEY_ENV[role_clean], "") or "").strip()
    if not url:
        url = (os.getenv("OPENAI_API_BASE_URL", "") or "").strip()
    if not key:
        key = (os.getenv("OPENAI_API_KEY", "") or "").strip()
    return url.rstrip("/"), key


def _openai_compat_request(base_url: str, api_key: str, path: str,
                            body: dict | None = None, method: str = "POST",
                            timeout: float | None = None) -> dict:
    """Authenticated JSON request against an OpenAI-compatible endpoint.
    Raises on transport / HTTP / JSON-decode errors so /chat can classify
    and fall back via MODEL_AUTO_FALLBACK."""
    if not base_url:
        raise RuntimeError("openai-compat base URL is empty")
    url = f"{base_url}{path}"
    data = json.dumps(body).encode("utf-8") if body is not None else None
    req = _seekdeep_urllib_req.Request(url, data=data, method=method)
    if data is not None:
        req.add_header("Content-Type", "application/json")
    if api_key:
        req.add_header("Authorization", f"Bearer {api_key}")
    t = timeout if timeout is not None else OPENAI_COMPAT_TIMEOUT_SECS
    with _seekdeep_urllib_req.urlopen(req, timeout=t) as resp:
        raw = resp.read().decode("utf-8", errors="replace")
        if not raw:
            return {}
        return json.loads(raw)


def _openai_compat_probe(base_url: str, api_key: str) -> tuple[bool, str]:
    """Hit GET /models on the endpoint to verify auth + connectivity.
    Returns (ok, note). Used by warm_chat_role for remote roles."""
    if not base_url:
        return False, "no base URL configured"
    try:
        _openai_compat_request(base_url, api_key, "/models", method="GET",
                                timeout=OPENAI_COMPAT_PROBE_TIMEOUT_SECS)
        return True, "endpoint reachable"
    except _seekdeep_urllib_err.HTTPError as e:
        return False, f"HTTP {e.code} from {base_url}/models -- check API key"
    except Exception as e:
        return False, f"unreachable: {e}"


def _openai_compat_chat(messages: list[dict], model: str, base_url: str,
                         api_key: str, temperature: float, max_tokens: int) -> str:
    """Call /v1/chat/completions (non-streaming). Returns the assistant text.
    Honors the same env knobs HF/Ollama do where the API supports them."""
    try:
        top_p = float(os.getenv("CHAT_TOP_P", "0.9"))
    except ValueError:
        top_p = 0.9
    body: dict = {
        "model": model,
        "messages": messages,
        "temperature": max(0.0, min(2.0, float(temperature))),
        "max_tokens": int(max_tokens),
        "top_p": top_p,
        "stream": False,
    }
    # Some providers (notably DeepSeek) support 'frequency_penalty' which is
    # the closest equivalent to repetition_penalty. Forward if env says > 0.
    try:
        freq = float(os.getenv("CHAT_FREQUENCY_PENALTY", "0"))
        if freq != 0.0:
            body["frequency_penalty"] = max(-2.0, min(2.0, freq))
    except ValueError:
        pass
    result = _openai_compat_request(base_url, api_key, "/chat/completions",
                                     body=body, timeout=OPENAI_COMPAT_TIMEOUT_SECS)
    choices = result.get("choices") or []
    if not choices:
        return ""
    return str((choices[0].get("message") or {}).get("content") or "").strip()


# ===== Anthropic native backend (/v1/messages) =====
# Anthropic's API is NOT OpenAI-compatible. Different shape:
#   - System prompt at top level (not in messages array)
#   - Auth via x-api-key header (not Bearer)
#   - anthropic-version header required
#   - Response: content[].text (list of content blocks)
#
# Set a chat role's backend to 'anthropic' to route through claude-*.
# Sends prompts off-box -- same privacy warning as openai-compat.

ANTHROPIC_API_BASE_URL_DEFAULT = "https://api.anthropic.com/v1"
ANTHROPIC_VERSION_DEFAULT = "2023-06-01"
ANTHROPIC_TIMEOUT_SECS = float(os.getenv("ANTHROPIC_TIMEOUT_SECS", "120"))
ANTHROPIC_PROBE_TIMEOUT_SECS = float(os.getenv("ANTHROPIC_PROBE_TIMEOUT_SECS", "5"))


def _resolve_anthropic_endpoint(role: str) -> tuple[str, str, str]:
    """Return (base_url, api_key, anthropic_version). Resolution mirrors
    openai-compat: per-role override -> global ANTHROPIC_* -> Anthropic
    public default URL. Shares the same LOCAL_CHAT_<ROLE>_API_URL/KEY
    per-role envs as openai-compat (the BACKEND env decides interpretation)."""
    role_clean = (role or "").strip().lower()
    url = ""
    key = ""
    if role_clean in CHAT_ROLE_API_URL_ENV:
        url = (os.getenv(CHAT_ROLE_API_URL_ENV[role_clean], "") or "").strip()
    if role_clean in CHAT_ROLE_API_KEY_ENV:
        key = (os.getenv(CHAT_ROLE_API_KEY_ENV[role_clean], "") or "").strip()
    if not url:
        url = (os.getenv("ANTHROPIC_API_BASE_URL", "") or "").strip() or ANTHROPIC_API_BASE_URL_DEFAULT
    if not key:
        key = (os.getenv("ANTHROPIC_API_KEY", "") or "").strip()
    version = (os.getenv("ANTHROPIC_VERSION", "") or "").strip() or ANTHROPIC_VERSION_DEFAULT
    return url.rstrip("/"), key, version


def _anthropic_request(base_url: str, api_key: str, version: str,
                       path: str, body: dict | None = None,
                       method: str = "POST", timeout: float | None = None) -> dict:
    if not base_url:
        raise RuntimeError("anthropic base URL is empty")
    url = f"{base_url}{path}"
    data = json.dumps(body).encode("utf-8") if body is not None else None
    req = _seekdeep_urllib_req.Request(url, data=data, method=method)
    if data is not None:
        req.add_header("Content-Type", "application/json")
    if api_key:
        req.add_header("x-api-key", api_key)
    req.add_header("anthropic-version", version or ANTHROPIC_VERSION_DEFAULT)
    t = timeout if timeout is not None else ANTHROPIC_TIMEOUT_SECS
    with _seekdeep_urllib_req.urlopen(req, timeout=t) as resp:
        raw = resp.read().decode("utf-8", errors="replace")
        return json.loads(raw) if raw else {}


def _anthropic_probe(base_url: str, api_key: str, version: str) -> tuple[bool, str]:
    """Anthropic exposes GET /v1/models. Use that to verify auth + reachability."""
    if not base_url:
        return False, "no base URL configured"
    if not api_key:
        return False, "ANTHROPIC_API_KEY missing"
    try:
        _anthropic_request(base_url, api_key, version, "/models", method="GET",
                            timeout=ANTHROPIC_PROBE_TIMEOUT_SECS)
        return True, "endpoint reachable"
    except _seekdeep_urllib_err.HTTPError as e:
        return False, f"HTTP {e.code} -- check ANTHROPIC_API_KEY"
    except Exception as e:
        return False, f"unreachable: {e}"


def _split_system_from_messages(messages: list[dict]) -> tuple[str, list[dict]]:
    """Anthropic + Gemini both take `system` separately from the messages
    array. Pull every system-role entry out and concatenate; return
    (system_text, remaining_messages_in_order)."""
    sys_parts: list[str] = []
    remaining: list[dict] = []
    for m in messages:
        if m.get("role") == "system":
            content = str(m.get("content") or "").strip()
            if content:
                sys_parts.append(content)
        else:
            remaining.append(m)
    return ("\n\n".join(sys_parts), remaining)


def _anthropic_chat(messages: list[dict], model: str, base_url: str,
                    api_key: str, version: str,
                    temperature: float, max_tokens: int) -> str:
    """Call /v1/messages. Returns the assistant text from content[].text."""
    system_text, msgs = _split_system_from_messages(messages)
    # Anthropic only accepts 'user' and 'assistant' roles in messages
    sanitized = []
    for m in msgs:
        role = "assistant" if m.get("role") == "assistant" else "user"
        content = str(m.get("content") or "")
        if content:
            sanitized.append({"role": role, "content": content})
    body: dict = {
        "model": model,
        "messages": sanitized,
        "max_tokens": int(max_tokens),
        "temperature": max(0.0, min(1.0, float(temperature))),
    }
    if system_text:
        body["system"] = system_text
    result = _anthropic_request(base_url, api_key, version, "/messages",
                                body=body, timeout=ANTHROPIC_TIMEOUT_SECS)
    # content is a list of {type, text|...} blocks; concatenate all text blocks
    blocks = result.get("content") or []
    pieces = [str(b.get("text") or "") for b in blocks if b.get("type") == "text"]
    return "".join(pieces).strip()


# ===== Google Gemini native backend =====
# Distinct from both OpenAI and Anthropic. Notably:
#   - Model name embedded in URL: /v1beta/models/{model}:generateContent
#   - role values are 'user' and 'model' (NOT 'assistant')
#   - system prompt under top-level 'systemInstruction'
#   - Auth via x-goog-api-key header
#   - Response shape: candidates[].content.parts[].text

GEMINI_API_BASE_URL_DEFAULT = "https://generativelanguage.googleapis.com/v1beta"
GEMINI_TIMEOUT_SECS = float(os.getenv("GEMINI_TIMEOUT_SECS", "120"))
GEMINI_PROBE_TIMEOUT_SECS = float(os.getenv("GEMINI_PROBE_TIMEOUT_SECS", "5"))


def _resolve_gemini_endpoint(role: str) -> tuple[str, str]:
    """Return (base_url, api_key). Resolution: per-role override ->
    global GEMINI_API_BASE_URL/KEY -> Gemini public default URL."""
    role_clean = (role or "").strip().lower()
    url = ""
    key = ""
    if role_clean in CHAT_ROLE_API_URL_ENV:
        url = (os.getenv(CHAT_ROLE_API_URL_ENV[role_clean], "") or "").strip()
    if role_clean in CHAT_ROLE_API_KEY_ENV:
        key = (os.getenv(CHAT_ROLE_API_KEY_ENV[role_clean], "") or "").strip()
    if not url:
        url = (os.getenv("GEMINI_API_BASE_URL", "") or "").strip() or GEMINI_API_BASE_URL_DEFAULT
    if not key:
        key = (os.getenv("GEMINI_API_KEY", "") or "").strip()
    return url.rstrip("/"), key


def _gemini_request(base_url: str, api_key: str, path: str,
                    body: dict | None = None, method: str = "POST",
                    timeout: float | None = None) -> dict:
    if not base_url:
        raise RuntimeError("gemini base URL is empty")
    url = f"{base_url}{path}"
    data = json.dumps(body).encode("utf-8") if body is not None else None
    req = _seekdeep_urllib_req.Request(url, data=data, method=method)
    if data is not None:
        req.add_header("Content-Type", "application/json")
    if api_key:
        req.add_header("x-goog-api-key", api_key)
    t = timeout if timeout is not None else GEMINI_TIMEOUT_SECS
    with _seekdeep_urllib_req.urlopen(req, timeout=t) as resp:
        raw = resp.read().decode("utf-8", errors="replace")
        return json.loads(raw) if raw else {}


def _gemini_probe(base_url: str, api_key: str) -> tuple[bool, str]:
    """Gemini exposes GET /models. Use it to verify auth + reachability."""
    if not base_url:
        return False, "no base URL configured"
    if not api_key:
        return False, "GEMINI_API_KEY missing"
    try:
        _gemini_request(base_url, api_key, "/models", method="GET",
                         timeout=GEMINI_PROBE_TIMEOUT_SECS)
        return True, "endpoint reachable"
    except _seekdeep_urllib_err.HTTPError as e:
        return False, f"HTTP {e.code} -- check GEMINI_API_KEY"
    except Exception as e:
        return False, f"unreachable: {e}"


def _gemini_chat(messages: list[dict], model: str, base_url: str,
                  api_key: str, temperature: float, max_tokens: int) -> str:
    """Call /models/{model}:generateContent. Returns the candidate text."""
    system_text, msgs = _split_system_from_messages(messages)
    # Gemini role names: assistant -> model, everything else -> user
    contents = []
    for m in msgs:
        role = "model" if m.get("role") == "assistant" else "user"
        content = str(m.get("content") or "")
        if not content:
            continue
        contents.append({"role": role, "parts": [{"text": content}]})
    body: dict = {
        "contents": contents,
        "generationConfig": {
            "temperature": max(0.0, min(2.0, float(temperature))),
            "maxOutputTokens": int(max_tokens),
            "topP": 0.9,
        },
    }
    if system_text:
        body["systemInstruction"] = {"parts": [{"text": system_text}]}
    # Model in URL, not body
    path = f"/models/{model}:generateContent"
    result = _gemini_request(base_url, api_key, path, body=body,
                              timeout=GEMINI_TIMEOUT_SECS)
    candidates = result.get("candidates") or []
    if not candidates:
        return ""
    parts = (candidates[0].get("content") or {}).get("parts") or []
    return "".join(str(p.get("text") or "") for p in parts).strip()


# Cap on decoded image bytes accepted by /vision, /img2img, /inpaint, /upscale,
# etc. Base64 expansion ratio is ~1.33×, so a 24 MB cap maps to ~32 MB of
# transmitted JSON. Realistic Discord uploads max at 25 MB on the free tier,
# so 24 MB is the right ceiling — bigger inputs are almost certainly a buggy
# caller or a DoS attempt rather than a real user image. Override with
# LOCAL_AI_MAX_IMAGE_BYTES in .env if you genuinely need larger uploads.
LOCAL_AI_MAX_IMAGE_BYTES = int(os.getenv("LOCAL_AI_MAX_IMAGE_BYTES", str(24 * 1024 * 1024)))
# Cap decoded dimensions before PIL loads/converts the image. Compressed files
# can sit under the byte cap while expanding to hundreds of MB in RGB pixels.
LOCAL_AI_MAX_IMAGE_PIXELS = int(os.getenv("LOCAL_AI_MAX_IMAGE_PIXELS", "36000000"))


def _check_image_pixel_budget(img: Image.Image, *, label: str = "image") -> None:
    try:
        pixels = int(img.width) * int(img.height)
    except Exception:
        raise HTTPException(400, f"{label} dimensions could not be read")
    if pixels > LOCAL_AI_MAX_IMAGE_PIXELS:
        raise HTTPException(
            413,
            f"{label} is {img.width}x{img.height} ({pixels} pixels); "
            f"max is {LOCAL_AI_MAX_IMAGE_PIXELS} pixels",
        )


def open_image_bytes(data: bytes, *, mode: str | None = "RGB", label: str = "image") -> Image.Image:
    try:
        img = Image.open(io.BytesIO(data))
        _check_image_pixel_budget(img, label=label)
        if mode:
            img = img.convert(mode)
        return img
    except HTTPException:
        raise
    except Image.DecompressionBombError as e:
        raise HTTPException(413, f"{label} exceeds PIL decompression safety limits: {e}") from e
    except (UnidentifiedImageError, OSError) as e:
        raise HTTPException(400, f"could not open {label}: {e}") from e

def b64_to_bytes(data: str, *, max_bytes: int = None) -> bytes:
    """Decode a base64 string (with optional data: URL prefix) to bytes.
    Raises HTTPException(400) for invalid base64 or HTTPException(413) when
    the decoded size would exceed `max_bytes` (default: LOCAL_AI_MAX_IMAGE_BYTES).

    Previously this just called base64.b64decode() with no validation and no
    size cap — a caller could post a 500 MB base64 blob and trigger an OOM
    before any model code saw the bytes. AUD-005."""
    if max_bytes is None:
        max_bytes = LOCAL_AI_MAX_IMAGE_BYTES
    if not isinstance(data, str):
        raise HTTPException(400, "image_b64/media_b64 must be a string")
    if "," in data and data.strip().startswith("data:"):
        data = data.split(",", 1)[1]
    # Cheap pre-decode size estimate: base64 expands ~4 bytes for every 3 input
    # bytes, so decoded_len ≈ len(data) * 3 / 4. Reject obviously oversized
    # blobs before paying the decode CPU.
    approx_decoded = (len(data) * 3) // 4
    if approx_decoded > max_bytes:
        raise HTTPException(413, f"base64 payload exceeds {max_bytes} bytes (approx {approx_decoded})")
    try:
        out = base64.b64decode(data, validate=True)
    except (binascii.Error, ValueError) as e:
        raise HTTPException(400, f"invalid base64: {e}")
    if len(out) > max_bytes:
        raise HTTPException(413, f"decoded image is {len(out)} bytes; max is {max_bytes}")
    return out


def image_to_b64_png(img: Image.Image) -> str:
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    return base64.b64encode(buf.getvalue()).decode("ascii")


# Absolute disk paths leak local filesystem layout to direct HTTP callers
# (Discord-facing code already only forwards filename, but the raw API
# response included e.g. C:\Users\nathan\AppData\…\out\img2img_…png).
# Gate via LOCAL_AI_DEBUG_PATHS=on (default off). AUD-021.
_LOCAL_AI_DEBUG_PATHS = os.getenv("LOCAL_AI_DEBUG_PATHS", "").strip().lower() in ("1","on","true","yes")
def _maybe_debug_path(out_path) -> dict:
    return {"debug_path": str(out_path)} if _LOCAL_AI_DEBUG_PATHS else {}


def open_image_b64(data: str, *, mode: str = "RGB", max_bytes: int = None) -> Image.Image:
    """Decode base64 image_b64 → PIL.Image with consistent error handling.

    Three image endpoints (/img2img, /instruct-pix2pix, /inpaint) previously
    opened images without local 400 handling, so a non-image base64 blob
    became a 500 with a traceback in the log. This helper raises
    HTTPException(400) for both the decode and open failures so direct API
    callers get a predictable response shape. AUD-005."""
    src_bytes = b64_to_bytes(data, max_bytes=max_bytes)
    return open_image_bytes(src_bytes, mode=mode, label="image_b64")


chat_model = None
chat_tokenizer = None
vision_model = None
vision_processor = None
vision_tokenizer = None
image_pipe = None
# TTS engine handle, lazily built by load_tts_engine(). Stays None until the
# first /tts request with a configured voice/model. For Piper this is the
# loaded PiperVoice (or a small dict describing the CLI fallback); for XTTS the
# Coqui TTS object. Never touched at import time.
tts_engine = None
loaded_task: Optional[str] = None
loaded_chat_role: Optional[str] = None
loaded_chat_model_id: Optional[str] = None
last_loaded_at = 0.0


def unload_chat_model() -> None:
    """Unload only the chat model, preserving any vision/image state."""
    global chat_model, chat_tokenizer, loaded_chat_role, loaded_chat_model_id
    if chat_model is None and chat_tokenizer is None and loaded_chat_role is None:
        return
    if loaded_chat_role or loaded_chat_model_id:
        print(
            f"[SeekDeep Local AI] unloading chat role={loaded_chat_role} model={loaded_chat_model_id}",
            flush=True,
        )
    _log_vram("before chat unload")
    chat_model = None
    chat_tokenizer = None
    loaded_chat_role = None
    loaded_chat_model_id = None
    cleanup_cuda()
    _log_vram("after chat unload")


def unload_all(force: bool = False) -> None:
    """Drop loaded models. With `force=False`, respects KEEP_RESIDENT_CHAT /
    KEEP_RESIDENT_VISION / KEEP_RESIDENT_IMAGE pins so pinned models survive
    task-LRU switches. The explicit POST /unload endpoint passes force=True
    and ignores pins."""
    global chat_model, chat_tokenizer, vision_model, vision_processor, vision_tokenizer, image_pipe, loaded_task
    global loaded_chat_role, loaded_chat_model_id
    global instruct_pix2pix_pipe, clipseg_model, clipseg_processor
    keep_chat = (not force) and KEEP_RESIDENT_CHAT
    keep_vision = (not force) and KEEP_RESIDENT_VISION
    keep_image = (not force) and KEEP_RESIDENT_IMAGE
    # Snapshot what's about to be evicted so we can fire one event per actually-
    # evicted role (not just "we tried to unload everything").
    evict_reason = "explicit-unload" if force else "task-lru"
    evicting = []
    if not keep_chat and chat_model is not None:
        evicting.append(("chat", loaded_chat_role, loaded_chat_model_id))
    if not keep_vision and vision_model is not None:
        evicting.append(("vision", "vision", VISION_MODEL_ID))
    if not keep_image and image_pipe is not None:
        evicting.append(("image", "image", IMAGE_MODEL_ID))
    if not keep_chat:
        chat_model = None
        chat_tokenizer = None
        loaded_chat_role = None
        loaded_chat_model_id = None
    if not keep_vision:
        vision_model = None
        vision_processor = None
        vision_tokenizer = None
    if not keep_image:
        image_pipe = None
    instruct_pix2pix_pipe = None
    clipseg_model = None
    clipseg_processor = None
    loaded_task = None
    cleanup_cuda()
    pin_note = ""
    pinned = [name for name, on in (("chat", keep_chat), ("vision", keep_vision), ("image", keep_image)) if on]
    if pinned:
        pin_note = f" (kept resident: {', '.join(pinned)})"
    print(f"[SeekDeep] unloaded models{pin_note}", flush=True)
    for task_kind, role, model_id in evicting:
        _emit_event("model.evicted", {
            "task": task_kind,
            "role": role or task_kind,
            "model": model_id or "",
            "reason": evict_reason,
        })


class TorchUnavailableError(Exception):
    """Raised when an HF-backed model load is requested but PyTorch can't be
    imported / can't see CUDA. Distinct from VRAMPressureError because the
    user fix is different: install ML deps or switch the role to Ollama,
    not free VRAM. Surfacing this as 'VRAM pressure: 0MB free' (which is
    what fell out before — torch absent → cuda_available=False →
    vram_total_mb()=0 → VRAMPressureError) led users to chase the GPU when
    the real problem was a torch-less Python interpreter."""

    def __init__(self, detail: str = ""):
        self.detail = detail
        super().__init__(
            "PyTorch is not loaded in this AI server process. Either ML deps "
            "aren't installed yet (Installer → Install ML libraries), the "
            ".venv the sidecar picked is incomplete (set SEEKDEEP_PYTHON in "
            ".env to a working venv), or the installed torch wheel doesn't "
            "match your GPU's CUDA version. " + (detail if detail else "")
        )


class VRAMPressureError(Exception):
    """Raised by _evict_for_budget when an upcoming load would spill into
    shared memory and SEEKDEEP_VRAM_PRESSURE_MODE='fallback' is set.
    Carries the required/available numbers so callers can build a
    user-facing message and degrade gracefully."""
    def __init__(self, task: str, role: str, available_mb: float, estimated_mb: int):
        self.task = task
        self.role = role
        self.available_mb = float(available_mb)
        self.estimated_mb = int(estimated_mb)
        super().__init__(
            f"VRAM pressure: {task}({role}) needs ~{estimated_mb}MB but only "
            f"{available_mb:.0f}MB free even after eviction"
        )


def _evict_for_budget(task: str, role: str = "") -> None:
    """If the incoming model won't fit in the VRAM budget, evict non-pinned
    models (heaviest first) until it does.

    Behavior when even after evicting EVERY non-pinned model we'd still
    spill is governed by SEEKDEEP_VRAM_PRESSURE_MODE:
      "fallback"    -> raise VRAMPressureError (caller falls back)
      "force-evict" -> additionally evict pinned models (most aggressive)
      "warn"        -> log + let load proceed (legacy behavior)

    Falls through silently if CUDA is unavailable or budget check is N/A."""
    global image_pipe, vision_model, vision_processor, vision_tokenizer

    # Distinguish "torch can't even import" from real VRAM pressure. Without
    # this guard, a torch-less Python yields cuda_available=False →
    # vram_total_mb=0 → vram_can_fit reports "needs 5500MB, 0MB free" and
    # raises VRAMPressureError. The user then chases the GPU when the real
    # fix is installing torch (or pointing SEEKDEEP_PYTHON at a working
    # venv). Raise an accurate exception so the bot + UI surface the right
    # remediation.
    try:
        import torch as _torch_probe  # noqa: F401
    except Exception as _torch_exc:
        raise TorchUnavailableError(f"({type(_torch_exc).__name__}: {_torch_exc})")

    fits, available, estimated = vram_can_fit(task, role)
    if fits:
        return
    print(
        f"[SeekDeep VRAM] budget check: {task}({role}) needs ~{estimated}MB, "
        f"only {available:.0f}MB free — evicting non-pinned models",
        flush=True,
    )
    evictable: list[tuple[str, int, bool]] = []   # (name, est_mb, is_pinned)
    if image_pipe is not None:
        evictable.append(("image", estimate_model_vram("image"), bool(KEEP_RESIDENT_IMAGE)))
    if vision_model is not None:
        evictable.append(("vision", estimate_model_vram("vision"), bool(KEEP_RESIDENT_VISION)))
    if chat_model is not None:
        evictable.append(("chat",
                          estimate_model_vram("chat", loaded_chat_role or "default_chat"),
                          bool(KEEP_RESIDENT_CHAT)))
    # Non-pinned first, then pinned -- both sorted heaviest-first within their tier.
    evictable.sort(key=lambda x: (x[2], -x[1]))

    def _do_evict(name: str, est_mb: int) -> None:
        nonlocal_g = globals()
        if name == "image":
            nonlocal_g["image_pipe"] = None
        elif name == "vision":
            nonlocal_g["vision_model"] = None
            nonlocal_g["vision_processor"] = None
            nonlocal_g["vision_tokenizer"] = None
        elif name == "chat":
            unload_chat_model()

    # First pass: only non-pinned.
    for name, est_mb, is_pinned in evictable:
        if is_pinned:
            continue
        _do_evict(name, est_mb)
        print(f"[SeekDeep VRAM] evicted {name} (~{est_mb}MB)", flush=True)
        cleanup_cuda()
        fits, available, estimated = vram_can_fit(task, role)
        if fits:
            print(f"[SeekDeep VRAM] budget OK after eviction: {available:.0f}MB free for ~{estimated}MB model", flush=True)
            _emit_pressure_event("resolved", task, role, available, estimated, evicted_pinned=False)
            return

    # Pinned models still in the way. Branch on configured pressure mode.
    if VRAM_PRESSURE_MODE == "fallback":
        print(
            f"[SeekDeep VRAM] PRESSURE: {task}({role}) needs ~{estimated}MB but only "
            f"{available:.0f}MB free after evicting non-pinned -- raising VRAMPressureError "
            f"(mode=fallback). Set SEEKDEEP_VRAM_PRESSURE_MODE=warn to allow spilled loads.",
            flush=True,
        )
        _emit_pressure_event("fallback", task, role, available, estimated, evicted_pinned=False)
        raise VRAMPressureError(task, role, available, estimated)

    if VRAM_PRESSURE_MODE == "force-evict":
        print(
            f"[SeekDeep VRAM] PRESSURE: still tight; force-evicting PINNED models "
            f"(mode=force-evict)",
            flush=True,
        )
        evicted_pinned_names: list[str] = []
        for name, est_mb, is_pinned in evictable:
            if not is_pinned:
                continue
            # Don't evict the same chat role we're about to load -- that's pointless
            if name == "chat" and task == "chat" and role and loaded_chat_role == role:
                continue
            _do_evict(name, est_mb)
            evicted_pinned_names.append(name)
            print(f"[SeekDeep VRAM] evicted pinned {name} (~{est_mb}MB)", flush=True)
            cleanup_cuda()
            fits, available, estimated = vram_can_fit(task, role)
            if fits:
                print(f"[SeekDeep VRAM] budget OK after pinned eviction: {available:.0f}MB free", flush=True)
                _emit_pressure_event("resolved", task, role, available, estimated,
                                     evicted_pinned=True, evicted_pinned_names=evicted_pinned_names)
                return

    # mode == "warn" (or force-evict couldn't help): proceed with the spilled load.
    print(
        f"[SeekDeep VRAM] WARNING: after all evictions only {available:.0f}MB free "
        f"for ~{estimated}MB model — load may spill into shared memory",
        flush=True,
    )
    _emit_pressure_event("spill", task, role, available, estimated, evicted_pinned=False)


def _emit_pressure_event(state: str, task: str, role: str,
                          available_mb: float, estimated_mb: int,
                          evicted_pinned: bool = False,
                          evicted_pinned_names: list[str] | None = None) -> None:
    """Push a vram.pressure event on the bus so the GUI can show a banner
    when the box is about to spill (or fall back). state is one of
    'resolved' / 'fallback' / 'spill'. Skipped silently when the bus
    isn't wired or has no subscribers (publish_sync fast-path)."""
    if event_bus is None:
        return
    try:
        event_bus.publish_sync({
            "type": "vram.pressure",
            "data": {
                "state": state,
                "task": task,
                "role": role,
                "available_mb": round(float(available_mb), 1),
                "estimated_mb": int(estimated_mb),
                "mode": VRAM_PRESSURE_MODE,
                "evicted_pinned": bool(evicted_pinned),
                "evicted_pinned_names": list(evicted_pinned_names or []),
            },
        })
    except Exception:
        pass


def prepare_task(task: str, role: str = "") -> None:
    global loaded_task
    if MODEL_KEEP_MODE in {"none", "off", "unload"}:
        unload_all()
        loaded_task = task
        return

    if MODEL_KEEP_MODE in {"task-lru", "lru", "single"} and loaded_task and loaded_task != task:
        staying = False
        if task == "chat" and KEEP_RESIDENT_CHAT and chat_model is not None:
            staying = True
        elif task == "vision" and KEEP_RESIDENT_VISION and vision_model is not None:
            staying = True
        elif task == "image" and KEEP_RESIDENT_IMAGE and image_pipe is not None:
            staying = True

        if staying:
            # The pinned model stays, but still clean up non-pinned models
            # from the previous task (e.g. SDXL sitting idle after image gen).
            print(f"[SeekDeep] keep-resident: {task} already loaded; cleaning up non-pinned from {loaded_task}", flush=True)
            unload_all()
        else:
            print(f"[SeekDeep] task switch from {loaded_task} to {task}", flush=True)
            _evict_for_budget(task, role)
            unload_all()

    # Even when loaded_task == task (no switch), check budget in case a
    # different chat role within the same task needs more VRAM. But skip
    # entirely if the SAME chat role is already loaded -- we already paid
    # for that VRAM and don't need to re-check or re-evict.
    if role and task == "chat" and loaded_chat_role == role and chat_model is not None:
        loaded_task = task
        return
    if role:
        _evict_for_budget(task, role)

    loaded_task = task


# ---------------------------------------------------------------------------
# Request models
# ---------------------------------------------------------------------------
#
# Length caps applied below. Tunable via env if a workload genuinely exceeds:
#   LOCAL_AI_MAX_PROMPT_CHARS    — single prompt / system / negative_prompt
#   LOCAL_AI_MAX_CONTEXT_CHARS   — context blob (sources, retrieved memory)
#   LOCAL_AI_MAX_MESSAGE_CHARS   — a single chat message in `messages`
#   LOCAL_AI_MAX_B64_CHARS       — base64 string length (~1.33× decoded bytes)
# Decoded bytes are separately capped by LOCAL_AI_MAX_IMAGE_BYTES inside
# b64_to_bytes(). These two together fail-fast on oversized payloads before
# any model code runs. AUD-005.
_MAX_PROMPT_CHARS  = int(os.getenv("LOCAL_AI_MAX_PROMPT_CHARS",  "20000"))   # ~5k tokens
_MAX_CONTEXT_CHARS = int(os.getenv("LOCAL_AI_MAX_CONTEXT_CHARS", "120000"))  # ~30k tokens
_MAX_MESSAGE_CHARS = int(os.getenv("LOCAL_AI_MAX_MESSAGE_CHARS", "20000"))
_MAX_B64_CHARS     = int(os.getenv("LOCAL_AI_MAX_B64_CHARS",     str(int(LOCAL_AI_MAX_IMAGE_BYTES * 1.4))))

class ChatMessage(BaseModel):
    role: str = Field(max_length=64)
    content: str = Field(max_length=_MAX_MESSAGE_CHARS)


class ChatRequest(BaseModel):
    prompt:  str       = Field(max_length=_MAX_PROMPT_CHARS)
    system:  str       = Field(default="", max_length=_MAX_PROMPT_CHARS)
    context: str       = Field(default="", max_length=_MAX_CONTEXT_CHARS)
    messages: list[ChatMessage] = Field(default_factory=list, max_length=200)
    max_new_tokens: int   = Field(default=700, ge=32, le=4096)
    temperature: float    = Field(default=0.35, ge=0.0, le=2.0)
    role: str             = Field(default="default_chat", max_length=64)
    # Optional metadata so the web playground can feed persona breakdowns
    # in the Stats pane without going through the bot. Empty/None is fine.
    persona: str          = Field(default="", max_length=64)


class ImageRequest(BaseModel):
    prompt: str             = Field(max_length=_MAX_PROMPT_CHARS)
    width: int              = Field(default=1024, ge=256, le=1536)
    height: int             = Field(default=1024, ge=256, le=1536)
    steps: int              = Field(default=28, ge=1, le=50)
    guidance_scale: float   = Field(default=5.0, ge=0.0, le=20.0)
    seed: Optional[int]     = None
    negative_prompt: str    = Field(default="", max_length=_MAX_PROMPT_CHARS)


class VisionRequest(BaseModel):
    prompt: str             = Field(default="Describe this media clearly.", max_length=_MAX_PROMPT_CHARS)
    media_b64: str          = Field(max_length=_MAX_B64_CHARS)
    filename: str           = Field(default="upload.png", max_length=512)
    media_kind: Literal["auto", "image", "video"] = "auto"
    max_new_tokens: int     = Field(default=700, ge=32, le=2048)
    temperature: float      = Field(default=0.0, ge=0.0, le=2.0)


class Img2ImgRequest(BaseModel):
    prompt: str             = Field(max_length=_MAX_PROMPT_CHARS)
    image_b64: str          = Field(max_length=_MAX_B64_CHARS)
    strength: float         = Field(default=0.6, ge=0.05, le=1.0)
    width: int              = Field(default=1024, ge=256, le=1536)
    height: int             = Field(default=1024, ge=256, le=1536)
    steps: int              = Field(default=28, ge=1, le=50)
    guidance_scale: float   = Field(default=5.0, ge=0.0, le=20.0)
    seed: Optional[int]     = None
    negative_prompt: str    = Field(default="", max_length=_MAX_PROMPT_CHARS)


class InpaintRequest(BaseModel):
    prompt: str             = Field(max_length=_MAX_PROMPT_CHARS)
    remove_target: str      = Field(default="", max_length=_MAX_PROMPT_CHARS)
    image_b64: str          = Field(max_length=_MAX_B64_CHARS)
    strength: float         = Field(default=0.85, ge=0.1, le=1.0)
    width: int              = Field(default=1024, ge=256, le=1536)
    height: int             = Field(default=1024, ge=256, le=1536)
    steps: int              = Field(default=28, ge=1, le=50)
    guidance_scale: float   = Field(default=5.0, ge=0.0, le=20.0)
    seed: Optional[int]     = None
    negative_prompt: str    = Field(default="", max_length=_MAX_PROMPT_CHARS)


class InpaintMaskPreviewRequest(BaseModel):
    image_b64: str = Field(max_length=_MAX_B64_CHARS)
    remove_target: str = Field(default="", max_length=_MAX_PROMPT_CHARS)
    width: int = Field(default=1024, ge=256, le=1536)
    height: int = Field(default=1024, ge=256, le=1536)


class InstructPix2PixRequest(BaseModel):
    instruction: str = Field(max_length=_MAX_PROMPT_CHARS)
    image_b64: str = Field(max_length=_MAX_B64_CHARS)
    steps: int = Field(default=30, ge=1, le=50)
    guidance_scale: float = Field(default=9.0, ge=0.0, le=20.0)
    image_guidance_scale: float = Field(default=1.0, ge=0.1, le=5.0)
    seed: Optional[int] = None
    negative_prompt: str = Field(default="", max_length=_MAX_PROMPT_CHARS)


class UpscaleRequest(BaseModel):
    image_b64: str = Field(max_length=_MAX_B64_CHARS)
    scale: int = Field(default=2, ge=2, le=4)
    method: Literal["lanczos", "realesrgan"] = "lanczos"
    resample: Literal["lanczos", "bicubic", "nearest"] = "lanczos"
    sharpen: bool = True
    sharpen_radius: float = Field(default=1.1, ge=0.0, le=5.0)
    sharpen_percent: int = Field(default=115, ge=0, le=300)
    sharpen_threshold: int = Field(default=3, ge=0, le=20)
    max_bytes: int = Field(default=0, ge=0)


# ---------------------------------------------------------------------------
# Health and utility endpoints
# ---------------------------------------------------------------------------


# SEEKDEEP_SINGLEFLIGHT_MIDDLEWARE_START
# Serialize heavyweight local model requests. FastAPI can accept overlapping
# requests, but this project keeps one active local model/task in VRAM at a time.
# Without this, two Discord events can race-load the same model twice.
import asyncio as _seekdeep_asyncio

_SEEKDEEP_MODEL_REQUEST_LOCK = _seekdeep_asyncio.Lock()
_SEEKDEEP_LOCKED_PATHS = {"/chat", "/vision", "/image", "/img2img", "/instruct-pix2pix", "/inpaint", "/inpaint_mask_preview", "/upscale", "/unload",
                          # Model loaders that mutate the same module globals
                          # (chat_model/vision_model/image_pipe/loaded_*). Without
                          # these, a /warmup/* or /model/warm (which runs the
                          # loader in a threadpool) could race an in-flight /chat
                          # → double-load / torn loaded_role / VRAM OOM. The
                          # middleware holds the lock for the whole request, so it
                          # covers the threadpool loader too.
                          "/warmup/chat", "/warmup/image", "/warmup/vision", "/model/warm"}

@app.middleware("http")
async def seekdeep_singleflight_middleware(request, call_next):
    if request.url.path in _SEEKDEEP_LOCKED_PATHS:
        locked = _SEEKDEEP_MODEL_REQUEST_LOCK.locked()
        if locked:
            print(f"[SeekDeep Local AI] {request.url.path} waiting for model lock (another request is in progress)", flush=True)
        async with _SEEKDEEP_MODEL_REQUEST_LOCK:
            if locked:
                print(f"[SeekDeep Local AI] {request.url.path} acquired model lock after wait", flush=True)
            return await call_next(request)
    return await call_next(request)
# SEEKDEEP_SINGLEFLIGHT_MIDDLEWARE_END


# Structured errors for inference routes. /chat handles its own failures (rich
# fallback), but the image/vision routes did not — an OOM or model-load failure
# surfaced as a bare 500 + traceback. These app-level handlers give every
# unhandled exception a structured JSON body: VRAM pressure / CUDA-OOM → 503
# (retryable), anything else → 500 without leaking a traceback. HTTPException
# (auth + 4xx) and request-validation errors keep their own handlers, and routes
# that already return their own JSONResponse are unaffected (those don't raise).
@app.exception_handler(VRAMPressureError)
async def _seekdeep_vram_pressure_handler(request, exc):
    return JSONResponse(status_code=503, content={
        "ok": False,
        "error": "GPU is out of free VRAM for this task — close other models or use a smaller one, then retry.",
        "detail": str(exc)[:300],
    })


@app.exception_handler(Exception)
async def _seekdeep_unhandled_handler(request, exc):
    name = type(exc).__name__
    msg = str(exc).lower()
    print(f"[SeekDeep Local AI] unhandled {name} on {request.url.path}: {str(exc)[:200]}", flush=True)
    if "out of memory" in msg or "cuda oom" in msg or "outofmemory" in name.lower():
        return JSONResponse(status_code=503, content={
            "ok": False,
            "error": "Ran out of GPU memory during generation — retry, or use a smaller model / lower resolution.",
            "detail": str(exc)[:300],
        })
    return JSONResponse(status_code=500, content={
        "ok": False, "error": "Internal error during the request.", "detail": str(exc)[:300],
    })


@app.get("/health")
async def health():
    # async def so /health runs on the asyncio event loop instead of the sync
    # thread pool. When /image is mid-generation it holds the CUDA pipeline +
    # GIL; sync /health would queue behind it. async /health stays responsive.
    # Ollama probe is cached (see ollama_available) so we don't pay 2s per call.
    _ollama_up = ollama_available()
    _chat_backends = {role: _resolve_chat_backend(role) for role in chat_role_map().keys()}
    # Surface remote-chat endpoints WITHOUT leaking API keys. The GUI uses
    # this to badge external roles with a "prompts leave the box" warning.
    _remote_chat_endpoints = {}
    for role, backend in _chat_backends.items():
        if backend == "openai-compat":
            base_url, _key = _resolve_openai_endpoint(role)
        elif backend == "anthropic":
            base_url, _key, _ver = _resolve_anthropic_endpoint(role)
        elif backend == "gemini":
            base_url, _key = _resolve_gemini_endpoint(role)
        else:
            continue
        _remote_chat_endpoints[role] = {
            "backend": backend,
            "endpoint": base_url or "(unconfigured)",
            "external": True,
            "warning": "prompts for this role leave the local machine",
        }
    return {
        "status": "ready",
        "version": SEEKDEEP_VERSION,
        "device": device_name(),
        "cuda_available": cuda_available(),
        "loaded_task": loaded_task,
        "loaded_chat_role": loaded_chat_role,
        "loaded_chat_model_id": loaded_chat_model_id,
        "chat_roles": chat_role_map(),
        "chat_backends": _chat_backends,
        "remote_chat_endpoints": _remote_chat_endpoints,
        "ollama": {
            "available": _ollama_up,
            "base_url": OLLAMA_BASE_URL,
            "installed_tags": ollama_list_tags() if _ollama_up else [],
        },
        "chat_quant_mode": _normalized_chat_quant_mode(),
        "chat_quant_full_roles": sorted(LOCAL_CHAT_QUANT_FULL_ROLES),
        "keep_mode": MODEL_KEEP_MODE,
        "keep_resident": {
            "chat": KEEP_RESIDENT_CHAT,
            "vision": KEEP_RESIDENT_VISION,
            "image": KEEP_RESIDENT_IMAGE,
        },
        "gpu": gpu_stats(),
        "models": {
            "chat": CHAT_MODEL_ID,
            "vision": VISION_MODEL_ID,
            "image": IMAGE_MODEL_ID,
        },
        # TTS readiness for the GUI voice-reader badge. `enabled` is purely
        # "is a voice/model configured?" — it does NOT import or load anything,
        # so /health stays cheap even when no TTS deps are installed.
        "tts": {
            "enabled": _tts_voice_configured(),
            "engine": SEEKDEEP_TTS_ENGINE,
            "voice": (_tts_configured_voice() or None),
        },
        "vram_budget": {
            "system_reserve_mb": VRAM_SYSTEM_RESERVE_MB,
            "safety_margin_mb": VRAM_SAFETY_MARGIN_MB,
            "available_for_models_mb": round(vram_budget_available_mb(), 0),
        },
        "cache_dir": str(MODEL_CACHE_DIR),
        "offline_model_loading": HF_LOCAL_FILES_ONLY,
        # True when either env var locks the HF cache to local-only. Surfaces
        # the "Offline lock" mini-card on the Model manager pane (app.html).
        "env_offline": (
            str(os.getenv("HF_HUB_OFFLINE", "")).strip().lower() in ("1", "true", "yes", "on")
            or str(os.getenv("TRANSFORMERS_OFFLINE", "")).strip().lower() in ("1", "true", "yes", "on")
        ),
    }


@app.get("/ml_deps")
def ml_deps_endpoint():
    """Report whether the heavy ML libraries needed by /chat (local) /image
    /vision are importable. Used by the in-app 'Install ML libraries' prompt
    so the user can opt to install ~2 GB of torch/diffusers/transformers on
    first use, instead of bloating the .exe installer.

    The check is lightweight (one __import__ per module, no init), so /ml_deps
    is safe to poll from the GUI on page load. Returns a structured payload
    so the frontend can pre-populate the install consent dialog with the
    missing-module list."""
    # Modules the local AI features genuinely require. Remote-backend-only
    # configs (openai-compat / anthropic / gemini) never trip this list
    # because /chat routes to HTTP for those backends — torch is unused.
    ML_MODULES = ("torch", "transformers", "diffusers", "accelerate", "safetensors")
    missing = []
    for mod in ML_MODULES:
        try:
            __import__(mod)
        except ImportError:
            missing.append(mod)
        except Exception:
            # If a module imports but raises something other than ImportError
            # (e.g. torch with mismatched CUDA), surface that as "present but
            # broken" rather than "missing" so we don't trigger a reinstall.
            pass
    return {
        "ok": True,
        "available": len(missing) == 0,
        "checked": list(ML_MODULES),
        "missing": missing,
        "requirements_file": "requirements-ml.txt",
        "install_endpoint": "POST /deps/install (token required)",
        "manual_command": "python -m pip install --user -r requirements-ml.txt",
        "note": (
            "Heavy ML deps (~2 GB) for /image, /vision, and local /chat. "
            "Remote backends (openai-compat / anthropic / gemini) don't need this. "
            "Install via POST /deps/install for the in-app flow, or run the pip "
            "command manually."
        ),
    }


@app.get("/models/installed")
def models_installed_endpoint():
    """Report which configured model_ids are actually downloaded so the GUI
    can prompt the user to install missing weights BEFORE they trigger a
    /chat / /image / /vision call that would otherwise silently block on
    snapshot_download for 5-15 minutes.

    For each role we report:
      - model_id   : what the .env / role-map says we'd use
      - backend    : hf | ollama | openai-compat | anthropic | gemini
      - local      : true if the backend stores weights on this machine
      - present    : true if the weights are reachable right now
                     (hf: in HF cache; ollama: tag installed; remote: always)

    `all_local_present` is the convenience boolean the UI uses to decide
    whether to show the 'Download missing models' banner at all.

    Cheap to call — no network, no model load. The HF cache scan is a
    single directory walk; the Ollama probe is the existing tag list."""
    # ML deps are a prerequisite for the HF cache probe. Report early so
    # the UI knows to prompt the user to install torch/etc first.
    try:
        from huggingface_hub import scan_cache_dir
        try:
            from huggingface_hub.errors import CacheNotFound
        except ImportError:
            CacheNotFound = Exception
    except ImportError:
        return {
            "ok": True,
            "ml_deps_missing": True,
            "all_local_present": False,
            "roles": {},
            "note": "huggingface_hub not installed — hit /ml_deps and POST /deps/install first.",
        }

    # Use gui_endpoints._safe_scan_hf_cache when available — it catches
    # WinError 448 (untrusted mount point) + per-file OSErrors so a bad
    # symlink doesn't kill the whole probe.
    try:
        from gui_endpoints import _safe_scan_hf_cache as _safe_scan
        info, _scan_err = _safe_scan()
        cached_repos = {r.repo_id for r in (info.repos if info else ())}
    except Exception:
        # Fallback path if gui_endpoints isn't importable for some reason.
        cache_dir = os.getenv("LOCAL_MODEL_CACHE_DIR", "").strip() or None
        try:
            info = scan_cache_dir(cache_dir=cache_dir) if cache_dir else scan_cache_dir()
            cached_repos = {r.repo_id for r in info.repos}
        except CacheNotFound:
            cached_repos = set()
        except Exception:
            cached_repos = set()

    ollama_tags: set = set()
    try:
        if ollama_available():
            ollama_tags = set(ollama_list_tags())
    except Exception:
        pass

    def _present(model_id: str, backend: str) -> bool:
        if not model_id:
            return False
        if backend == "hf":
            return model_id in cached_repos
        if backend == "ollama":
            return model_id in ollama_tags
        if backend in {"openai-compat", "anthropic", "gemini"}:
            return True
        return False

    roles: dict = {}
    for role, model_id in chat_role_map().items():
        backend = _resolve_chat_backend(role)
        roles[f"chat.{role}"] = {
            "model_id": model_id,
            "backend": backend,
            "local": backend in {"hf", "ollama"},
            "present": _present(model_id, backend),
        }
    # Image + vision live on hf only.
    roles["image"] = {
        "model_id": IMAGE_MODEL_ID,
        "backend": "hf",
        "local": True,
        "present": _present(IMAGE_MODEL_ID, "hf"),
    }
    roles["vision"] = {
        "model_id": VISION_MODEL_ID,
        "backend": "hf",
        "local": True,
        "present": _present(VISION_MODEL_ID, "hf"),
    }

    all_local_present = all(v["present"] for v in roles.values() if v["local"])
    missing = [
        {"role": k, "model_id": v["model_id"], "backend": v["backend"]}
        for k, v in roles.items()
        if v["local"] and not v["present"]
    ]
    # Ollama is the second local backend. If the user has any role wired to
    # ollama, the GUI needs to know whether the daemon is reachable so it
    # can surface "Get Ollama" before the user clicks Download (which would
    # otherwise fail with "daemon not reachable"). For HF-only setups, this
    # is just informational.
    ollama_required = any(v["backend"] == "ollama" for v in roles.values())
    ollama_up = False
    try:
        ollama_up = ollama_available()
    except Exception:
        pass
    return {
        "ok": True,
        "ml_deps_missing": False,
        "all_local_present": all_local_present,
        "missing": missing,
        "roles": roles,
        "ollama_required": ollama_required,
        "ollama_available": ollama_up,
        "ollama_base_url": OLLAMA_BASE_URL,
        "ollama_install_url": "https://ollama.com/download",
        "install_endpoint": "POST /model/install (token required) — body: {model_id, backend, auto_pull?}",
    }


# Curated model catalog — what fresh users see in the picker before they
# have anything cached. Hand-picked to cover the common VRAM tiers without
# overwhelming. `gated=true` repos need HF_TOKEN + license acceptance on HF;
# `gated=false` repos install with no setup. Sizes are approximate disk
# footprint at default precision (HF metadata isn't reliable). Pulls live
# regardless of model_id status — install adds to cache, picker rescans.
_MODEL_CATALOG_CHAT = [
    # Open / no HF gating — these should "just work" on first install.
    {"repo_id": "ibm-granite/granite-3.3-8b-instruct", "backend": "hf", "role": "chat",
     "tier": "medium", "size_gb": 16, "gated": False,
     "why": "IBM 8B · solid quality · int4-friendly · what we test against"},
    {"repo_id": "microsoft/Phi-3.5-mini-instruct", "backend": "hf", "role": "chat",
     "tier": "small", "size_gb": 7, "gated": False,
     "why": "Microsoft 3.8B · runs on 8 GB VRAM · fast cold-load"},
    {"repo_id": "Qwen/Qwen2.5-7B-Instruct", "backend": "hf", "role": "chat",
     "tier": "medium", "size_gb": 15, "gated": False,
     "why": "Qwen 7B · strong all-around · great multilingual"},
    {"repo_id": "mistralai/Mistral-7B-Instruct-v0.3", "backend": "hf", "role": "chat",
     "tier": "medium", "size_gb": 14, "gated": False,
     "why": "Mistral 7B · well-known baseline · fast"},
    {"repo_id": "microsoft/phi-4", "backend": "hf", "role": "chat",
     "tier": "large", "size_gb": 29, "gated": False,
     "why": "Microsoft 14B · strongest in this open list · needs 16+ GB VRAM"},
    # Gated — flag clearly so user knows there's an extra step.
    {"repo_id": "meta-llama/Llama-3.2-3B-Instruct", "backend": "hf", "role": "chat",
     "tier": "small", "size_gb": 7, "gated": True,
     "why": "Meta 3B · tiny Llama · accept license at huggingface.co/meta-llama"},
    {"repo_id": "meta-llama/Llama-3.1-8B-Instruct", "backend": "hf", "role": "chat",
     "tier": "medium", "size_gb": 16, "gated": True,
     "why": "Meta 8B · the default · accept license at huggingface.co/meta-llama"},
    {"repo_id": "google/gemma-2-9b-it", "backend": "hf", "role": "chat",
     "tier": "medium", "size_gb": 18, "gated": True,
     "why": "Google 9B · strong reasoning · accept license at huggingface.co/google"},
]
_MODEL_CATALOG_VISION = [
    {"repo_id": "Qwen/Qwen2.5-VL-3B-Instruct", "backend": "hf", "role": "vision",
     "tier": "small", "size_gb": 7, "gated": False,
     "why": "Qwen vision 3B · OCR + describe · fits on 8 GB VRAM"},
    {"repo_id": "Qwen/Qwen2.5-VL-7B-Instruct", "backend": "hf", "role": "vision",
     "tier": "medium", "size_gb": 16, "gated": False,
     "why": "Qwen vision 7B · sharper · more grounded answers"},
]
_MODEL_CATALOG_IMAGE = [
    {"repo_id": "stabilityai/stable-diffusion-xl-base-1.0", "backend": "hf", "role": "image",
     "tier": "small", "size_gb": 7, "gated": False,
     "why": "SDXL base · canonical txt2img · works with all our img tooling"},
    {"repo_id": "Lykon/dreamshaper-xl-1-0", "backend": "hf", "role": "image",
     "tier": "small", "size_gb": 7, "gated": False,
     "why": "DreamShaper XL · popular SDXL finetune · vivid + detailed"},
]
_MODEL_CATALOG_OLLAMA = [
    {"repo_id": "llama3.1:8b-instruct-q4_K_M", "backend": "ollama", "role": "chat",
     "tier": "small", "size_gb": 5, "gated": False,
     "why": "Llama 3.1 8B via Ollama · int4 quantized · ~5 GB"},
    {"repo_id": "phi3:14b", "backend": "ollama", "role": "chat",
     "tier": "small", "size_gb": 8, "gated": False,
     "why": "Phi-3 medium via Ollama · ~8 GB"},
    {"repo_id": "qwen2.5:7b-instruct-q4_K_M", "backend": "ollama", "role": "chat",
     "tier": "small", "size_gb": 5, "gated": False,
     "why": "Qwen 2.5 7B via Ollama · int4 quantized"},
    {"repo_id": "mistral:7b-instruct-q4_K_M", "backend": "ollama", "role": "chat",
     "tier": "small", "size_gb": 4, "gated": False,
     "why": "Mistral 7B via Ollama · int4 quantized"},
    {"repo_id": "granite3.3:8b", "backend": "ollama", "role": "chat",
     "tier": "small", "size_gb": 5, "gated": False,
     "why": "IBM Granite 3.3 8B via Ollama · int4 quantized · matches our HF default"},
    {"repo_id": "gemma2:9b-instruct-q4_K_M", "backend": "ollama", "role": "chat",
     "tier": "small", "size_gb": 6, "gated": False,
     "why": "Gemma 2 9B via Ollama · int4 · open license (unlike HF gated Gemma)"},
]

# Chat tab is the union: Ollama tags + HF repos in one place so users see
# every chat option regardless of backend. Each entry tags its backend so
# the cached-badge check + install path stays correct. Ollama-tab still
# shows just the Ollama subset for power users who want backend-filtered
# browsing.
_MODEL_CATALOG_CHAT_ALL = _MODEL_CATALOG_OLLAMA + _MODEL_CATALOG_CHAT


@app.get("/models/catalog")
def models_catalog_endpoint():
    """Curated model catalog for fresh users with empty caches. Pure data
    endpoint — the GUI renders these as 'Recommended (install)' rows when
    LOCAL_CHAT_MODEL_ID is blank or the user clicks 'Browse recommended'.

    Returns the catalog plus a hf_token_set flag so the GUI can dim gated
    entries and prompt for HF_TOKEN before the user clicks Install."""
    return {
        "ok": True,
        "hf_token_set": bool((os.getenv("HF_TOKEN") or os.getenv("HUGGINGFACE_TOKEN") or "").strip()),
        "vram_total_mb": vram_total_mb() if cuda_available() else 0,
        "chat":   _MODEL_CATALOG_CHAT_ALL,   # HF + Ollama merged for Chat tab
        "vision": _MODEL_CATALOG_VISION,
        "image":  _MODEL_CATALOG_IMAGE,
        "ollama": _MODEL_CATALOG_OLLAMA,
    }


@app.get("/models/available")
def models_available_endpoint():
    """Full inventory of models the user has on this machine right now —
    HF cache + Ollama daemon tags. Powers the LOCAL_CHAT_MODEL_ID dropdown
    in Bot config so the user picks from a real list instead of typing a
    repo ID from memory.

    Shape:
      {
        ok, ml_deps_missing,
        hf: {
          cache_dir, total_size_bytes,
          repos: [{repo_id, repo_type, size_bytes, last_modified,
                   nb_files, refs}, ...]
        },
        ollama: {
          available, base_url,
          tags: [{name, size_bytes?, modified_at?, family?}, ...]
        },
        current: { LOCAL_CHAT_MODEL_ID, LOCAL_IMAGE_MODEL_ID, LOCAL_VISION_MODEL_ID }
      }
    """
    out: dict = {"ok": True, "ml_deps_missing": False,
                 "hf": {"cache_dir": None, "total_size_bytes": 0, "repos": []},
                 "ollama": {"available": False, "base_url": OLLAMA_BASE_URL, "tags": []},
                 "current": {
                     "LOCAL_CHAT_MODEL_ID":   os.getenv("LOCAL_CHAT_MODEL_ID", "") or "",
                     "LOCAL_IMAGE_MODEL_ID":  os.getenv("LOCAL_IMAGE_MODEL_ID", "") or "",
                     "LOCAL_VISION_MODEL_ID": os.getenv("LOCAL_VISION_MODEL_ID", "") or "",
                 },
                 # Curated catalog inlined so the GUI gets cache + daemon + suggestions
                 # in one round-trip. Fresh users see the catalog; experienced users
                 # see their cached repos first with the catalog as a secondary list.
                 "catalog": {
                     "chat":   _MODEL_CATALOG_CHAT_ALL,
                     "vision": _MODEL_CATALOG_VISION,
                     "image":  _MODEL_CATALOG_IMAGE,
                     "ollama": _MODEL_CATALOG_OLLAMA,
                 },
                 "hf_token_set": bool((os.getenv("HF_TOKEN") or os.getenv("HUGGINGFACE_TOKEN") or "").strip()),
                 "vram_total_mb": vram_total_mb() if cuda_available() else 0,
                 # Surface offline-lock so the catalog modal can disable
                 # HF install buttons before the user hits a 500. Same flag
                 # /health exposes; inline here to avoid a second round-trip.
                 "env_offline": (str(os.getenv("HF_HUB_OFFLINE", "")).strip().lower()
                                 in ("1", "true", "yes", "on"))}
    # Resilient HF scan — catches WinError 448 / OSError on bad symlinks and
    # returns whatever portion of the cache was readable.
    try:
        from gui_endpoints import _safe_scan_hf_cache as _safe_scan
        info, scan_err = _safe_scan()
    except ImportError:
        out["ml_deps_missing"] = True
        return out
    except Exception as exc:
        out["hf"]["error"] = f"{type(exc).__name__}: {exc}"
        info, scan_err = None, str(exc)
    if info is not None:
        cache_dir = os.getenv("LOCAL_MODEL_CACHE_DIR", "").strip() or None
        out["hf"]["cache_dir"] = cache_dir or ""
        out["hf"]["total_size_bytes"] = int(getattr(info, "size_on_disk", 0) or 0)
        repos_out = []
        for r in info.repos:
            try:
                refs = sorted({ref for rev in (getattr(r, "revisions", None) or ()) for ref in (rev.refs or [])})
            except Exception:
                refs = []
            repos_out.append({
                "repo_id":       r.repo_id,
                "repo_type":     getattr(r, "repo_type", "model"),
                "size_bytes":    int(getattr(r, "size_on_disk", 0) or 0),
                "last_modified": getattr(r, "last_modified", None) and str(r.last_modified) or None,
                "nb_files":      int(getattr(r, "nb_files", 0) or 0),
                "refs":          list(refs),
            })
        repos_out.sort(key=lambda x: -x["size_bytes"])
        out["hf"]["repos"] = repos_out
    if scan_err:
        out["hf"]["scan_warning"] = scan_err
    # Ollama daemon tags. We hit /api/tags directly (not just the bool probe)
    # so the response includes size + modified_at when available.
    try:
        if ollama_available():
            out["ollama"]["available"] = True
            try:
                data = _ollama_request("/api/tags", method="GET",
                                       timeout=OLLAMA_PROBE_TIMEOUT_SECS + 2)
                for m in (data.get("models") or []):
                    if not m.get("name"):
                        continue
                    out["ollama"]["tags"].append({
                        "name":        m.get("name"),
                        "size_bytes":  int(m.get("size") or 0),
                        "modified_at": m.get("modified_at"),
                        "family":      ((m.get("details") or {}).get("family")),
                    })
            except Exception:
                # Daemon reachable but /api/tags shape differs — at least
                # return the bool so the GUI can still offer "Pull tag…"
                pass
    except Exception:
        pass
    return out


@app.get("/vram")
def vram_budget_endpoint():
    """Detailed VRAM budget breakdown for diagnostics."""
    total = vram_total_mb()
    used = vram_used_mb()
    available = vram_budget_available_mb()
    loaded_models = {}
    if chat_model is not None:
        role = loaded_chat_role or "default_chat"
        loaded_models["chat"] = {
            "role": role,
            "model_id": loaded_chat_model_id,
            "estimated_mb": estimate_model_vram("chat", role),
            "pinned": KEEP_RESIDENT_CHAT,
        }
    if vision_model is not None:
        loaded_models["vision"] = {
            "model_id": VISION_MODEL_ID,
            "estimated_mb": estimate_model_vram("vision"),
            "pinned": KEEP_RESIDENT_VISION,
        }
    if image_pipe is not None:
        loaded_models["image"] = {
            "model_id": IMAGE_MODEL_ID,
            "estimated_mb": estimate_model_vram("image"),
            "pinned": KEEP_RESIDENT_IMAGE,
        }
    return {
        "total_mb": round(total, 0),
        "used_mb": round(used, 0),
        "system_reserve_mb": VRAM_SYSTEM_RESERVE_MB,
        "safety_margin_mb": VRAM_SAFETY_MARGIN_MB,
        "available_for_models_mb": round(available, 0),
        "loaded_models": loaded_models,
        "estimates": VRAM_ESTIMATES,
    }


@app.post("/unload", dependencies=[Depends(require_gui_token)])
def unload_endpoint():
    # Explicit user request ignores keep-resident pins.
    unload_all(force=True)
    return {"ok": True, "status": "unloaded"}


def warm_chat_role(role: str = "default_chat") -> dict:
    """Backend-aware chat warm. For HF roles, loads into chat_model global.
    For Ollama roles, verifies the daemon is reachable and the tag is
    present (auto-pulling via /api/pull if missing). For openai-compat
    roles, probes /models on the remote endpoint to verify auth +
    connectivity (does not 'warm' the model -- remote provider does that
    on demand). Returns a uniform dict."""
    backend = _resolve_chat_backend(role)
    if backend == "ollama":
        resolved_role, model_tag = resolve_chat_role(role)
        if not model_tag:
            return {"ok": False, "task": "chat", "role": resolved_role, "backend": "ollama",
                    "error": f"no Ollama tag configured for role {resolved_role!r}"}
        ok, note = _ollama_ensure_tag(model_tag, auto_pull=True)
        return {
            "ok": ok,
            "status": "warmed_up" if ok else "pull_or_probe_failed",
            "task": "chat",
            "role": resolved_role,
            "model_id": model_tag,
            "backend": "ollama",
            "note": note,
        }
    if backend == "openai-compat":
        resolved_role, model_name = resolve_chat_role(role)
        base_url, api_key = _resolve_openai_endpoint(resolved_role)
        if not base_url or not model_name:
            return {"ok": False, "task": "chat", "role": resolved_role, "backend": "openai-compat",
                    "error": "missing API URL or model name -- set OPENAI_API_BASE_URL + "
                             "the role's LOCAL_CHAT_<...>_MODEL_ID, optionally OPENAI_API_KEY"}
        ok, note = _openai_compat_probe(base_url, api_key)
        return {
            "ok": ok,
            "status": "remote_ok" if ok else "remote_probe_failed",
            "task": "chat",
            "role": resolved_role,
            "model_id": model_name,
            "backend": "openai-compat",
            "endpoint": base_url,
            "warning": "prompts for this role leave the local machine",
            "note": note,
        }
    if backend == "anthropic":
        resolved_role, model_name = resolve_chat_role(role)
        base_url, api_key, version = _resolve_anthropic_endpoint(resolved_role)
        if not model_name:
            return {"ok": False, "task": "chat", "role": resolved_role, "backend": "anthropic",
                    "error": "missing model name -- set the role's LOCAL_CHAT_<...>_MODEL_ID"}
        ok, note = _anthropic_probe(base_url, api_key, version)
        return {
            "ok": ok,
            "status": "remote_ok" if ok else "remote_probe_failed",
            "task": "chat",
            "role": resolved_role,
            "model_id": model_name,
            "backend": "anthropic",
            "endpoint": base_url,
            "warning": "prompts for this role leave the local machine",
            "note": note,
        }
    if backend == "gemini":
        resolved_role, model_name = resolve_chat_role(role)
        base_url, api_key = _resolve_gemini_endpoint(resolved_role)
        if not model_name:
            return {"ok": False, "task": "chat", "role": resolved_role, "backend": "gemini",
                    "error": "missing model name -- set the role's LOCAL_CHAT_<...>_MODEL_ID"}
        ok, note = _gemini_probe(base_url, api_key)
        return {
            "ok": ok,
            "status": "remote_ok" if ok else "remote_probe_failed",
            "task": "chat",
            "role": resolved_role,
            "model_id": model_name,
            "backend": "gemini",
            "endpoint": base_url,
            "warning": "prompts for this role leave the local machine",
            "note": note,
        }
    # HF default path
    resolved_role, model_id = load_chat_model(role)
    return {"ok": True, "status": "warmed_up", "task": "chat",
            "role": resolved_role, "model_id": model_id, "backend": "hf"}


class ModelInstallRequest(BaseModel):
    """Body for POST /model/install. `backend` selects the storage / dispatch path:
      hf            -- download via huggingface_hub.snapshot_download
      ollama        -- pull via Ollama /api/pull (auto if auto_pull=True)
      openai-compat -- no install (model is hosted remotely); validate
                       connectivity via /models probe, then patch .env.
                       Optional api_url + api_key let the wizard configure
                       the role's endpoint without a separate /config call.
    `model_id` is interpreted by backend:
      hf            -- HF repo ID (e.g. meta-llama/Llama-3.1-8B-Instruct)
      ollama        -- Ollama tag (e.g. llama3:8b)
      openai-compat -- remote provider model name (e.g. deepseek-chat)
    Optional `role` patches .env to assign this model to a chat role."""
    backend: Literal["hf", "ollama", "openai-compat", "anthropic", "gemini"]
    model_id: str
    role: str = ""           # if provided, .env gets updated for this role
    revision: str = ""       # HF only: branch/tag/commit
    auto_pull: bool = True   # Ollama only: auto-pull if tag missing
    api_url: str = ""        # remote backends: per-role API endpoint override
    api_key: str = ""        # remote backends: per-role API key
    api_version: str = ""    # anthropic only: per-call anthropic-version


class _HfDownloadProgressTqdm:
    """tqdm-compatible wrapper that emits `model.install.line` WS events
    instead of writing progress bars to stderr. huggingface_hub
    instantiates this once per file being downloaded:
        tqdm_class(total=N, desc=filename, unit='B', unit_scale=True, ...)
    then calls .update(chunk_size) on each chunk. We throttle events to
    at most every 250 ms per file AND only on integer percent changes so
    the bus doesn't get hammered.

    Each emitted event payload:
        { filename, bytes, total, percent, unit, done? }
    The GUI (gui/model-install.js) subscribes via SeekDeepEvents.on and
    paints a real progress bar instead of just a spinner."""

    # huggingface_hub calls tqdm_class.get_lock() at class level for thread
    # safety before any instance is constructed. Without these, the install
    # raises "_HfDownloadProgressTqdm has no attribute 'get_lock'" and the
    # whole download fails. Mirror real tqdm: shared threading.RLock.
    import threading as _threading
    _lock = _threading.RLock()

    @classmethod
    def get_lock(cls):
        return cls._lock

    @classmethod
    def set_lock(cls, lock):
        cls._lock = lock

    monitor_interval = 10  # tqdm class attribute hf_hub probes

    def __init__(self, *args, **kwargs):
        self.desc = kwargs.get('desc') or ''
        self.total = kwargs.get('total') or 0
        self.n = kwargs.get('initial') or 0
        self.unit = kwargs.get('unit', 'it')
        self._last_ts = 0.0
        self._last_pct = -1

    def update(self, n=1):
        self.n += int(n or 0)
        now = time.time()
        pct = int((self.n * 100) / self.total) if self.total else None
        # Skip emit if neither 250 ms nor a new int-percent has happened
        if (now - self._last_ts) < 0.25 and pct == self._last_pct:
            return
        self._last_ts = now
        self._last_pct = pct
        _publish_model_event("model.install.line", {
            "filename": self.desc or "?",
            "bytes": self.n,
            "total": self.total,
            "percent": pct,
            "unit": self.unit,
        })

    def close(self):
        _publish_model_event("model.install.line", {
            "filename": self.desc or "?",
            "bytes": self.n,
            "total": self.total or self.n,
            "percent": 100,
            "done": True,
        })

    def set_description(self, desc=None, *_, **__):
        if desc:
            self.desc = desc

    # tqdm has a wide surface area. These are the methods huggingface_hub
    # actually touches; the rest are no-ops to be safe.
    def set_postfix(self, *_, **__): pass
    def set_postfix_str(self, *_, **__): pass
    def write(self, *_, **__): pass
    def refresh(self, *_, **__): pass
    def reset(self, total=None):
        if total is not None: self.total = total
        self.n = 0
        self._last_pct = -1

    def __enter__(self): return self
    def __exit__(self, *_): self.close()
    def __iter__(self): return iter([])


def _hf_install(model_id: str, revision: str = "") -> dict:
    """Download an HF repo to LOCAL_MODEL_CACHE_DIR (or HF_HOME). Uses
    huggingface_hub.snapshot_download so partial downloads resume cleanly.
    Streams per-file byte progress to the GUI via model.install.line
    events (see _HfDownloadProgressTqdm above).
    Returns {ok, model_id, local_dir, files_downloaded}."""
    try:
        from huggingface_hub import snapshot_download
    except ImportError:
        return {"ok": False, "error": "huggingface_hub not installed"}
    try:
        cache_dir = os.getenv("LOCAL_MODEL_CACHE_DIR", "").strip() or None
        kw = {
            "repo_id": model_id,
            "tqdm_class": _HfDownloadProgressTqdm,
        }
        if cache_dir:
            kw["cache_dir"] = cache_dir
        if revision:
            kw["revision"] = revision
        if os.getenv("HF_TOKEN"):
            kw["token"] = os.getenv("HF_TOKEN")
        local_dir = snapshot_download(**kw)
        # Best-effort file count
        try:
            files = sum(1 for _ in Path(local_dir).rglob("*") if _.is_file())
        except Exception:
            files = -1
        return {"ok": True, "model_id": model_id, "local_dir": str(local_dir),
                "files_downloaded": files}
    except TypeError as e:
        # Older huggingface_hub didn't accept tqdm_class. Retry without it.
        if "tqdm_class" not in str(e):
            return {"ok": False, "error": f"hf download failed: {e}"}
        kw.pop("tqdm_class", None)
        try:
            local_dir = snapshot_download(**kw)
            return {"ok": True, "model_id": model_id, "local_dir": str(local_dir),
                    "files_downloaded": -1, "note": "progress events disabled (legacy huggingface_hub)"}
        except Exception as e2:
            return {"ok": False, "error": f"hf download failed: {e2}"}
    except Exception as e:
        return {"ok": False, "error": f"hf download failed: {e}"}


def _env_key_for_role(role: str, kind: Literal["model_id", "backend"]) -> str | None:
    """Return the .env key that controls this role's model_id or backend.
    default_chat uses the bare LOCAL_CHAT_MODEL_ID / LOCAL_CHAT_BACKEND;
    other roles use the per-role mirror tables."""
    role_clean = (role or "").strip().lower()
    if not role_clean:
        return None
    if kind == "model_id":
        return CHAT_ROLE_ENV.get(role_clean)
    if kind == "backend":
        if role_clean == "default_chat":
            return "LOCAL_CHAT_BACKEND"
        return CHAT_ROLE_BACKEND_ENV.get(role_clean)
    return None


def _publish_model_event(event_type: str, data: dict) -> None:
    """Best-effort WS event publish — used by /model/install to surface
    download progress to subscribed GUI tabs. Failures swallowed so a
    missing event_bus (e.g. in unit-test import) doesn't break the
    install path."""
    try:
        from gui_endpoints import event_bus
        event_bus.publish_sync({"type": event_type, "data": data})
    except Exception:
        pass


@app.post("/model/install", dependencies=[Depends(require_gui_token)])
def model_install(req: ModelInstallRequest):
    """Install a model (HF download or Ollama pull) and optionally assign
    it to a chat role by patching .env. Idempotent: re-running with the
    same params is a no-op when the model is already present.

    Emits WS events on the /events bus so the GUI's install modal (and any
    other subscribed tab) sees progress even if the user navigates away:
      - model.install.started   {model_id, backend, role}
      - model.install.complete  {model_id, backend, role, result}
      - model.install.failed    {model_id, backend, role, error}

    Synchronous return shape preserved for callers that prefer to wait."""
    model_id = (req.model_id or "").strip()
    if not model_id:
        raise HTTPException(400, "model_id is required")

    _publish_model_event("model.install.started", {
        "model_id": model_id,
        "backend": req.backend,
        "role": (req.role or "").strip() or None,
    })

    if req.backend == "ollama":
        # Ollama tag pull (or just verify presence)
        ok, note = _ollama_ensure_tag(model_id, auto_pull=bool(req.auto_pull))
        install_result = {"ok": ok, "backend": "ollama", "model_id": model_id,
                          "note": note, "base_url": OLLAMA_BASE_URL}
    elif req.backend in {"openai-compat", "anthropic", "gemini"}:
        # No download -- remote provider hosts the model. Validate connectivity
        # against the resolved endpoint. Per-role override on req.api_url wins
        # over the env-resolved global so the wizard can verify BEFORE writing
        # the key to disk.
        per_role_url = (req.api_url or "").strip().rstrip("/")
        per_role_key = (req.api_key or "").strip()
        if req.backend == "openai-compat":
            probe_url = per_role_url or (os.getenv("OPENAI_API_BASE_URL", "") or "").strip().rstrip("/")
            probe_key = per_role_key or (os.getenv("OPENAI_API_KEY", "") or "").strip()
            ok, note = _openai_compat_probe(probe_url, probe_key)
        elif req.backend == "anthropic":
            probe_url = (per_role_url or (os.getenv("ANTHROPIC_API_BASE_URL", "") or "").strip().rstrip("/")
                         or ANTHROPIC_API_BASE_URL_DEFAULT)
            probe_key = per_role_key or (os.getenv("ANTHROPIC_API_KEY", "") or "").strip()
            probe_ver = (req.api_version or "").strip() or (os.getenv("ANTHROPIC_VERSION", "") or "").strip() or ANTHROPIC_VERSION_DEFAULT
            ok, note = _anthropic_probe(probe_url, probe_key, probe_ver)
        else:  # gemini
            probe_url = (per_role_url or (os.getenv("GEMINI_API_BASE_URL", "") or "").strip().rstrip("/")
                         or GEMINI_API_BASE_URL_DEFAULT)
            probe_key = per_role_key or (os.getenv("GEMINI_API_KEY", "") or "").strip()
            ok, note = _gemini_probe(probe_url, probe_key)
        install_result = {
            "ok": ok,
            "backend": req.backend,
            "model_id": model_id,
            "endpoint": probe_url or "(unconfigured)",
            "note": note,
            "external": True,
            "warning": (
                "This backend sends prompts OUTSIDE the local machine. The remote "
                "provider has its own privacy / data-handling policy, separate from "
                "SeekDeep. Token use, content, and metadata are subject to that policy."
            ),
        }
    else:  # hf
        # PYS-1: validate the HF repo-id SHAPE before downloading. Accept only
        # `name` or `org/name` (alnum start, [A-Za-z0-9._-] body, at most one
        # slash) and reject `..` — so /model/install can't be pointed at a local
        # path, a URL, or a traversal string. Defense-in-depth alongside
        # trust_remote_code now defaulting off.
        if ".." in model_id or not re.match(r"^[A-Za-z0-9][\w.-]*(/[A-Za-z0-9][\w.-]*)?$", model_id):
            _publish_model_event("model.install.failed", {
                "model_id": model_id, "backend": "hf",
                "role": (req.role or "").strip() or None,
                "error": "invalid HF repo id",
            })
            raise HTTPException(400, "invalid HF repo id; expected 'name' or 'org/name' (letters/digits/._- only)")
        install_result = _hf_install(model_id, req.revision or "")
        install_result["backend"] = "hf"

    if not install_result.get("ok"):
        _publish_model_event("model.install.failed", {
            "model_id": model_id,
            "backend": req.backend,
            "role": (req.role or "").strip() or None,
            "error": install_result.get("note") or install_result.get("error") or "install failed",
        })
        return JSONResponse(status_code=500, content=install_result)

    # Optional .env patch: assign this model to a chat role
    role = (req.role or "").strip().lower()
    if role:
        model_id_key = _env_key_for_role(role, "model_id")
        backend_key  = _env_key_for_role(role, "backend")
        if not model_id_key:
            return JSONResponse(status_code=400, content={
                **install_result,
                "env_patched": False,
                "error": f"unknown role {role!r} -- expected one of {sorted(CHAT_ROLE_ENV.keys())}"
            })
        try:
            from gui_endpoints import _merge_env as _seekdeep_merge_env
            env_path = Path(os.path.dirname(os.path.abspath(__file__))) / ".env"
            updates = {model_id_key: model_id}
            if backend_key:
                updates[backend_key] = req.backend
            # For remote backends, persist per-role endpoint + key when the
            # caller provided them. The wizard typically supplies these in
            # the same request so the role is usable immediately.
            # Defaults to per-backend global env when no per-role override is set.
            remote_url_global = {
                "openai-compat": "OPENAI_API_BASE_URL",
                "anthropic":     "ANTHROPIC_API_BASE_URL",
                "gemini":        "GEMINI_API_BASE_URL",
            }
            remote_key_global = {
                "openai-compat": "OPENAI_API_KEY",
                "anthropic":     "ANTHROPIC_API_KEY",
                "gemini":        "GEMINI_API_KEY",
            }
            if req.backend in remote_url_global:
                if req.api_url:
                    api_url_key = CHAT_ROLE_API_URL_ENV.get(role) or remote_url_global[req.backend]
                    updates[api_url_key] = req.api_url.rstrip("/")
                if req.api_key:
                    api_key_key = CHAT_ROLE_API_KEY_ENV.get(role) or remote_key_global[req.backend]
                    updates[api_key_key] = req.api_key
                if req.backend == "anthropic" and req.api_version:
                    updates["ANTHROPIC_VERSION"] = req.api_version
            patched = _seekdeep_merge_env(env_path, updates)
            install_result["env_patched"] = True
            install_result["env_keys_updated"] = patched.get("updated", [])
        except HTTPException as he:
            install_result["env_patched"] = False
            install_result["env_error"] = he.detail
        except Exception as e:
            install_result["env_patched"] = False
            install_result["env_error"] = str(e)
        install_result["role"] = role

    _publish_model_event("model.install.complete", {
        "model_id": model_id,
        "backend": req.backend,
        "role": role or None,
        "result": {
            "ok": install_result.get("ok"),
            "env_patched": install_result.get("env_patched", False),
            "external": install_result.get("external", False),
        },
    })
    return install_result


class ModelUninstallRequest(BaseModel):
    """Body for POST /model/uninstall. Counterpart to /model/install.

    For hf backend, deletes the cached snapshot via huggingface_hub.scan_cache_dir().
    For ollama, calls DELETE /api/delete on the daemon.
    For remote backends (openai-compat / anthropic / gemini), there's nothing
    to delete remotely -- just strips per-role env keys.

    If `role` is set, additionally wipes the role's BACKEND, MODEL_ID,
    API_URL, API_KEY entries from .env (empties their values; doesn't
    remove the lines so user can re-fill them later).

    `purge` (default False) makes the cache-delete extra aggressive
    (currently only meaningful for hf -- forces revision delete even
    when other repos share the snapshot)."""
    backend: Literal["hf", "ollama", "openai-compat", "anthropic", "gemini"]
    model_id: str = ""       # required for hf / ollama; ignored for remote backends
    role: str = ""           # if set, also blanks the role's env keys
    purge: bool = False


def _hf_uninstall(model_id: str) -> dict:
    """Delete an HF snapshot from the cache. Returns {ok, freed_bytes, error?}."""
    if not model_id:
        return {"ok": False, "error": "model_id is required for hf uninstall"}
    try:
        from huggingface_hub import scan_cache_dir
    except ImportError:
        return {"ok": False, "error": "huggingface_hub not installed"}
    # CacheNotFound is raised on a fresh install with no models ever
    # downloaded. Treat as idempotent success rather than 500.
    try:
        from huggingface_hub.errors import CacheNotFound
    except ImportError:
        CacheNotFound = Exception
    cache_dir = os.getenv("LOCAL_MODEL_CACHE_DIR", "").strip() or None
    # Scan phase. Any scan failure (CacheNotFound, WinError 448 from HF
    # symlinks on Windows, permission errors, etc.) means we can't see
    # what's in the cache — treat that as "model absent" so the uninstall
    # request is idempotent. Smoke test "uninstall absent → 200" was failing
    # because scan exceptions surfaced as 500.
    try:
        info = scan_cache_dir(cache_dir=cache_dir) if cache_dir else scan_cache_dir()
    except CacheNotFound:
        return {"ok": True, "model_id": model_id, "freed_bytes": 0,
                "note": "not in HF cache (cache directory not found)"}
    except Exception as scan_exc:
        return {"ok": True, "model_id": model_id, "freed_bytes": 0,
                "note": f"cache unscannable, treating as absent: {type(scan_exc).__name__}: {str(scan_exc)[:120]}"}
    # Delete phase. Real delete errors are still errors — we shouldn't
    # silently pretend a permission denied on rm became a successful uninstall.
    try:
        # Find the repo (handles 'meta-llama/Llama-3.1-8B-Instruct' shape)
        repo_info = next((r for r in info.repos if r.repo_id == model_id), None)
        if not repo_info:
            return {"ok": True, "model_id": model_id, "freed_bytes": 0,
                    "note": "not in HF cache (already absent)"}
        revisions = [r.commit_hash for r in repo_info.revisions]
        if not revisions:
            return {"ok": True, "model_id": model_id, "freed_bytes": 0,
                    "note": "no revisions to delete"}
        strategy = info.delete_revisions(*revisions)
        freed = int(strategy.expected_freed_size)
        strategy.execute()
        return {"ok": True, "model_id": model_id, "freed_bytes": freed,
                "revisions_deleted": len(revisions)}
    except Exception as e:
        return {"ok": False, "error": f"hf uninstall failed: {e}"}


def _ollama_delete(model_tag: str) -> tuple[bool, str]:
    """DELETE /api/delete on the Ollama daemon. Returns (ok, note)."""
    if not model_tag:
        return False, "model_id required for ollama uninstall"
    if not ollama_available():
        return False, f"Ollama daemon not reachable at {OLLAMA_BASE_URL}"
    try:
        # Ollama's delete is a DELETE method with body
        _ollama_request("/api/delete", body={"model": model_tag}, method="DELETE",
                         timeout=OLLAMA_TIMEOUT_SECS)
        return True, "deleted"
    except _seekdeep_urllib_err.HTTPError as e:
        if e.code == 404:
            return True, "not installed (already absent)"
        return False, f"HTTP {e.code} from /api/delete"
    except Exception as e:
        return False, f"delete failed: {e}"


@app.post("/model/uninstall", dependencies=[Depends(require_gui_token)])
def model_uninstall(req: ModelUninstallRequest):
    """Uninstall a model OR detach a role's env binding (or both).
    Idempotent: re-running on an absent model is a no-op success."""
    model_id = (req.model_id or "").strip()
    backend = req.backend

    if backend == "hf":
        uninstall_result = _hf_uninstall(model_id)
        uninstall_result["backend"] = "hf"
        # The `purge` field is documented but huggingface_hub.scan_cache_dir()
        # doesn't expose a safe "force-delete shared revision" knob today.
        # Surface that the flag was accepted but ignored so callers don't
        # silently assume aggressive behavior. AUD-014.
        if req.purge:
            uninstall_result["purge_ignored"] = True
            uninstall_result["purge_note"] = "huggingface_hub cache API doesn't support safe force-delete of shared revisions; treat as reserved/future"
    elif backend == "ollama":
        ok, note = _ollama_delete(model_id)
        uninstall_result = {"ok": ok, "backend": "ollama", "model_id": model_id,
                             "note": note, "base_url": OLLAMA_BASE_URL}
    else:  # openai-compat / anthropic / gemini -- nothing to delete remotely
        uninstall_result = {
            "ok": True,
            "backend": backend,
            "model_id": model_id,
            "note": "remote backends have no local storage; nothing deleted",
            "external": True,
        }

    if not uninstall_result.get("ok"):
        return JSONResponse(status_code=500, content=uninstall_result)

    # Optional .env detach: blank the role's binding so the next /chat
    # request falls through to whatever LOCAL_CHAT_BACKEND globally points
    # at. We BLANK rather than DELETE the lines so the user can re-fill
    # them in the GUI later without losing comment context.
    #
    # SAFETY: only blank when the requested model actually matches the
    # current binding. Otherwise a Model Manager Remove on a stale row
    # (hardcoded HTML rows ship with default model IDs that may not
    # match the user's live LOCAL_CHAT_MODEL_ID) would detach the wrong
    # role and silently change which model /chat routes to.
    role = (req.role or "").strip().lower()
    if role:
        current_id_key = _env_key_for_role(role, "model_id")
        current_id     = (os.getenv(current_id_key) or "").strip() if current_id_key else ""
        # Normalize for the ollama: prefix that the picker writes.
        norm_current = current_id.split(":", 1)[1] if current_id.startswith("ollama:") else current_id
        norm_request = (req.model_id or "").strip()
        if current_id and norm_current and norm_current != norm_request:
            # Role is bound to a DIFFERENT model than the one being removed.
            # Skip the env detach silently — uninstall_result still reflects
            # the disk-level removal but we don't touch the binding.
            uninstall_result["env_patched"] = False
            uninstall_result["env_skip_reason"] = (
                f"role={role!r} is currently bound to {current_id!r}, "
                f"not the removed {norm_request!r}. .env left untouched."
            )
            uninstall_result["role"] = role
            return uninstall_result
        env_keys_to_blank: list[str] = []
        model_id_key = _env_key_for_role(role, "model_id")
        backend_key  = _env_key_for_role(role, "backend")
        if model_id_key: env_keys_to_blank.append(model_id_key)
        if backend_key:  env_keys_to_blank.append(backend_key)
        # Remote-backend role bindings also clear per-role API URL/key
        api_url_key = CHAT_ROLE_API_URL_ENV.get(role)
        api_key_key = CHAT_ROLE_API_KEY_ENV.get(role)
        if api_url_key: env_keys_to_blank.append(api_url_key)
        if api_key_key: env_keys_to_blank.append(api_key_key)

        if not env_keys_to_blank:
            return JSONResponse(status_code=400, content={
                **uninstall_result,
                "env_patched": False,
                "error": f"unknown role {role!r}",
            })
        try:
            from gui_endpoints import _merge_env as _seekdeep_merge_env
            env_path = Path(os.path.dirname(os.path.abspath(__file__))) / ".env"
            blanks = {k: "" for k in env_keys_to_blank}
            patched = _seekdeep_merge_env(env_path, blanks)
            uninstall_result["env_patched"] = True
            uninstall_result["env_keys_blanked"] = patched.get("updated", [])
        except HTTPException as he:
            uninstall_result["env_patched"] = False
            uninstall_result["env_error"] = he.detail
        except Exception as e:
            uninstall_result["env_patched"] = False
            uninstall_result["env_error"] = str(e)
        uninstall_result["role"] = role

    return uninstall_result


@app.get("/route/debug")
def route_debug(prompt: str = "", role: str = "default_chat"):
    """Surface server-side routing decisions for diagnostics.

    The bot's role-selection heuristics (regex patterns, casual-vs-formal
    classification, lightweight-chat short-circuit, etc.) live in
    index.js's seekdeepSelectChatModelRole. THIS endpoint can't see
    those -- it can only describe what happens AFTER a role is chosen:
      - which chat backend the role resolves to (hf / ollama / openai-compat
        / anthropic / gemini)
      - what model id / tag / remote model name the backend will use
      - what HTTP endpoint (if remote) or in-process state (if hf)
      - what the MODEL_AUTO_FALLBACK chain would be on failure
      - whether the HF path would no-op (role already loaded) or swap

    For the GUI's Route Inspector panel: have the bot's seekdeepSelectChatModelRole
    pick a role, then call this with role=<that role> to see the
    execution plan. Read-only; no auth required.
    """
    requested_role = (role or "default_chat").strip().lower() or "default_chat"
    resolved_role, model_id = resolve_chat_role(requested_role)
    backend = _resolve_chat_backend(resolved_role)

    endpoint: dict[str, Any] = {}
    if backend == "ollama":
        endpoint = {
            "base_url": OLLAMA_BASE_URL,
            "tag": model_id,
            "daemon_up": ollama_available(),
            "external": False,
        }
    elif backend == "openai-compat":
        url, _key = _resolve_openai_endpoint(resolved_role)
        endpoint = {"base_url": url or "(unconfigured)", "external": True,
                    "warning": "prompts for this role leave the local machine"}
    elif backend == "anthropic":
        url, _key, ver = _resolve_anthropic_endpoint(resolved_role)
        endpoint = {"base_url": url, "version": ver, "external": True,
                    "warning": "prompts for this role leave the local machine"}
    elif backend == "gemini":
        url, _key = _resolve_gemini_endpoint(resolved_role)
        endpoint = {"base_url": url or "(unconfigured)", "external": True,
                    "warning": "prompts for this role leave the local machine"}
    else:  # hf
        same_role_loaded = (chat_model is not None and loaded_chat_role == resolved_role)
        endpoint = {
            "external": False,
            "already_loaded": bool(same_role_loaded),
            "would_swap": bool(chat_model is not None and not same_role_loaded),
            "currently_loaded_role": loaded_chat_role,
            "currently_loaded_model_id": loaded_chat_model_id,
            "estimated_vram_mb": estimate_model_vram("chat", resolved_role),
        }

    # MODEL_AUTO_FALLBACK chain. The bot does at most one fallback hop to
    # fallback_chat; this exposes what that hop would resolve to so the
    # GUI can render it.
    fallback_chain: list[dict] = []
    if resolved_role != "fallback_chat" and MODEL_AUTO_FALLBACK:
        try:
            fb_role, fb_model_id = resolve_chat_role("fallback_chat")
        except Exception:
            fb_role, fb_model_id = ("fallback_chat", "")
        if fb_model_id and fb_role != resolved_role:
            fallback_chain.append({
                "role": fb_role,
                "backend": _resolve_chat_backend(fb_role),
                "model_id": fb_model_id,
            })

    return {
        "ok": True,
        "prompt_preview": str(prompt or "")[:240],
        "role_requested": requested_role,
        "role_resolved": resolved_role,
        "backend": backend,
        "model_id": model_id,
        "endpoint": endpoint,
        "fallback_chain": fallback_chain,
        "auto_fallback_enabled": bool(MODEL_AUTO_FALLBACK),
        "note": (
            "Role-selection regex heuristics live in index.js "
            "seekdeepSelectChatModelRole and are not visible from the AI "
            "server. Pass the role the bot WOULD pick (or the role the "
            "user requested directly via /chat) as the `role` query "
            "param to inspect what happens once that role is resolved."
        ),
    }


@app.post("/warmup/chat", dependencies=[Depends(require_gui_token)])
def warmup_chat_endpoint():
    try:
        result = warm_chat_role("default_chat")
        if not result.get("ok"):
            return JSONResponse(status_code=500, content=result)
        return result
    except Exception as e:
        return JSONResponse(status_code=500, content={"error": str(e), "task": "chat"})


@app.post("/warmup/image", dependencies=[Depends(require_gui_token)])
def warmup_image_endpoint():
    try:
        load_image_pipe()
        return {"ok": True, "status": "warmed_up", "task": "image", "model_id": IMAGE_MODEL_ID}
    except Exception as e:
        return JSONResponse(status_code=500, content={"error": str(e), "task": "image"})


@app.post("/warmup/vision", dependencies=[Depends(require_gui_token)])
def warmup_vision_endpoint():
    try:
        load_vision_model()
        return {"ok": True, "status": "warmed_up", "task": "vision", "model_id": VISION_MODEL_ID}
    except Exception as e:
        return JSONResponse(status_code=500, content={"error": str(e), "task": "vision"})


@app.get("/gpu")
async def gpu_endpoint():
    """Focused GPU stats endpoint. async def + asyncio.to_thread so the
    nvidia-smi subprocess inside gpu_stats() doesn't queue behind /chat
    or /image when they're holding the sync threadpool."""
    import asyncio as _asyncio_gpu
    stats = await _asyncio_gpu.to_thread(gpu_stats)
    stats["vram_budget"] = {
        "system_reserve_mb": VRAM_SYSTEM_RESERVE_MB,
        "safety_margin_mb": VRAM_SAFETY_MARGIN_MB,
        "available_for_models_mb": round(vram_budget_available_mb(), 0),
    }
    # Per-feature fit hints so the GUI can disable a control before the user
    # triggers an OOM. fits_now reflects the CURRENT budget (what's resident);
    # the inpaint flow loads mask-first so the real check is more forgiving.
    _sam_ok, _sam_reason = check_sam_available()
    stats["feature_fit"] = {
        "sam_segment": {
            "enabled": sam_segment_enabled(),
            "available": _sam_ok,
            "reason": _sam_reason,
            "estimated_mb": estimate_model_vram("sam_segment"),
            "fits_now": vram_can_fit("sam_segment")[0],
        },
    }
    return stats


@app.exception_handler(Exception)
async def exception_handler(request, exc: Exception):
    print(f"[SeekDeep] ERROR: {exc!r}", flush=True)
    traceback.print_exc()
    return JSONResponse(status_code=500, content={"error": str(exc), "type": type(exc).__name__})


# ---------------------------------------------------------------------------
# Chat
# ---------------------------------------------------------------------------

def load_chat_model(role: str = "default_chat") -> tuple[str, str]:
    """Load (or reuse) the chat model for the requested role.

    Returns (resolved_role, model_id). Keeps a single chat model in VRAM at a time and
    preserves the existing AutoTokenizer + AutoModelForCausalLM loading path.
    """
    global chat_model, chat_tokenizer, loaded_chat_role, loaded_chat_model_id, last_loaded_at

    resolved_role, model_id = resolve_chat_role(role)

    # Empty model_id (LOCAL_CHAT_MODEL_ID blank in .env) would bubble up as a
    # cryptic HF OSError "Repo id must use alphanumeric chars". Surface the
    # real config problem instead so the user knows what to fix.
    if not (model_id or "").strip():
        raise ValueError(
            f"chat role={resolved_role!r} has no model_id configured. "
            f"Set LOCAL_CHAT_MODEL_ID in .env (e.g. meta-llama/Llama-3.1-8B-Instruct) "
            f"or set the per-role override for this role, then restart the AI server."
        )

    # When the default chat model is pinned, skip lightweight routing.
    # Case 1 (warm): pinned model already loaded — swap cost (~7-14s) dwarfs
    #   generation savings on a short reply.
    # Case 2 (cold start): nothing loaded yet — loading lightweight first is
    #   pure waste because the very next non-trivial request will swap it out.
    #   Load default_chat directly so it's resident from the first request.
    # Quality/reasoning swaps are still honored (different purpose: better output).
    if KEEP_RESIDENT_CHAT and resolved_role == "lightweight_chat":
        if chat_model is not None and loaded_chat_role and loaded_chat_role != "lightweight_chat":
            # Warm case: reuse the pinned model.
            if MODEL_ROUTER_LOG:
                print(
                    f"[SeekDeep Model Router] skipping lightweight swap — "
                    f"using pinned {loaded_chat_role} (swap cost > generation savings)",
                    flush=True,
                )
            prepare_task("chat", loaded_chat_role)
            return loaded_chat_role, loaded_chat_model_id
        if chat_model is None:
            # Cold-start case: redirect to default_chat so the pin is
            # established from the first request.
            resolved_role = "default_chat"
            model_id = CHAT_MODEL_ID
            if MODEL_ROUTER_LOG:
                print(
                    f"[SeekDeep Model Router] cold-start redirect — "
                    f"loading default_chat instead of lightweight_chat (chat pin on)",
                    flush=True,
                )

    if MODEL_ROUTER_LOG:
        print(
            f"[SeekDeep Model Router] requested role={role} resolved role={resolved_role} model={model_id}",
            flush=True,
        )

    # Same role + same model already loaded -> reuse.
    if (
        chat_model is not None
        and chat_tokenizer is not None
        and loaded_chat_role == resolved_role
        and loaded_chat_model_id == model_id
    ):
        prepare_task("chat", resolved_role)
        return resolved_role, model_id

    # A different chat model is loaded. Pre-check whether the swap would spill
    # BEFORE tearing down the current model. If it would, fall back to the
    # current chat role so the user gets a real answer (possibly with a
    # different model) instead of a 30-60s spilled load.
    if chat_model is not None or chat_tokenizer is not None:
        if VRAM_PRESSURE_MODE == "fallback":
            current_chat_mb = estimate_model_vram("chat", loaded_chat_role or "default_chat")
            new_chat_mb = estimate_model_vram("chat", resolved_role)
            _fits, available_mb, _est = vram_can_fit("chat", resolved_role)
            # Available AFTER hypothetical unload of current chat
            projected_free_mb = available_mb + current_chat_mb
            if projected_free_mb < new_chat_mb and loaded_chat_role and loaded_chat_model_id:
                fb_role = loaded_chat_role
                fb_id = loaded_chat_model_id
                print(
                    f"[SeekDeep Local AI] VRAM pressure -> falling back to resident {fb_role} "
                    f"({fb_id}); requested {resolved_role} would need ~{new_chat_mb}MB but only "
                    f"~{projected_free_mb:.0f}MB would be free even after unloading current chat. "
                    f"Set SEEKDEEP_VRAM_PRESSURE_MODE=warn to allow spilled loads.",
                    flush=True,
                )
                _emit_pressure_event("fallback", "chat", resolved_role, projected_free_mb, new_chat_mb)
                return fb_role, fb_id
        unload_chat_model()

    try:
        prepare_task("chat", resolved_role)
    except VRAMPressureError as pressure:
        # Pressure raised AFTER unload (mode=fallback, but the unload was
        # still necessary). Reload default_chat at minimum so the next request
        # has something to serve. Bubble the error to the caller for clear
        # signalling -- /chat will surface the issue.
        print(f"[SeekDeep Local AI] VRAM pressure during chat prepare: {pressure}", flush=True)
        raise
    role_is_full_precision = resolved_role in LOCAL_CHAT_QUANT_FULL_ROLES
    quant_mode = _normalized_chat_quant_mode()
    quant_config = None if role_is_full_precision else _build_chat_quant_config()
    if role_is_full_precision and quant_mode != "none":
        quant_label = "none (full-precision role)"
    else:
        quant_label = quant_mode if quant_config is not None else "none"
    print(
        f"[SeekDeep Local AI] loading chat role={resolved_role} model={model_id} quant={quant_label}",
        flush=True,
    )
    _log_vram(f"before chat load role={resolved_role}")

    from transformers import AutoModelForCausalLM, AutoTokenizer

    # Multimodal-model guard. AutoModelForCausalLM raises "Unrecognized model"
    # for multimodal architectures (Gemma3nForConditionalGeneration, PaliGemma,
    # LLaVA, etc.) because their model_type isn't registered as a causal LM.
    # The failed load corrupts transformers' auto-class registry in the running
    # process — every subsequent load (even of a clean causal LM like Llama 3.1)
    # then fails with the same "Unrecognized model" error. Pre-validate the
    # config.json model_type so the bad load never happens. Treat as a normal
    # load failure (caller falls through to fallback_chat) and the process
    # state stays clean.
    _MULTIMODAL_MODEL_TYPES = {
        "gemma3n", "gemma4_vision", "gemma3_vision", "paligemma",
        "llava", "llava_next", "llava_next_video", "llava_onevision",
        "qwen2_vl", "qwen2_5_vl", "qwen2_audio", "idefics", "idefics2", "idefics3",
    }
    # Pre-load config.json directly from cache and pass it to from_pretrained.
    # This bypasses transformers' own config resolution which keeps failing in
    # the running process with "Unrecognized model in <id>" because OSError(22,
    # 'Invalid argument') fires when opening symlinks under the snapshots/<sha>/
    # dir. The blobs/ siblings are regular files — readable. We readlink ourselves.
    def _open_json_via_symlink(path: str) -> dict | None:
        try:
            with open(path, encoding="utf-8") as f:
                return json.load(f)
        except OSError:
            pass
        try:
            target = os.readlink(path)
        except OSError:
            return None
        if not os.path.isabs(target):
            target = os.path.normpath(os.path.join(os.path.dirname(path), target))
        try:
            with open(target, encoding="utf-8") as f:
                return json.load(f)
        except OSError:
            return None

    _preloaded_config = None
    try:
        _org_name = model_id.replace("/", "--")
        _refs = os.path.join(str(MODEL_CACHE_DIR), f"models--{_org_name}", "refs", "main")
        try:
            with open(_refs, encoding="utf-8") as _f:
                _sha = _f.read().strip()
        except OSError:
            _sha = None
        _cfg_data = None
        if _sha:
            _candidate = os.path.join(str(MODEL_CACHE_DIR), f"models--{_org_name}",
                                       "snapshots", _sha, "config.json")
            _cfg_data = _open_json_via_symlink(_candidate)
        if _cfg_data is not None:
            _mt = (_cfg_data.get("model_type") or "").strip().lower()
            print(f"[SeekDeep] config: cache-resolved model_type={_mt!r} for {model_id!r}", flush=True)
            if _mt in _MULTIMODAL_MODEL_TYPES:
                raise ValueError(
                    f"model {model_id!r} has model_type={_mt!r} which is a multimodal "
                    f"architecture and cannot load via AutoModelForCausalLM."
                )
            # Build the config object from the dict directly. AutoConfig has
            # been failing in this process — sidestep it.
            from transformers import AutoConfig as _AutoConfig
            try:
                _preloaded_config = _AutoConfig.for_model(_mt, **{k: v for k, v in _cfg_data.items() if k != "model_type"})
                print(f"[SeekDeep] config: pre-built {type(_preloaded_config).__name__}", flush=True)
            except Exception as exc:
                print(f"[SeekDeep] config: AutoConfig.for_model FAIL: {exc!r}", flush=True)
    except FileNotFoundError:
        pass

    tokenizer_kwargs = {
        "cache_dir": str(MODEL_CACHE_DIR),
        "trust_remote_code": SEEKDEEP_TRUST_REMOTE_CODE,
        "token": HF_TOKEN,
        "local_files_only": HF_LOCAL_FILES_ONLY,
    }

    # Direct tokenizer load: bypass AutoTokenizer routing entirely. Two paths
    # to find tokenizer.json — huggingface_hub's helper (clean API) AND a
    # pure-filesystem glob (works even when huggingface_hub returns None for
    # whatever Windows / symlink / cache-shape reason). Then load via the
    # `tokenizers` library and wrap in PreTrainedTokenizerFast. Every silent
    # failure path now LOGS so we can see which step missed.
    def _is_actually_readable(path: str) -> bool:
        # The user's long-running process has os.path.isfile() returning
        # False for HF symlinks that ARE readable. Bypass isfile entirely;
        # the only definition of "exists" that matters is "I can open it".
        try:
            with open(path, "rb") as _f:
                _f.read(1)
            return True
        except (OSError, IOError):
            return False

    def _resolve_blob_via_symlink(symlink_path: str) -> str | None:
        # When os.path.isfile() lies about a symlink, read the target
        # manually and point at the underlying blob (which is a plain
        # regular file, no symlink traversal needed).
        try:
            if not os.path.islink(symlink_path):
                return symlink_path if _is_actually_readable(symlink_path) else None
            target = os.readlink(symlink_path)
            if not os.path.isabs(target):
                target = os.path.normpath(os.path.join(os.path.dirname(symlink_path), target))
            return target if _is_actually_readable(target) else None
        except OSError:
            return None

    def _resolve_cached_file(filename: str) -> str | None:
        cache_dir = str(MODEL_CACHE_DIR)
        # Path A: huggingface_hub helper. We accept its answer if open() works.
        try:
            from huggingface_hub import try_to_load_from_cache
            tj = try_to_load_from_cache(model_id, filename, cache_dir=cache_dir)
            if tj:
                resolved = _resolve_blob_via_symlink(str(tj))
                if resolved:
                    return resolved
                print(f"[SeekDeep Local AI] try_to_load_from_cache gave {tj!r} but read failed", flush=True)
        except Exception as exc:
            print(f"[SeekDeep Local AI] try_to_load_from_cache raised: {exc!r}", flush=True)
        # Path B: pure filesystem. Read refs/main → snapshot path → blob.
        try:
            org_name = model_id.replace("/", "--")
            repo_dir = os.path.join(cache_dir, f"models--{org_name}")
            refs_main = os.path.join(repo_dir, "refs", "main")
            if _is_actually_readable(refs_main):
                with open(refs_main, encoding="utf-8") as _f:
                    sha = _f.read().strip()
                candidate = os.path.join(repo_dir, "snapshots", sha, filename)
                resolved = _resolve_blob_via_symlink(candidate)
                if resolved:
                    return resolved
                print(f"[SeekDeep Local AI] fs fallback: file at {candidate!r} unreadable even via blob", flush=True)
            else:
                print(f"[SeekDeep Local AI] fs fallback: no refs/main at {refs_main!r}", flush=True)
        except Exception as exc:
            print(f"[SeekDeep Local AI] fs fallback raised: {exc!r}", flush=True)
        # Path C: glob any snapshot dir.
        try:
            import glob as _glob
            org_name = model_id.replace("/", "--")
            pattern = os.path.join(cache_dir, f"models--{org_name}", "snapshots", "*", filename)
            for match in _glob.glob(pattern):
                resolved = _resolve_blob_via_symlink(match)
                if resolved:
                    return resolved
        except Exception as exc:
            # CRIT-1: the other resolution paths above (refs/main, fs
            # fallback) log on failure; this glob path was the lone silent
            # swallow. A failure here means model files can't be located in
            # the HF cache — worth surfacing. Control flow unchanged.
            print(f"[SeekDeep Local AI] cache glob resolve raised for {model_id!r}/{filename!r}: {type(exc).__name__}: {exc}", flush=True)
        return None

    def _try_load_tokenizer_direct():
        try:
            from tokenizers import Tokenizer as _RawTokenizer
            from transformers import PreTrainedTokenizerFast
        except Exception as exc:
            print(f"[SeekDeep Local AI] direct tokenizer path unavailable: {exc!r}", flush=True)
            return None
        tj = _resolve_cached_file("tokenizer.json")
        if not tj:
            print(f"[SeekDeep Local AI] direct path: no tokenizer.json found for {model_id} "
                  f"in {MODEL_CACHE_DIR} — falling through to AutoTokenizer", flush=True)
            return None
        try:
            backend = _RawTokenizer.from_file(tj)
        except Exception as exc:
            print(f"[SeekDeep Local AI] tokenizer.json at {tj!r} unreadable: {exc!r}", flush=True)
            return None
        tok = PreTrainedTokenizerFast(tokenizer_object=backend)
        tc = _resolve_cached_file("tokenizer_config.json")
        if tc:
            try:
                with open(tc, encoding="utf-8") as _f:
                    cfg = json.load(_f)
                if isinstance(cfg.get("chat_template"), str):
                    tok.chat_template = cfg["chat_template"]
                for k in ("bos_token", "eos_token", "pad_token", "unk_token"):
                    v = cfg.get(k)
                    if isinstance(v, str):
                        setattr(tok, k, v)
                    elif isinstance(v, dict) and isinstance(v.get("content"), str):
                        setattr(tok, k, v["content"])
            except Exception as exc:
                print(f"[SeekDeep Local AI] tokenizer_config hydration partial: {exc!r}", flush=True)
        print(f"[SeekDeep Local AI] tokenizer loaded via direct cache (model={model_id}, file={tj})", flush=True)
        return tok

    # Cache-first AutoTokenizer fallback chain (for models without
    # tokenizer.json or when the direct path fails for some reason).
    def _try_load(cls, *, what: str):
        attempts = [
            ("cache-fast", {**tokenizer_kwargs, "local_files_only": True}),
            ("cache-slow", {**tokenizer_kwargs, "local_files_only": True, "use_fast": False}),
            ("hub-fast",   dict(tokenizer_kwargs)),
            ("hub-slow",   {**tokenizer_kwargs, "use_fast": False}),
        ]
        extra: dict = {}
        if what == "model":
            if quant_config is not None and cuda_available():
                extra = {"quantization_config": quant_config, "device_map": "auto"}
            else:
                extra = {"torch_dtype": model_dtype(), "device_map": None, "low_cpu_mem_usage": True}
            # Inject the pre-built config object if the guard above succeeded.
            # transformers will skip its own (broken-in-this-process) config
            # resolution and use ours.
            if _preloaded_config is not None:
                extra["config"] = _preloaded_config
        last_exc: BaseException | None = None
        for label, kw in attempts:
            kw_clean = {k: v for k, v in kw.items() if k != "use_fast"} if what == "model" else kw
            try:
                obj = cls.from_pretrained(model_id, **kw_clean, **extra)
                if label != "cache-fast":
                    print(f"[SeekDeep Local AI] {what} loaded via {label} "
                          f"(model={model_id})", flush=True)
                return obj
            except (ValueError, OSError) as e:
                last_exc = e
        raise last_exc
    chat_tokenizer = _try_load_tokenizer_direct() or _try_load(AutoTokenizer, what="tokenizer")
    try:
        chat_model = _try_load(AutoModelForCausalLM, what="model")
    except Exception as _quant_exc:
        # Resilience: if the QUANTIZED (bitsandbytes) load fails — e.g. a broken
        # bitsandbytes/torch CUDA binding, which raises odd errors including a
        # NameError for `torch` from inside the quantizer — retry once in full
        # precision instead of hard-failing the warm. Only fires on the
        # already-failing quantized path; the non-quantized success path is
        # untouched, so this can never regress a working load.
        if quant_config is None:
            raise
        print(
            f"[SeekDeep Local AI] quantized chat load failed "
            f"({type(_quant_exc).__name__}: {_quant_exc}); retrying in full precision "
            f"(bitsandbytes may be unavailable or mis-bound to torch/CUDA)",
            flush=True,
        )
        quant_config = None  # _try_load reads this via closure -> full-precision branch;
                             # also makes the .to('cuda') below run for the reloaded model.
        chat_model = _try_load(AutoModelForCausalLM, what="model")

    # Only move manually when NOT using bnb quant — bnb already placed the weights.
    if quant_config is None and cuda_available():
        chat_model = chat_model.to("cuda")

    chat_model = chat_model.eval()
    loaded_chat_role = resolved_role
    loaded_chat_model_id = model_id
    last_loaded_at = time.time()
    _log_vram(f"after chat load role={resolved_role}")
    print(f"[SeekDeep] chat model loaded role={resolved_role} model={model_id}", flush=True)
    _emit_event("model.loaded", {
        "role": resolved_role,
        "model": model_id,
        "task": "chat",
        "vram_allocated_mb": _vram_event_payload().get("allocated_mb"),
    })
    return resolved_role, model_id


def _is_remote_chat_transport_failure(exc: Exception) -> bool:
    """True if `exc` looks like a remote-chat connectivity / HTTP error from
    EITHER the Ollama daemon OR an openai-compat endpoint (daemon/remote
    offline, connection refused, HTTP 4xx/5xx, auth failure, etc.).
    These are exactly the cases where falling back to fallback_chat
    (potentially an HF or different remote role) should rescue the request."""
    name = type(exc).__name__
    msg = str(exc).lower()
    # urllib.error.URLError / HTTPError, ConnectionRefusedError, OSError 10061,
    # socket.timeout / TimeoutError -- the full transport-layer surface
    if name in {"URLError", "HTTPError", "ConnectionRefusedError",
                 "TimeoutError", "RemoteDisconnected", "BadStatusLine",
                 "ContentTooShortError"}:
        return True
    if "connection refused" in msg or "actively refused" in msg:
        return True
    if "http error 4" in msg or "http error 5" in msg:
        return True
    if "winerror 10061" in msg:  # Windows: no connection could be made
        return True
    # Ollama-specific: tag not installed and auto-pull failed
    if "ollama" in msg and ("not found" in msg or "tag" in msg):
        return True
    # openai-compat-specific: auth / model-not-found errors from /chat/completions
    if "openai-compat" in msg or "no base url configured" in msg:
        return True
    if "401" in msg and ("unauthorized" in msg or "api key" in msg or "auth" in msg):
        return True
    return False


# Back-compat alias for any external callers / tests
_is_ollama_transport_failure = _is_remote_chat_transport_failure


def _classify_chat_load_failure(exc: Exception) -> str:
    """Return a short, log-friendly reason string for known recoverable failures."""
    name = type(exc).__name__
    msg = str(exc).lower()
    if name == "TorchUnavailableError":
        return "torch-unavailable"
    if _is_remote_chat_transport_failure(exc):
        return "remote-chat-transport"
    if "out of memory" in msg or "cuda oom" in msg or "outofmemory" in name.lower():
        return "cuda-oom"
    if "no such file" in msg or "not found" in msg or "couldn't find" in msg or "missing" in msg:
        return "missing-cache"
    if "huggingface" in msg or "hf hub" in msg or "huggingface_hub" in msg or "401" in msg or "403" in msg:
        return "hf-load-error"
    if "tokenizer" in msg:
        return "tokenizer-load-failure"
    if name == "ValueError" and "model_id configured" in msg:
        return "no-model-configured"
    if "multimodal" in msg or "automodelforcausallm" in msg:
        return "multimodal-not-causal-lm"
    if "unrecognized model" in msg:
        return "unrecognized-model"
    return f"chat-load-error:{name}"


def _is_fallback_eligible_exception(exc: Exception) -> bool:
    if _is_remote_chat_transport_failure(exc):
        return True
    msg = str(exc).lower()
    if "out of memory" in msg or "cuda oom" in msg:
        return True
    if "no such file" in msg or "not found" in msg or "couldn't find" in msg or "missing" in msg:
        return True
    if "huggingface" in msg or "hf hub" in msg or "huggingface_hub" in msg or "401" in msg or "403" in msg:
        return True
    if "tokenizer" in msg:
        return True
    # Multimodal guard fires when a multimodal model_type is configured for
    # a chat role. Without this branch, the bot's image-refinement prompt
    # (which routes to lightweight_chat) 503s instead of falling through
    # to fallback_chat / default_chat — and the user sees "static rules"
    # refinement instead of a real LLM rewrite.
    if "multimodal" in msg or "automodelforcausallm" in msg:
        return True
    # "Unrecognized model" still leaks through transformers' AutoConfig in
    # the rare case our guard misses; treat as fallback-eligible too.
    if "unrecognized model" in msg:
        return True
    return False


def build_chat_prompt(system: str, context: str, prompt: str, messages: list | None = None):
    base_system = system.strip() or (
        "You are SeekDeep, a locally running Discord assistant. "
        "Answer directly and naturally. Do not claim you searched the web unless search context is provided. "
        "Use provided search context as supporting evidence, not as a raw list of results. "
        "For casual/simple questions, answer without mentioning tools."
    )

    # Build the current user message (with optional web context)
    if context.strip():
        user_content = (
            "Answer using these search results as evidence:\n\n"
            f"{context.strip()}\n\n"
            f"User question:\n{prompt.strip()}"
        )
    else:
        user_content = prompt.strip()

    # Multi-turn: proper conversation structure when history is available
    if messages:
        result = [{"role": "system", "content": base_system}]
        for msg in messages:
            r = msg["role"] if isinstance(msg, dict) else msg.role
            c = msg["content"] if isinstance(msg, dict) else msg.content
            if r in ("user", "assistant") and c.strip():
                result.append({"role": r, "content": c.strip()})
        # Append the current user message as the final turn
        result.append({"role": "user", "content": user_content})
        return result

    # Legacy single-turn fallback
    return [
        {"role": "system", "content": base_system},
        {"role": "user", "content": user_content},
    ]


def _run_ollama_generation(req: ChatRequest, role: str) -> tuple[str, str, str]:
    """Dispatch a chat request to the Ollama daemon. The role's existing
    LOCAL_CHAT_<...>_MODEL_ID env is interpreted as an Ollama tag.
    Returns (text, resolved_role, model_tag)."""
    resolved_role, model_tag = resolve_chat_role(role)
    if not model_tag:
        raise RuntimeError(
            f"Ollama role {resolved_role!r} has no model tag configured "
            f"(set {CHAT_ROLE_ENV.get(resolved_role, 'LOCAL_CHAT_MODEL_ID')})"
        )
    messages = build_chat_prompt(req.system, req.context, req.prompt, req.messages or None)
    text = _ollama_chat(messages, model_tag, req.temperature, req.max_new_tokens)
    # Strip any thinking blocks that some models still emit
    text = re.sub(r"<think>[\s\S]*?</think>", "", text, flags=re.IGNORECASE).strip()
    text = re.sub(r"<think>[\s\S]*$", "", text, flags=re.IGNORECASE).strip()
    return text, resolved_role, model_tag


def _run_openai_compat_generation(req: ChatRequest, role: str) -> tuple[str, str, str]:
    """Dispatch a chat request to an OpenAI-compatible remote endpoint.
    Sends prompts OFF THE BOX. The role's MODEL_ID is the remote provider's
    model name (e.g. 'deepseek-chat', 'gpt-4o-mini').
    Returns (text, resolved_role, model_name)."""
    resolved_role, model_name = resolve_chat_role(role)
    if not model_name:
        raise RuntimeError(
            f"openai-compat role {resolved_role!r} has no model name configured "
            f"(set {CHAT_ROLE_ENV.get(resolved_role, 'LOCAL_CHAT_MODEL_ID')})"
        )
    base_url, api_key = _resolve_openai_endpoint(resolved_role)
    if not base_url:
        raise RuntimeError(
            f"openai-compat role {resolved_role!r} has no API URL configured "
            f"(set {CHAT_ROLE_API_URL_ENV.get(resolved_role, 'OPENAI_API_BASE_URL')} "
            f"or OPENAI_API_BASE_URL)"
        )
    messages = build_chat_prompt(req.system, req.context, req.prompt, req.messages or None)
    text = _openai_compat_chat(messages, model_name, base_url, api_key,
                                req.temperature, req.max_new_tokens)
    text = re.sub(r"<think>[\s\S]*?</think>", "", text, flags=re.IGNORECASE).strip()
    text = re.sub(r"<think>[\s\S]*$", "", text, flags=re.IGNORECASE).strip()
    return text, resolved_role, model_name


def _run_anthropic_generation(req: ChatRequest, role: str) -> tuple[str, str, str]:
    """Dispatch a chat request to Anthropic's /v1/messages.
    Sends prompts off-box. Model ID is a Claude model name."""
    resolved_role, model_name = resolve_chat_role(role)
    if not model_name:
        raise RuntimeError(
            f"anthropic role {resolved_role!r} has no model name configured "
            f"(set {CHAT_ROLE_ENV.get(resolved_role, 'LOCAL_CHAT_MODEL_ID')})"
        )
    base_url, api_key, version = _resolve_anthropic_endpoint(resolved_role)
    if not api_key:
        raise RuntimeError(
            f"anthropic role {resolved_role!r} needs ANTHROPIC_API_KEY "
            f"(or {CHAT_ROLE_API_KEY_ENV.get(resolved_role, 'LOCAL_CHAT_API_KEY')}) "
            f"to be set"
        )
    messages = build_chat_prompt(req.system, req.context, req.prompt, req.messages or None)
    text = _anthropic_chat(messages, model_name, base_url, api_key, version,
                           req.temperature, req.max_new_tokens)
    text = re.sub(r"<think>[\s\S]*?</think>", "", text, flags=re.IGNORECASE).strip()
    text = re.sub(r"<think>[\s\S]*$", "", text, flags=re.IGNORECASE).strip()
    return text, resolved_role, model_name


def _run_gemini_generation(req: ChatRequest, role: str) -> tuple[str, str, str]:
    """Dispatch a chat request to Google Gemini's generateContent endpoint.
    Sends prompts off-box. Model ID is a Gemini model name."""
    resolved_role, model_name = resolve_chat_role(role)
    if not model_name:
        raise RuntimeError(
            f"gemini role {resolved_role!r} has no model name configured "
            f"(set {CHAT_ROLE_ENV.get(resolved_role, 'LOCAL_CHAT_MODEL_ID')})"
        )
    base_url, api_key = _resolve_gemini_endpoint(resolved_role)
    if not api_key:
        raise RuntimeError(
            f"gemini role {resolved_role!r} needs GEMINI_API_KEY "
            f"(or {CHAT_ROLE_API_KEY_ENV.get(resolved_role, 'LOCAL_CHAT_API_KEY')}) "
            f"to be set"
        )
    messages = build_chat_prompt(req.system, req.context, req.prompt, req.messages or None)
    text = _gemini_chat(messages, model_name, base_url, api_key,
                        req.temperature, req.max_new_tokens)
    text = re.sub(r"<think>[\s\S]*?</think>", "", text, flags=re.IGNORECASE).strip()
    text = re.sub(r"<think>[\s\S]*$", "", text, flags=re.IGNORECASE).strip()
    return text, resolved_role, model_name


def _run_chat_generation(req: ChatRequest, role: str) -> tuple[str, str, str]:
    """Load a chat role and run a single generation. Returns (text, resolved_role, model_id).
    Dispatches per-role to HF transformers (in-process), Ollama (local daemon),
    OpenAI-compatible remote, Anthropic native, or Gemini native."""
    backend = _resolve_chat_backend(role)
    if backend == "ollama":
        return _run_ollama_generation(req, role)
    if backend == "openai-compat":
        return _run_openai_compat_generation(req, role)
    if backend == "anthropic":
        return _run_anthropic_generation(req, role)
    if backend == "gemini":
        return _run_gemini_generation(req, role)
    # Default: in-process HF transformers path.
    resolved_role, model_id = load_chat_model(role)

    import torch

    messages = build_chat_prompt(req.system, req.context, req.prompt, req.messages or None)

    try:
        # Some models (e.g. Qwen3) emit hidden thinking blocks; disable if supported.
        try:
            text = chat_tokenizer.apply_chat_template(
                messages,
                tokenize=False,
                add_generation_prompt=True,
                enable_thinking=False,
            )
        except TypeError:
            text = chat_tokenizer.apply_chat_template(messages, tokenize=False, add_generation_prompt=True)
    except Exception:
        text = f"{messages[0]['content']}\n\nUser: {messages[1]['content']}\nAssistant:"

    # PYS-3: cap the tokenizer input. Keep the start (system prompt + earliest
    # context) on the char cap; truncate the token sequence to the model budget.
    if len(text) > SEEKDEEP_CHAT_MAX_INPUT_CHARS:
        text = text[:SEEKDEEP_CHAT_MAX_INPUT_CHARS]
    inputs = chat_tokenizer(text, return_tensors="pt", truncation=True, max_length=SEEKDEEP_CHAT_MAX_INPUT_TOKENS)
    inputs = move_inputs(inputs, first_model_device(chat_model))

    gen_kwargs = {
        "max_new_tokens": int(req.max_new_tokens),
        "do_sample": float(req.temperature) > 0,
        "temperature": max(float(req.temperature), 0.01),
        "top_p": 0.9,
        "top_k": max(int(os.getenv("CHAT_TOP_K", "50")), 0) or None,
        "repetition_penalty": max(float(os.getenv("CHAT_REPETITION_PENALTY", "1.08")), 1.0),
        "no_repeat_ngram_size": max(int(os.getenv("CHAT_NO_REPEAT_NGRAM_SIZE", "4")), 0),
        "use_cache": True,
        "pad_token_id": getattr(chat_tokenizer, "eos_token_id", None),
        "eos_token_id": getattr(chat_tokenizer, "eos_token_id", None),
    }

    with torch.inference_mode():
        out = chat_model.generate(**inputs, **gen_kwargs)

    new_tokens = out[0][inputs["input_ids"].shape[-1]:]
    answer = chat_tokenizer.decode(new_tokens, skip_special_tokens=True, clean_up_tokenization_spaces=False).strip()

    # Safety cleanup in case the model still leaks hidden thinking.
    answer = re.sub(r"<think>[\s\S]*?</think>", "", answer, flags=re.IGNORECASE).strip()
    answer = re.sub(r"<think>[\s\S]*$", "", answer, flags=re.IGNORECASE).strip()
    answer = answer.replace("</think>", "").strip()

    return answer, resolved_role, model_id


@app.post("/chat", dependencies=[Depends(require_gui_token)])
def chat(req: ChatRequest):
    requested_role = (req.role or "default_chat").strip().lower() or "default_chat"
    n_msgs = len(req.messages) if req.messages else 0
    print(f"[SeekDeep Local AI] /chat entry role={requested_role} msgs={n_msgs} prompt={req.prompt[:120]!r}", flush=True)

    # Audit §6: one attempt_log threaded through every rung so a failure
    # response names WHICH layer gave up instead of surfacing only the last
    # rung's message. Each entry: {step, role, model_id?, ok, reason?}.
    attempt_log: list[dict] = []

    try:
        answer, resolved_role, model_id = _run_chat_generation(req, requested_role)
        attempt_log.append({"step": "primary", "role": resolved_role,
                            "model_id": model_id, "ok": True})
        # Bump web-playground breakdowns so the Stats pane shows non-empty
        # persona/model usage even on installs that don't use the Discord bot.
        try:
            _seekdeep_bump_web_chat(getattr(req, 'persona', '') or '', model_id or resolved_role)
        except Exception:
            pass
        return {
            "text": answer or "(empty response)",
            "model_role": resolved_role,
            "model_id": model_id,
            "attempt_log": attempt_log,
        }
    except Exception as exc:
        reason = _classify_chat_load_failure(exc)
        attempt_log.append({"step": "primary", "role": requested_role,
                            "ok": False, "reason": reason})
        print(f"[SeekDeep Local AI] chat generation failed role={requested_role} reason={reason}: {exc!r}", flush=True)
        traceback.print_exc()

        # One-shot fallback: only if enabled, exception is recoverable, and fallback resolves
        # to a different model than the failed one.
        if MODEL_AUTO_FALLBACK and _is_fallback_eligible_exception(exc):
            try:
                _, failed_model_id = resolve_chat_role(requested_role)
            except Exception:
                failed_model_id = ""
            try:
                fallback_role, fallback_model_id = resolve_chat_role("fallback_chat")
            except Exception:
                fallback_role, fallback_model_id = ("fallback_chat", "")

            if fallback_model_id and fallback_model_id != failed_model_id and fallback_role != requested_role:
                print(
                    f"[SeekDeep Local AI] fallback role=fallback_chat model={fallback_model_id} reason={reason}",
                    flush=True,
                )
                try:
                    unload_chat_model()
                    answer, resolved_role, model_id = _run_chat_generation(req, "fallback_chat")
                    attempt_log.append({"step": "fallback", "role": resolved_role,
                                        "model_id": model_id, "ok": True})
                    return {
                        "text": answer or "(empty response)",
                        "model_role": resolved_role,
                        "model_id": model_id,
                        "fallback_used": True,
                        "fallback_reason": reason,
                        "failed_model_id": failed_model_id,
                        "attempt_log": attempt_log,
                    }
                except Exception as fb_exc:
                    fb_reason = _classify_chat_load_failure(fb_exc)
                    attempt_log.append({"step": "fallback", "role": "fallback_chat",
                                        "ok": False, "reason": fb_reason})
                    print(f"[SeekDeep Local AI] fallback chat also failed reason={fb_reason}: {fb_exc!r}", flush=True)
                    traceback.print_exc()
            else:
                attempt_log.append({"step": "fallback", "role": "fallback_chat",
                                    "ok": False, "reason": "skipped-same-model-or-role"})
        elif MODEL_AUTO_FALLBACK:
            attempt_log.append({"step": "fallback", "role": "fallback_chat",
                                "ok": False, "reason": "skipped-not-fallback-eligible"})

        # Tailor the message for the cases the user can actually fix without
        # reading the log. VRAMPressureError means "your GPU is full" — the
        # user can free it via POST /unload or by closing other CUDA apps.
        if reason == "torch-unavailable":
            clean_msg = ("PyTorch isn't loaded in this AI server process. The .venv "
                         "the sidecar booted with is missing torch (or has a wheel "
                         "incompatible with your GPU). Fix one of: "
                         "(a) Installer → Install ML libraries, "
                         "(b) Installer → Detect venv → Use detected .venv to point "
                         "SEEKDEEP_PYTHON at a torch-capable interpreter, "
                         "(c) switch this chat role to an Ollama backend in Bot Config. "
                         "The 'VRAM 0MB' you may have seen elsewhere was a downstream "
                         "symptom — torch absence makes torch.cuda.mem_get_info() return 0.")
        elif reason == "chat-load-error:VRAMPressureError":
            clean_msg = ("Out of VRAM — the model couldn't fit. Free GPU memory: "
                         "click 'Flush model cache' in the Control Center (or POST /unload), "
                         "close other CUDA apps, or pick a smaller quantization in Config.")
        elif reason == "tokenizer-load-failure":
            # transformers needs sentencepiece OR tiktoken to convert slow
            # tokenizers. Llama 3.x uses tiktoken, Llama 2 / Mistral / etc.
            # use sentencepiece. Both belong in requirements-ml.txt as of
            # the tiktoken add. If the user installed before that landed,
            # one re-run of "Install ML libraries" pulls the missing dep.
            clean_msg = ("Chat model's tokenizer couldn't load. transformers needs "
                         "sentencepiece (Llama 2 / Mistral / Granite ≤3.2) or tiktoken "
                         "(Llama 3.x / Qwen / Granite 3.3+) installed. Click 'Install ML "
                         "libraries' in the Control Center to pull them — pip will skip "
                         "deps you already have.")
        elif reason == "multimodal-not-causal-lm":
            # User configured a multimodal-only model for a chat role. The role
            # router will auto-fallback to fallback_chat / default_chat for the
            # current request, but the underlying config still needs fixing so
            # this role works on its own. Be specific so the user knows what to do.
            clean_msg = ("A chat role is configured with a multimodal model "
                         "(e.g. gemma-3n-E4B-it, paligemma, llava). Those load via "
                         "AutoModelForImageTextToText, not AutoModelForCausalLM, "
                         "so they can't serve plain text chat. Change the model_id "
                         "for this role in Config → Bot Config to a text-only chat "
                         "model (Llama 3.x, Qwen2.5, Granite 3.3+, Mistral, etc.).")
        elif reason == "unrecognized-model":
            clean_msg = ("Chat model's config.json couldn't be read by transformers. "
                         "Usually fixes itself after restarting the AI server (the "
                         "hardlink workaround at boot makes the cache readable again). "
                         "If it persists, the cache for this model may be incomplete — "
                         "re-download via Model Manager.")
        elif reason.startswith("chat-load-error:"):
            clean_msg = f"Chat model failed to load ({reason.split(':',1)[1]}). Open Control Center → View logs for the full trace."
        else:
            clean_msg = f"Chat model failed ({reason}). Open Control Center → View logs for the full trace."
        # Surface a short slice of the underlying exception so the user can see
        # the actual cause (gated repo, missing cache file, 401, etc.) without
        # opening the log file. Keep it short and redact obvious secrets.
        try:
            raw_detail = f"{type(exc).__name__}: {exc}"
        except Exception:
            raw_detail = type(exc).__name__
        raw_detail = re.sub(r"\b(hf_|sk-|nvapi-)[A-Za-z0-9_-]{8,}", r"\1[redacted]", raw_detail)
        if len(raw_detail) > 600:
            raw_detail = raw_detail[:600] + "…"
        return JSONResponse(status_code=503, content={
            "error": clean_msg,
            "reason": reason,
            "detail": raw_detail,
            "attempt_log": attempt_log,
        })


# ---------------------------------------------------------------------------
# Vision - Qwen2.5-VL, stable local backend
# ---------------------------------------------------------------------------

def load_vision_model() -> None:
    global vision_model, vision_processor, vision_tokenizer, last_loaded_at

    if vision_model is not None and vision_processor is not None:
        return

    prepare_task("vision")
    print(f"[SeekDeep] loading vision model: {VISION_MODEL_ID}", flush=True)

    import torch
    from transformers import AutoProcessor, Qwen2_5_VLForConditionalGeneration

    kwargs = {
        "cache_dir": str(MODEL_CACHE_DIR),
        "token": HF_TOKEN,
        "local_files_only": HF_LOCAL_FILES_ONLY,
    }

    vision_processor = AutoProcessor.from_pretrained(
        VISION_MODEL_ID,
        min_pixels=256 * 28 * 28,
        max_pixels=1280 * 28 * 28,
        **kwargs,
    )
    vision_tokenizer = vision_processor

    vision_model = Qwen2_5_VLForConditionalGeneration.from_pretrained(
        VISION_MODEL_ID,
        torch_dtype=model_dtype(),
        device_map=None,
        low_cpu_mem_usage=False,
        **kwargs,
    )

    if cuda_available():
        vision_model = vision_model.to("cuda")

    vision_model = vision_model.eval()
    last_loaded_at = time.time()
    print("[SeekDeep] vision model loaded", flush=True)
    _emit_event("model.loaded", {
        "role": "vision",
        "model": VISION_MODEL_ID,
        "task": "vision",
        "vram_allocated_mb": _vram_event_payload().get("allocated_mb"),
    })


def load_media_frames(media_bytes: bytes, filename: str, media_kind: str) -> tuple[list[Image.Image], str]:
    # ext comes from a user-provided filename — keep only a safe extension charset
    # so it can never become a path component (CodeQL py/path-injection; defensive,
    # since .suffix is already separator-free).
    ext = re.sub(r"[^A-Za-z0-9.]", "", Path(filename).suffix.lower())[:12]
    is_video = media_kind == "video" or (media_kind == "auto" and ext in {".mp4", ".mov", ".webm", ".mkv", ".avi", ".gif"})

    if not is_video:
        img = open_image_bytes(media_bytes, mode="RGB", label="vision image")
        return [img], "image"

    # Video path: sample up to 8 frames.
    tmp = None
    vid_iter = None
    try:
        import imageio.v3 as iio
        tmp = TEMP_DIR / f"vision_{int(time.time() * 1000)}{ext or '.mp4'}"
        tmp.write_bytes(media_bytes)
        frames = []
        vid_iter = iio.imiter(tmp)
        for idx, frame in enumerate(vid_iter):
            if idx % 15 == 0:
                img = Image.fromarray(frame)
                _check_image_pixel_budget(img, label="vision video frame")
                frames.append(img.convert("RGB"))
            if len(frames) >= 8:
                break
        if not frames:
            raise RuntimeError("No frames could be decoded from video.")
        return frames, "video"
    except Exception as exc:
        raise RuntimeError(f"Could not decode video. Try a PNG/JPG first, or install imageio-ffmpeg. Details: {exc}")
    finally:
        # PYS-6: close the imiter generator FIRST. On Windows an early `break` leaves
        # it suspended holding a file lock on tmp, so the unlink below would fail with
        # PermissionError and leak the file (Gemini). Then remove the temp file on
        # EVERY exit path (corrupt upload, early break, success).
        if vid_iter is not None:
            try:
                vid_iter.close()
            except Exception:
                pass
        if tmp is not None:
            try:
                tmp.unlink(missing_ok=True)
            except Exception:
                pass


def generate_vision_answer(prompt: str, frames: list[Image.Image], media_kind: str, max_new_tokens: int, temperature: float) -> str:
    load_vision_model()

    import torch

    usable_frames = []
    for frame in frames[:8]:
        usable_frames.append(frame.convert("RGB"))

    if not usable_frames:
        raise RuntimeError("No readable image/video frames were provided.")

    user_text = prompt.strip() or "Describe and interpret this media."
    if media_kind == "video":
        user_text = f"The input is a video represented by {len(usable_frames)} sampled frames. {user_text}"

    content = [{"type": "image", "image": frame} for frame in usable_frames]
    content.append({"type": "text", "text": user_text})
    messages = [{"role": "user", "content": content}]

    chat_text = vision_processor.apply_chat_template(messages, tokenize=False, add_generation_prompt=True)
    inputs = vision_processor(text=[chat_text], images=usable_frames, padding=True, return_tensors="pt")

    device = first_model_device(vision_model)
    try:
        inputs = inputs.to(device)
    except Exception:
        inputs = move_inputs(inputs, device)

    gen_kwargs = {
        "max_new_tokens": max(32, min(int(max_new_tokens), 2048)),
        "do_sample": float(temperature) > 0,
    }
    if gen_kwargs["do_sample"]:
        gen_kwargs["temperature"] = max(float(temperature), 0.01)
        gen_kwargs["top_p"] = 0.9

    with torch.inference_mode():
        generated_ids = vision_model.generate(**inputs, **gen_kwargs)

    generated_trimmed = [
        output_ids[len(input_ids):]
        for input_ids, output_ids in zip(inputs.input_ids, generated_ids)
    ]

    output_text = vision_processor.batch_decode(
        generated_trimmed,
        skip_special_tokens=True,
        clean_up_tokenization_spaces=False,
    )

    return (output_text[0].strip() if output_text else "").strip() or "(empty vision response)"


@app.post("/vision", dependencies=[Depends(require_gui_token)])
def vision(req: VisionRequest):
    media_bytes = b64_to_bytes(req.media_b64)
    frames, actual_kind = load_media_frames(media_bytes, req.filename, req.media_kind)
    answer = generate_vision_answer(req.prompt, frames, actual_kind, req.max_new_tokens, req.temperature)
    return {"text": answer, "frames_used": len(frames), "media_kind": actual_kind}


# ---------------------------------------------------------------------------
# Text-to-speech — loader + synthesis. Heavy imports live INSIDE load_tts_engine
# so importing this module never pulls in piper / TTS. The /tts route (below the
# image routes) maps the two sentinels to HTTP codes: TTSDepsMissing -> 501,
# TTSNotConfigured -> 503, and any other exception -> 500.
# ---------------------------------------------------------------------------

class TTSNotConfigured(RuntimeError):
    """No voice/model env is set for the active engine -> HTTP 503."""


class TTSDepsMissing(RuntimeError):
    """The chosen engine's package/binary isn't installed -> HTTP 501."""


def load_tts_engine():
    """Lazily build (and cache) the TTS engine handle for the active engine.

    Mirrors load_image_pipe(): cached-handle short-circuit -> lazy import inside
    -> assign the `tts_engine` module global. NOTHING heavy imports at module
    load. Raises TTSNotConfigured (->503) when no voice/model is set, and
    TTSDepsMissing (->501) when the engine's package/binary is unavailable.

    Piper resolution order:
      1. Python package: `from piper import PiperVoice` + PiperVoice.load(voice).
      2. CLI fallback: if the import fails but SEEKDEEP_TTS_PIPER_BIN (or a
         `piper` on PATH) exists, stash a {"mode": "cli", ...} descriptor and
         shell out at synth time.
      3. Neither -> TTSDepsMissing.
    """
    global tts_engine

    if tts_engine is not None:
        return tts_engine

    if not _tts_voice_configured():
        raise TTSNotConfigured(
            "No TTS voice/model configured. Set SEEKDEEP_TTS_PIPER_VOICE "
            "(Piper) or SEEKDEEP_TTS_MODEL_ID (XTTS)."
        )

    if SEEKDEEP_TTS_ENGINE == "piper":
        # --- Preferred: the piper Python package (offline, fast). ---
        try:
            from piper import PiperVoice  # type: ignore
        except Exception:
            PiperVoice = None  # fall through to the CLI probe below

        if PiperVoice is not None:
            try:
                voice = PiperVoice.load(SEEKDEEP_TTS_PIPER_VOICE)
            except Exception as exc:
                # Package present but the voice file is unloadable (missing
                # .onnx / .onnx.json, corrupt, wrong path). That's a 500-class
                # config error, not a missing-dep — surface it loudly.
                raise RuntimeError(f"failed to load Piper voice: {exc}") from exc
            tts_engine = {"mode": "python", "voice": voice}
            print(f"[SeekDeep] TTS (piper) loaded voice: {SEEKDEEP_TTS_PIPER_VOICE}", flush=True)
            return tts_engine

        # --- Fallback: a `piper` executable. ---
        import shutil
        piper_bin = SEEKDEEP_TTS_PIPER_BIN or shutil.which("piper")
        if piper_bin and (os.path.isfile(piper_bin) or shutil.which(piper_bin)):
            tts_engine = {"mode": "cli", "bin": piper_bin, "voice": SEEKDEEP_TTS_PIPER_VOICE}
            print(f"[SeekDeep] TTS (piper) using CLI: {piper_bin}", flush=True)
            return tts_engine

        raise TTSDepsMissing("TTS engine not installed (pip install piper-tts).")

    if SEEKDEEP_TTS_ENGINE == "xtts":
        try:
            from TTS.api import TTS  # type: ignore
        except Exception as exc:
            raise TTSDepsMissing("TTS engine not installed (pip install TTS).") from exc
        try:
            use_gpu = cuda_available()
            engine = TTS(model_name=SEEKDEEP_TTS_MODEL_ID).to("cuda" if use_gpu else "cpu")
        except Exception as exc:
            raise RuntimeError(f"failed to load XTTS model: {exc}") from exc
        tts_engine = {"mode": "xtts", "tts": engine}
        print(f"[SeekDeep] TTS (xtts) loaded model: {SEEKDEEP_TTS_MODEL_ID}", flush=True)
        return tts_engine

    # Engine string isn't one we know how to drive.
    raise TTSDepsMissing(
        f"Unknown TTS engine {SEEKDEEP_TTS_ENGINE!r}. Set SEEKDEEP_TTS_ENGINE to 'piper' or 'xtts'."
    )


def _tts_default_sample_rate() -> int:
    """Best-effort sample rate for the active engine, used only when synthesis
    can't report one (Piper voices are typically 22050 Hz mono; XTTS is 24000)."""
    return 24000 if SEEKDEEP_TTS_ENGINE == "xtts" else 22050


def synthesize_tts(text: str, voice: str = "", rate: float = 1.0) -> tuple[bytes, int]:
    """Synthesize `text` -> (wav_bytes, sample_rate). Builds the engine on first
    call. `rate` is an optional length scale (>1.0 = slower for Piper). Raises
    the same sentinels as load_tts_engine(); other failures bubble as plain
    exceptions the route maps to 500. Returns a native WAV (no resampling)."""
    import io as _io
    import wave as _wave

    engine = load_tts_engine()
    mode = engine.get("mode")

    # ---------------- Piper: Python package ----------------
    if mode == "python":
        voice_obj = engine["voice"]
        # The piper1-gpl package accepts a SynthesisConfig with a length_scale;
        # older builds don't. Pass it when available, otherwise synthesize plain.
        syn_config = None
        try:
            from piper import SynthesisConfig  # type: ignore
            if rate and rate > 0 and abs(rate - 1.0) > 1e-3:
                syn_config = SynthesisConfig(length_scale=1.0 / float(rate))
        except Exception:
            syn_config = None

        buf = _io.BytesIO()
        # Preferred path: synthesize_wav writes a full WAV (header + frames)
        # straight into a wave.Wave_write. This is the documented one-shot API.
        try:
            with _wave.open(buf, "wb") as wav_file:
                if syn_config is not None:
                    voice_obj.synthesize_wav(text, wav_file, syn_config=syn_config)
                else:
                    voice_obj.synthesize_wav(text, wav_file)
            data = buf.getvalue()
            if data:
                sr = _wav_sample_rate(data) or _tts_default_sample_rate()
                return data, sr
        except (AttributeError, TypeError):
            pass  # older/newer API — fall back to the streaming chunk API

        # Fallback: stream raw int16 chunks and assemble the WAV ourselves.
        sample_rate = _tts_default_sample_rate()
        sample_width = 2
        channels = 1
        frames = bytearray()
        produced = False
        for chunk in voice_obj.synthesize(text):
            produced = True
            # piper1-gpl AudioChunk carries int16 bytes + format metadata.
            sample_rate = int(getattr(chunk, "sample_rate", sample_rate) or sample_rate)
            sample_width = int(getattr(chunk, "sample_width", sample_width) or sample_width)
            channels = int(getattr(chunk, "sample_channels", channels) or channels)
            payload = getattr(chunk, "audio_int16_bytes", None)
            if payload is None:
                # Last-resort: some builds expose float arrays instead.
                arr = getattr(chunk, "audio_float_array", None)
                if arr is not None:
                    import numpy as _np  # local: numpy ships with the ML stack
                    payload = (_np.clip(arr, -1.0, 1.0) * 32767).astype("<i2").tobytes()
            if payload:
                frames.extend(payload)
        if not produced:
            raise RuntimeError("Piper produced no audio for the request.")
        return _pcm_to_wav(bytes(frames), sample_rate, sample_width, channels), sample_rate

    # ---------------- Piper: CLI fallback ----------------
    if mode == "cli":
        import subprocess
        import tempfile
        tmp_path = None
        try:
            with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as tmp:
                tmp_path = tmp.name
            cmd = [engine["bin"], "-m", engine["voice"], "-f", tmp_path]
            if rate and rate > 0 and abs(rate - 1.0) > 1e-3:
                cmd += ["--length_scale", str(1.0 / float(rate))]
            proc = subprocess.run(
                cmd,
                input=text.encode("utf-8"),
                capture_output=True,
                timeout=120,
            )
            if proc.returncode != 0:
                err = (proc.stderr or b"").decode("utf-8", "replace")[:300]
                raise RuntimeError(f"piper CLI failed (exit {proc.returncode}): {err}")
            with open(tmp_path, "rb") as fh:
                data = fh.read()
            if not data:
                raise RuntimeError("piper CLI produced an empty WAV.")
            sr = _wav_sample_rate(data) or _tts_default_sample_rate()
            return data, sr
        finally:
            if tmp_path:
                try:
                    os.remove(tmp_path)
                except OSError:
                    pass

    # ---------------- XTTS (Coqui) ----------------
    if mode == "xtts":
        import tempfile
        tts_obj = engine["tts"]
        tmp_path = None
        try:
            with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as tmp:
                tmp_path = tmp.name
            kwargs = {"text": text, "file_path": tmp_path}
            # XTTS-v2 needs a target language; default to English. A speaker
            # name (when the model ships built-in speakers) can be passed via
            # the request `voice` field.
            try:
                kwargs["language"] = os.getenv("SEEKDEEP_TTS_XTTS_LANGUAGE", "en")
                if voice:
                    kwargs["speaker"] = voice
                tts_obj.tts_to_file(**kwargs)
            except TypeError:
                # Model doesn't take language/speaker — retry minimal.
                tts_obj.tts_to_file(text=text, file_path=tmp_path)
            with open(tmp_path, "rb") as fh:
                data = fh.read()
            if not data:
                raise RuntimeError("XTTS produced an empty WAV.")
            sr = _wav_sample_rate(data) or _tts_default_sample_rate()
            return data, sr
        finally:
            if tmp_path:
                try:
                    os.remove(tmp_path)
                except OSError:
                    pass

    raise RuntimeError(f"TTS engine in an unexpected state: mode={mode!r}")


def _pcm_to_wav(pcm: bytes, sample_rate: int, sample_width: int = 2, channels: int = 1) -> bytes:
    """Wrap raw little-endian PCM frames in a minimal WAV container."""
    import io as _io
    import wave as _wave
    buf = _io.BytesIO()
    with _wave.open(buf, "wb") as wav_file:
        wav_file.setnchannels(max(1, channels))
        wav_file.setsampwidth(max(1, sample_width))
        wav_file.setframerate(max(1, sample_rate))
        wav_file.writeframes(pcm)
    return buf.getvalue()


def _wav_sample_rate(wav_bytes: bytes) -> int:
    """Read the sample rate out of a WAV byte string; 0 if it isn't parseable."""
    import io as _io
    import wave as _wave
    try:
        with _wave.open(_io.BytesIO(wav_bytes), "rb") as wav_file:
            return int(wav_file.getframerate())
    except Exception:
        return 0


# ---------------------------------------------------------------------------
# Image generation - configurable diffusion steps for the current model.
# ---------------------------------------------------------------------------

def load_image_pipe() -> None:
    global image_pipe, last_loaded_at

    if image_pipe is not None:
        return

    prepare_task("image")
    print(f"[SeekDeep] loading image model: {IMAGE_MODEL_ID}", flush=True)

    import torch
    from diffusers import DiffusionPipeline
    try:
        from diffusers import ZImagePipeline
    except Exception:
        ZImagePipeline = None

    image_pipeline_class = os.getenv("LOCAL_IMAGE_PIPELINE_CLASS", "").strip().lower()
    is_zimage = image_pipeline_class == "zimagepipeline" or IMAGE_MODEL_ID.strip().lower() == "tongyi-mai/z-image"

    kwargs = {
        "cache_dir": str(MODEL_CACHE_DIR),
        "token": HF_TOKEN,
        "local_files_only": HF_LOCAL_FILES_ONLY,
        "torch_dtype": model_dtype(),
    }

    if is_zimage:
        if ZImagePipeline is None:
            raise RuntimeError("ZImagePipeline is unavailable. Upgrade diffusers to a version that includes ZImagePipeline.")
        kwargs["low_cpu_mem_usage"] = False
        image_pipe = ZImagePipeline.from_pretrained(IMAGE_MODEL_ID, **kwargs)
    else:
        image_variant = os.getenv("LOCAL_IMAGE_VARIANT", "").strip()
        if image_variant:
            kwargs["variant"] = image_variant

        image_use_safetensors = os.getenv("IMAGE_USE_SAFETENSORS", "true").lower() not in {"0", "false", "no", "off"}
        kwargs["use_safetensors"] = image_use_safetensors

        image_pipe = DiffusionPipeline.from_pretrained(IMAGE_MODEL_ID, **kwargs)

    # v10.30: force DPM++ 2M Karras scheduler for SDXL. This is the scheduler
    # Dreamshaper-XL was fine-tuned with and produces the fewest artifacts.
    # Other schedulers (PNDM, Euler, etc.) can introduce subtle malformations,
    # especially at lower step counts. Env override: IMAGE_SCHEDULER=default.
    scheduler_choice = os.getenv("IMAGE_SCHEDULER", "dpmsolver++").strip().lower()
    if scheduler_choice != "default" and not is_zimage:
        try:
            from diffusers import DPMSolverMultistepScheduler
            image_pipe.scheduler = DPMSolverMultistepScheduler.from_config(
                image_pipe.scheduler.config,
                algorithm_type="dpmsolver++",
                use_karras_sigmas=True,
            )
            print("[SeekDeep] scheduler set to DPM++ 2M Karras", flush=True)
        except Exception as e:
            print(f"[SeekDeep] scheduler override failed, using default: {e}", flush=True)

    if cuda_available():
        image_pipe = image_pipe.to("cuda")

    try:
        image_pipe.set_progress_bar_config(disable=True)
    except Exception:
        pass

    last_loaded_at = time.time()
    print("[SeekDeep] image model loaded", flush=True)
    _emit_event("model.loaded", {
        "role": "image",
        "model": IMAGE_MODEL_ID,
        "task": "image",
        "vram_allocated_mb": _vram_event_payload().get("allocated_mb"),
    })

def _cap_sdxl_prompt(prompt: str, tokenizer, max_tokens: int = 75) -> tuple[str, bool]:
    """Trim `prompt` so it tokenizes to <= max_tokens under `tokenizer`. SDXL's
    CLIP text encoders cap at 77 tokens (including BOS/EOS), so anything past
    token 75 gets silently dropped by the pipeline. Without this cap, dynamic
    refinement's longer prompts (200-360 chars) lose their tail descriptors
    -- the SDXL output reflects only the first sentence or two.

    Trims at a sentence-end (. ! ? ,) boundary when possible so the truncated
    prompt still parses coherently. Returns (capped_prompt, was_truncated)."""
    if not prompt or tokenizer is None:
        return prompt or "", False
    try:
        ids = tokenizer(prompt, add_special_tokens=False).input_ids
        if len(ids) <= max_tokens:
            return prompt, False
        # Walk back char-by-char to find a clean break that still tokenizes
        # short enough. Two-pass: first try sentence boundaries, then commas,
        # then just hard-cap.
        for sep_chars in (".!?", ",;", " "):
            best = ""
            for i, ch in enumerate(prompt):
                if ch in sep_chars:
                    candidate = prompt[: i + 1].rstrip(", ;")
                    if len(tokenizer(candidate, add_special_tokens=False).input_ids) <= max_tokens:
                        best = candidate
                    else:
                        break
            if best:
                return best.strip(), True
        # Hard truncate as last resort
        encoded = tokenizer(prompt, add_special_tokens=False, truncation=True,
                            max_length=max_tokens)
        truncated = tokenizer.decode(encoded.input_ids, skip_special_tokens=True).strip()
        return truncated, True
    except Exception:
        return prompt, False


def _apply_sdxl_prompt_cap(args: dict, pipe) -> None:
    """In-place: trim args['prompt'] and args.get('negative_prompt') so neither
    exceeds the pipeline's 77-token text-encoder limit. Logs each truncation."""
    tok = getattr(pipe, "tokenizer", None)
    if tok is None:
        return
    for key in ("prompt", "negative_prompt"):
        val = args.get(key)
        if not val or not isinstance(val, str):
            continue
        capped, truncated = _cap_sdxl_prompt(val, tok)
        if truncated:
            print(
                f"[SeekDeep] SDXL {key} trimmed to <=75 tokens (was ~{len(val)} chars, "
                f"now ~{len(capped)} chars). Tail descriptors past token 75 would have "
                f"been silently dropped by the text encoder.",
                flush=True,
            )
            args[key] = capped


@app.post("/image", dependencies=[Depends(require_gui_token)])
def image(req: ImageRequest):
    load_image_pipe()

    import torch

    width = int(req.width)
    height = int(req.height)
    if width % 8:
        width = width - (width % 8)
    if height % 8:
        height = height - (height % 8)

    seed = req.seed
    generator = None
    if seed is not None:
        device = "cuda" if cuda_available() else "cpu"
        generator = torch.Generator(device=device).manual_seed(int(seed))

    image_pipeline_class = os.getenv("LOCAL_IMAGE_PIPELINE_CLASS", "").strip().lower()
    is_zimage = image_pipeline_class == "zimagepipeline" or IMAGE_MODEL_ID.strip().lower() == "tongyi-mai/z-image"

    requested_steps = max(1, min(50, int(req.steps)))

    args = {
        "prompt": req.prompt.strip(),
        "width": width,
        "height": height,
        "num_inference_steps": requested_steps,
        "guidance_scale": float(req.guidance_scale),
    }

    request_negative_prompt = str(getattr(req, "negative_prompt", "") or os.getenv("IMAGE_NEGATIVE_PROMPT", "") or "").strip()
    if request_negative_prompt:
        args["negative_prompt"] = request_negative_prompt

    if is_zimage:
        cfg_norm_env = os.getenv("IMAGE_CFG_NORMALIZATION", "false").strip().lower()
        args["cfg_normalization"] = cfg_norm_env in {"1", "true", "yes", "on"}

        negative_prompt = os.getenv("IMAGE_NEGATIVE_PROMPT", "").strip()
        if negative_prompt and "negative_prompt" not in args:
            args["negative_prompt"] = negative_prompt

    if generator is not None:
        args["generator"] = generator

    # SDXL text encoder caps at 77 tokens (incl. BOS/EOS); trim cleanly here
    # so dynamic refinement's longer prompts don't lose their tail silently.
    # Skipped for Z-Image, which has its own tokenizer behavior.
    if not is_zimage:
        _apply_sdxl_prompt_cap(args, image_pipe)

    final_prompt_for_response = str(args.get("prompt", req.prompt.strip())).strip()

    result = image_pipe(**args)
    img = result.images[0]

    ts = time.time_ns()  # nanosecond resolution defeats same-second filename collisions (AUD-015)
    safe_name = f"seekdeep_image_{ts}.png"
    out_path = _output_path(safe_name)
    img.save(out_path)

    return {
        "image_b64": image_to_b64_png(img),
        "original_prompt": req.prompt.strip(),
        "refined_prompt": final_prompt_for_response,
        "filename": safe_name,
        **_maybe_debug_path(out_path),
        "forced_steps": int(args.get("num_inference_steps", requested_steps)),
        "seed": seed,
    }


@app.post("/img2img", dependencies=[Depends(require_gui_token)])
def img2img(req: Img2ImgRequest):
    load_image_pipe()

    import torch
    from diffusers import AutoPipelineForImage2Image

    # Create an img2img pipeline sharing the same model components — no extra
    # VRAM.  AutoPipelineForImage2Image.from_pipe() is the modern diffusers way
    # to reuse loaded weights for a different pipeline type.
    i2i_pipe = AutoPipelineForImage2Image.from_pipe(image_pipe)

    # Decode the source image (400 on invalid base64 / non-image bytes)
    source_img = open_image_b64(req.image_b64, mode="RGB")

    width = int(req.width)
    height = int(req.height)
    if width % 8:
        width = width - (width % 8)
    if height % 8:
        height = height - (height % 8)

    source_img = source_img.resize((width, height), Image.LANCZOS)

    seed = req.seed
    generator = None
    if seed is not None:
        device = "cuda" if cuda_available() else "cpu"
        generator = torch.Generator(device=device).manual_seed(int(seed))

    args = {
        "prompt": req.prompt.strip(),
        "image": source_img,
        "strength": float(req.strength),
        "num_inference_steps": max(1, min(50, int(req.steps))),
        "guidance_scale": float(req.guidance_scale),
    }

    if req.negative_prompt.strip():
        args["negative_prompt"] = req.negative_prompt.strip()
    if generator is not None:
        args["generator"] = generator

    _apply_sdxl_prompt_cap(args, i2i_pipe)

    result = i2i_pipe(**args)
    img = result.images[0]

    ts = time.time_ns()  # nanosecond resolution defeats same-second filename collisions (AUD-015)
    safe_name = f"seekdeep_img2img_{ts}.png"
    out_path = _output_path(safe_name)
    img.save(out_path)

    return {
        "image_b64": image_to_b64_png(img),
        "original_prompt": req.prompt.strip(),
        "filename": safe_name,
        **_maybe_debug_path(out_path),
        "strength": float(req.strength),
        "seed": seed,
    }
def _resolve_realesrgan_weights(scale: "int | None" = None) -> "Path | None":
    """Locate the Real-ESRGAN .pth to use, or None if none is configured.

    Priority: explicit SEEKDEEP_REALESRGAN_MODEL_PATH (the documented knob) ->
    any *.pth dropped into <MODEL_CACHE_DIR>/realesrgan (legacy convenience). When
    `scale` is given, a fallback-dir file whose name contains `x{scale}` wins so a
    2x/3x/4x request still picks the matching weight (legacy behavior).
    No weights are bundled with the repo, so this returns None until the user
    provides one and the caller then falls back to Lanczos.
    """
    explicit = (os.getenv("SEEKDEEP_REALESRGAN_MODEL_PATH") or "").strip()
    if explicit:
        p = Path(explicit)
        return p if p.is_file() else None
    realesrgan_dir = MODEL_CACHE_DIR / "realesrgan"
    if not realesrgan_dir.exists():
        return None
    pth_files = list(realesrgan_dir.glob("*.pth"))
    if not pth_files:
        return None
    if scale is not None:
        for p in pth_files:
            if f"x{scale}" in p.name.lower():
                return p
    return pth_files[0]


def check_realesrgan_available() -> tuple[bool, str]:
    """
    Checks if Real-ESRGAN dependencies and models are available.
    Returns (is_available, error_message).

    Gated on: feature flag on, basicsr/realesrgan importable, and a weights file
    resolvable via SEEKDEEP_REALESRGAN_MODEL_PATH (or the legacy realesrgan/ dir).
    Any miss -> (False, reason) and the /upscale path falls back to Lanczos.
    """
    if os.getenv("SEEKDEEP_FEATURE_UPSCALE_REALESRGAN") != "on":
        return False, "Real-ESRGAN feature flag (SEEKDEEP_FEATURE_UPSCALE_REALESRGAN) is not 'on'."
    try:
        import torch  # noqa: F401
        from basicsr.archs.rrdbnet_arch import RRDBNet  # noqa: F401
        from realesrgan import RealESRGANer  # noqa: F401
    except ImportError as e:
        return False, f"Missing Python dependency for Real-ESRGAN: {e}"

    weights = _resolve_realesrgan_weights()
    if weights is None:
        explicit = (os.getenv("SEEKDEEP_REALESRGAN_MODEL_PATH") or "").strip()
        if explicit:
            return False, f"SEEKDEEP_REALESRGAN_MODEL_PATH does not point to a file: {explicit}"
        return False, (
            "No Real-ESRGAN weights configured; set SEEKDEEP_REALESRGAN_MODEL_PATH to a "
            f".pth (or drop one in {MODEL_CACHE_DIR / 'realesrgan'}). Model not bundled."
        )

    return True, ""


def select_upscale_method(requested_method: str) -> tuple[str, bool, str]:
    """
    Resolves the upscale method based on availability and fallback config.
    Returns (resolved_method, is_available, error_message).
    """
    method = str(requested_method or "").lower()
    if method == "realesrgan":
        is_avail, err_msg = check_realesrgan_available()
        if is_avail:
            return "realesrgan", True, ""
        
        fallback = str(os.getenv("SEEKDEEP_UPSCALE_REALESRGAN_FALLBACK") or "").lower()
        if fallback == "lanczos":
            return "lanczos", False, err_msg
        else:
            return "realesrgan", False, err_msg
            
    return "lanczos", True, ""


@app.post("/upscale", dependencies=[Depends(require_gui_token)])
def upscale(req: UpscaleRequest):
    """Upscale an image. 'lanczos' is a zero-model PIL fallback that works
    immediately. 'realesrgan' requires the model to be downloaded separately."""
    try:
        source_bytes = b64_to_bytes(req.image_b64)
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=400, detail=f"Invalid base64 image payload: {exc}") from exc

    try:
        opened_img = open_image_bytes(source_bytes, mode=None, label="upscale image")
        opened_img.load()
    except UnidentifiedImageError as exc:
        raise HTTPException(status_code=400, detail="Unsupported or unrecognized image format.") from exc
    except HTTPException:
        raise
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=400, detail=f"Invalid image: {exc}") from exc

    is_animated = bool(getattr(opened_img, "is_animated", False) or getattr(opened_img, "n_frames", 1) > 1)
    if is_animated:
        if str(getattr(opened_img, "format", "")).upper() == "GIF":
            raise HTTPException(status_code=400, detail="animated GIFs are not supported for upscaling.")
        raise HTTPException(status_code=400, detail="Animated images are not supported for upscaling.")

    try:
        transposed = ImageOps.exif_transpose(opened_img)
        if transposed.mode in {"RGBA", "LA"} or (transposed.mode == "P" and "transparency" in transposed.info):
            source_img = transposed.convert("RGBA")
        else:
            source_img = transposed.convert("RGB")
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=400, detail=f"Could not normalize image orientation: {exc}") from exc

    scale = int(req.scale)
    max_bytes = max(0, int(req.max_bytes or 0))
    input_width, input_height = source_img.width, source_img.height
    input_bytes = len(source_bytes)
    resample_map = {
        "lanczos": Image.Resampling.LANCZOS if hasattr(Image, "Resampling") else Image.LANCZOS,
        "bicubic": Image.Resampling.BICUBIC if hasattr(Image, "Resampling") else Image.BICUBIC,
        "nearest": Image.Resampling.NEAREST if hasattr(Image, "Resampling") else Image.NEAREST,
    }
    resample_name = str(req.resample or "lanczos").lower()
    resample_filter = resample_map.get(resample_name, resample_map["lanczos"])
    lanczos_filter = Image.Resampling.LANCZOS if hasattr(Image, "Resampling") else Image.LANCZOS

    def encode_image_bytes(img: Image.Image, fmt: str, **save_kwargs: Any) -> bytes:
        buf = io.BytesIO()
        to_save = img.convert("RGB") if fmt.upper() in {"JPEG", "JPG"} else img
        to_save.save(buf, format=fmt, **save_kwargs)
        return buf.getvalue()

    def select_output_bytes(img: Image.Image) -> dict[str, Any]:
        candidates: list[tuple[str, str, bytes, int, int]] = []

        def add_candidate(fmt: str, ext: str, candidate_img: Image.Image, **kwargs: Any) -> None:
            try:
                encoded = encode_image_bytes(candidate_img, fmt, **kwargs)
                candidates.append((fmt.upper(), ext, encoded, candidate_img.width, candidate_img.height))
            except Exception as exc:  # noqa: BLE001
                print(f"[SeekDeep Local AI] upscale encode candidate failed fmt={fmt}: {exc}", flush=True)

        add_candidate("PNG", ".png", img)
        if max_bytes <= 0 or (candidates and len(candidates[-1][2]) <= max_bytes):
            fmt, ext, encoded, width, height = candidates[-1]
            return {"format": fmt, "ext": ext, "bytes": encoded, "width": width, "height": height}

        add_candidate("PNG", ".png", img, optimize=True, compress_level=9)
        if candidates and len(candidates[-1][2]) <= max_bytes:
            fmt, ext, encoded, width, height = candidates[-1]
            return {"format": fmt, "ext": ext, "bytes": encoded, "width": width, "height": height}

        for quality in (90, 80):
            add_candidate("WEBP", ".webp", img, quality=quality, method=6)
            if candidates and len(candidates[-1][2]) <= max_bytes:
                fmt, ext, encoded, width, height = candidates[-1]
                return {"format": fmt, "ext": ext, "bytes": encoded, "width": width, "height": height}

        for quality in (90, 80):
            add_candidate("JPEG", ".jpg", img, quality=quality, optimize=True, progressive=True)
            if candidates and len(candidates[-1][2]) <= max_bytes:
                fmt, ext, encoded, width, height = candidates[-1]
                return {"format": fmt, "ext": ext, "bytes": encoded, "width": width, "height": height}

        for pct in range(90, 49, -10):
            w = max(1, int(img.width * pct / 100))
            h = max(1, int(img.height * pct / 100))
            reduced = img.resize((w, h), lanczos_filter)
            add_candidate("JPEG", ".jpg", reduced, quality=80, optimize=True, progressive=True)
            if candidates and len(candidates[-1][2]) <= max_bytes:
                fmt, ext, encoded, width, height = candidates[-1]
                return {"format": fmt, "ext": ext, "bytes": encoded, "width": width, "height": height}

        smallest = min(candidates, key=lambda c: len(c[2])) if candidates else None
        smallest_bytes = len(smallest[2]) if smallest else 0
        raise HTTPException(
            status_code=400,
            detail=(
                "Upscaled output is too large for this server upload limit "
                f"({smallest_bytes} bytes after compression/downscale, limit {max_bytes} bytes)."
            ),
        )

    def finish_pil_upscale(note: str = ""):
        new_w = source_img.width * scale
        new_h = source_img.height * scale
        max_pixels = int(os.getenv("SEEKDEEP_UPSCALE_MAX_OUTPUT_PIXELS", "20000000"))
        upscale_clamp_meta = {"clamped": False}
        output_pixels = new_w * new_h
        img_for_resize = source_img
        if output_pixels > int(max_pixels):
            img_for_resize, upscale_clamp_meta = seekdeep_fit_upscale_input_to_output_cap(
                source_img,
                scale,
                max_pixels,
            )
            new_w = upscale_clamp_meta["output_width"]
            new_h = upscale_clamp_meta["output_height"]
            print(
                "[seekdeep] upscale output clamped: "
                f"{upscale_clamp_meta['requested_width']}x{upscale_clamp_meta['requested_height']} "
                f"({upscale_clamp_meta['requested_pixels']} pixels) -> "
                f"{upscale_clamp_meta['output_width']}x{upscale_clamp_meta['output_height']} "
                f"({upscale_clamp_meta['output_pixels']} pixels), "
                f"cap={upscale_clamp_meta['max_output_pixels']}"
            )
        img = img_for_resize.resize((new_w, new_h), resample_filter)
        sharpened = bool(req.sharpen and int(req.sharpen_percent) > 0)
        if sharpened:
            img = img.filter(ImageFilter.UnsharpMask(
                radius=float(req.sharpen_radius),
                percent=int(req.sharpen_percent),
                threshold=int(req.sharpen_threshold),
            ))

        selected = select_output_bytes(img)
        png_bytes = encode_image_bytes(img, "PNG")
        ts = time.time_ns()  # nanosecond resolution defeats same-second filename collisions (AUD-015)
        safe_name = f"seekdeep_upscale_{ts}{selected['ext']}"
        out_path = _output_path(safe_name)
        out_path.write_bytes(selected["bytes"])
        result = {
            "image_b64": base64.b64encode(selected["bytes"]).decode("ascii"),
            "png_b64": base64.b64encode(png_bytes).decode("ascii"),
            "filename": safe_name,
            **_maybe_debug_path(out_path),
            "method": "lanczos",
            "resample": resample_name,
            "sharpened": sharpened,
            "sharpen_radius": float(req.sharpen_radius),
            "sharpen_percent": int(req.sharpen_percent),
            "sharpen_threshold": int(req.sharpen_threshold),
            "scale": scale,
            "width": int(selected["width"]),
            "height": int(selected["height"]),
            "input_width": input_width,
            "input_height": input_height,
            "input_bytes": input_bytes,
            "output_format": selected["format"],
            "output_bytes": len(selected["bytes"]),
            "max_bytes": max_bytes,
        }
        if note:
            result["note"] = note
        return result

    resolved_method, is_avail, err_msg = select_upscale_method(req.method)
    if resolved_method == "realesrgan":
        if not is_avail:
            # Requested Real-ESRGAN but it's not usable (flag off / no weights /
            # deps missing). Graceful fallback to Lanczos so the request still
            # succeeds with today's behavior; upgrades automatically once a
            # model + flag are configured. (Model not bundled.)
            print(
                f"[SeekDeep Local AI] Real-ESRGAN unavailable ({err_msg}); "
                "falling back to Lanczos upscale.",
                flush=True,
            )
            return finish_pil_upscale(f"Real-ESRGAN unavailable, used Lanczos: {err_msg}")
        try:
            import numpy as np
            from basicsr.archs.rrdbnet_arch import RRDBNet
            from realesrgan import RealESRGANer

            # Weights: explicit SEEKDEEP_REALESRGAN_MODEL_PATH first, else a
            # *.pth in <cache>/realesrgan. check_realesrgan_available() already
            # guaranteed one resolves; guard anyway so we degrade, never 500.
            model_path = _resolve_realesrgan_weights(scale)
            if model_path is None:
                raise RuntimeError("Real-ESRGAN weights vanished between check and load")

            # Optional arch override (e.g. RealESRGAN_x4plus / *_anime_6B). When
            # unset we infer the arch from the weights filename, matching the
            # legacy behavior.
            model_name = (os.getenv("SEEKDEEP_REALESRGAN_MODEL_NAME") or "").strip()
            name_hint = (model_name or model_path.name).lower()

            num_block = 6 if ("anime" in name_hint or "6b" in name_hint) else 23

            model_scale = 4
            if "x2" in name_hint:
                model_scale = 2
            elif "x3" in name_hint:
                model_scale = 3
            elif "x4" in name_hint:
                model_scale = 4

            model = RRDBNet(num_in_ch=3, num_out_ch=3, num_feat=64, num_block=num_block, num_grow_ch=32, scale=model_scale)
            device = "cuda" if cuda_available() else "cpu"
            upsampler = RealESRGANer(
                scale=model_scale,
                model_path=str(model_path),
                model=model,
                tile=0,
                tile_pad=10,
                pre_pad=0,
                half=(device == "cuda"),
                device=device
            )

            img_for_upscale = source_img
            max_pixels = int(os.getenv("SEEKDEEP_UPSCALE_MAX_OUTPUT_PIXELS", "20000000"))
            if source_img.width * source_img.height * scale * scale > int(max_pixels):
                img_for_upscale, upscale_clamp_meta = seekdeep_fit_upscale_input_to_output_cap(
                    source_img,
                    scale,
                    max_pixels,
                )
                print(
                    "[seekdeep] realesrgan upscale output clamped: "
                    f"{upscale_clamp_meta['requested_width']}x{upscale_clamp_meta['requested_height']} "
                    f"({upscale_clamp_meta['requested_pixels']} pixels) -> "
                    f"{upscale_clamp_meta['output_width']}x{upscale_clamp_meta['output_height']} "
                    f"({upscale_clamp_meta['output_pixels']} pixels), "
                    f"cap={upscale_clamp_meta['max_output_pixels']}"
                )

            img_np = np.array(img_for_upscale)
            if img_for_upscale.mode == "RGBA":
                img_np = img_np[:, :, :3]
            img_np = img_np[:, :, ::-1] # RGB to BGR

            out_img, _ = upsampler.enhance(img_np, outscale=scale)
            out_img = out_img[:, :, ::-1] # BGR to RGB
            img = Image.fromarray(out_img)

            # Apply sharpening if requested
            sharpened = bool(req.sharpen and int(req.sharpen_percent) > 0)
            if sharpened:
                img = img.filter(ImageFilter.UnsharpMask(
                    radius=float(req.sharpen_radius),
                    percent=int(req.sharpen_percent),
                    threshold=int(req.sharpen_threshold),
                ))

            selected = select_output_bytes(img)
            png_bytes = encode_image_bytes(img, "PNG")
            ts = time.time_ns()  # nanosecond resolution defeats same-second filename collisions (AUD-015)
            safe_name = f"seekdeep_upscale_{ts}{selected['ext']}"
            out_path = _output_path(safe_name)
            out_path.write_bytes(selected["bytes"])
            return {
                "image_b64": base64.b64encode(selected["bytes"]).decode("ascii"),
                "png_b64": base64.b64encode(png_bytes).decode("ascii"),
                "filename": safe_name,
                **_maybe_debug_path(out_path),
                "method": "realesrgan",
                "resample": resample_name,
                "sharpened": sharpened,
                "sharpen_radius": float(req.sharpen_radius),
                "sharpen_percent": int(req.sharpen_percent),
                "sharpen_threshold": int(req.sharpen_threshold),
                "scale": scale,
                "width": int(selected["width"]),
                "height": int(selected["height"]),
                "input_width": input_width,
                "input_height": input_height,
                "input_bytes": input_bytes,
                "output_format": selected["format"],
                "output_bytes": len(selected["bytes"]),
                "max_bytes": max_bytes,
            }
        except Exception as exc:
            # Load/run error with deps+weights present: degrade to Lanczos
            # rather than failing the request (identical result to today's
            # zero-model path). The user still gets an upscaled image.
            print(
                f"[SeekDeep Local AI] Real-ESRGAN run failed ({exc}); "
                "falling back to Lanczos upscale.",
                flush=True,
            )
            return finish_pil_upscale(f"Real-ESRGAN run failed, used Lanczos: {exc}")

    note = ""
    if req.method == "realesrgan" and not is_avail:
        note = f"Real-ESRGAN fallback to Lanczos: {err_msg}"
    return finish_pil_upscale(note)


# ---------- InstructPix2Pix endpoint ----------

INSTRUCT_PIX2PIX_MODEL = os.getenv("LOCAL_INSTRUCT_PIX2PIX_MODEL_ID", "timbrooks/instruct-pix2pix")
instruct_pix2pix_pipe = None


def load_instruct_pix2pix() -> None:
    global instruct_pix2pix_pipe, last_loaded_at
    if instruct_pix2pix_pipe is not None:
        return
    prepare_task("instruct_pix2pix")
    print(f"[SeekDeep] loading InstructPix2Pix model: {INSTRUCT_PIX2PIX_MODEL}", flush=True)
    _log_vram("before instruct-pix2pix load")

    import torch
    from diffusers import StableDiffusionInstructPix2PixPipeline

    instruct_pix2pix_pipe = StableDiffusionInstructPix2PixPipeline.from_pretrained(
        INSTRUCT_PIX2PIX_MODEL,
        torch_dtype=model_dtype(),
        cache_dir=str(MODEL_CACHE_DIR),
        token=HF_TOKEN,
        local_files_only=HF_LOCAL_FILES_ONLY,
        safety_checker=None,
    )
    if cuda_available():
        instruct_pix2pix_pipe = instruct_pix2pix_pipe.to("cuda")
    try:
        instruct_pix2pix_pipe.set_progress_bar_config(disable=True)
    except Exception:
        pass
    last_loaded_at = time.time()
    _log_vram("after instruct-pix2pix load")
    print("[SeekDeep] InstructPix2Pix model loaded", flush=True)


@app.post("/instruct-pix2pix", dependencies=[Depends(require_gui_token)])
def instruct_pix2pix_endpoint(req: InstructPix2PixRequest):
    load_instruct_pix2pix()

    import torch

    source_img = open_image_b64(req.image_b64, mode="RGB")
    source_img = source_img.resize((512, 512), Image.LANCZOS)

    seed = req.seed
    generator = None
    if seed is not None:
        device = "cuda" if cuda_available() else "cpu"
        generator = torch.Generator(device=device).manual_seed(int(seed))

    args = {
        "prompt": req.instruction.strip(),
        "image": source_img,
        "num_inference_steps": max(1, min(50, int(req.steps))),
        "guidance_scale": float(req.guidance_scale),
        "image_guidance_scale": float(req.image_guidance_scale),
    }
    neg = req.negative_prompt.strip() or os.getenv("IMAGE_NEGATIVE_PROMPT", "").strip()
    if neg:
        args["negative_prompt"] = neg
    if generator is not None:
        args["generator"] = generator

    _apply_sdxl_prompt_cap(args, instruct_pix2pix_pipe)

    result = instruct_pix2pix_pipe(**args)
    img = result.images[0]

    img = img.resize((1024, 1024), Image.LANCZOS)

    ts = time.time_ns()  # nanosecond resolution defeats same-second filename collisions (AUD-015)
    safe_name = f"seekdeep_pix2pix_{ts}.png"
    out_path = _output_path(safe_name)
    img.save(out_path)

    return {
        "image_b64": image_to_b64_png(img),
        "instruction": req.instruction.strip(),
        "filename": safe_name,
        **_maybe_debug_path(out_path),
    }


# ---------- Inpainting endpoint (CLIPSeg auto-mask + SDXL inpaint) ----------

CLIPSEG_MODEL = os.getenv("LOCAL_CLIPSEG_MODEL_ID", "CIDAS/clipseg-rd64-refined")
clipseg_processor = None
clipseg_model = None


def load_clipseg() -> None:
    global clipseg_processor, clipseg_model
    if clipseg_model is not None:
        return
    print(f"[SeekDeep] loading CLIPSeg for auto-masking: {CLIPSEG_MODEL}", flush=True)
    from transformers import CLIPSegProcessor, CLIPSegForImageSegmentation
    clipseg_processor = CLIPSegProcessor.from_pretrained(
        CLIPSEG_MODEL,
        cache_dir=str(MODEL_CACHE_DIR),
        local_files_only=HF_LOCAL_FILES_ONLY,
    )
    clipseg_model = CLIPSegForImageSegmentation.from_pretrained(
        CLIPSEG_MODEL,
        cache_dir=str(MODEL_CACHE_DIR),
        local_files_only=HF_LOCAL_FILES_ONLY,
    )
    if cuda_available():
        clipseg_model = clipseg_model.to("cuda")
    print("[SeekDeep] CLIPSeg loaded", flush=True)


def generate_mask_clipseg(image: Image.Image, target: str) -> Image.Image:
    """Use CLIPSeg to generate a binary mask for `target` in `image`."""
    import torch
    import numpy as np
    from PIL import ImageFilter
    load_clipseg()
    inputs = clipseg_processor(
        text=[target], images=[image], return_tensors="pt", padding=True
    )
    if cuda_available():
        inputs = {k: v.to("cuda") if hasattr(v, "to") else v for k, v in inputs.items()}
    with torch.no_grad():
        outputs = clipseg_model(**inputs)
    logits = outputs.logits.squeeze()
    mask = torch.sigmoid(logits)
    mask = (mask > 0.3).float()
    mask_np = mask.cpu().numpy()
    mask_img = Image.fromarray((mask_np * 255).astype("uint8"), mode="L")
    mask_img = mask_img.resize(image.size, Image.LANCZOS)
    mask_img = mask_img.filter(ImageFilter.MaxFilter(21))
    mask_img = mask_img.filter(ImageFilter.GaussianBlur(radius=8))
    return mask_img


# ---------- High-fidelity auto-mask: GroundingDINO + SAM (opt-in) ----------
# Sharper alternative to CLIPSeg's 64x64 heatmap: GroundingDINO turns the text
# target into bounding boxes, SAM turns those boxes into pixel-precise masks.
# Both come from the transformers library (no custom CUDA extensions) via the
# same HF cache CLIPSeg uses.
#
# GUARDRAIL: combined ~3.2 GB, so unlike CLIPSeg these are NOT loaded blindly.
# generate_mask_sam() runs a VRAM budget check FIRST (_evict_for_budget →
# honors SEEKDEEP_VRAM_PRESSURE_MODE), loads mask-first + frees BEFORE SDXL,
# and on ANY failure (flag off, weights/deps missing, no CUDA, VRAM pressure,
# nothing detected, runtime error) returns None so the caller degrades to
# CLIPSeg → full mask. A jagged mask always beats an OOM. Default OFF.
# Model sources. The documented knobs are SEEKDEEP_SAM_MODEL_PATH /
# SEEKDEEP_GROUNDINGDINO_MODEL_PATH (an absolute path to a local model dir or a
# single weights file — from_pretrained accepts either). When unset we fall
# back to the HF repo ids (LOCAL_*_MODEL_ID), which auto-download on first use.
# Nothing is bundled, so with neither configured + offline the load fails and
# generate_mask_sam() degrades to CLIPSeg.
SAM_MODEL_PATH = (os.getenv("SEEKDEEP_SAM_MODEL_PATH") or "").strip()
GROUNDING_DINO_MODEL_PATH = (os.getenv("SEEKDEEP_GROUNDINGDINO_MODEL_PATH") or "").strip()
# Optional GroundingDINO config (e.g. a GroundingDINO_SwinB.cfg.py). Only some
# loaders need it; passed through to the loader when present.
GROUNDING_DINO_CONFIG_PATH = (os.getenv("SEEKDEEP_GROUNDINGDINO_CONFIG_PATH") or "").strip()
SAM_MODEL_ID = SAM_MODEL_PATH or os.getenv("LOCAL_SAM_MODEL_ID", "facebook/sam-vit-huge")
GROUNDING_DINO_MODEL_ID = GROUNDING_DINO_MODEL_PATH or os.getenv("LOCAL_GROUNDING_DINO_MODEL_ID", "IDEA-Research/grounding-dino-base")
SAM_BOX_THRESHOLD = float(os.getenv("SEEKDEEP_SAM_BOX_THRESHOLD", "0.25") or "0.25")
SAM_TEXT_THRESHOLD = float(os.getenv("SEEKDEEP_SAM_TEXT_THRESHOLD", "0.25") or "0.25")

sam_model = None
sam_processor = None
gdino_model = None
gdino_processor = None


def sam_segment_enabled() -> bool:
    return (os.getenv("SEEKDEEP_FEATURE_SAM_SEGMENT", "off") or "off").strip().lower() in {"1", "true", "yes", "on"}


def check_sam_available() -> tuple[bool, str]:
    """(ok, reason) — mirrors check_realesrgan_available(). Gates the high-
    fidelity mask path on: feature flag on, CUDA present (SAM on CPU is
    impractically slow), and the transformers SAM/GroundingDINO classes
    importable. Models come from SEEKDEEP_SAM_MODEL_PATH /
    SEEKDEEP_GROUNDINGDINO_MODEL_PATH when set, else the HF repo ids (download
    on first use when HF_LOCAL_FILES_ONLY is false). Nothing is bundled; if the
    weights are absent + offline the load fails and the caller falls back to
    CLIPSeg."""
    if not sam_segment_enabled():
        return False, "SAM segmentation flag (SEEKDEEP_FEATURE_SAM_SEGMENT) is not 'on'."
    if not cuda_available():
        return False, "SAM segmentation needs CUDA; CPU inference is impractically slow."
    try:
        from transformers import (  # noqa: F401
            SamModel, SamProcessor, GroundingDinoForObjectDetection, AutoProcessor,
        )
    except Exception as exc:
        return False, f"transformers SAM/GroundingDINO classes unavailable: {exc}"
    return True, ""


def _load_sam_models() -> None:
    """Budget-gated load of GroundingDINO + SAM (fp32 — avoids fp16 input/weight
    dtype mismatches; ~3.2 GB still fits the mask-first budget). Raises
    VRAMPressureError (mode=fallback) or a load error when it can't fit / isn't
    available, so generate_mask_sam can degrade to CLIPSeg."""
    global sam_model, sam_processor, gdino_model, gdino_processor
    if sam_model is not None and gdino_model is not None:
        return
    # Guardrail: make room (evict non-pinned, heaviest-first). In the default
    # 'fallback' pressure mode this RAISES VRAMPressureError when even after
    # eviction it won't fit — caught upstream → CLIPSeg.
    _evict_for_budget("sam_segment")
    from transformers import (
        SamModel, SamProcessor, GroundingDinoForObjectDetection, AutoProcessor,
    )
    device = "cuda" if cuda_available() else "cpu"
    print(f"[SeekDeep] loading GroundingDINO ({GROUNDING_DINO_MODEL_ID}) + SAM ({SAM_MODEL_ID}) for high-fidelity masks", flush=True)
    if gdino_model is None:
        # Optional explicit config (SEEKDEEP_GROUNDINGDINO_CONFIG_PATH). When set
        # we hand from_pretrained a parsed config so a bare-weights checkpoint
        # still loads; absent, from_pretrained reads the config from the repo /
        # model dir as usual.
        gdino_kwargs = dict(cache_dir=str(MODEL_CACHE_DIR), local_files_only=HF_LOCAL_FILES_ONLY)
        if GROUNDING_DINO_CONFIG_PATH:
            try:
                from transformers import AutoConfig
                gdino_kwargs["config"] = AutoConfig.from_pretrained(GROUNDING_DINO_CONFIG_PATH)
            except Exception as cfg_exc:
                print(f"[SeekDeep] GroundingDINO config {GROUNDING_DINO_CONFIG_PATH!r} ignored: {cfg_exc}", flush=True)
        gdino_processor = AutoProcessor.from_pretrained(
            GROUNDING_DINO_MODEL_ID, cache_dir=str(MODEL_CACHE_DIR), local_files_only=HF_LOCAL_FILES_ONLY)
        gdino_model = GroundingDinoForObjectDetection.from_pretrained(
            GROUNDING_DINO_MODEL_ID, **gdino_kwargs).to(device)
    if sam_model is None:
        sam_processor = SamProcessor.from_pretrained(
            SAM_MODEL_ID, cache_dir=str(MODEL_CACHE_DIR), local_files_only=HF_LOCAL_FILES_ONLY)
        sam_model = SamModel.from_pretrained(
            SAM_MODEL_ID, cache_dir=str(MODEL_CACHE_DIR), local_files_only=HF_LOCAL_FILES_ONLY).to(device)
    _log_vram("after SAM+GroundingDINO load")


def _unload_sam_models() -> None:
    """Free GroundingDINO + SAM and reclaim VRAM. Called right after the mask
    is produced so SDXL (the inpaint pipe) loads into a clean budget."""
    global sam_model, sam_processor, gdino_model, gdino_processor
    sam_model = None
    sam_processor = None
    gdino_model = None
    gdino_processor = None
    cleanup_cuda()


def generate_mask_sam(image: Image.Image, target: str):
    """High-fidelity binary mask for `target` via GroundingDINO → SAM. Returns
    a PIL 'L' image, or None to signal the caller should fall back to CLIPSeg
    (nothing detected / VRAM pressure / missing weights / any error). Always
    frees the heavy models before returning (mask-first design)."""
    import torch
    from PIL import ImageFilter
    try:
        _load_sam_models()
    except VRAMPressureError as exc:
        print(f"[SeekDeep] SAM mask skipped (VRAM pressure): {exc} → CLIPSeg fallback", flush=True)
        _unload_sam_models()
        return None
    except Exception as exc:
        print(f"[SeekDeep] SAM/GroundingDINO load failed: {exc} → CLIPSeg fallback", flush=True)
        _unload_sam_models()
        return None

    device = "cuda" if cuda_available() else "cpu"
    try:
        text = target.strip().lower()
        if not text.endswith("."):
            text += "."
        gd_inputs = gdino_processor(images=image, text=text, return_tensors="pt").to(device)
        with torch.no_grad():
            gd_out = gdino_model(**gd_inputs)
        # transformers 5.x: param is `threshold` (not `box_threshold`); returns
        # {scores, boxes (xyxy px), labels, text_labels}. target_sizes is (h, w).
        results = gdino_processor.post_process_grounded_object_detection(
            gd_out,
            input_ids=gd_inputs["input_ids"],
            threshold=SAM_BOX_THRESHOLD,
            text_threshold=SAM_TEXT_THRESHOLD,
            target_sizes=[image.size[::-1]],
        )[0]
        boxes = results.get("boxes")
        if boxes is None or len(boxes) == 0:
            print(f"[SeekDeep] GroundingDINO found nothing for {target!r} → CLIPSeg fallback", flush=True)
            return None
        input_boxes = [[[float(c) for c in box] for box in boxes.tolist()]]
        sam_inputs = sam_processor(image, input_boxes=input_boxes, return_tensors="pt").to(device)
        with torch.no_grad():
            sam_out = sam_model(**sam_inputs)
        masks = sam_processor.post_process_masks(
            sam_out.pred_masks.cpu(),
            sam_inputs["original_sizes"].cpu(),
            sam_inputs["reshaped_input_sizes"].cpu(),
        )[0]
        # Union every box's masks (SAM emits nested whole/part candidates).
        m = masks.float()
        while m.ndim > 2:
            m = m.sum(dim=0)
        union = ((m > 0).to(torch.uint8).numpy() * 255).astype("uint8")
        mask_img = Image.fromarray(union, mode="L").resize(image.size, Image.LANCZOS)
        # Light feathering, matching the CLIPSeg path's edge softening.
        mask_img = mask_img.filter(ImageFilter.MaxFilter(15)).filter(ImageFilter.GaussianBlur(radius=6))
        return mask_img
    except Exception as exc:
        print(f"[SeekDeep] SAM mask generation failed: {exc} → CLIPSeg fallback", flush=True)
        return None
    finally:
        _unload_sam_models()


def generate_mask(image: Image.Image, target: str) -> tuple[Image.Image, str]:
    """Auto-mask dispatcher with graceful fallback. Tries SAM (high-fidelity)
    when enabled + it fits; otherwise CLIPSeg. Returns (mask_image, backend)
    where backend ∈ {'sam','clipseg'}. MASK-FIRST by design — call this BEFORE
    load_image_pipe() so the detector isn't contending with SDXL for VRAM."""
    ok, _reason = check_sam_available()
    if ok:
        mask = generate_mask_sam(image, target)
        if mask is not None:
            return mask, "sam"
    return generate_mask_clipseg(image, target), "clipseg"


@app.post("/inpaint", dependencies=[Depends(require_gui_token)])
def inpaint_endpoint(req: InpaintRequest):
    import torch
    from diffusers import AutoPipelineForInpainting

    source_img = open_image_b64(req.image_b64, mode="RGB")

    width = int(req.width)
    height = int(req.height)
    if width % 8:
        width = width - (width % 8)
    if height % 8:
        height = height - (height % 8)
    source_img = source_img.resize((width, height), Image.LANCZOS)

    # MASK-FIRST: build the mask BEFORE loading SDXL so a heavy SAM detector
    # (when enabled) isn't resident at the same time as the diffusion pipe.
    # generate_mask() is VRAM-budget-gated and degrades sam → clipseg → full.
    remove_target = req.remove_target.strip()
    if remove_target:
        mask_img, mask_backend = generate_mask(source_img, remove_target)
    else:
        mask_img, mask_backend = Image.new("L", (width, height), 255), "full"

    load_image_pipe()
    inpaint_pipe = AutoPipelineForInpainting.from_pipe(image_pipe)

    seed = req.seed
    generator = None
    if seed is not None:
        device = "cuda" if cuda_available() else "cpu"
        generator = torch.Generator(device=device).manual_seed(int(seed))

    args = {
        "prompt": req.prompt.strip(),
        "image": source_img,
        "mask_image": mask_img,
        "strength": float(req.strength),
        "num_inference_steps": max(1, min(50, int(req.steps))),
        "guidance_scale": float(req.guidance_scale),
    }
    if req.negative_prompt.strip():
        args["negative_prompt"] = req.negative_prompt.strip()
    if generator is not None:
        args["generator"] = generator

    _apply_sdxl_prompt_cap(args, inpaint_pipe)

    result = inpaint_pipe(**args)
    img = result.images[0]

    ts = time.time_ns()  # nanosecond resolution defeats same-second filename collisions (AUD-015)
    safe_name = f"seekdeep_inpaint_{ts}.png"
    out_path = _output_path(safe_name)
    img.save(out_path)

    return {
        "image_b64": image_to_b64_png(img),
        "prompt": req.prompt.strip(),
        "remove_target": remove_target,
        "mask_backend": mask_backend,
        "filename": safe_name,
        **_maybe_debug_path(out_path),
        "strength": float(req.strength),
    }


@app.post("/inpaint_mask_preview", dependencies=[Depends(require_gui_token)])
def inpaint_mask_preview_endpoint(req: InpaintMaskPreviewRequest):
    """
    Generate and return only the CLIPSeg mask preview.
    Does not run diffusion inpainting.
    """
    try:
        source_bytes = b64_to_bytes(req.image_b64)
        source_img = open_image_bytes(source_bytes, mode="RGB", label="mask preview image")
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(status_code=400, detail=f"Invalid image/payload: {exc}")

    width = int(req.width)
    height = int(req.height)
    if width % 8:
        width = width - (width % 8)
    if height % 8:
        height = height - (height % 8)
    source_img = source_img.resize((width, height), Image.LANCZOS)

    remove_target = req.remove_target.strip()
    if not remove_target:
        raise HTTPException(status_code=400, detail="remove_target must not be empty for mask preview.")

    try:
        # Same SAM→CLIPSeg dispatcher as /inpaint so the preview matches what
        # the real run will use; degrades gracefully, never OOMs.
        mask_img, mask_backend = generate_mask(source_img, remove_target)
    except Exception as exc:
        raise HTTPException(
            status_code=500,
            detail=f"Mask model/dependencies are unavailable: {exc}"
        )

    ts = time.time_ns()  # nanosecond resolution defeats same-second filename collisions (AUD-015)
    safe_name = f"seekdeep_mask_preview_{ts}.png"
    out_path = _output_path(safe_name)
    mask_img.save(out_path)

    return {
        "image_b64": image_to_b64_png(mask_img),
        "remove_target": remove_target,
        "mask_backend": mask_backend,
        "filename": safe_name,
        **_maybe_debug_path(out_path),
    }


# ---------- chart: render server-stats dayBuckets as a PNG ----------

class ChartRequest(BaseModel):
    """Accepts dayBuckets from the Node bot's server-stats.json and renders
    a 30-day activity chart.  No AI model needed — pure matplotlib."""
    day_buckets: dict = Field(..., description="{ 'YYYY-MM-DD': { images, chats, vision } }")
    title: str = Field("SeekDeep — 30-Day Activity", description="Chart title")
    guild_name: str = Field("", description="Optional server name for subtitle")


class TTSRequest(BaseModel):
    """Text-to-speech request. `voice`/`engine` override the configured defaults
    (echoed back in the response); `rate` is a speed multiplier (>1.0 = faster).
    Length is validated in the route (the documented 400) so an oversized
    paragraph is rejected before any synthesis runs."""
    text: str = Field(...)
    voice: str = Field("", max_length=256)
    engine: str = Field("", max_length=32)
    rate: float = Field(1.0, ge=0.1, le=4.0)


@app.post("/chart", dependencies=[Depends(require_gui_token)])
def chart(req: ChartRequest):
    """Render a line chart of daily images / chats / vision counts."""
    try:
        import matplotlib
        matplotlib.use("Agg")  # headless backend
        import matplotlib.pyplot as plt
        import matplotlib.dates as mdates
        from datetime import datetime
    except ImportError:
        return JSONResponse(
            status_code=501,
            content={"error": "matplotlib is not installed.  pip install matplotlib"},
        )

    buckets = req.day_buckets or {}
    if not buckets:
        return JSONResponse(status_code=400, content={"error": "No day_buckets data."})
    # PYS-5: bound the render. A stats chart only needs ~30-90 daily points;
    # refuse a payload that would pin matplotlib. (Label strings clamped below.)
    if len(buckets) > 400:
        return JSONResponse(status_code=400, content={"error": "too many day_buckets (max 400)"})

    # Sort dates and fill gaps with zeros so the chart is contiguous.
    sorted_dates = sorted(buckets.keys())
    date_objs = [datetime.strptime(d, "%Y-%m-%d") for d in sorted_dates]
    images = [buckets[d].get("images", 0) for d in sorted_dates]
    chats  = [buckets[d].get("chats", 0) for d in sorted_dates]
    vision = [buckets[d].get("vision", 0) for d in sorted_dates]

    fig, ax = plt.subplots(figsize=(10, 4), dpi=120)
    fig.patch.set_facecolor("#2b2d31")  # Discord dark theme background
    ax.set_facecolor("#2b2d31")

    ax.fill_between(date_objs, images, alpha=0.25, color="#5865F2")
    ax.fill_between(date_objs, chats,  alpha=0.25, color="#57F287")
    ax.fill_between(date_objs, vision, alpha=0.25, color="#FEE75C")

    ax.plot(date_objs, images, color="#5865F2", linewidth=2, label=f"Images ({sum(images)})")
    ax.plot(date_objs, chats,  color="#57F287", linewidth=2, label=f"Chats ({sum(chats)})")
    ax.plot(date_objs, vision, color="#FEE75C", linewidth=2, label=f"Vision ({sum(vision)})")

    ax.xaxis.set_major_formatter(mdates.DateFormatter("%b %d"))
    ax.xaxis.set_major_locator(mdates.AutoDateLocator(minticks=4, maxticks=10))
    fig.autofmt_xdate(rotation=30, ha="right")

    ax.tick_params(colors="#dcddde")
    ax.spines["top"].set_visible(False)
    ax.spines["right"].set_visible(False)
    ax.spines["left"].set_color("#40444b")
    ax.spines["bottom"].set_color("#40444b")
    ax.yaxis.label.set_color("#dcddde")
    ax.xaxis.label.set_color("#dcddde")

    # PYS-5: clamp caller-supplied label strings so an oversized title/guild
    # name can't bloat the render.
    title = str(req.title or "")[:200]
    if req.guild_name:
        title += f"  •  {str(req.guild_name)[:120]}"
    ax.set_title(title, color="#ffffff", fontsize=13, pad=10)
    ax.legend(loc="upper left", facecolor="#36393f", edgecolor="#40444b",
              labelcolor="#dcddde", fontsize=9)
    ax.grid(axis="y", color="#40444b", linewidth=0.5, alpha=0.5)

    buf = io.BytesIO()
    fig.savefig(buf, format="png", bbox_inches="tight", facecolor=fig.get_facecolor())
    plt.close(fig)
    buf.seek(0)
    img_b64 = base64.b64encode(buf.read()).decode("utf-8")

    return {"image_b64": img_b64, "filename": "seekdeep_stats_chart.png"}


# ---------- tts: synthesize speech from text -> base64 WAV ----------

@app.post("/tts", dependencies=[Depends(require_gui_token)])
def tts(req: TTSRequest):
    """Synthesize speech for `req.text` and return a base64-encoded WAV.

    Status contract (mirrors /chart's JSONResponse error shaping):
      200 -> {ok:true, audio_b64, format:'wav', sample_rate, engine, voice}
      400 -> empty text, or text longer than SEEKDEEP_TTS_MAX_CHARS
      503 -> no voice/model configured (detail: 'tts-not-configured')
      501 -> chosen engine's package/binary unavailable (detail: 'tts-deps-missing')
      500 -> any other synthesis failure (short message)

    The token gate (Depends(require_gui_token)) fires before this body runs, so
    an unauthenticated call is 401 and never reaches synthesis. NO model is
    bundled, so on a stock checkout this returns 503 until SEEKDEEP_TTS_PIPER_VOICE
    (or SEEKDEEP_TTS_MODEL_ID for XTTS) is set.
    """
    text = (req.text or "").strip()
    if not text:
        return JSONResponse(status_code=400, content={"ok": False, "error": "text is required."})
    if len(text) > SEEKDEEP_TTS_MAX_CHARS:
        return JSONResponse(
            status_code=400,
            content={"ok": False, "error": f"text too long (max {SEEKDEEP_TTS_MAX_CHARS} chars)."},
        )

    # Deterministic 'not configured' gate BEFORE we try to import/load anything.
    if not _tts_voice_configured():
        return JSONResponse(
            status_code=503,
            content={
                "ok": False,
                "error": "No TTS voice/model configured. Set SEEKDEEP_TTS_PIPER_VOICE (Piper) or SEEKDEEP_TTS_MODEL_ID (XTTS).",
                "detail": "tts-not-configured",
            },
        )

    try:
        wav_bytes, sample_rate = synthesize_tts(text, voice=req.voice, rate=req.rate)
    except TTSNotConfigured:
        # Defensive: the gate above should have caught this, but a racing env
        # change could land here. Static message (no exc string in the body) so
        # we don't leak internals via the error text.
        return JSONResponse(
            status_code=503,
            content={"ok": False,
                     "error": "No TTS voice/model configured. Set SEEKDEEP_TTS_PIPER_VOICE (Piper) or SEEKDEEP_TTS_MODEL_ID (XTTS).",
                     "detail": "tts-not-configured"},
        )
    except TTSDepsMissing:
        return JSONResponse(
            status_code=501,
            content={"ok": False, "error": "TTS engine not installed (pip install piper-tts).",
                     "detail": "tts-deps-missing"},
        )
    except Exception as exc:  # noqa: BLE001 — log the full trace, return a static body
        print(f"[SeekDeep Local AI] /tts synthesis error: {exc}")
        traceback.print_exc()
        return JSONResponse(
            status_code=500,
            content={"ok": False, "error": "TTS synthesis failed."},
        )

    return {
        "ok": True,
        "audio_b64": base64.b64encode(wav_bytes).decode("ascii"),
        "format": "wav",
        "sample_rate": int(sample_rate),
        "engine": SEEKDEEP_TTS_ENGINE,
        "voice": req.voice or _tts_configured_voice() or "",
    }


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="127.0.0.1", port=7865)
