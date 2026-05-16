# SeekDeep / Seekotics restore from failed ThinkPad guardrails v2 patch
#
# Purpose:
# - Recover index.js after failed patch left syntax broken:
#     SyntaxError: Unexpected token 'if'
# - Restore from the backup created immediately before the failed v2 patch:
#     patches\backups\index.js.thinkpad-research-guardrails-v2-*.bak
#
# Safety:
# - Backs up the currently broken index.js first
# - Restores the newest matching v2 backup
# - Runs:
#     node --check .\index.js
#     .\.venv\Scripts\python.exe -m py_compile .\local_ai_server.py

$ErrorActionPreference = "Stop"

try {
  [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
} catch {}

function Write-Info {
  param([string]$Message)
  Write-Host "[SeekDeep restore] $Message" -ForegroundColor Cyan
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
  $backupDir = Join-Path $projectRoot "patches\backups"
  $stamp = Get-Date -Format "yyyyMMdd-HHmmss"

  if (-not (Test-Path -LiteralPath $indexPath)) { throw "index.js not found." }
  if (-not (Test-Path -LiteralPath $serverPath)) { throw "local_ai_server.py not found." }
  if (-not (Test-Path -LiteralPath $backupDir)) { throw "Backup directory not found: $backupDir" }

  Write-Info "Project root: $projectRoot"

  $brokenBackup = Join-Path $backupDir "index.js.broken-after-thinkpad-v2-$stamp.bak"
  Copy-Item -LiteralPath $indexPath -Destination $brokenBackup -Force
  Write-Pass "Backed up current broken index.js to $brokenBackup"

  $restoreCandidate = Get-ChildItem -LiteralPath $backupDir -Filter "index.js.thinkpad-research-guardrails-v2-*.bak" |
    Sort-Object LastWriteTime -Descending |
    Select-Object -First 1

  if (-not $restoreCandidate) {
    throw "No v2 backup found matching: index.js.thinkpad-research-guardrails-v2-*.bak"
  }

  Write-Info "Restoring from: $($restoreCandidate.FullName)"
  Copy-Item -LiteralPath $restoreCandidate.FullName -Destination $indexPath -Force
  Write-Pass "Restored index.js"

  Push-Location $projectRoot
  try {
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
  Write-Pass "Restore completed. Restart the Discord bot before testing."
  Write-Host "Restored from: $($restoreCandidate.FullName)" -ForegroundColor Yellow
  Write-Host "Broken copy saved at: $brokenBackup" -ForegroundColor Yellow
  exit 0
} catch {
  Write-Host ""
  Write-Fail $_.Exception.Message
  exit 1
}
