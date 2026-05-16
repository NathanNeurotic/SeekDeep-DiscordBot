from pathlib import Path
import re
import sys

if len(sys.argv) != 3:
    raise SystemExit("Usage: patch_switch_to_zimage.py <local_ai_server.py> <.env>")

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

def set_env_value(text: str, key: str, value: str) -> str:
    pattern = re.compile(rf'^(\s*{re.escape(key)}=).*$', re.M)
    if pattern.search(text):
        return pattern.sub(lambda m: m.group(1) + value, text, count=1)
    if not text.endswith("\n"):
        text += "\n"
    return text + f"{key}={value}\n"

def require_contains(text: str, needle: str, label: str):
    if needle not in text:
        raise SystemExit(f"Required anchor not found: {label}")

server, server_nl = read_text(server_path)
env, env_nl = read_text(env_path)

require_contains(server, "def load_image_pipe() -> None:", "load_image_pipe")
require_contains(server, "image_pipe = DiffusionPipeline.from_pretrained(IMAGE_MODEL_ID, **kwargs)", "image pipeline constructor")
require_contains(server, "result = image_pipe(**args)", "image invocation")

import_block_old = """    import torch
    from diffusers import DiffusionPipeline
"""
import_block_new = """    import torch
    from diffusers import DiffusionPipeline
    try:
        from diffusers import ZImagePipeline
    except Exception:
        ZImagePipeline = None
"""
if "from diffusers import ZImagePipeline" not in server:
    if import_block_old not in server:
        raise SystemExit("Could not locate image pipeline import block.")
    server = server.replace(import_block_old, import_block_new, 1)

constructor_old = """    image_pipe = DiffusionPipeline.from_pretrained(IMAGE_MODEL_ID, **kwargs)
"""
constructor_new = """    image_pipeline_class = os.getenv(\"LOCAL_IMAGE_PIPELINE_CLASS\", \"\").strip().lower()
    is_zimage = image_pipeline_class == \"zimagepipeline\" or IMAGE_MODEL_ID.strip().lower() == \"tongyi-mai/z-image\"

    if is_zimage:
        if ZImagePipeline is None:
            raise RuntimeError(\"ZImagePipeline is unavailable. Upgrade diffusers to a version that includes ZImagePipeline.\")
        kwargs[\"low_cpu_mem_usage\"] = False
        image_pipe = ZImagePipeline.from_pretrained(IMAGE_MODEL_ID, **kwargs)
    else:
        image_pipe = DiffusionPipeline.from_pretrained(IMAGE_MODEL_ID, **kwargs)
"""
if "image_pipeline_class = os.getenv(\"LOCAL_IMAGE_PIPELINE_CLASS\"" not in server:
    if constructor_old not in server:
        raise SystemExit("Could not locate image pipeline constructor.")
    server = server.replace(constructor_old, constructor_new, 1)

args_old = """    # Sana Sprint SCM pipeline supports exactly 2 steps. Do not use arbitrary steps.
    args = {
        \"prompt\": req.prompt.strip(),
        \"width\": width,
        \"height\": height,
        \"num_inference_steps\": 2,
        \"guidance_scale\": float(req.guidance_scale),
    }
"""
args_new = """    image_pipeline_class = os.getenv(\"LOCAL_IMAGE_PIPELINE_CLASS\", \"\").strip().lower()
    is_zimage = image_pipeline_class == \"zimagepipeline\" or IMAGE_MODEL_ID.strip().lower() == \"tongyi-mai/z-image\"

    requested_steps = max(1, int(req.steps))

    args = {
        \"prompt\": req.prompt.strip(),
        \"width\": width,
        \"height\": height,
        \"num_inference_steps\": requested_steps,
        \"guidance_scale\": float(req.guidance_scale),
    }

    if is_zimage:
        cfg_norm_env = os.getenv(\"IMAGE_CFG_NORMALIZATION\", \"false\").strip().lower()
        args[\"cfg_normalization\"] = cfg_norm_env in {\"1\", \"true\", \"yes\", \"on\"}

        negative_prompt = os.getenv(\"IMAGE_NEGATIVE_PROMPT\", \"\").strip()
        if negative_prompt:
            args[\"negative_prompt\"] = negative_prompt
"""
if "requested_steps = max(1, int(req.steps))" not in server:
    if args_old in server:
        server = server.replace(args_old, args_new, 1)
    else:
        flexible_old = """    args = {
        \"prompt\": req.prompt.strip(),
        \"width\": width,
        \"height\": height,
        \"num_inference_steps\": int(req.steps),
        \"guidance_scale\": float(req.guidance_scale),
    }
"""
        if flexible_old not in server:
            raise SystemExit("Could not locate image args block to make Z-Image compatible.")
        server = server.replace(flexible_old, args_new, 1)

forced_old = """        \"forced_steps\": 2,
"""
forced_new = """        \"forced_steps\": int(args.get(\"num_inference_steps\", requested_steps)),
"""
if forced_old in server:
    server = server.replace(forced_old, forced_new, 1)
elif '"forced_steps": int(args.get("num_inference_steps", int(req.steps))),' in server:
    server = server.replace('"forced_steps": int(args.get("num_inference_steps", int(req.steps))),', forced_new.strip(), 1)

env = set_env_value(env, "LOCAL_IMAGE_MODEL_ID", "Tongyi-MAI/Z-Image")
env = set_env_value(env, "LOCAL_IMAGE_PIPELINE_CLASS", "ZImagePipeline")
env = set_env_value(env, "LOCAL_TORCH_DTYPE", "bfloat16")
env = set_env_value(env, "IMAGE_STEPS", "36")
env = set_env_value(env, "IMAGE_GUIDANCE_SCALE", "4")
env = set_env_value(env, "IMAGE_CFG_NORMALIZATION", "false")
env = set_env_value(env, "IMAGE_NEGATIVE_PROMPT", "")
env = set_env_value(env, "HF_LOCAL_FILES_ONLY", "false")
env = set_env_value(env, "HF_HUB_OFFLINE", "0")
env = set_env_value(env, "TRANSFORMERS_OFFLINE", "0")
env = set_env_value(env, "HF_DATASETS_OFFLINE", "0")

write_text(server_path, server, server_nl)
write_text(env_path, env, env_nl)

print("Patched local_ai_server.py and .env for Tongyi-MAI/Z-Image.")