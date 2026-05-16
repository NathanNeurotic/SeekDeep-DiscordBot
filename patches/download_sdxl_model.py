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

try:
    from huggingface_hub import snapshot_download
except Exception as exc:
    raise SystemExit(f"huggingface_hub is not installed in this venv: {exc}")

print(f"[SeekDeep SDXL] model_id={model_id}")
print(f"[SeekDeep SDXL] cache_dir={cache_dir}")

path = snapshot_download(
    repo_id=model_id,
    cache_dir=str(cache_dir),
    token=token,
    local_files_only=False,
    resume_download=True,
)

print(f"[SeekDeep SDXL] downloaded snapshot: {path}")