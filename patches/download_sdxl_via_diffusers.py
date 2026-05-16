import gc
import os
from pathlib import Path

from dotenv import load_dotenv

load_dotenv()

model_id = os.getenv("LOCAL_IMAGE_MODEL_ID", "stabilityai/stable-diffusion-xl-base-1.0")
cache_dir = Path(os.getenv("LOCAL_MODEL_CACHE_DIR", "./models/huggingface"))
if not cache_dir.is_absolute():
    cache_dir = Path.cwd() / cache_dir
cache_dir.mkdir(parents=True, exist_ok=True)

token = os.getenv("HF_TOKEN") or os.getenv("HUGGINGFACE_TOKEN") or None
variant = os.getenv("LOCAL_IMAGE_VARIANT", "").strip() or None
use_safetensors = os.getenv("IMAGE_USE_SAFETENSORS", "true").lower() not in {"0", "false", "no", "off"}

import torch
from diffusers import DiffusionPipeline

dtype_name = os.getenv("LOCAL_TORCH_DTYPE", "float16").lower()
dtype = torch.float16 if dtype_name == "float16" else torch.bfloat16 if dtype_name == "bfloat16" else torch.float32

kwargs = {
    "cache_dir": str(cache_dir),
    "token": token,
    "local_files_only": False,
    "torch_dtype": dtype,
    "use_safetensors": use_safetensors,
}
if variant:
    kwargs["variant"] = variant

print(f"[SeekDeep SDXL minimal] model_id={model_id}")
print(f"[SeekDeep SDXL minimal] cache_dir={cache_dir}")
print(f"[SeekDeep SDXL minimal] variant={variant}")
print(f"[SeekDeep SDXL minimal] use_safetensors={use_safetensors}")
print(f"[SeekDeep SDXL minimal] dtype={dtype}")

pipe = DiffusionPipeline.from_pretrained(model_id, **kwargs)
print("[SeekDeep SDXL minimal] pipeline loaded from cache/download successfully")

del pipe
gc.collect()
if torch.cuda.is_available():
    torch.cuda.empty_cache()