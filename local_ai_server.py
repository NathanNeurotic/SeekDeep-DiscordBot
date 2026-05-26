from __future__ import annotations

import base64
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
MODEL_CACHE_DIR = Path(os.getenv("LOCAL_MODEL_CACHE_DIR", "./models/huggingface"))
if not MODEL_CACHE_DIR.is_absolute():
    MODEL_CACHE_DIR = ROOT / MODEL_CACHE_DIR
MODEL_CACHE_DIR.mkdir(parents=True, exist_ok=True)

OUTPUT_DIR = ROOT / "outputs"
OUTPUT_DIR.mkdir(exist_ok=True)
TEMP_DIR = ROOT / "temp"
TEMP_DIR.mkdir(exist_ok=True)

CHAT_MODEL_ID = os.getenv("LOCAL_CHAT_MODEL_ID", "meta-llama/Llama-3.1-8B-Instruct")
VISION_MODEL_ID = os.getenv("LOCAL_VISION_MODEL_ID", "Qwen/Qwen2.5-VL-3B-Instruct")
IMAGE_MODEL_ID = os.getenv("LOCAL_IMAGE_MODEL_ID", "Lykon/dreamshaper-xl-1-0")

HF_TOKEN = os.getenv("HF_TOKEN") or os.getenv("HUGGINGFACE_TOKEN") or None
HF_LOCAL_FILES_ONLY = os.getenv("HF_LOCAL_FILES_ONLY", "false").lower() in {"1", "true", "yes", "on"}
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

app = FastAPI(title="SeekDeep Local AI Server", version=SEEKDEEP_VERSION)

# ===== SeekDeep GUI · static mount =====
from fastapi.staticfiles import StaticFiles
_GUI_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "gui")
if os.path.isdir(_GUI_DIR):
    app.mount("/gui", StaticFiles(directory=_GUI_DIR, html=True), name="gui")
    print(f"[SeekDeep] GUI mounted at /gui  ->  {_GUI_DIR}")

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
    )
