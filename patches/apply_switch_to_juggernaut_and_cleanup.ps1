# SeekDeep / Seekotics switch image model to Juggernaut XL v9 and clean old model caches
#
# Purpose:
# - Replace the current image model with RunDiffusion/Juggernaut-XL-v9
# - Keep runtime fully local/offline after the one-time download
# - Reclaim disk space by deleting old image model caches you no longer want
#
# Workflow guarantees:
# - Backs up index.js first
# - Also backs up local_ai_server.py and .env
# - Uses UTF-8-safe file operations
# - Runs:
#     node --check .\index.js
#     .\.venv\Scripts\python.exe -m py_compile .\local_ai_server.py
#
# Notes:
# - This is intentionally a low-risk env/cache swap. It does NOT rewrite queue/routing logic.
# - Juggernaut XL v9 is an SDXL-family checkpoint, so your current generic DiffusionPipeline path should be fine.

$ErrorActionPreference = "Stop"

try {
  [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
} catch {}

function Write-Info {
  param([string]$Message)
  Write-Host "[SeekDeep Juggernaut] $Message" -ForegroundColor Cyan
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

  $indexBackup = Join-Path $backupDir "index.js.switch-to-juggernaut-$stamp.bak"
  $serverBackup = Join-Path $backupDir "local_ai_server.py.switch-to-juggernaut-$stamp.bak"
  $envBackup = Join-Path $backupDir ".env.switch-to-juggernaut-$stamp.bak"

  # Required by your workflow: back up index.js first.
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
'@

  $patchPyPath = Join-Path $patchesDir "patch_juggernaut_env.py"
  [System.IO.File]::WriteAllText($patchPyPath, $patchPy, $utf8NoBom)

  Push-Location $projectRoot
  try {
    Write-Info "Patching .env for Juggernaut XL v9"
    & ".\.venv\Scripts\python.exe" $patchPyPath $envPath
    if ($LASTEXITCODE -ne 0) {
      throw "Patch helper failed with exit code $LASTEXITCODE."
    }
    Write-Pass "Patched .env"

    Invoke-CheckedCommand "node --check .\index.js" {
      & node --check ".\index.js"
    }

    Invoke-CheckedCommand ".\.venv\Scripts\python.exe -m py_compile .\local_ai_server.py" {
      & ".\.venv\Scripts\python.exe" -m py_compile ".\local_ai_server.py"
    }

    $cacheRoot = Join-Path $projectRoot "models\huggingface"
    New-Item -ItemType Directory -Path $cacheRoot -Force | Out-Null

    $candidateCaches = @(
      @{ Label = "Z-Image"; Path = (Join-Path $cacheRoot "models--Tongyi-MAI--Z-Image") },
      @{ Label = "SDXL Base"; Path = (Join-Path $cacheRoot "models--stabilityai--stable-diffusion-xl-base-1.0") },
      @{ Label = "Sana Sprint"; Path = (Join-Path $cacheRoot "models--Efficient-Large-Model--Sana_Sprint_1.6B_1024px_diffusers") },
      @{ Label = "Sana Sprint alt"; Path = (Join-Path $cacheRoot "models--Efficient-Large-Model--Sana_Sprint_1.6B_1024px") }
    )

    foreach ($entry in $candidateCaches) {
      if (Test-Path -LiteralPath $entry.Path) {
        $prompt = "Delete old cache for $($entry.Label)? Type DELETE to confirm, or press Enter to keep"
        $answer = Read-Host $prompt
        if ($answer -ceq "DELETE") {
          Write-Info "Deleting $($entry.Label) cache: $($entry.Path)"
          Remove-Item -LiteralPath $entry.Path -Recurse -Force
          Write-Pass "Deleted $($entry.Label) cache"
        } else {
          Write-Warn "Kept $($entry.Label) cache"
        }
      }
    }

    $juggCache = Join-Path $cacheRoot "models--RunDiffusion--Juggernaut-XL-v9"
    if (Test-Path -LiteralPath $juggCache) {
      $answer = Read-Host "Delete any existing partial Juggernaut cache before download? Type DELETE to remove it, or press Enter to keep"
      if ($answer -ceq "DELETE") {
        Remove-Item -LiteralPath $juggCache -Recurse -Force
        Write-Pass "Deleted existing Juggernaut cache"
      }
    }

    $downloadPy = @'
import gc
import os
from pathlib import Path

from dotenv import load_dotenv
load_dotenv()

import torch
from diffusers import DiffusionPipeline

model_id = os.getenv("LOCAL_IMAGE_MODEL_ID", "RunDiffusion/Juggernaut-XL-v9")
cache_dir = Path(os.getenv("LOCAL_MODEL_CACHE_DIR", "./models/huggingface"))
if not cache_dir.is_absolute():
    cache_dir = Path.cwd() / cache_dir
cache_dir.mkdir(parents=True, exist_ok=True)

token = os.getenv("HF_TOKEN") or os.getenv("HUGGINGFACE_TOKEN") or None
dtype_name = os.getenv("LOCAL_TORCH_DTYPE", "float16").lower()
if dtype_name == "bfloat16":
    dtype = torch.bfloat16
elif dtype_name == "float32":
    dtype = torch.float32
else:
    dtype = torch.float16

variant = os.getenv("LOCAL_IMAGE_VARIANT", "").strip()
use_safetensors = os.getenv("IMAGE_USE_SAFETENSORS", "true").strip().lower() not in {"0", "false", "no", "off"}

kwargs = {
    "cache_dir": str(cache_dir),
    "local_files_only": False,
    "torch_dtype": dtype,
    "use_safetensors": use_safetensors,
}
if token:
    kwargs["token"] = token
if variant:
    kwargs["variant"] = variant

print(f"[SeekDeep Juggernaut] model_id={model_id}")
print(f"[SeekDeep Juggernaut] cache_dir={cache_dir}")
print(f"[SeekDeep Juggernaut] dtype={dtype}")
print(f"[SeekDeep Juggernaut] variant={variant or '(none)'}")
print(f"[SeekDeep Juggernaut] use_safetensors={use_safetensors}")

pipe = DiffusionPipeline.from_pretrained(model_id, **kwargs)
if torch.cuda.is_available():
    pipe = pipe.to("cuda")

print("[SeekDeep Juggernaut] pipeline downloaded and loaded successfully")

del pipe
gc.collect()
if torch.cuda.is_available():
    torch.cuda.empty_cache()
'@

    $downloadPyPath = Join-Path $patchesDir "download_juggernaut.py"
    [System.IO.File]::WriteAllText($downloadPyPath, $downloadPy, $utf8NoBom)

    Write-Info "Downloading/loading RunDiffusion/Juggernaut-XL-v9 locally"
    & ".\.venv\Scripts\python.exe" $downloadPyPath
    if ($LASTEXITCODE -ne 0) {
      throw "Juggernaut download/load failed with exit code $LASTEXITCODE."
    }
    Write-Pass "Juggernaut downloaded and loaded successfully"

    $envText = [System.IO.File]::ReadAllText($envPath, $utf8NoBom)
    $envText = $envText -replace "`r`n", "`n"
    $envText = $envText -replace "`r", "`n"
    $envText = Set-EnvLine $envText "HF_LOCAL_FILES_ONLY" "true"
    $envText = Set-EnvLine $envText "HF_HUB_OFFLINE" "1"
    $envText = Set-EnvLine $envText "TRANSFORMERS_OFFLINE" "1"
    $envText = Set-EnvLine $envText "HF_DATASETS_OFFLINE" "1"
    [System.IO.File]::WriteAllText($envPath, $envText.Replace("`n", "`r`n"), $utf8NoBom)
    Write-Pass "Restored offline Hugging Face flags in .env"

    Invoke-CheckedCommand "node --check .\index.js" {
      & node --check ".\index.js"
    }

    Invoke-CheckedCommand ".\.venv\Scripts\python.exe -m py_compile .\local_ai_server.py" {
      & ".\.venv\Scripts\python.exe" -m py_compile ".\local_ai_server.py"
    }

    Write-Info "Current major image caches under $cacheRoot"
    Get-ChildItem -LiteralPath $cacheRoot -Force -ErrorAction SilentlyContinue |
      Where-Object { $_.PSIsContainer -and $_.Name -like 'models--*' } |
      Select-Object Name, @{Name='SizeGB';Expression={
        $sum = (Get-ChildItem -LiteralPath $_.FullName -Recurse -File -ErrorAction SilentlyContinue | Measure-Object -Property Length -Sum).Sum
        if ($null -eq $sum) { 0 } else { [math]::Round($sum / 1GB, 2) }
      }} |
      Sort-Object Name |
      Format-Table -AutoSize

  } finally {
    Pop-Location
  }

  Write-Host ""
  Write-Pass "Juggernaut XL v9 setup completed."
  Write-Host "Restart both:" -ForegroundColor Yellow
  Write-Host "1. local_ai_server.py" -ForegroundColor Yellow
  Write-Host "2. Discord bot" -ForegroundColor Yellow
  Write-Host ""
  Write-Host "Recommended first test prompt:" -ForegroundColor Cyan
  Write-Host '@SEEKOTICS draw me a gritty punk poster of Pepe the frog under red and blue neon lighting' -ForegroundColor White
  exit 0
} catch {
  Write-Host ""
  Write-Fail $_.Exception.Message
  Write-Host "Backups are available here:" -ForegroundColor Yellow
  if ($indexBackup) { Write-Host $indexBackup -ForegroundColor Yellow }
  if ($serverBackup) { Write-Host $serverBackup -ForegroundColor Yellow }
  if ($envBackup) { Write-Host $envBackup -ForegroundColor Yellow }
  exit 1
}
