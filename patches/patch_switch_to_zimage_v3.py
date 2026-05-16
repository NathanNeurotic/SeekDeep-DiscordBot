from pathlib import Path
import re
import sys

if len(sys.argv) != 4:
    raise SystemExit("Usage: patch_switch_to_zimage_v3.py <index.js> <local_ai_server.py> <.env>")

index_path = Path(sys.argv[1])
server_path = Path(sys.argv[2])
env_path = Path(sys.argv[3])

Z_MODEL = "Tongyi-MAI/Z-Image"


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

index, index_nl = read_text(index_path)
server, server_nl = read_text(server_path)
env, env_nl = read_text(env_path)

require_contains(server, "def load_image_pipe() -> None:", "load_image_pipe start")
require_contains(server, '@app.post("/image")', "image route decorator")
require_contains(server, 'if __name__ == "__main__":', "main guard")
require_contains(index, "function seekdeepImageModelLabel()", "image model label function")

# Patch top-level default image model.
server = re.sub(
    r'IMAGE_MODEL_ID\s*=\s*os\.getenv\("LOCAL_IMAGE_MODEL_ID",\s*"[^"]+"\)',
    'IMAGE_MODEL_ID = os.getenv("LOCAL_IMAGE_MODEL_ID", "Tongyi-MAI/Z-Image")',
    server,
    count=1,
)

# Replace load_image_pipe function exactly from its start up to the image route decorator.
load_start = server.find("def load_image_pipe() -> None:")
load_end = server.find('\n@app.post("/image")', load_start)
if load_start < 0 or load_end < 0:
    raise SystemExit("Could not isolate load_image_pipe function.")

new_load = '''def load_image_pipe() -> None:
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

    if cuda_available():
        image_pipe = image_pipe.to("cuda")

    try:
        image_pipe.set_progress_bar_config(disable=True)
    except Exception:
        pass

    last_loaded_at = time.time()
    print("[SeekDeep] image model loaded", flush=True)

'''
server = server[:load_start] + new_load + server[load_end + 1:]

# Replace /image endpoint exactly from decorator up to main guard.
route_start = server.find('@app.post("/image")')
route_end = server.find('\n\nif __name__ == "__main__":', route_start)
if route_start < 0 or route_end < 0:
    raise SystemExit("Could not isolate /image endpoint.")

new_route = '''@app.post("/image")
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

    if is_zimage:
        cfg_norm_env = os.getenv("IMAGE_CFG_NORMALIZATION", "false").strip().lower()
        args["cfg_normalization"] = cfg_norm_env in {"1", "true", "yes", "on"}

        negative_prompt = os.getenv("IMAGE_NEGATIVE_PROMPT", "").strip()
        if negative_prompt:
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
'''
server = server[:route_start] + new_route + server[route_end:]

# Patch index fallback label only. Env remains primary.
index = re.sub(
    r"return process\.env\.LOCAL_IMAGE_MODEL_ID \|\| '[^']+';",
    "return process.env.LOCAL_IMAGE_MODEL_ID || 'Tongyi-MAI/Z-Image';",
    index,
    count=1,
)

# Configure env for Z-Image and temporarily allow download.
env = set_env_value(env, "LOCAL_IMAGE_MODEL_ID", "Tongyi-MAI/Z-Image")
env = set_env_value(env, "LOCAL_IMAGE_PIPELINE_CLASS", "ZImagePipeline")
env = set_env_value(env, "LOCAL_TORCH_DTYPE", "bfloat16")
env = set_env_value(env, "IMAGE_STEPS", "36")
env = set_env_value(env, "IMAGE_GUIDANCE_SCALE", "4")
env = set_env_value(env, "IMAGE_CFG_NORMALIZATION", "false")
env = set_env_value(env, "IMAGE_NEGATIVE_PROMPT", "")
# Avoid SDXL-specific variant carrying over to Z-Image.
env = set_env_value(env, "LOCAL_IMAGE_VARIANT", "")
env = set_env_value(env, "IMAGE_USE_SAFETENSORS", "true")
env = set_env_value(env, "HF_LOCAL_FILES_ONLY", "false")
env = set_env_value(env, "HF_HUB_OFFLINE", "0")
env = set_env_value(env, "TRANSFORMERS_OFFLINE", "0")
env = set_env_value(env, "HF_DATASETS_OFFLINE", "0")

for needle, label in [
    ("IMAGE_MODEL_ID = os.getenv(\"LOCAL_IMAGE_MODEL_ID\", \"Tongyi-MAI/Z-Image\")", "server image model default"),
    ("from diffusers import ZImagePipeline", "ZImagePipeline import"),
    ("ZImagePipeline.from_pretrained", "ZImagePipeline constructor"),
    ("requested_steps = max(1, min(50, int(req.steps)))", "bounded requested steps"),
    ("cfg_normalization", "cfg normalization arg"),
    ("LOCAL_IMAGE_MODEL_ID=Tongyi-MAI/Z-Image", "env image model"),
]:
    require_contains(server if label not in {"env image model"} else env, needle, label)

write_text(index_path, index, index_nl)
write_text(server_path, server, server_nl)
write_text(env_path, env, env_nl)
print("Patched index.js, local_ai_server.py, and .env for Tongyi-MAI/Z-Image v3.")