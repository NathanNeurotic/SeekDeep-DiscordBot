import gc
import os
from pathlib import Path

from dotenv import load_dotenv
load_dotenv()

import torch
from diffusers import DiffusionPipeline

model_id = os.getenv("LOCAL_IMAGE_MODEL_ID", "RunDiffusion/Juggernaut-XL-v9")
cache_dir = Path(os.getenv("LOCAL_MODEL_CACHE_DIR", "./models/huggingface"))
if not cache_dir.is_absolute():
    cache_dir = Path.cwd() / cache_dir
cache_dir.mkdir(parents=True, exist_ok=True)

token = os.getenv("HF_TOKEN") or os.getenv("HUGGINGFACE_TOKEN") or None
dtype_name = os.getenv("LOCAL_TORCH_DTYPE", "float16").lower()
if dtype_name == "bfloat16":
    dtype = torch.bfloat16
elif dtype_name == "float32":
    dtype = torch.float32
else:
    dtype = torch.float16

variant = os.getenv("LOCAL_IMAGE_VARIANT", "").strip()
use_safetensors = os.getenv("IMAGE_USE_SAFETENSORS", "true").strip().lower() not in {"0", "false", "no", "off"}

kwargs = {
    "cache_dir": str(cache_dir),
    "local_files_only": False,
    "torch_dtype": dtype,
    "use_safetensors": use_safetensors,
}
if token:
    kwargs["token"] = token
if variant:
    kwargs["variant"] = variant

print(f"[SeekDeep Juggernaut] model_id={model_id}")
print(f"[SeekDeep Juggernaut] cache_dir={cache_dir}")
print(f"[SeekDeep Juggernaut] dtype={dtype}")
print(f"[SeekDeep Juggernaut] variant={variant or '(none)'}")
print(f"[SeekDeep Juggernaut] use_safetensors={use_safetensors}")

pipe = DiffusionPipeline.from_pretrained(model_id, **kwargs)
if torch.cuda.is_available():
    pipe = pipe.to("cuda")

print("[SeekDeep Juggernaut] pipeline downloaded and loaded successfully")

del pipe
gc.collect()
if torch.cuda.is_available():
    torch.cuda.empty_cache()