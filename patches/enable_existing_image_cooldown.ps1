# SeekDeep / Seekotics enable existing per-user image cooldown
#
# This script does NOT modify index.js.
# It backs up index.js, verifies the existing cooldown implementation is present,
# then enables it in .env by setting:
#   SEEKDEEP_IMAGE_COOLDOWN_MS=45000
#
# Existing code uses:
#   seekdeepImageCooldownRemaining(userId)
#   seekdeepRememberImageCooldown(userId)
#
# Required checks run at end:
#   node --check .\index.js
#   .\.venv\Scripts\python.exe -m py_compile .\local_ai_server.py

$ErrorActionPreference = "Stop"

try {
  [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
} catch {}

function Write-SeekDeepInfo {
  param([string]$Message)
  Write-Host "[SeekDeep config] $Message" -ForegroundColor Cyan
}

function Write-SeekDeepPass {
  param([string]$Message)
  Write-Host "[PASS] $Message" -ForegroundColor Green
}

function Write-SeekDeepFail {
  param([string]$Message)
  Write-Host "[FAIL] $Message" -ForegroundColor Red
}

function Resolve-SeekDeepRoot {
  $scriptPath = $PSCommandPath
  if (-not $scriptPath) {
    $scriptPath = $MyInvocation.MyCommand.Path
  }

  $scriptDir = $null
  if ($scriptPath) {
    $scriptDir = Split-Path -Parent $scriptPath
  }

  $candidates = New-Object System.Collections.Generic.List[string]

  if ($scriptDir) {
    if ((Split-Path -Leaf $scriptDir) -ieq "patches") {
      $candidates.Add((Split-Path -Parent $scriptDir))
    }
    $candidates.Add($scriptDir)
  }

  $candidates.Add((Get-Location).Path)
  $candidates.Add((Join-Path $env:USERPROFILE "SeekDeep-DiscordBot"))

  foreach ($candidate in $candidates) {
    if (-not [string]::IsNullOrWhiteSpace($candidate)) {
      $index = Join-Path $candidate "index.js"
      $server = Join-Path $candidate "local_ai_server.py"
      if ((Test-Path -LiteralPath $index) -and (Test-Path -LiteralPath $server)) {
        return (Resolve-Path -LiteralPath $candidate).Path
      }
    }
  }

  throw "Could not locate SeekDeep project root. Run this from C:\Users\natha\SeekDeep-DiscordBot or place it in C:\Users\natha\SeekDeep-DiscordBot\patches."
}

function Invoke-CheckedCommand {
  param(
    [Parameter(Mandatory=$true)][string]$Label,
    [Parameter(Mandatory=$true)][scriptblock]$Command
  )

  Write-SeekDeepInfo "Running $Label"
  & $Command
  if ($LASTEXITCODE -ne 0) {
    throw "$Label failed with exit code $LASTEXITCODE."
  }

  Write-SeekDeepPass "$Label passed"
}

try {
  $projectRoot = Resolve-SeekDeepRoot
  $indexPath = Join-Path $projectRoot "index.js"
  $serverPath = Join-Path $projectRoot "local_ai_server.py"
  $envPath = Join-Path $projectRoot ".env"
  $patchesDir = Join-Path $projectRoot "patches"
  $backupDir = Join-Path $patchesDir "backups"
  $stamp = Get-Date -Format "yyyyMMdd-HHmmss"

  New-Item -ItemType Directory -Path $patchesDir -Force | Out-Null
  New-Item -ItemType Directory -Path $backupDir -Force | Out-Null

  Write-SeekDeepInfo "Project root: $projectRoot"

  $indexBackupPath = Join-Path $backupDir "index.js.enable-existing-image-cooldown-$stamp.bak"
  Copy-Item -LiteralPath $indexPath -Destination $indexBackupPath -Force
  Write-SeekDeepPass "Backed up index.js to $indexBackupPath"

  if (Test-Path -LiteralPath $envPath) {
    $envBackupPath = Join-Path $backupDir ".env.enable-existing-image-cooldown-$stamp.bak"
    Copy-Item -LiteralPath $envPath -Destination $envBackupPath -Force
    Write-SeekDeepPass "Backed up .env to $envBackupPath"
  } else {
    New-Item -ItemType File -Path $envPath -Force | Out-Null
    Write-SeekDeepInfo "Created missing .env"
  }

  $utf8NoBom = [System.Text.UTF8Encoding]::new($false)
  $indexText = [System.IO.File]::ReadAllText($indexPath, $utf8NoBom)

  $required = @(
    "const SEEKDEEP_IMAGE_COOLDOWN_MS",
    "const seekdeepImageCooldowns",
    "function seekdeepImageCooldownRemaining",
    "function seekdeepRememberImageCooldown",
    "function seekdeepImageCooldownText",
    "seekdeepImageCooldownRemaining(userId)",
    "seekdeepRememberImageCooldown(userId)",
    "function seekdeepEnqueueImageJob(job, runner)"
  )

  foreach ($needle in $required) {
    if ($indexText.IndexOf($needle, [System.StringComparison]::Ordinal) -lt 0) {
      throw "Existing cooldown implementation not found. Missing: $needle"
    }
    Write-SeekDeepPass "Found existing cooldown implementation marker: $needle"
  }

  if ($indexText.IndexOf("seekdeepMakeImageQueueJobId", [System.StringComparison]::Ordinal) -ge 0) {
    throw "Unsafe old queue helper found: seekdeepMakeImageQueueJobId"
  }

  if ($indexText.IndexOf("job.run", [System.StringComparison]::Ordinal) -ge 0) {
    throw "Unsafe job.run-style queue logic found"
  }

  $envText = [System.IO.File]::ReadAllText($envPath, $utf8NoBom)
  $envText = $envText -replace "`r`n", "`n"
  $envText = $envText -replace "`r", "`n"

  $cooldownLine = "SEEKDEEP_IMAGE_COOLDOWN_MS=45000"

  if ($envText -match "(?m)^SEEKDEEP_IMAGE_COOLDOWN_MS\s*=") {
    $envText = [regex]::Replace($envText, "(?m)^SEEKDEEP_IMAGE_COOLDOWN_MS\s*=.*$", $cooldownLine)
    Write-SeekDeepPass "Updated existing SEEKDEEP_IMAGE_COOLDOWN_MS setting to 45000"
  } else {
    if ($envText.Length -gt 0 -and -not $envText.EndsWith("`n")) {
      $envText += "`n"
    }
    $envText += "`n# Per-user image generation cooldown. 45000 ms = 45 seconds.`n$cooldownLine`n"
    Write-SeekDeepPass "Added SEEKDEEP_IMAGE_COOLDOWN_MS=45000 to .env"
  }

  [System.IO.File]::WriteAllText($envPath, $envText.Replace("`n", "`r`n"), $utf8NoBom)

  Push-Location $projectRoot
  try {
    Invoke-CheckedCommand "node --check .\index.js" {
      & node --check ".\index.js"
    }

    Invoke-CheckedCommand ".\.venv\Scripts\python.exe -m py_compile .\local_ai_server.py" {
      & ".\.venv\Scripts\python.exe" -m py_compile ".\local_ai_server.py"
    }

    if (Test-Path ".\patches\apply_routing_regression_audit.ps1") {
      Write-SeekDeepInfo "Running existing routing regression audit"
      & ".\patches\apply_routing_regression_audit.ps1"
      if ($LASTEXITCODE -ne 0) {
        throw "Existing routing regression audit failed with exit code $LASTEXITCODE."
      }
      Write-SeekDeepPass "Existing routing regression audit passed"
    } else {
      Write-SeekDeepInfo "Routing regression audit script not found; skipped optional audit."
    }
  } finally {
    Pop-Location
  }

  Write-Host ""
  Write-Host "SeekDeep existing per-user image cooldown is now enabled." -ForegroundColor Green
  Write-Host "Cooldown: 45000 ms / 45 seconds per user" -ForegroundColor Green
  Write-Host "Restart the bot for .env changes to take effect." -ForegroundColor Yellow
  Write-Host "index.js backup: $indexBackupPath" -ForegroundColor Yellow
  if ($envBackupPath) {
    Write-Host ".env backup: $envBackupPath" -ForegroundColor Yellow
  }
  exit 0
} catch {
  Write-Host ""
  Write-SeekDeepFail $_.Exception.Message
  Write-Host "No index.js changes were made by this script." -ForegroundColor Yellow
  if ($indexBackupPath) {
    Write-Host "index.js backup: $indexBackupPath" -ForegroundColor Yellow
  }
  if ($envBackupPath) {
    Write-Host ".env backup: $envBackupPath" -ForegroundColor Yellow
  }
  exit 1
}