except Exception as _gui_err:
    print(f"[SeekDeep] gui_endpoints not registered: {_gui_err}")
    async def require_gui_token(request=None): return None  # no-op fallback
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
    """
    stats: dict = {
        "available": False,
        "device_name": device_name(),
        "loaded_task": loaded_task,
        "loaded_chat_role": loaded_chat_role,
        "loaded_chat_model_id": loaded_chat_model_id,
    }
    try:
        import torch
        if not torch.cuda.is_available():
            return stats
        stats["available"] = True
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
    except Exception as exc:
        stats["error"] = str(exc)
    return stats


def move_inputs(value: Any, device: Any) -> Any:
    try:
        if hasattr(value, "to"):
            return value.to(device)
    except Exception:
        pass

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


def ollama_available() -> bool:
    """Cheap probe of the Ollama daemon. True if /api/tags responds within OLLAMA_PROBE_TIMEOUT_SECS."""
    try:
        _ollama_request("/api/tags", method="GET", timeout=OLLAMA_PROBE_TIMEOUT_SECS)
        return True
    except Exception:
        return False


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


def b64_to_bytes(data: str) -> bytes:
    if "," in data and data.strip().startswith("data:"):
        data = data.split(",", 1)[1]
    return base64.b64decode(data)


def image_to_b64_png(img: Image.Image) -> str:
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    return base64.b64encode(buf.getvalue()).decode("ascii")


chat_model = None
chat_tokenizer = None
vision_model = None
vision_processor = None
vision_tokenizer = None
image_pipe = None
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

class ChatMessage(BaseModel):
    role: str
    content: str


class ChatRequest(BaseModel):
    prompt: str
    system: str = ""
    context: str = ""
    messages: list[ChatMessage] = Field(default_factory=list)
    max_new_tokens: int = Field(default=700, ge=32, le=4096)
    temperature: float = Field(default=0.35, ge=0.0, le=2.0)
    role: str = "default_chat"


class ImageRequest(BaseModel):
    prompt: str
    width: int = Field(default=1024, ge=256, le=1536)
    height: int = Field(default=1024, ge=256, le=1536)
    steps: int = Field(default=28, ge=1, le=50)
    guidance_scale: float = Field(default=5.0, ge=0.0, le=20.0)
    seed: Optional[int] = None
    negative_prompt: str = ""


class VisionRequest(BaseModel):
    prompt: str = "Describe this media clearly."
    media_b64: str
    filename: str = "upload.png"
    media_kind: Literal["auto", "image", "video"] = "auto"
    max_new_tokens: int = Field(default=700, ge=32, le=2048)
    temperature: float = Field(default=0.0, ge=0.0, le=2.0)


class Img2ImgRequest(BaseModel):
    prompt: str
    image_b64: str
    strength: float = Field(default=0.6, ge=0.05, le=1.0)
    width: int = Field(default=1024, ge=256, le=1536)
    height: int = Field(default=1024, ge=256, le=1536)
    steps: int = Field(default=28, ge=1, le=50)
    guidance_scale: float = Field(default=5.0, ge=0.0, le=20.0)
    seed: Optional[int] = None
    negative_prompt: str = ""


class InpaintRequest(BaseModel):
    prompt: str
    remove_target: str = ""
    image_b64: str
    strength: float = Field(default=0.85, ge=0.1, le=1.0)
    width: int = Field(default=1024, ge=256, le=1536)
    height: int = Field(default=1024, ge=256, le=1536)
    steps: int = Field(default=28, ge=1, le=50)
    guidance_scale: float = Field(default=5.0, ge=0.0, le=20.0)
    seed: Optional[int] = None
    negative_prompt: str = ""


class InpaintMaskPreviewRequest(BaseModel):
    image_b64: str
    remove_target: str = ""
    width: int = Field(default=1024, ge=256, le=1536)
    height: int = Field(default=1024, ge=256, le=1536)


class InstructPix2PixRequest(BaseModel):
    instruction: str
    image_b64: str
    steps: int = Field(default=30, ge=1, le=50)
    guidance_scale: float = Field(default=9.0, ge=0.0, le=20.0)
    image_guidance_scale: float = Field(default=1.0, ge=0.1, le=5.0)
    seed: Optional[int] = None
    negative_prompt: str = ""


class UpscaleRequest(BaseModel):
    image_b64: str
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
_SEEKDEEP_LOCKED_PATHS = {"/chat", "/vision", "/image", "/img2img", "/instruct-pix2pix", "/inpaint", "/inpaint_mask_preview", "/upscale", "/unload"}

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


@app.get("/health")
def health():
    # Snapshot Ollama state so the GUI can show daemon status + per-role
    # backend badges. Probe is cheap (~2s timeout) but cached at request
    # time -- /health isn't hit often enough to need finer caching.
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
        "vram_budget": {
            "system_reserve_mb": VRAM_SYSTEM_RESERVE_MB,
            "safety_margin_mb": VRAM_SAFETY_MARGIN_MB,
            "available_for_models_mb": round(vram_budget_available_mb(), 0),
        },
        "cache_dir": str(MODEL_CACHE_DIR),
        "offline_model_loading": HF_LOCAL_FILES_ONLY,
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


def _hf_install(model_id: str, revision: str = "") -> dict:
    """Download an HF repo to LOCAL_MODEL_CACHE_DIR (or HF_HOME). Uses
    huggingface_hub.snapshot_download so partial downloads resume cleanly.
    Returns {ok, model_id, local_dir, files_downloaded}."""
    try:
        from huggingface_hub import snapshot_download
    except ImportError:
        return {"ok": False, "error": "huggingface_hub not installed"}
    try:
        cache_dir = os.getenv("LOCAL_MODEL_CACHE_DIR", "").strip() or None
        kw = {"repo_id": model_id, "cache_dir": cache_dir} if cache_dir else {"repo_id": model_id}
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
    try:
        cache_dir = os.getenv("LOCAL_MODEL_CACHE_DIR", "").strip() or None
        try:
            info = scan_cache_dir(cache_dir=cache_dir) if cache_dir else scan_cache_dir()
        except CacheNotFound:
            return {"ok": True, "model_id": model_id, "freed_bytes": 0,
                    "note": "not in HF cache (cache directory not found)"}
        # Find the repo (handles 'meta-llama/Llama-3.1-8B-Instruct' shape)
        repo_info = next((r for r in info.repos if r.repo_id == model_id), None)
        if not repo_info:
            return {"ok": True, "model_id": model_id, "freed_bytes": 0,
                    "note": "not in HF cache (already absent)"}
        # Collect every revision's hash and delete them
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
    role = (req.role or "").strip().lower()
    if role:
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
def gpu_endpoint():
    """Focused GPU stats endpoint. Lighter than /health; safe to poll
    every few seconds for live-tail monitoring without spam."""
    stats = gpu_stats()
    stats["vram_budget"] = {
        "system_reserve_mb": VRAM_SYSTEM_RESERVE_MB,
        "safety_margin_mb": VRAM_SAFETY_MARGIN_MB,
        "available_for_models_mb": round(vram_budget_available_mb(), 0),
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

    tokenizer_kwargs = {
        "cache_dir": str(MODEL_CACHE_DIR),
        "trust_remote_code": True,
        "token": HF_TOKEN,
        "local_files_only": HF_LOCAL_FILES_ONLY,
    }

    chat_tokenizer = AutoTokenizer.from_pretrained(model_id, **tokenizer_kwargs)

    model_kwargs = dict(tokenizer_kwargs)
    if quant_config is not None and cuda_available():
        # bitsandbytes places weights itself; device_map='auto' is required.
        model_kwargs["quantization_config"] = quant_config
        model_kwargs["device_map"] = "auto"
    else:
        model_kwargs["torch_dtype"] = model_dtype()
        model_kwargs["device_map"] = None
        model_kwargs["low_cpu_mem_usage"] = True

    chat_model = AutoModelForCausalLM.from_pretrained(model_id, **model_kwargs)

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

    inputs = chat_tokenizer(text, return_tensors="pt")
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


@app.post("/chat")
def chat(req: ChatRequest):
    requested_role = (req.role or "default_chat").strip().lower() or "default_chat"
    n_msgs = len(req.messages) if req.messages else 0
    print(f"[SeekDeep Local AI] /chat entry role={requested_role} msgs={n_msgs} prompt={req.prompt[:120]!r}", flush=True)

    try:
        answer, resolved_role, model_id = _run_chat_generation(req, requested_role)
        return {
            "text": answer or "(empty response)",
            "model_role": resolved_role,
            "model_id": model_id,
        }
    except Exception as exc:
        reason = _classify_chat_load_failure(exc)
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
                    return {
                        "text": answer or "(empty response)",
                        "model_role": resolved_role,
                        "model_id": model_id,
                        "fallback_used": True,
                        "fallback_reason": reason,
                        "failed_model_id": failed_model_id,
                    }
                except Exception as fb_exc:
                    fb_reason = _classify_chat_load_failure(fb_exc)
                    print(f"[SeekDeep Local AI] fallback chat also failed reason={fb_reason}: {fb_exc!r}", flush=True)
                    traceback.print_exc()

        clean_msg = f"Chat model failed ({reason}). Check the local AI server log for details."
        return JSONResponse(status_code=503, content={"error": clean_msg, "reason": reason})


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
    ext = Path(filename).suffix.lower()
    is_video = media_kind == "video" or (media_kind == "auto" and ext in {".mp4", ".mov", ".webm", ".mkv", ".avi", ".gif"})

    if not is_video:
        img = Image.open(io.BytesIO(media_bytes)).convert("RGB")
        return [img], "image"

    # Video path: sample up to 8 frames.
    try:
        import imageio.v3 as iio
        tmp = TEMP_DIR / f"vision_{int(time.time() * 1000)}{ext or '.mp4'}"
        tmp.write_bytes(media_bytes)
        frames = []
        for idx, frame in enumerate(iio.imiter(tmp)):
            if idx % 15 == 0:
                frames.append(Image.fromarray(frame).convert("RGB"))
            if len(frames) >= 8:
                break
        try:
            tmp.unlink(missing_ok=True)
        except Exception:
            pass
        if not frames:
            raise RuntimeError("No frames could be decoded from video.")
        return frames, "video"
    except Exception as exc:
        raise RuntimeError(f"Could not decode video. Try a PNG/JPG first, or install imageio-ffmpeg. Details: {exc}")


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


@app.post("/vision")
def vision(req: VisionRequest):
    media_bytes = b64_to_bytes(req.media_b64)
    frames, actual_kind = load_media_frames(media_bytes, req.filename, req.media_kind)
    answer = generate_vision_answer(req.prompt, frames, actual_kind, req.max_new_tokens, req.temperature)
    return {"text": answer, "frames_used": len(frames), "media_kind": actual_kind}


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


@app.post("/image")
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

    ts = int(time.time())
    safe_name = f"seekdeep_image_{ts}.png"
    out_path = OUTPUT_DIR / safe_name
    img.save(out_path)

    return {
        "image_b64": image_to_b64_png(img),
        "original_prompt": req.prompt.strip(),
        "refined_prompt": final_prompt_for_response,
        "filename": safe_name,
        "path": str(out_path),
        "forced_steps": int(args.get("num_inference_steps", requested_steps)),
        "seed": seed,
    }


@app.post("/img2img")
def img2img(req: Img2ImgRequest):
    load_image_pipe()

    import torch
    from diffusers import AutoPipelineForImage2Image

    # Create an img2img pipeline sharing the same model components — no extra
    # VRAM.  AutoPipelineForImage2Image.from_pipe() is the modern diffusers way
    # to reuse loaded weights for a different pipeline type.
    i2i_pipe = AutoPipelineForImage2Image.from_pipe(image_pipe)

    # Decode the source image
    source_bytes = b64_to_bytes(req.image_b64)
    source_img = Image.open(io.BytesIO(source_bytes)).convert("RGB")

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

    ts = int(time.time())
    safe_name = f"seekdeep_img2img_{ts}.png"
    out_path = OUTPUT_DIR / safe_name
    img.save(out_path)

    return {
        "image_b64": image_to_b64_png(img),
        "original_prompt": req.prompt.strip(),
        "filename": safe_name,
        "path": str(out_path),
        "strength": float(req.strength),
        "seed": seed,
    }
def check_realesrgan_available() -> tuple[bool, str]:
    """
    Checks if Real-ESRGAN dependencies and models are available.
    Returns (is_available, error_message).
    """
    if os.getenv("SEEKDEEP_FEATURE_UPSCALE_REALESRGAN") != "on":
        return False, "Real-ESRGAN feature flag (SEEKDEEP_FEATURE_UPSCALE_REALESRGAN) is not 'on'."
    try:
        import torch
        from basicsr.archs.rrdbnet_arch import RRDBNet
        from realesrgan import RealESRGANer
    except ImportError as e:
        return False, f"Missing Python dependency for Real-ESRGAN: {e}"

    realesrgan_dir = MODEL_CACHE_DIR / "realesrgan"
    if not realesrgan_dir.exists():
        return False, f"Real-ESRGAN model directory not found at {realesrgan_dir}"
    
    pth_files = list(realesrgan_dir.glob("*.pth"))
    if not pth_files:
        return False, f"No Real-ESRGAN model weights (.pth) found in {realesrgan_dir}"
        
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


@app.post("/upscale")
def upscale(req: UpscaleRequest):
    """Upscale an image. 'lanczos' is a zero-model PIL fallback that works
    immediately. 'realesrgan' requires the model to be downloaded separately."""
    try:
        source_bytes = b64_to_bytes(req.image_b64)
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=400, detail=f"Invalid base64 image payload: {exc}") from exc

    try:
        opened_img = Image.open(io.BytesIO(source_bytes))
        opened_img.load()
    except UnidentifiedImageError as exc:
        raise HTTPException(status_code=400, detail="Unsupported or unrecognized image format.") from exc
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
        ts = int(time.time())
        safe_name = f"seekdeep_upscale_{ts}{selected['ext']}"
        out_path = OUTPUT_DIR / safe_name
        out_path.write_bytes(selected["bytes"])
        result = {
            "image_b64": base64.b64encode(selected["bytes"]).decode("ascii"),
            "png_b64": base64.b64encode(png_bytes).decode("ascii"),
            "filename": safe_name,
            "path": str(out_path),
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
            return JSONResponse(
                status_code=400,
                content={
                    "ok": False,
                    "method": "realesrgan",
                    "error": "Real-ESRGAN is enabled but dependencies/model are missing..."
                }
            )
        try:
            import numpy as np
            from basicsr.archs.rrdbnet_arch import RRDBNet
            from realesrgan import RealESRGANer

            realesrgan_dir = MODEL_CACHE_DIR / "realesrgan"
            pth_files = list(realesrgan_dir.glob("*.pth"))
            model_path = None
            for p in pth_files:
                if f"x{scale}" in p.name.lower():
                    model_path = p
                    break
            if not model_path:
                model_path = pth_files[0]

            num_block = 23
            if "anime" in model_path.name.lower():
                num_block = 6

            model_scale = 4
            if "x2" in model_path.name.lower():
                model_scale = 2
            elif "x3" in model_path.name.lower():
                model_scale = 3
            elif "x4" in model_path.name.lower():
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

            img_np = np.array(source_img)
            if source_img.mode == "RGBA":
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
            ts = int(time.time())
            safe_name = f"seekdeep_upscale_{ts}{selected['ext']}"
            out_path = OUTPUT_DIR / safe_name
            out_path.write_bytes(selected["bytes"])
            return {
                "image_b64": base64.b64encode(selected["bytes"]).decode("ascii"),
                "png_b64": base64.b64encode(png_bytes).decode("ascii"),
                "filename": safe_name,
                "path": str(out_path),
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
            return JSONResponse(
                status_code=400,
                content={
                    "ok": False,
                    "method": "realesrgan",
                    "error": f"Real-ESRGAN is enabled but dependencies/model are missing: Failed to execute: {exc}"
                }
            )

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


@app.post("/instruct-pix2pix")
def instruct_pix2pix_endpoint(req: InstructPix2PixRequest):
    load_instruct_pix2pix()

    import torch

    source_bytes = b64_to_bytes(req.image_b64)
    source_img = Image.open(io.BytesIO(source_bytes)).convert("RGB")
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

    ts = int(time.time())
    safe_name = f"seekdeep_pix2pix_{ts}.png"
    out_path = OUTPUT_DIR / safe_name
    img.save(out_path)

    return {
        "image_b64": image_to_b64_png(img),
        "instruction": req.instruction.strip(),
        "filename": safe_name,
        "path": str(out_path),
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


@app.post("/inpaint")
def inpaint_endpoint(req: InpaintRequest):
    load_image_pipe()

    import torch
    from diffusers import AutoPipelineForInpainting

    source_bytes = b64_to_bytes(req.image_b64)
    source_img = Image.open(io.BytesIO(source_bytes)).convert("RGB")

    width = int(req.width)
    height = int(req.height)
    if width % 8:
        width = width - (width % 8)
    if height % 8:
        height = height - (height % 8)
    source_img = source_img.resize((width, height), Image.LANCZOS)

    remove_target = req.remove_target.strip()
    if remove_target:
        mask_img = generate_mask_clipseg(source_img, remove_target)
    else:
        mask_img = Image.new("L", (width, height), 255)

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

    ts = int(time.time())
    safe_name = f"seekdeep_inpaint_{ts}.png"
    out_path = OUTPUT_DIR / safe_name
    img.save(out_path)

    return {
        "image_b64": image_to_b64_png(img),
        "prompt": req.prompt.strip(),
        "remove_target": remove_target,
        "filename": safe_name,
        "path": str(out_path),
        "strength": float(req.strength),
    }


@app.post("/inpaint_mask_preview")
def inpaint_mask_preview_endpoint(req: InpaintMaskPreviewRequest):
    """
    Generate and return only the CLIPSeg mask preview.
    Does not run diffusion inpainting.
    """
    try:
        source_bytes = b64_to_bytes(req.image_b64)
        source_img = Image.open(io.BytesIO(source_bytes)).convert("RGB")
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
        mask_img = generate_mask_clipseg(source_img, remove_target)
    except Exception as exc:
        raise HTTPException(
            status_code=500,
            detail=f"CLIPSeg model/dependencies are unavailable: {exc}"
        )

    ts = int(time.time())
    safe_name = f"seekdeep_mask_preview_{ts}.png"
    out_path = OUTPUT_DIR / safe_name
    mask_img.save(out_path)

    return {
        "image_b64": image_to_b64_png(mask_img),
        "remove_target": remove_target,
        "filename": safe_name,
        "path": str(out_path),
    }


# ---------- chart: render server-stats dayBuckets as a PNG ----------

class ChartRequest(BaseModel):
    """Accepts dayBuckets from the Node bot's server-stats.json and renders
    a 30-day activity chart.  No AI model needed — pure matplotlib."""
    day_buckets: dict = Field(..., description="{ 'YYYY-MM-DD': { images, chats, vision } }")
    title: str = Field("SeekDeep — 30-Day Activity", description="Chart title")
    guild_name: str = Field("", description="Optional server name for subtitle")


@app.post("/chart")
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

    title = req.title
    if req.guild_name:
        title += f"  •  {req.guild_name}"
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


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="127.0.0.1", port=7865)
