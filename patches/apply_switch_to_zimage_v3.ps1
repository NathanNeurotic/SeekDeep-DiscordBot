# SeekDeep / Seekotics switch image model to Tongyi-MAI/Z-Image v3
#
# Fixes prior failures by replacing the exact image loader and /image endpoint
# instead of searching for brittle sub-blocks.
#
# This switches the active image model to full Z-Image, not Turbo.
# Runtime remains local/offline after the one-time download.
#
# Files patched:
# - index.js fallback image label only
# - local_ai_server.py image loader + /image endpoint
# - .env
#
# Backups:
# - index.js
# - local_ai_server.py
# - .env
#
# Required checks:
#   node --check .\index.js
#   .\.venv\Scripts\python.exe -m py_compile .\local_ai_server.py

$ErrorActionPreference = "Stop"

try { [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false) } catch {}

function Write-Info { param([string]$Message) Write-Host "[SeekDeep Z-Image v3] $Message" -ForegroundColor Cyan }
function Write-Pass { param([string]$Message) Write-Host "[PASS] $Message" -ForegroundColor Green }
function Write-Warn { param([string]$Message) Write-Host "[WARN] $Message" -ForegroundColor Yellow }
function Write-Fail { param([string]$Message) Write-Host "[FAIL] $Message" -ForegroundColor Red }

function Set-EnvLine {
  param([string]$Text, [string]$Key, [string]$Value)
  $escaped = [regex]::Escape($Key)
  if ($Text -match "(?m)^$escaped=") {
    return [regex]::Replace($Text, "(?m)^$escaped=.*$", "$Key=$Value")
  }
  if ($Text.Length -gt 0 -and -not $Text.EndsWith("`n")) { $Text += "`n" }
  return $Text + "$Key=$Value`n"
}

function Invoke-CheckedCommand {
  param([Parameter(Mandatory=$true)][string]$Label, [Parameter(Mandatory=$true)][scriptblock]$Command)
  Write-Info "Running $Label"
  & $Command
  if ($LASTEXITCODE -ne 0) { throw "$Label failed with exit code $LASTEXITCODE." }
  Write-Pass "$Label passed"
}

function Get-DirectorySizeBytes {
  param([string]$Path)
  if (-not (Test-Path -LiteralPath $Path)) { return 0 }
  $sum = 0
  Get-ChildItem -LiteralPath $Path -Recurse -Force -ErrorAction SilentlyContinue | ForEach-Object {
    if (-not $_.PSIsContainer) { $sum += $_.Length }
  }
  return $sum
}

function Format-Bytes {
  param([Int64]$Bytes)
  if ($Bytes -ge 1TB) { return "{0:N2} TB" -f ($Bytes / 1TB) }
  if ($Bytes -ge 1GB) { return "{0:N2} GB" -f ($Bytes / 1GB) }
  if ($Bytes -ge 1MB) { return "{0:N2} MB" -f ($Bytes / 1MB) }
  if ($Bytes -ge 1KB) { return "{0:N2} KB" -f ($Bytes / 1KB) }
  return "$Bytes B"
}

