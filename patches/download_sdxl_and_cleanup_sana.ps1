# SeekDeep / Seekotics SDXL download + Sana Sprint cache cleanup helper
#
# Purpose:
# - Download/cache SDXL locally.
# - Keep your .env offline-friendly after the download.
# - Optionally remove the old Sana Sprint cache to recover SSD space.
#
# This script does NOT modify index.js or local_ai_server.py.
#
# It will:
# 1. Back up .env.
# 2. Temporarily set offline flags to false for download.
# 3. Ensure LOCAL_IMAGE_MODEL_ID=stabilityai/stable-diffusion-xl-base-1.0.
# 4. Download SDXL using huggingface_hub.snapshot_download().
# 5. Restore offline flags to true.
# 6. Show SDXL/Sana cache sizes.
# 7. Ask before deleting old Sana Sprint cache.
# 8. Run:
#      node --check .\index.js
#      .\.venv\Scripts\python.exe -m py_compile .\local_ai_server.py

$ErrorActionPreference = "Stop"

try {
  [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
} catch {}

function Write-Info {
  param([string]$Message)
  Write-Host "[SeekDeep SDXL] $Message" -ForegroundColor Cyan
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

try {
  $projectRoot = Join-Path $env:USERPROFILE "SeekDeep-DiscordBot"
  if (-not (Test-Path -LiteralPath (Join-Path $projectRoot "index.js"))) {
    $projectRoot = (Get-Location).Path
  }

  $indexPath = Join-Path $projectRoot "index.js"
  $serverPath = Join-Path $projectRoot "local_ai_server.py"
  $envPath = Join-Path $projectRoot ".env"
  $backupDir = Join-Path $projectRoot "patches\backups"
  $stamp = Get-Date -Format "yyyyMMdd-HHmmss"

  if (-not (Test-Path -LiteralPath $indexPath)) { throw "index.js not found." }
  if (-not (Test-Path -LiteralPath $serverPath)) { throw "local_ai_server.py not found." }
  if (-not (Test-Path -LiteralPath $envPath)) { throw ".env not found." }

  New-Item -ItemType Directory -Path $backupDir -Force | Out-Null

  Write-Info "Project root: $projectRoot"

  $envBackup = Join-Path $backupDir ".env.before-sdxl-download-$stamp.bak"
  Copy-Item -LiteralPath $envPath -Destination $envBackup -Force
  Write-Pass "Backed up .env to $envBackup"

  $utf8NoBom = [System.Text.UTF8Encoding]::new($false)
  $envText = [System.IO.File]::ReadAllText($envPath, $utf8NoBom)
  $envText = $envText -replace "`r`n", "`n"
  $envText = $envText -replace "`r", "`n"

  # Keep the SDXL replacement settings explicit.
  $envText = Set-EnvLine $envText "LOCAL_IMAGE_MODEL_ID" "stabilityai/stable-diffusion-xl-base-1.0"
  $envText = Set-EnvLine $envText "IMAGE_STEPS" "28"
  $envText = Set-EnvLine $envText "IMAGE_GUIDANCE_SCALE" "6.5"

  # Temporarily allow model download.
  $envText = Set-EnvLine $envText "HF_LOCAL_FILES_ONLY" "false"
  $envText = Set-EnvLine $envText "HF_HUB_OFFLINE" "0"
  $envText = Set-EnvLine $envText "TRANSFORMERS_OFFLINE" "0"
  $envText = Set-EnvLine $envText "HF_DATASETS_OFFLINE" "0"

  [System.IO.File]::WriteAllText($envPath, $envText.Replace("`n", "`r`n"), $utf8NoBom)
  Write-Pass "Temporarily enabled Hugging Face downloads in .env"

  Push-Location $projectRoot
  try {
    Write-Info "Downloading SDXL into local Hugging Face cache. This can take a while."

    $downloadPy = @'
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

try:
    from huggingface_hub import snapshot_download
except Exception as exc:
    raise SystemExit(f"huggingface_hub is not installed in this venv: {exc}")

print(f"[SeekDeep SDXL] model_id={model_id}")
print(f"[SeekDeep SDXL] cache_dir={cache_dir}")

path = snapshot_download(
    repo_id=model_id,
    cache_dir=str(cache_dir),
    token=token,
    local_files_only=False,
    resume_download=True,
)

print(f"[SeekDeep SDXL] downloaded snapshot: {path}")
'@

    $downloadPyPath = Join-Path $projectRoot "patches\download_sdxl_model.py"
    [System.IO.File]::WriteAllText($downloadPyPath, $downloadPy, $utf8NoBom)

    & ".\.venv\Scripts\python.exe" $downloadPyPath
    if ($LASTEXITCODE -ne 0) {
      throw "SDXL download failed with exit code $LASTEXITCODE. If this is a gated-model error, accept the model terms on Hugging Face for your account/token, then rerun."
    }

    Write-Pass "SDXL download completed"

    # Restore offline flags after download.
    $envText = [System.IO.File]::ReadAllText($envPath, $utf8NoBom)
    $envText = $envText -replace "`r`n", "`n"
    $envText = $envText -replace "`r", "`n"
    $envText = Set-EnvLine $envText "HF_LOCAL_FILES_ONLY" "true"
    $envText = Set-EnvLine $envText "HF_HUB_OFFLINE" "1"
    $envText = Set-EnvLine $envText "TRANSFORMERS_OFFLINE" "1"
    $envText = Set-EnvLine $envText "HF_DATASETS_OFFLINE" "1"
    [System.IO.File]::WriteAllText($envPath, $envText.Replace("`n", "`r`n"), $utf8NoBom)
    Write-Pass "Restored offline Hugging Face flags in .env"

    $cacheRoot = Join-Path $projectRoot "models\huggingface"
    $sdxlCache = Join-Path $cacheRoot "models--stabilityai--stable-diffusion-xl-base-1.0"
    $sanaCache = Join-Path $cacheRoot "models--Efficient-Large-Model--Sana_Sprint_1.6B_1024px_diffusers"

    Write-Host ""
    Write-Info "Cache sizes:"
    Write-Host "SDXL:        $sdxlCache"
    Write-Host "             $(Format-Bytes (Get-DirectorySizeBytes $sdxlCache))"
    Write-Host "Sana Sprint: $sanaCache"
    Write-Host "             $(Format-Bytes (Get-DirectorySizeBytes $sanaCache))"

    if (Test-Path -LiteralPath $sanaCache) {
      Write-Host ""
      Write-Warn "Old Sana Sprint cache exists."
      $answer = Read-Host "Delete old Sana Sprint cache now to reclaim SSD space? Type DELETE to permanently remove it"
      if ($answer -ceq "DELETE") {
        Remove-Item -LiteralPath $sanaCache -Recurse -Force
        Write-Pass "Deleted old Sana Sprint cache: $sanaCache"
      } else {
        Write-Warn "Skipped deleting Sana Sprint cache."
      }
    } else {
      Write-Pass "Old Sana Sprint cache folder not found; nothing to delete."
    }

    Write-Info "Running syntax checks"
    & node --check ".\index.js"
    if ($LASTEXITCODE -ne 0) { throw "node --check failed with exit code $LASTEXITCODE." }
    Write-Pass "node --check .\index.js passed"

    & ".\.venv\Scripts\python.exe" -m py_compile ".\local_ai_server.py"
    if ($LASTEXITCODE -ne 0) { throw "py_compile failed with exit code $LASTEXITCODE." }
    Write-Pass "py_compile local_ai_server.py passed"
  } finally {
    Pop-Location
  }

  Write-Host ""
  Write-Pass "SDXL is downloaded/configured and offline mode is restored."
  Write-Host "Restart both:" -ForegroundColor Yellow
  Write-Host "1. local_ai_server.py" -ForegroundColor Yellow
  Write-Host "2. Discord bot" -ForegroundColor Yellow
  exit 0
} catch {
  Write-Host ""
  Write-Fail $_.Exception.Message
  Write-Host "Your .env backup is here:" -ForegroundColor Yellow
  if ($envBackup) { Write-Host $envBackup -ForegroundColor Yellow }
  exit 1
}
