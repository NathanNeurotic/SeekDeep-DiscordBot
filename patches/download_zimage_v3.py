import gc
import os
from pathlib import Path

from dotenv import load_dotenv
load_dotenv()

import torch
from diffusers import ZImagePipeline

model_id = os.getenv("LOCAL_IMAGE_MODEL_ID", "Tongyi-MAI/Z-Image")
cache_dir = Path(os.getenv("LOCAL_MODEL_CACHE_DIR", "./models/huggingface"))
if not cache_dir.is_absolute():
    cache_dir = Path.cwd() / cache_dir
cache_dir.mkdir(parents=True, exist_ok=True)

token = os.getenv("HF_TOKEN") or os.getenv("HUGGINGFACE_TOKEN") or None
dtype_name = os.getenv("LOCAL_TORCH_DTYPE", "bfloat16").lower()
dtype = torch.bfloat16 if dtype_name == "bfloat16" else torch.float16 if dtype_name == "float16" else torch.float32

kwargs = {
    "cache_dir": str(cache_dir),
    "token": token,
    "local_files_only": False,
    "torch_dtype": dtype,
    "low_cpu_mem_usage": False,
}

print(f"[SeekDeep Z-Image] model_id={model_id}")
print(f"[SeekDeep Z-Image] cache_dir={cache_dir}")
print(f"[SeekDeep Z-Image] dtype={dtype}")

pipe = ZImagePipeline.from_pretrained(model_id, **kwargs)
print("[SeekDeep Z-Image] pipeline downloaded/loaded successfully on CPU")

del pipe
gc.collect()
if torch.cuda.is_available():
    torch.cuda.empty_cache()