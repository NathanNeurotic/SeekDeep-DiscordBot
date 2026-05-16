from pathlib import Path
import re
import sys

if len(sys.argv) != 4:
    raise SystemExit("Usage: patch_replace_sprint_with_sdxl.py <index.js> <local_ai_server.py> <.env>")

index_path = Path(sys.argv[1])
server_path = Path(sys.argv[2])
env_path = Path(sys.argv[3])

SDXL_MODEL_ID = "stabilityai/stable-diffusion-xl-base-1.0"
SDXL_STEPS = "28"
SDXL_GUIDANCE = "6.5"


def read_text_with_newline(path: Path):
    raw = path.read_bytes()
    newline = "\r\n" if b"\r\n" in raw else "\n"
    text = raw.decode("utf-8-sig")
    text = text.replace("\r\n", "\n").replace("\r", "\n")
    return text, newline


def write_text_with_newline(path: Path, text: str, newline: str):
    out = text if newline == "\n" else text.replace("\n", "\r\n")
    path.write_bytes(out.encode("utf-8"))


def require_contains(haystack: str, needle: str, label: str):
    if needle not in haystack:
        raise SystemExit(f"Required anchor not found: {label}")


index_text, index_nl = read_text_with_newline(index_path)
server_text, server_nl = read_text_with_newline(server_path)
env_text, env_nl = read_text_with_newline(env_path)

# ----- index.js -----
require_contains(index_text, "LOCAL_IMAGE_MODEL_ID", "index.js image model label")
require_contains(index_text, "steps: 2,", "index.js hardcoded image steps")
require_contains(index_text, "guidance_scale: Number(process.env.IMAGE_GUIDANCE_SCALE || 0.0),", "index.js image guidance line")

index_text = index_text.replace(
    "return process.env.LOCAL_IMAGE_MODEL_ID || 'Efficient-Large-Model/Sana_Sprint_1.6B_1024px_diffusers';",
    "return process.env.LOCAL_IMAGE_MODEL_ID || 'stabilityai/stable-diffusion-xl-base-1.0';",
    1,
)
index_text = index_text.replace("steps: 2,", "steps: Number(process.env.IMAGE_STEPS || 28),", 1)
index_text = index_text.replace(
    "guidance_scale: Number(process.env.IMAGE_GUIDANCE_SCALE || 0.0),",
    "guidance_scale: Number(process.env.IMAGE_GUIDANCE_SCALE || 6.5),",
    1,
)

# ----- local_ai_server.py -----
require_contains(server_text, 'IMAGE_MODEL_ID = os.getenv("LOCAL_IMAGE_MODEL_ID", "Efficient-Large-Model/Sana_Sprint_1.6B_1024px_diffusers")', 'server image model default')
require_contains(server_text, 'steps: int = Field(default=2, ge=1, le=50)', 'server ImageRequest default steps')
require_contains(server_text, '"num_inference_steps": 2,', 'server hardcoded 2-step image args')
require_contains(server_text, '"forced_steps": 2,', 'server forced_steps response')

server_text = server_text.replace(
    'IMAGE_MODEL_ID = os.getenv("LOCAL_IMAGE_MODEL_ID", "Efficient-Large-Model/Sana_Sprint_1.6B_1024px_diffusers")',
    'IMAGE_MODEL_ID = os.getenv("LOCAL_IMAGE_MODEL_ID", "stabilityai/stable-diffusion-xl-base-1.0")',
    1,
)
server_text = server_text.replace('steps: int = Field(default=2, ge=1, le=50)', 'steps: int = Field(default=28, ge=1, le=50)', 1)
server_text = server_text.replace(
    '# Image generation - Sana Sprint requires exactly 2 inference steps.',
    '# Image generation - configurable diffusion steps for the current model.',
    1,
)

# Replace the Sana-specific steps block.
old_block = '''    # Sana Sprint SCM pipeline supports exactly 2 steps. Do not use arbitrary steps.
    args = {
        "prompt": req.prompt.strip(),
        "width": width,
        "height": height,
        "num_inference_steps": 2,
        "guidance_scale": float(req.guidance_scale),
    }
'''
new_block = '''    actual_steps = max(1, min(50, int(req.steps)))

    args = {
        "prompt": req.prompt.strip(),
        "width": width,
        "height": height,
        "num_inference_steps": actual_steps,
        "guidance_scale": float(req.guidance_scale),
    }
'''
if old_block not in server_text:
    raise SystemExit('Could not locate Sana-only image args block in local_ai_server.py.')
server_text = server_text.replace(old_block, new_block, 1)
server_text = server_text.replace('"forced_steps": 2,', '"forced_steps": actual_steps,', 1)

# ----- .env -----
require_contains(env_text, 'LOCAL_IMAGE_MODEL_ID=', '.env image model id')
require_contains(env_text, 'IMAGE_STEPS=', '.env image steps')
require_contains(env_text, 'IMAGE_GUIDANCE_SCALE=', '.env image guidance scale')


def set_env_value(text: str, key: str, value: str) -> str:
    pattern = re.compile(rf'^(\s*{re.escape(key)}=).*$' , re.M)
    if pattern.search(text):
        return pattern.sub(rf'\1{value}', text, count=1)
    if not text.endswith('\n'):
        text += '\n'
    return text + f'{key}={value}\n'

env_text = set_env_value(env_text, 'LOCAL_IMAGE_MODEL_ID', SDXL_MODEL_ID)
env_text = set_env_value(env_text, 'IMAGE_STEPS', SDXL_STEPS)
env_text = set_env_value(env_text, 'IMAGE_GUIDANCE_SCALE', SDXL_GUIDANCE)

# Optional status hint comments (only if not already present)
if '# SDXL replacement defaults' not in env_text:
    anchor = 'IMAGE_SEED=-1'
    insert = 'IMAGE_SEED=-1\n# SDXL replacement defaults\n# If the model is not already cached, first startup will fail while offline-only flags remain enabled.\n# Temporarily disable HF_LOCAL_FILES_ONLY / HF_HUB_OFFLINE / TRANSFORMERS_OFFLINE if you need the model to download.\n'
    if anchor in env_text:
        env_text = env_text.replace(anchor, insert, 1)

write_text_with_newline(index_path, index_text, index_nl)
write_text_with_newline(server_path, server_text, server_nl)
write_text_with_newline(env_path, env_text, env_nl)

print('Patched index.js, local_ai_server.py, and .env for SDXL image generation.')