try {
  $projectRoot = Join-Path $env:USERPROFILE "SeekDeep-DiscordBot"
  if (-not (Test-Path -LiteralPath (Join-Path $projectRoot "index.js"))) { $projectRoot = (Get-Location).Path }

  $indexPath = Join-Path $projectRoot "index.js"
  $serverPath = Join-Path $projectRoot "local_ai_server.py"
  $envPath = Join-Path $projectRoot ".env"
  $patchesDir = Join-Path $projectRoot "patches"
  $backupDir = Join-Path $patchesDir "backups"
  $stamp = Get-Date -Format "yyyyMMdd-HHmmss"

  if (-not (Test-Path -LiteralPath $indexPath)) { throw "index.js not found." }
  if (-not (Test-Path -LiteralPath $serverPath)) { throw "local_ai_server.py not found." }
  if (-not (Test-Path -LiteralPath $envPath)) { throw ".env not found." }

  New-Item -ItemType Directory -Path $patchesDir -Force | Out-Null
  New-Item -ItemType Directory -Path $backupDir -Force | Out-Null

  Write-Info "Project root: $projectRoot"

  $indexBackup = Join-Path $backupDir "index.js.switch-to-zimage-v3-$stamp.bak"
  $serverBackup = Join-Path $backupDir "local_ai_server.py.switch-to-zimage-v3-$stamp.bak"
  $envBackup = Join-Path $backupDir ".env.switch-to-zimage-v3-$stamp.bak"
  Copy-Item -LiteralPath $indexPath -Destination $indexBackup -Force
  Copy-Item -LiteralPath $serverPath -Destination $serverBackup -Force
  Copy-Item -LiteralPath $envPath -Destination $envBackup -Force
  Write-Pass "Backed up index.js to $indexBackup"
  Write-Pass "Backed up local_ai_server.py to $serverBackup"
  Write-Pass "Backed up .env to $envBackup"

  $utf8NoBom = [System.Text.UTF8Encoding]::new($false)

  $patchPy = @'
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
'@

  $patchPyPath = Join-Path $patchesDir "patch_switch_to_zimage_v3.py"
  [System.IO.File]::WriteAllText($patchPyPath, $patchPy, $utf8NoBom)

  Push-Location $projectRoot
  try {
    Write-Info "Verifying ZImagePipeline is installed"
    & ".\.venv\Scripts\python.exe" -c "from diffusers import ZImagePipeline; print('ZImagePipeline OK')"
    if ($LASTEXITCODE -ne 0) {
      throw "ZImagePipeline import failed. The previous package update did not complete correctly."
    }
    Write-Pass "ZImagePipeline import verified"

    Write-Info "Applying v3 Z-Image patch"
    & ".\.venv\Scripts\python.exe" $patchPyPath $indexPath $serverPath $envPath
    if ($LASTEXITCODE -ne 0) { throw "Patch helper failed with exit code $LASTEXITCODE." }
    Write-Pass "Patched files"

    Invoke-CheckedCommand "node --check .\index.js" { & node --check ".\index.js" }
    Invoke-CheckedCommand ".\.venv\Scripts\python.exe -m py_compile .\local_ai_server.py" { & ".\.venv\Scripts\python.exe" -m py_compile ".\local_ai_server.py" }

    $cacheRoot = Join-Path $projectRoot "models\huggingface"
    $zImageCache = Join-Path $cacheRoot "models--Tongyi-MAI--Z-Image"
    $sdxlCache = Join-Path $cacheRoot "models--stabilityai--stable-diffusion-xl-base-1.0"
    $sanaCache = Join-Path $cacheRoot "models--Efficient-Large-Model--Sana_Sprint_1.6B_1024px_diffusers"

    Write-Host ""
    Write-Info "Current cache sizes:"
    Write-Host "Z-Image:     $(Format-Bytes (Get-DirectorySizeBytes $zImageCache))  $zImageCache"
    Write-Host "SDXL:        $(Format-Bytes (Get-DirectorySizeBytes $sdxlCache))  $sdxlCache"
    Write-Host "Sana Sprint: $(Format-Bytes (Get-DirectorySizeBytes $sanaCache))  $sanaCache"

    $answer = Read-Host "Delete any existing partial Z-Image cache before download? Type DELETE to remove it, or press Enter to keep"
    if ($answer -ceq "DELETE" -and (Test-Path -LiteralPath $zImageCache)) {
      Remove-Item -LiteralPath $zImageCache -Recurse -Force
      Write-Pass "Deleted existing Z-Image cache"
    }

    $answer = Read-Host "Delete old SDXL cache now? Type DELETE to remove it, or press Enter to keep"
    if ($answer -ceq "DELETE" -and (Test-Path -LiteralPath $sdxlCache)) {
      Remove-Item -LiteralPath $sdxlCache -Recurse -Force
      Write-Pass "Deleted old SDXL cache"
    }

    $answer = Read-Host "Delete old Sana Sprint cache now? Type DELETE to remove it, or press Enter to keep"
    if ($answer -ceq "DELETE" -and (Test-Path -LiteralPath $sanaCache)) {
      Remove-Item -LiteralPath $sanaCache -Recurse -Force
      Write-Pass "Deleted old Sana Sprint cache"
    }

    $downloadPy = @'
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
'@

    $downloadPyPath = Join-Path $patchesDir "download_zimage_v3.py"
    [System.IO.File]::WriteAllText($downloadPyPath, $downloadPy, $utf8NoBom)

    Write-Info "Downloading/loading Tongyi-MAI/Z-Image locally. This can be large."
    & ".\.venv\Scripts\python.exe" $downloadPyPath
    if ($LASTEXITCODE -ne 0) { throw "Z-Image download/load failed with exit code $LASTEXITCODE." }
    Write-Pass "Z-Image downloaded/loaded successfully"

    $envText = [System.IO.File]::ReadAllText($envPath, $utf8NoBom)
    $envText = $envText -replace "`r`n", "`n"
    $envText = $envText -replace "`r", "`n"
    $envText = Set-EnvLine $envText "HF_LOCAL_FILES_ONLY" "true"
    $envText = Set-EnvLine $envText "HF_HUB_OFFLINE" "1"
    $envText = Set-EnvLine $envText "TRANSFORMERS_OFFLINE" "1"
    $envText = Set-EnvLine $envText "HF_DATASETS_OFFLINE" "1"
    [System.IO.File]::WriteAllText($envPath, $envText.Replace("`n", "`r`n"), $utf8NoBom)
    Write-Pass "Restored offline Hugging Face flags in .env"

    Write-Host ""
    Write-Info "Final cache sizes:"
    Write-Host "Z-Image:     $(Format-Bytes (Get-DirectorySizeBytes $zImageCache))  $zImageCache"
    Write-Host "SDXL:        $(Format-Bytes (Get-DirectorySizeBytes $sdxlCache))  $sdxlCache"
    Write-Host "Sana Sprint: $(Format-Bytes (Get-DirectorySizeBytes $sanaCache))  $sanaCache"

    Invoke-CheckedCommand "node --check .\index.js" { & node --check ".\index.js" }
    Invoke-CheckedCommand ".\.venv\Scripts\python.exe -m py_compile .\local_ai_server.py" { & ".\.venv\Scripts\python.exe" -m py_compile ".\local_ai_server.py" }
  } finally {
    Pop-Location
  }

  Write-Host ""
  Write-Pass "Tongyi-MAI/Z-Image v3 setup completed."
  Write-Host "Restart both local_ai_server.py and the Discord bot." -ForegroundColor Yellow
  exit 0
} catch {
  Write-Host ""
  Write-Fail $_.Exception.Message
  Write-Host "Backups available:" -ForegroundColor Yellow
  if ($indexBackup) { Write-Host $indexBackup -ForegroundColor Yellow }
  if ($serverBackup) { Write-Host $serverBackup -ForegroundColor Yellow }
  if ($envBackup) { Write-Host $envBackup -ForegroundColor Yellow }
  exit 1
}
