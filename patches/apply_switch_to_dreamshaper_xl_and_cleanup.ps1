# SeekDeep / Seekotics switch image model to DreamShaper XL and optionally clean old caches
#
# Purpose:
# - Move away from Juggernaut XL v9's smooth/photoreal bias
# - Use a more artistic SDXL-family checkpoint: Lykon/dreamshaper-xl-1-0
# - Keep runtime local/offline after one-time download
# - Optionally delete old image model caches to reclaim SSD space
#
# Files patched:
# - .env
#
# Files backed up:
# - index.js first
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
  Write-Host "[SeekDeep DreamShaper] $Message" -ForegroundColor Cyan
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

  $indexBackup = Join-Path $backupDir "index.js.switch-to-dreamshaper-xl-$stamp.bak"
  $serverBackup = Join-Path $backupDir "local_ai_server.py.switch-to-dreamshaper-xl-$stamp.bak"
  $envBackup = Join-Path $backupDir ".env.switch-to-dreamshaper-xl-$stamp.bak"

  # Required by your workflow: back up index.js first.
  Copy-Item -LiteralPath $indexPath -Destination $indexBackup -Force
  Copy-Item -LiteralPath $serverPath -Destination $serverBackup -Force
  Copy-Item -LiteralPath $envPath -Destination $envBackup -Force

  Write-Pass "Backed up index.js to $indexBackup"
  Write-Pass "Backed up local_ai_server.py to $serverBackup"
  Write-Pass "Backed up .env to $envBackup"

  $utf8NoBom = [System.Text.UTF8Encoding]::new($false)

  $envText = [System.IO.File]::ReadAllText($envPath, $utf8NoBom)
  $envText = $envText -replace "`r`n", "`n"
  $envText = $envText -replace "`r", "`n"

  # DreamShaper XL is SDXL-family. Use the generic DiffusionPipeline path.
  $envText = Set-EnvLine $envText "LOCAL_IMAGE_MODEL_ID" "Lykon/dreamshaper-xl-1-0"
  $envText = Set-EnvLine $envText "LOCAL_IMAGE_PIPELINE_CLASS" ""
  $envText = Set-EnvLine $envText "LOCAL_IMAGE_VARIANT" ""
  $envText = Set-EnvLine $envText "IMAGE_USE_SAFETENSORS" "true"
  $envText = Set-EnvLine $envText "LOCAL_TORCH_DTYPE" "float16"
  $envText = Set-EnvLine $envText "IMAGE_STEPS" "30"
  $envText = Set-EnvLine $envText "IMAGE_GUIDANCE_SCALE" "6.5"
  $envText = Set-EnvLine $envText "IMAGE_CFG_NORMALIZATION" "false"
  $envText = Set-EnvLine $envText "IMAGE_NEGATIVE_PROMPT" ""

  # Temporarily allow Hugging Face download. Restored after successful download.
  $envText = Set-EnvLine $envText "HF_LOCAL_FILES_ONLY" "false"
  $envText = Set-EnvLine $envText "HF_HUB_OFFLINE" "0"
  $envText = Set-EnvLine $envText "TRANSFORMERS_OFFLINE" "0"
  $envText = Set-EnvLine $envText "HF_DATASETS_OFFLINE" "0"

  [System.IO.File]::WriteAllText($envPath, $envText.Replace("`n", "`r`n"), $utf8NoBom)
  Write-Pass "Patched .env for DreamShaper XL"

  Push-Location $projectRoot
  try {
    Invoke-CheckedCommand "node --check .\index.js" {
      & node --check ".\index.js"
    }

    Invoke-CheckedCommand ".\.venv\Scripts\python.exe -m py_compile .\local_ai_server.py" {
      & ".\.venv\Scripts\python.exe" -m py_compile ".\local_ai_server.py"
    }

    $cacheRoot = Join-Path $projectRoot "models\huggingface"
    New-Item -ItemType Directory -Path $cacheRoot -Force | Out-Null

    $dreamCache = Join-Path $cacheRoot "models--Lykon--dreamshaper-xl-1-0"
    if (Test-Path -LiteralPath $dreamCache) {
      Write-Host ""
      Write-Warn "Existing/partial DreamShaper cache found: $dreamCache"
      Write-Host "Size: $(Format-Bytes (Get-DirectorySizeBytes $dreamCache))"
      $answer = Read-Host "Delete existing DreamShaper cache before clean download? Type DELETE to remove it, or press Enter to keep"
      if ($answer -ceq "DELETE") {
        Remove-Item -LiteralPath $dreamCache -Recurse -Force
        Write-Pass "Deleted existing DreamShaper cache"
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

model_id = os.getenv("LOCAL_IMAGE_MODEL_ID", "Lykon/dreamshaper-xl-1-0")
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

print(f"[SeekDeep DreamShaper] model_id={model_id}")
print(f"[SeekDeep DreamShaper] cache_dir={cache_dir}")
print(f"[SeekDeep DreamShaper] dtype={dtype}")
print(f"[SeekDeep DreamShaper] variant={variant or '(none)'}")
print(f"[SeekDeep DreamShaper] use_safetensors={use_safetensors}")

pipe = DiffusionPipeline.from_pretrained(model_id, **kwargs)
if torch.cuda.is_available():
    pipe = pipe.to("cuda")

print("[SeekDeep DreamShaper] pipeline downloaded and loaded successfully")

del pipe
gc.collect()
if torch.cuda.is_available():
    torch.cuda.empty_cache()
'@

    $downloadPyPath = Join-Path $patchesDir "download_dreamshaper_xl.py"
    [System.IO.File]::WriteAllText($downloadPyPath, $downloadPy, $utf8NoBom)

    Write-Info "Downloading/loading Lykon/dreamshaper-xl-1-0 locally"
    & ".\.venv\Scripts\python.exe" $downloadPyPath
    if ($LASTEXITCODE -ne 0) {
      throw "DreamShaper download/load failed with exit code $LASTEXITCODE."
    }
    Write-Pass "DreamShaper downloaded and loaded successfully"

    # Restore offline mode after successful download.
    $envText = [System.IO.File]::ReadAllText($envPath, $utf8NoBom)
    $envText = $envText -replace "`r`n", "`n"
    $envText = $envText -replace "`r", "`n"
    $envText = Set-EnvLine $envText "HF_LOCAL_FILES_ONLY" "true"
    $envText = Set-EnvLine $envText "HF_HUB_OFFLINE" "1"
    $envText = Set-EnvLine $envText "TRANSFORMERS_OFFLINE" "1"
    $envText = Set-EnvLine $envText "HF_DATASETS_OFFLINE" "1"
    [System.IO.File]::WriteAllText($envPath, $envText.Replace("`n", "`r`n"), $utf8NoBom)
    Write-Pass "Restored offline Hugging Face flags in .env"

    # Now that DreamShaper is confirmed available, offer cleanup of old image model caches.
    $candidateCaches = @(
      @{ Label = "Juggernaut XL v9"; Path = (Join-Path $cacheRoot "models--RunDiffusion--Juggernaut-XL-v9") },
      @{ Label = "Z-Image"; Path = (Join-Path $cacheRoot "models--Tongyi-MAI--Z-Image") },
      @{ Label = "SDXL Base"; Path = (Join-Path $cacheRoot "models--stabilityai--stable-diffusion-xl-base-1.0") },
      @{ Label = "Sana Sprint"; Path = (Join-Path $cacheRoot "models--Efficient-Large-Model--Sana_Sprint_1.6B_1024px_diffusers") },
      @{ Label = "Sana Sprint alt"; Path = (Join-Path $cacheRoot "models--Efficient-Large-Model--Sana_Sprint_1.6B_1024px") }
    )

    foreach ($entry in $candidateCaches) {
      if (Test-Path -LiteralPath $entry.Path) {
        Write-Host ""
        Write-Warn "Old cache found: $($entry.Label)"
        Write-Host $entry.Path
        Write-Host "Size: $(Format-Bytes (Get-DirectorySizeBytes $entry.Path))"
        $answer = Read-Host "Delete $($entry.Label) cache now? Type DELETE to confirm, or press Enter to keep"
        if ($answer -ceq "DELETE") {
          Remove-Item -LiteralPath $entry.Path -Recurse -Force
          Write-Pass "Deleted $($entry.Label) cache"
        } else {
          Write-Warn "Kept $($entry.Label) cache"
        }
      }
    }

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
  Write-Pass "DreamShaper XL setup completed."
  Write-Host "Restart both:" -ForegroundColor Yellow
  Write-Host "1. local_ai_server.py" -ForegroundColor Yellow
  Write-Host "2. Discord bot" -ForegroundColor Yellow
  Write-Host ""
  Write-Host "Recommended first test prompt:" -ForegroundColor Cyan
  Write-Host '@SEEKOTICS generate Pepe and Sailor Moon smoking together on a balcony during the sunset over a forest' -ForegroundColor White
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
