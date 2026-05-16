
# SeekDeep / Seekotics safer SDXL runtime download + fp16 setup
#
# Purpose:
# - Avoid full-repo snapshot_download bloat.
# - Configure SDXL runtime to use fp16 safetensors when available.
# - Optionally delete old/partial SDXL cache first.
# - Download the runtime pipeline via DiffusionPipeline.from_pretrained().
# - Restore offline Hugging Face flags after successful download.
#
# Files patched:
# - local_ai_server.py
# - .env
#
# Required checks:
#   node --check .\index.js
#   .\.venv\Scripts\python.exe -m py_compile .\local_ai_server.py

$ErrorActionPreference = "Stop"

try {
  [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
} catch {}

function Write-Info {
  param([string]$Message)
  Write-Host "[SeekDeep SDXL minimal] $Message" -ForegroundColor Cyan
}

function Write-Pass {
  param([string]$Message)
  Write-Host "[PASS] $Message" -ForegroundColor Green
}

function Write-Warn {
  param([string]$Message)
  Write-Host "[WARN] $Message" -ForegroundColor Yellow
}

function Write-Fail {
  param([string]$Message)
  Write-Host "[FAIL] $Message" -ForegroundColor Red
}

function Get-DirectorySizeBytes {
  param([string]$Path)

  if (-not (Test-Path -LiteralPath $Path)) {
    return 0
  }

  $sum = 0
  Get-ChildItem -LiteralPath $Path -Recurse -Force -ErrorAction SilentlyContinue | ForEach-Object {
    if (-not $_.PSIsContainer) {
      $sum += $_.Length
    }
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

function Set-EnvLine {
  param(
    [string]$Text,
    [string]$Key,
    [string]$Value
  )

  $escaped = [regex]::Escape($Key)
  if ($Text -match "(?m)^$escaped=") {
    return [regex]::Replace($Text, "(?m)^$escaped=.*$", "$Key=$Value")
  }

  if ($Text.Length -gt 0 -and -not $Text.EndsWith("`n")) {
    $Text += "`n"
  }

  return $Text + "$Key=$Value`n"
}

function Invoke-CheckedCommand {
  param(
    [Parameter(Mandatory=$true)][string]$Label,
    [Parameter(Mandatory=$true)][scriptblock]$Command
  )

  Write-Info "Running $Label"
  & $Command
  if ($LASTEXITCODE -ne 0) {
    throw "$Label failed with exit code $LASTEXITCODE."
  }

  Write-Pass "$Label passed"
}

try {
  $projectRoot = Join-Path $env:USERPROFILE "SeekDeep-DiscordBot"
  if (-not (Test-Path -LiteralPath (Join-Path $projectRoot "index.js"))) {
    $projectRoot = (Get-Location).Path
  }

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

  $serverBackup = Join-Path $backupDir "local_ai_server.py.sdxl-fp16-runtime-download-$stamp.bak"
  $envBackup = Join-Path $backupDir ".env.sdxl-fp16-runtime-download-$stamp.bak"

  Copy-Item -LiteralPath $serverPath -Destination $serverBackup -Force
  Copy-Item -LiteralPath $envPath -Destination $envBackup -Force

  Write-Pass "Backed up local_ai_server.py to $serverBackup"
  Write-Pass "Backed up .env to $envBackup"

  $utf8NoBom = [System.Text.UTF8Encoding]::new($false)

  $patchPy = @'
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
'@

  $patchPyPath = Join-Path $patchesDir "patch_sdxl_fp16_runtime.py"
  [System.IO.File]::WriteAllText($patchPyPath, $patchPy, $utf8NoBom)

  Push-Location $projectRoot
  try {
    Write-Info "Patching SDXL fp16 runtime settings"
    & ".\.venv\Scripts\python.exe" $patchPyPath $serverPath $envPath
    if ($LASTEXITCODE -ne 0) {
      throw "SDXL fp16 runtime patch failed with exit code $LASTEXITCODE."
    }
    Write-Pass "Patched runtime settings"

    Invoke-CheckedCommand "node --check .\index.js" {
      & node --check ".\index.js"
    }

    Invoke-CheckedCommand ".\.venv\Scripts\python.exe -m py_compile .\local_ai_server.py" {
      & ".\.venv\Scripts\python.exe" -m py_compile ".\local_ai_server.py"
    }

    $cacheRoot = Join-Path $projectRoot "models\huggingface"
    $sdxlCache = Join-Path $cacheRoot "models--stabilityai--stable-diffusion-xl-base-1.0"
    $sanaCache = Join-Path $cacheRoot "models--Efficient-Large-Model--Sana_Sprint_1.6B_1024px_diffusers"

    Write-Host ""
    Write-Info "Current cache sizes before download:"
    Write-Host "SDXL:        $sdxlCache"
    Write-Host "             $(Format-Bytes (Get-DirectorySizeBytes $sdxlCache))"
    Write-Host "Sana Sprint: $sanaCache"
    Write-Host "             $(Format-Bytes (Get-DirectorySizeBytes $sanaCache))"

    if (Test-Path -LiteralPath $sdxlCache) {
      Write-Host ""
      Write-Warn "Partial/existing SDXL cache exists."
      $answer = Read-Host "Delete existing SDXL cache first to avoid carrying full-snapshot bloat? Type DELETE to remove it, or press Enter to keep/resume"
      if ($answer -ceq "DELETE") {
        Remove-Item -LiteralPath $sdxlCache -Recurse -Force
        Write-Pass "Deleted existing SDXL cache"
      } else {
        Write-Warn "Keeping existing SDXL cache; download may reuse partial files."
      }
    }

    if (Test-Path -LiteralPath $sanaCache) {
      Write-Host ""
      Write-Warn "Old Sana Sprint cache exists."
      $answer = Read-Host "Delete old Sana Sprint cache now? Type DELETE to remove it, or press Enter to keep"
      if ($answer -ceq "DELETE") {
        Remove-Item -LiteralPath $sanaCache -Recurse -Force
        Write-Pass "Deleted old Sana Sprint cache"
      } else {
        Write-Warn "Keeping old Sana Sprint cache."
      }
    }

    $downloadPy = @'
import gc
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
variant = os.getenv("LOCAL_IMAGE_VARIANT", "").strip() or None
use_safetensors = os.getenv("IMAGE_USE_SAFETENSORS", "true").lower() not in {"0", "false", "no", "off"}

import torch
from diffusers import DiffusionPipeline

dtype_name = os.getenv("LOCAL_TORCH_DTYPE", "float16").lower()
dtype = torch.float16 if dtype_name == "float16" else torch.bfloat16 if dtype_name == "bfloat16" else torch.float32

kwargs = {
    "cache_dir": str(cache_dir),
    "token": token,
    "local_files_only": False,
    "torch_dtype": dtype,
    "use_safetensors": use_safetensors,
}
if variant:
    kwargs["variant"] = variant

print(f"[SeekDeep SDXL minimal] model_id={model_id}")
print(f"[SeekDeep SDXL minimal] cache_dir={cache_dir}")
print(f"[SeekDeep SDXL minimal] variant={variant}")
print(f"[SeekDeep SDXL minimal] use_safetensors={use_safetensors}")
print(f"[SeekDeep SDXL minimal] dtype={dtype}")

pipe = DiffusionPipeline.from_pretrained(model_id, **kwargs)
print("[SeekDeep SDXL minimal] pipeline loaded from cache/download successfully")

del pipe
gc.collect()
if torch.cuda.is_available():
    torch.cuda.empty_cache()
'@

    $downloadPyPath = Join-Path $patchesDir "download_sdxl_via_diffusers.py"
    [System.IO.File]::WriteAllText($downloadPyPath, $downloadPy, $utf8NoBom)

    Write-Info "Downloading/loading SDXL via DiffusionPipeline.from_pretrained. This should avoid full snapshot_download bloat."
    & ".\.venv\Scripts\python.exe" $downloadPyPath
    if ($LASTEXITCODE -ne 0) {
      throw "SDXL runtime download/load failed with exit code $LASTEXITCODE."
    }

    Write-Pass "SDXL runtime pipeline downloaded/loaded successfully"

    # Restore offline flags.
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
    Write-Host "SDXL:        $sdxlCache"
    Write-Host "             $(Format-Bytes (Get-DirectorySizeBytes $sdxlCache))"
    Write-Host "Sana Sprint: $sanaCache"
    Write-Host "             $(Format-Bytes (Get-DirectorySizeBytes $sanaCache))"

    Invoke-CheckedCommand "node --check .\index.js" {
      & node --check ".\index.js"
    }

    Invoke-CheckedCommand ".\.venv\Scripts\python.exe -m py_compile .\local_ai_server.py" {
      & ".\.venv\Scripts\python.exe" -m py_compile ".\local_ai_server.py"
    }
  } finally {
    Pop-Location
  }

  Write-Host ""
  Write-Pass "SDXL fp16 runtime setup completed."
  Write-Host "Restart both local_ai_server.py and the Discord bot." -ForegroundColor Yellow
  exit 0
} catch {
  Write-Host ""
  Write-Fail $_.Exception.Message
  Write-Host "Backups:" -ForegroundColor Yellow
  if ($serverBackup) { Write-Host $serverBackup -ForegroundColor Yellow }
  if ($envBackup) { Write-Host $envBackup -ForegroundColor Yellow }
  exit 1
}
