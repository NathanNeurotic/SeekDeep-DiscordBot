# SeekDeep / Seekotics regenerate button cooldown v2 syntax repair
#
# Fixes:
#   SyntaxError: Unexpected reserved word
#   at:
#     await seekdeepNotifyRegenerateJobCooldown(job, seekdeepRegenCooldownRemaining);
#
# Cause:
#   seekdeepEnqueueImageJob(job, runner) is not async in the current file, so await is invalid there.
#
# Repair:
# - Keep the regenerate queue-boundary cooldown gate.
# - Replace await notification with fire-and-forget promise handling.
# - Preserve queue contract: seekdeepEnqueueImageJob(job, runner)
#
# Required checks:
#   node --check .\index.js
#   .\.venv\Scripts\python.exe -m py_compile .\local_ai_server.py

$ErrorActionPreference = "Stop"

try {
  [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
} catch {}

function Write-SeekDeepInfo {
  param([string]$Message)
  Write-Host "[SeekDeep repair] $Message" -ForegroundColor Cyan
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
  $patchesDir = Join-Path $projectRoot "patches"
  $backupDir = Join-Path $patchesDir "backups"
  $stamp = Get-Date -Format "yyyyMMdd-HHmmss"

  New-Item -ItemType Directory -Path $patchesDir -Force | Out-Null
  New-Item -ItemType Directory -Path $backupDir -Force | Out-Null

  Write-SeekDeepInfo "Project root: $projectRoot"

  $backupPath = Join-Path $backupDir "index.js.regenerate-button-cooldown-v2-syntax-repair-$stamp.bak"
  Copy-Item -LiteralPath $indexPath -Destination $backupPath -Force
  Write-SeekDeepPass "Backed up current broken index.js to $backupPath"

  $patchPy = @'
from pathlib import Path
import re
import sys

if len(sys.argv) != 2:
    raise SystemExit("Usage: repair_regenerate_button_cooldown_v2_syntax.py <index.js>")

path = Path(sys.argv[1])
raw = path.read_bytes()
newline = "\r\n" if b"\r\n" in raw else "\n"
text = raw.decode("utf-8-sig")
text = text.replace("\r\n", "\n").replace("\r", "\n")

def require_contains(haystack, needle, label):
    if needle not in haystack:
        raise SystemExit(f"Required anchor not found: {label}")

require_contains(text, "function seekdeepEnqueueImageJob(job, runner)", "correct queue contract")
require_contains(text, "SEEKDEEP_REGENERATE_QUEUE_COOLDOWN_GATE_START", "regenerate queue cooldown gate")
require_contains(text, "seekdeepNotifyRegenerateJobCooldown", "regenerate cooldown notifier")

if "seekdeepMakeImageQueueJobId" in text:
    raise SystemExit("Unsafe old queue helper found: seekdeepMakeImageQueueJobId")
if "job.run" in text:
    raise SystemExit("Unsafe job.run-style queue logic found")

old = "      await seekdeepNotifyRegenerateJobCooldown(job, seekdeepRegenCooldownRemaining);\n      return null;"
new = """      Promise.resolve(seekdeepNotifyRegenerateJobCooldown(job, seekdeepRegenCooldownRemaining))
        .catch((err) => console.warn('Regenerate cooldown notification failed:', err?.message || err));
      return null;"""

count = text.count(old)
if count != 1:
    raise SystemExit(f"Expected exactly one invalid await notification call, found {count}.")

text = text.replace(old, new, 1)

# Guard against this exact invalid await returning.
if "await seekdeepNotifyRegenerateJobCooldown(job, seekdeepRegenCooldownRemaining);" in text:
    raise SystemExit("Invalid await notification call still present after repair.")

require_contains(text, "Promise.resolve(seekdeepNotifyRegenerateJobCooldown(job, seekdeepRegenCooldownRemaining))", "fire-and-forget cooldown notifier")
require_contains(text, "return null;", "cooldown gate still blocks regenerate job")
require_contains(text, "function seekdeepEnqueueImageJob(job, runner)", "queue contract preserved")

out = text if newline == "\n" else text.replace("\n", "\r\n")
path.write_bytes(out.encode("utf-8"))
print("Repaired invalid await inside non-async regenerate queue cooldown gate.")
'@

  $patchPyPath = Join-Path $patchesDir "repair_regenerate_button_cooldown_v2_syntax.py"
  [System.IO.File]::WriteAllText($patchPyPath, $patchPy, [System.Text.UTF8Encoding]::new($false))
  Write-SeekDeepPass "Wrote UTF-8 repair helper to $patchPyPath"

  Push-Location $projectRoot
  try {
    Write-SeekDeepInfo "Repairing invalid await in regenerate queue cooldown gate"
    & ".\.venv\Scripts\python.exe" $patchPyPath $indexPath
    if ($LASTEXITCODE -ne 0) {
      throw "Python repair helper failed with exit code $LASTEXITCODE."
    }
    Write-SeekDeepPass "Applied syntax repair"

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
  Write-Host "SeekDeep regenerate button cooldown v2 syntax repair completed successfully." -ForegroundColor Green
  Write-Host "Backup created: $backupPath" -ForegroundColor Yellow
  Write-Host "Restart the Discord bot before testing." -ForegroundColor Yellow
  exit 0
} catch {
  Write-Host ""
  Write-SeekDeepFail $_.Exception.Message
  Write-Host "index.js backup is available here if you need to restore:" -ForegroundColor Yellow
  if ($backupPath) {
    Write-Host $backupPath -ForegroundColor Yellow
  }
  Write-Host ""
  Write-Host "Known clean pre-v2 backup from the failed patch:" -ForegroundColor Yellow
  Write-Host "C:\Users\natha\SeekDeep-DiscordBot\patches\backups\index.js.regenerate-button-cooldown-v2-20260513-003406.bak" -ForegroundColor Yellow
  exit 1
}
