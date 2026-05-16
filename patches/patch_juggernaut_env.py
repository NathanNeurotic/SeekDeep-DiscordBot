from pathlib import Path
import re
import sys

if len(sys.argv) != 2:
    raise SystemExit("Usage: patch_juggernaut_env.py <.env>")

env_path = Path(sys.argv[1])
raw = env_path.read_bytes()
newline = "\r\n" if b"\r\n" in raw else "\n"
text = raw.decode("utf-8-sig").replace("\r\n", "\n").replace("\r", "\n")

def set_env_value(src: str, key: str, value: str) -> str:
    pattern = re.compile(rf'^(\s*{re.escape(key)}=).*$', re.M)
    if pattern.search(src):
        return pattern.sub(lambda m: m.group(1) + value, src, count=1)
    if not src.endswith("\n"):
        src += "\n"
    return src + f"{key}={value}\n"

# Switch to Juggernaut XL v9 (SDXL family)
text = set_env_value(text, "LOCAL_IMAGE_MODEL_ID", "RunDiffusion/Juggernaut-XL-v9")
text = set_env_value(text, "LOCAL_IMAGE_PIPELINE_CLASS", "")
text = set_env_value(text, "LOCAL_IMAGE_VARIANT", "fp16")
text = set_env_value(text, "IMAGE_USE_SAFETENSORS", "true")
text = set_env_value(text, "LOCAL_TORCH_DTYPE", "float16")
text = set_env_value(text, "IMAGE_STEPS", "30")
text = set_env_value(text, "IMAGE_GUIDANCE_SCALE", "6")
# Clear Z-Image-only tuning remnants if present.
text = set_env_value(text, "IMAGE_CFG_NORMALIZATION", "false")
text = set_env_value(text, "IMAGE_NEGATIVE_PROMPT", "")

# Temporarily allow download. Script restores offline flags afterward.
text = set_env_value(text, "HF_LOCAL_FILES_ONLY", "false")
text = set_env_value(text, "HF_HUB_OFFLINE", "0")
text = set_env_value(text, "TRANSFORMERS_OFFLINE", "0")
text = set_env_value(text, "HF_DATASETS_OFFLINE", "0")

out = text if newline == "\n" else text.replace("\n", "\r\n")
env_path.write_bytes(out.encode("utf-8"))
print("Patched .env for Juggernaut XL v9.")