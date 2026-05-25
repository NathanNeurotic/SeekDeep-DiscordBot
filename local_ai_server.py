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

from dotenv import load_dotenv
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
    """VRAM available for models after subtracting system reserve + safety margin.

    This is the headroom the model loader should work within.  It accounts for
    Windows desktop overhead, background apps, and inference temporaries.
    """
    if not cuda_available():
        return 0
    try:
        import torch
        free, total = torch.cuda.mem_get_info()
        total_mb = total / (1024 ** 2)
        used_mb = (total - free) / (1024 ** 2)
        # What PyTorch has reserved (includes loaded models + caching pool)
        reserved_mb = torch.cuda.memory_reserved() / (1024 ** 2)
        # Non-PyTorch VRAM usage (Windows, Discord, etc.)
        system_used_mb = used_mb - reserved_mb
        # Budget = total - system_reserve - safety - what PyTorch already holds
        budget = total_mb - VRAM_SYSTEM_RESERVE_MB - VRAM_SAFETY_MARGIN_MB - reserved_mb
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
            "chat":   lambda role: load_chat_model(role),
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


def _evict_for_budget(task: str, role: str = "") -> None:
    """If the incoming model won't fit in the VRAM budget, evict non-pinned
    models (heaviest first) until it does.  Pinned models are never evicted.
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
    evictable: list[tuple[str, int]] = []
    if not KEEP_RESIDENT_IMAGE and image_pipe is not None:
        evictable.append(("image", estimate_model_vram("image")))
    if not KEEP_RESIDENT_VISION and vision_model is not None:
        evictable.append(("vision", estimate_model_vram("vision")))
    if not KEEP_RESIDENT_CHAT and chat_model is not None:
        evictable.append(("chat", estimate_model_vram("chat", loaded_chat_role or "default_chat")))
    evictable.sort(key=lambda x: x[1], reverse=True)

    for name, est_mb in evictable:
        if name == "image":
            image_pipe = None
        elif name == "vision":
            vision_model = None
            vision_processor = None
            vision_tokenizer = None
        elif name == "chat":
            unload_chat_model()
        print(f"[SeekDeep VRAM] evicted {name} (~{est_mb}MB)", flush=True)
        cleanup_cuda()
        fits, available, estimated = vram_can_fit(task, role)
        if fits:
            print(f"[SeekDeep VRAM] budget OK after eviction: {available:.0f}MB free for ~{estimated}MB model", flush=True)
            return
    # If we get here, even after evicting everything we might be tight.
    # Log a warning but let the load attempt proceed — PyTorch may still
    # manage via its caching pool.
    print(
        f"[SeekDeep VRAM] WARNING: after all evictions only {available:.0f}MB free "
        f"for ~{estimated}MB model — load may spill into shared memory",
        flush=True,
    )


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
    # different chat role within the same task needs more VRAM.
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
    return {
        "status": "ready",
        "version": SEEKDEEP_VERSION,
        "device": device_name(),
        "cuda_available": cuda_available(),
        "loaded_task": loaded_task,
        "loaded_chat_role": loaded_chat_role,
        "loaded_chat_model_id": loaded_chat_model_id,
        "chat_roles": chat_role_map(),
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


@app.post("/warmup/chat", dependencies=[Depends(require_gui_token)])
def warmup_chat_endpoint():
    try:
        role, model_id = load_chat_model("default_chat")
        return {"ok": True, "status": "warmed_up", "task": "chat", "role": role, "model_id": model_id}
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

    # A different chat model is loaded; unload it before bringing in the new one.
    if chat_model is not None or chat_tokenizer is not None:
        unload_chat_model()

    prepare_task("chat", resolved_role)
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


def _classify_chat_load_failure(exc: Exception) -> str:
    """Return a short, log-friendly reason string for known recoverable failures."""
    name = type(exc).__name__
    msg = str(exc).lower()
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


def _run_chat_generation(req: ChatRequest, role: str) -> tuple[str, str, str]:
    """Load a chat role and run a single generation. Returns (text, resolved_role, model_id)."""
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
