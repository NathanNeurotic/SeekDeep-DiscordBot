from pathlib import Path
import re
import sys

if len(sys.argv) != 3:
    raise SystemExit("Usage: patch_sdxl_fp16_runtime.py <local_ai_server.py> <.env>")

server_path = Path(sys.argv[1])
env_path = Path(sys.argv[2])

def read_text(path: Path):
    raw = path.read_bytes()
    newline = "\r\n" if b"\r\n" in raw else "\n"
    text = raw.decode("utf-8-sig").replace("\r\n", "\n").replace("\r", "\n")
    return text, newline

def write_text(path: Path, text: str, newline: str):
    out = text if newline == "\n" else text.replace("\n", "\r\n")
    path.write_bytes(out.encode("utf-8"))

def require_contains(text: str, needle: str, label: str):
    if needle not in text:
        raise SystemExit(f"Required anchor not found: {label}")

def set_env_value(text: str, key: str, value: str) -> str:
    pattern = re.compile(rf'^(\s*{re.escape(key)}=).*$', re.M)
    if pattern.search(text):
        return pattern.sub(lambda m: m.group(1) + value, text, count=1)
    if not text.endswith("\n"):
        text += "\n"
    return text + f"{key}={value}\n"

server, server_nl = read_text(server_path)
env, env_nl = read_text(env_path)

require_contains(server, "DiffusionPipeline.from_pretrained(IMAGE_MODEL_ID, **kwargs)", "DiffusionPipeline.from_pretrained kwargs")
require_contains(server, "\"torch_dtype\": model_dtype(),", "torch_dtype kwargs")
require_contains(env, "LOCAL_IMAGE_MODEL_ID=stabilityai/stable-diffusion-xl-base-1.0", ".env SDXL model id")

if "LOCAL_IMAGE_VARIANT" not in server:
    old = """    kwargs = {
        "cache_dir": str(MODEL_CACHE_DIR),
        "token": HF_TOKEN,
        "local_files_only": HF_LOCAL_FILES_ONLY,
        "torch_dtype": model_dtype(),
    }

    image_pipe = DiffusionPipeline.from_pretrained(IMAGE_MODEL_ID, **kwargs)
"""
    new = """    kwargs = {
        "cache_dir": str(MODEL_CACHE_DIR),
        "token": HF_TOKEN,
        "local_files_only": HF_LOCAL_FILES_ONLY,
        "torch_dtype": model_dtype(),
    }

    image_variant = os.getenv("LOCAL_IMAGE_VARIANT", "").strip()
    if image_variant:
        kwargs["variant"] = image_variant

    image_use_safetensors = os.getenv("IMAGE_USE_SAFETENSORS", "true").lower() not in {"0", "false", "no", "off"}
    kwargs["use_safetensors"] = image_use_safetensors

    image_pipe = DiffusionPipeline.from_pretrained(IMAGE_MODEL_ID, **kwargs)
"""
    if old not in server:
        raise SystemExit("Could not patch DiffusionPipeline kwargs block; current local_ai_server.py shape differs.")
    server = server.replace(old, new, 1)

env = set_env_value(env, "LOCAL_IMAGE_MODEL_ID", "stabilityai/stable-diffusion-xl-base-1.0")
env = set_env_value(env, "LOCAL_IMAGE_VARIANT", "fp16")
env = set_env_value(env, "IMAGE_USE_SAFETENSORS", "true")
env = set_env_value(env, "LOCAL_TORCH_DTYPE", "float16")
env = set_env_value(env, "IMAGE_STEPS", "28")
env = set_env_value(env, "IMAGE_GUIDANCE_SCALE", "6.5")

# Temporarily online for download.
env = set_env_value(env, "HF_LOCAL_FILES_ONLY", "false")
env = set_env_value(env, "HF_HUB_OFFLINE", "0")
env = set_env_value(env, "TRANSFORMERS_OFFLINE", "0")
env = set_env_value(env, "HF_DATASETS_OFFLINE", "0")

write_text(server_path, server, server_nl)
write_text(env_path, env, env_nl)

print("Patched local_ai_server.py for image variant/use_safetensors and prepared .env for SDXL fp16 download.")