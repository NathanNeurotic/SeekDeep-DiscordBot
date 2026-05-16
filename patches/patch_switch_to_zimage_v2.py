from pathlib import Path
import re
import sys

if len(sys.argv) != 3:
    raise SystemExit("Usage: patch_switch_to_zimage_v2.py <local_ai_server.py> <.env>")

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

def find_matching_brace(src, open_index):
    depth = 0
    i = open_index
    in_single = in_double = in_template = False
    in_line_comment = in_block_comment = False
    escape = False

    while i < len(src):
        c = src[i]
        n = src[i + 1] if i + 1 < len(src) else ""

        if in_line_comment:
            if c in "\r\n":
                in_line_comment = False
            i += 1
            continue

        if in_block_comment:
            if c == "*" and n == "/":
                in_block_comment = False
                i += 2
                continue
            i += 1
            continue

        if in_single:
            if escape:
                escape = False
            elif c == "\\":
                escape = True
            elif c == "'":
                in_single = False
            i += 1
            continue

        if in_double:
            if escape:
                escape = False
            elif c == "\\":
                escape = True
            elif c == '"':
                in_double = False
            i += 1
            continue

        if in_template:
            if escape:
                escape = False
            elif c == "\\":
                escape = True
            elif c == "`":
                in_template = False
            i += 1
            continue

        if c == "/" and n == "/":
            in_line_comment = True
            i += 2
            continue

        if c == "/" and n == "*":
            in_block_comment = True
            i += 2
            continue

        if c == "'":
            in_single = True
            i += 1
            continue

        if c == '"':
            in_double = True
            i += 1
            continue

        if c == "`":
            in_template = True
            i += 1
            continue

        if c == "{":
            depth += 1
        elif c == "}":
            depth -= 1
            if depth == 0:
                return i

        i += 1

    raise SystemExit("Could not find matching closing brace.")

def find_python_function(src, name):
    m = re.search(rf"^def\s+{re.escape(name)}\s*\([^)]*\):", src, re.M)
    if not m:
        raise SystemExit(f"Could not locate function {name}.")
    next_m = re.search(r"^def\s+\w+\s*\([^)]*\):|^@app\.", src[m.end():], re.M)
    if next_m:
        return m.start(), m.end() + next_m.start(), src[m.start():m.end() + next_m.start()]
    return m.start(), len(src), src[m.start():]

server, server_nl = read_text(server_path)
env, env_nl = read_text(env_path)

require_contains(server, "def load_image_pipe() -> None:", "load_image_pipe")
require_contains(server, "def image(req: ImageRequest):", "image endpoint")
require_contains(server, "result = image_pipe(**args)", "image invocation")

# 1. Patch load_image_pipe with ZImagePipeline support.
load_start, load_end, load_fn = find_python_function(server, "load_image_pipe")

if "from diffusers import ZImagePipeline" not in load_fn:
    load_fn = load_fn.replace(
        "    from diffusers import DiffusionPipeline\n",
        "    from diffusers import DiffusionPipeline\n    try:\n        from diffusers import ZImagePipeline\n    except Exception:\n        ZImagePipeline = None\n",
        1,
    )

if "LOCAL_IMAGE_PIPELINE_CLASS" not in load_fn:
    old = "    image_pipe = DiffusionPipeline.from_pretrained(IMAGE_MODEL_ID, **kwargs)\n"
    new = """    image_pipeline_class = os.getenv("LOCAL_IMAGE_PIPELINE_CLASS", "").strip().lower()
    is_zimage = image_pipeline_class == "zimagepipeline" or IMAGE_MODEL_ID.strip().lower() == "tongyi-mai/z-image"

    if is_zimage:
        if ZImagePipeline is None:
            raise RuntimeError("ZImagePipeline is unavailable. Upgrade diffusers to a version that includes ZImagePipeline.")
        kwargs["low_cpu_mem_usage"] = False
        image_pipe = ZImagePipeline.from_pretrained(IMAGE_MODEL_ID, **kwargs)
    else:
        image_pipe = DiffusionPipeline.from_pretrained(IMAGE_MODEL_ID, **kwargs)
"""
    if old not in load_fn:
        raise SystemExit("Could not locate DiffusionPipeline constructor inside load_image_pipe.")
    load_fn = load_fn.replace(old, new, 1)

server = server[:load_start] + load_fn + server[load_end:]

# 2. Patch image endpoint args by replacing from first args = { through before if generator is not None.
img_start, img_end, img_fn = find_python_function(server, "image")

if "LOCAL_IMAGE_PIPELINE_CLASS" not in img_fn or "requested_steps = max(1, int(req.steps))" not in img_fn:
    args_pos = img_fn.find("    args = {")
    if args_pos < 0:
        raise SystemExit("Could not locate args dict inside image endpoint.")

    args_open = img_fn.find("{", args_pos)
    args_close = find_matching_brace(img_fn, args_open)
    line_end = img_fn.find("\n", args_close)
    if line_end < 0:
        line_end = args_close + 1

    # Include a preceding Sana/steps comment if present.
    replace_start = args_pos
    comment = "    # Sana Sprint SCM pipeline supports exactly 2 steps. Do not use arbitrary steps.\n"
    comment_pos = img_fn.rfind(comment, 0, args_pos)
    if comment_pos >= 0 and args_pos - comment_pos < 200:
        replace_start = comment_pos

    new_args = """    image_pipeline_class = os.getenv("LOCAL_IMAGE_PIPELINE_CLASS", "").strip().lower()
    is_zimage = image_pipeline_class == "zimagepipeline" or IMAGE_MODEL_ID.strip().lower() == "tongyi-mai/z-image"

    requested_steps = max(1, int(req.steps))

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
"""
    img_fn = img_fn[:replace_start] + new_args + img_fn[line_end + 1:]

# 3. Fix forced_steps response if needed.
img_fn = img_fn.replace('"forced_steps": 2,', '"forced_steps": int(args.get("num_inference_steps", requested_steps)),')
img_fn = img_fn.replace('"forced_steps": actual_steps,', '"forced_steps": int(args.get("num_inference_steps", requested_steps)),')
img_fn = img_fn.replace('"forced_steps": int(args.get("num_inference_steps", int(req.steps))),', '"forced_steps": int(args.get("num_inference_steps", requested_steps)),')

server = server[:img_start] + img_fn + server[img_end:]

# 4. Configure .env for Z-Image and temporarily allow download.
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

for needle, label in [
    ("from diffusers import ZImagePipeline", "ZImagePipeline import"),
    ("ZImagePipeline.from_pretrained", "ZImagePipeline constructor"),
    ("requested_steps = max(1, int(req.steps))", "requested steps"),
    ("cfg_normalization", "Z-Image cfg_normalization"),
    ('"forced_steps": int(args.get("num_inference_steps", requested_steps)),', "forced_steps response"),
]:
    require_contains(server, needle, label)

write_text(server_path, server, server_nl)
write_text(env_path, env, env_nl)

print("Patched local_ai_server.py and .env for Tongyi-MAI/Z-Image v2.")