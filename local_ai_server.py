from __future__ import annotations

import base64
import gc
import io
import json
import os
import re
import tempfile
import time
import traceback
from pathlib import Path
from typing import Any, Literal, Optional

from dotenv import load_dotenv
from fastapi import FastAPI
from fastapi.responses import JSONResponse
from PIL import Image
from pydantic import BaseModel, Field

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

CHAT_MODEL_ID = os.getenv("LOCAL_CHAT_MODEL_ID", "Qwen/Qwen3-8B")
VISION_MODEL_ID = os.getenv("LOCAL_VISION_MODEL_ID", "Qwen/Qwen2.5-VL-3B-Instruct")
IMAGE_MODEL_ID = os.getenv("LOCAL_IMAGE_MODEL_ID", "Lykon/dreamshaper-xl-1-0")

HF_TOKEN = os.getenv("HF_TOKEN") or os.getenv("HUGGINGFACE_TOKEN") or None
HF_LOCAL_FILES_ONLY = os.getenv("HF_LOCAL_FILES_ONLY", "false").lower() in {"1", "true", "yes", "on"}
MODEL_KEEP_MODE = os.getenv("MODEL_KEEP_MODE", "task-lru").lower()

# v10.4: opt-in pins to keep specific models resident in VRAM across task
# switches. Useful when you want chat+vision to coexist (e.g. asking
# follow-up questions about an image without paying the unload/reload
# cost). The explicit POST /unload endpoint still clears everything.
#
# VRAM budget on a 24GB GPU:
#   chat 8B fp16 (~16GB) + vision 3B fp16 (~6GB) = ~22GB tight but works.
#   chat 8B 4bit (~5GB)  + vision 3B fp16 (~6GB) = comfortable.
#   chat 14B 4bit (~9GB) + vision 3B fp16 (~6GB) = comfortable.
KEEP_RESIDENT_VISION = os.getenv("LOCAL_VISION_KEEP_RESIDENT", "false").lower() in {"1", "true", "yes", "on"}
KEEP_RESIDENT_IMAGE = os.getenv("LOCAL_IMAGE_KEEP_RESIDENT", "false").lower() in {"1", "true", "yes", "on"}

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
}

MODEL_AUTO_FALLBACK = os.getenv("MODEL_AUTO_FALLBACK", "true").lower() in {"1", "true", "yes", "on"}
MODEL_ROUTER_LOG = os.getenv("MODEL_ROUTER_LOG", "true").lower() in {"1", "true", "yes", "on"}
MODEL_LOG_VRAM = os.getenv("MODEL_LOG_VRAM", "true").lower() in {"1", "true", "yes", "on"}

# Chat-model quantization mode: 4bit (recommended for laptops), 8bit, or none/off/fp16/bf16.
LOCAL_CHAT_QUANT = (os.getenv("LOCAL_CHAT_QUANT", "4bit") or "").strip().lower()

# Roles that should always load at full precision (no bnb quant), e.g. 8B models that
# already fit on a 24 GB GPU. These keep their full-precision quality. The big roles
# (quality_text 12B, reasoning_code 14B) still use LOCAL_CHAT_QUANT.
LOCAL_CHAT_QUANT_FULL_ROLES = {
    role.strip().lower()
    for role in (os.getenv("LOCAL_CHAT_QUANT_FULL_ROLES", "default_chat,fallback_chat") or "").split(",")
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
    mapping = {
        "default_chat": default_id,
        "fallback_chat": fallback_id,
        "quality_text": quality_id,
        "reasoning_code": reasoning_id,
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

app = FastAPI(title="SeekDeep Local AI Server", version="10.0.0-fresh-rebuild")


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
    """Drop loaded models. With `force=False`, respects KEEP_RESIDENT_VISION /
    KEEP_RESIDENT_IMAGE pins so the pinned task survives task-LRU switches.
    The explicit POST /unload endpoint passes force=True and ignores pins."""
    global chat_model, chat_tokenizer, vision_model, vision_processor, vision_tokenizer, image_pipe, loaded_task
    global loaded_chat_role, loaded_chat_model_id
    chat_model = None
    chat_tokenizer = None
    keep_vision = (not force) and KEEP_RESIDENT_VISION
    keep_image = (not force) and KEEP_RESIDENT_IMAGE
    if not keep_vision:
        vision_model = None
        vision_processor = None
        vision_tokenizer = None
    if not keep_image:
        image_pipe = None
    loaded_task = None
    loaded_chat_role = None
    loaded_chat_model_id = None
    cleanup_cuda()
    pin_note = ""
    if keep_vision or keep_image:
        pinned = [name for name, on in (("vision", keep_vision), ("image", keep_image)) if on]
        pin_note = f" (kept resident: {', '.join(pinned)})"
    print(f"[SeekDeep] unloaded models{pin_note}", flush=True)


def prepare_task(task: str) -> None:
    global loaded_task
    if MODEL_KEEP_MODE in {"none", "off", "unload"}:
        unload_all()
        loaded_task = task
        return

    if MODEL_KEEP_MODE in {"task-lru", "lru", "single"} and loaded_task and loaded_task != task:
        # When the next task is the pinned one and it's already loaded, skip
        # the unload entirely. (Saves an unload/reload cycle for vision when
        # alternating chat<->vision and KEEP_RESIDENT_VISION is on.)
        if task == "vision" and KEEP_RESIDENT_VISION and vision_model is not None:
            print(f"[SeekDeep] keep-resident: vision already loaded; staying", flush=True)
            loaded_task = task
            return
        if task == "image" and KEEP_RESIDENT_IMAGE and image_pipe is not None:
            print(f"[SeekDeep] keep-resident: image already loaded; staying", flush=True)
            loaded_task = task
            return
        print(f"[SeekDeep] unloading models; switching from {loaded_task} to {task}", flush=True)
        unload_all()

    loaded_task = task


# ---------------------------------------------------------------------------
# Request models
# ---------------------------------------------------------------------------

class ChatRequest(BaseModel):
    prompt: str
    system: str = ""
    context: str = ""
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


class UpscaleRequest(BaseModel):
    image_b64: str
    scale: int = Field(default=2, ge=2, le=4)
    method: Literal["lanczos", "realesrgan"] = "lanczos"


# ---------------------------------------------------------------------------
# Health and utility endpoints
# ---------------------------------------------------------------------------


# SEEKDEEP_SINGLEFLIGHT_MIDDLEWARE_START
# Serialize heavyweight local model requests. FastAPI can accept overlapping
# requests, but this project keeps one active local model/task in VRAM at a time.
# Without this, two Discord events can race-load the same model twice.
import asyncio as _seekdeep_asyncio

_SEEKDEEP_MODEL_REQUEST_LOCK = _seekdeep_asyncio.Lock()
_SEEKDEEP_LOCKED_PATHS = {"/chat", "/vision", "/image", "/img2img", "/unload"}

@app.middleware("http")
async def seekdeep_singleflight_middleware(request, call_next):
    if request.url.path in _SEEKDEEP_LOCKED_PATHS:
        async with _SEEKDEEP_MODEL_REQUEST_LOCK:
            return await call_next(request)
    return await call_next(request)
# SEEKDEEP_SINGLEFLIGHT_MIDDLEWARE_END


@app.get("/health")
def health():
    return {
        "status": "ready",
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
            "vision": KEEP_RESIDENT_VISION,
            "image": KEEP_RESIDENT_IMAGE,
        },
        "gpu": gpu_stats(),
        "models": {
            "chat": CHAT_MODEL_ID,
            "vision": VISION_MODEL_ID,
            "image": IMAGE_MODEL_ID,
        },
        "cache_dir": str(MODEL_CACHE_DIR),
        "offline_model_loading": HF_LOCAL_FILES_ONLY,
    }


@app.post("/unload")
def unload_endpoint():
    # Explicit user request ignores keep-resident pins.
    unload_all(force=True)
    return {"ok": True, "status": "unloaded"}


@app.get("/gpu")
def gpu_endpoint():
    """Focused GPU stats endpoint. Lighter than /health; safe to poll
    every few seconds for live-tail monitoring without spam."""
    return gpu_stats()


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
        prepare_task("chat")
        return resolved_role, model_id

    # A different chat model is loaded; unload it before bringing in the new one.
    if chat_model is not None or chat_tokenizer is not None:
        unload_chat_model()

    prepare_task("chat")
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


def build_chat_prompt(system: str, context: str, prompt: str):
    base_system = system.strip() or (
        "You are SeekDeep, a locally running Discord assistant. "
        "Answer directly and naturally. Do not claim you searched the web unless search context is provided. "
        "Use provided search context as supporting evidence, not as a raw list of results. "
        "For casual/simple questions, answer without mentioning tools."
    )

    if context.strip():
        user_content = (
            "Use the following context only where relevant. Infer a proper answer; do not merely list results.\n\n"
            f"{context.strip()}\n\n"
            f"User question:\n{prompt.strip()}"
        )
    else:
        user_content = prompt.strip()

    return [
        {"role": "system", "content": base_system},
        {"role": "user", "content": user_content},
    ]


def _run_chat_generation(req: ChatRequest, role: str) -> tuple[str, str, str]:
    """Load a chat role and run a single generation. Returns (text, resolved_role, model_id)."""
    resolved_role, model_id = load_chat_model(role)

    import torch

    messages = build_chat_prompt(req.system, req.context, req.prompt)

    try:
        # Qwen3 tends to emit hidden thinking blocks unless explicitly disabled.
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
        "repetition_penalty": max(float(os.getenv("CHAT_REPETITION_PENALTY", "1.08")), 1.0),
        "no_repeat_ngram_size": max(int(os.getenv("CHAT_NO_REPEAT_NGRAM_SIZE", "6")), 0),
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


@app.post("/upscale")
def upscale(req: UpscaleRequest):
    """Upscale an image. 'lanczos' is a zero-model PIL fallback that works
    immediately. 'realesrgan' requires the model to be downloaded separately."""
    source_bytes = b64_to_bytes(req.image_b64)
    source_img = Image.open(io.BytesIO(source_bytes)).convert("RGB")
    scale = int(req.scale)

    if req.method == "realesrgan":
        # Placeholder — Real-ESRGAN requires a separate model download.
        # Check if it's available; if not, fall back to Lanczos with a note.
        realesrgan_path = MODEL_CACHE_DIR / "realesrgan"
        if not realesrgan_path.exists():
            # Fall back to Lanczos with a note
            new_w = source_img.width * scale
            new_h = source_img.height * scale
            img = source_img.resize((new_w, new_h), Image.LANCZOS)
            ts = int(time.time())
            safe_name = f"seekdeep_upscale_{ts}.png"
            out_path = OUTPUT_DIR / safe_name
            img.save(out_path)
            return {
                "image_b64": image_to_b64_png(img),
                "filename": safe_name,
                "path": str(out_path),
                "method": "lanczos",
                "note": "Real-ESRGAN model not installed; used Lanczos fallback.",
                "scale": scale,
                "width": new_w,
                "height": new_h,
            }
        # Future: load Real-ESRGAN and run inference here
        return JSONResponse(status_code=501, content={"error": "Real-ESRGAN is scaffolded but not yet implemented."})

    # Lanczos upscale — high-quality bicubic, no model needed
    new_w = source_img.width * scale
    new_h = source_img.height * scale
    img = source_img.resize((new_w, new_h), Image.LANCZOS)

    ts = int(time.time())
    safe_name = f"seekdeep_upscale_{ts}.png"
    out_path = OUTPUT_DIR / safe_name
    img.save(out_path)

    return {
        "image_b64": image_to_b64_png(img),
        "filename": safe_name,
        "path": str(out_path),
        "method": "lanczos",
        "scale": scale,
        "width": new_w,
        "height": new_h,
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

