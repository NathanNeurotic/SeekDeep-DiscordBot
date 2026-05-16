# SeekDeep / Seekotics emergency repair for backend refined prompt patch
#
# Fixes:
#   SyntaxError: Identifier 'seekdeepClipForDiscord' has already been declared
#
# Cause:
#   A previous patch already added seekdeepClipForDiscord / seekdeepRefinedPromptLine.
#   The backend refined prompt patch added another copy.
#
# This repair:
# - Backs up the current broken index.js first.
# - Keeps local_ai_server.py refined_prompt/original_prompt return.
# - Replaces the duplicate backend helper block with only seekdeepExtractRefinedPrompt().
# - Preserves existing seekdeepClipForDiscord() and seekdeepRefinedPromptLine().
# - Runs:
#     node --check .\index.js
#     .\.venv\Scripts\python.exe -m py_compile .\local_ai_server.py

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

  $brokenIndexBackup = Join-Path $backupDir "index.js.broken-before-refined-helper-repair-$stamp.bak"
  Copy-Item -LiteralPath $indexPath -Destination $brokenIndexBackup -Force
  Write-SeekDeepPass "Backed up current broken index.js to $brokenIndexBackup"

  $serverBackup = Join-Path $backupDir "local_ai_server.py.before-refined-helper-repair-$stamp.bak"
  Copy-Item -LiteralPath $serverPath -Destination $serverBackup -Force
  Write-SeekDeepPass "Backed up current local_ai_server.py to $serverBackup"

  $repairPy = @'
from pathlib import Path
import re
import sys

if len(sys.argv) != 3:
    raise SystemExit("Usage: repair_refined_prompt_duplicate_helpers.py <index.js> <local_ai_server.py>")

index_path = Path(sys.argv[1])
server_path = Path(sys.argv[2])

raw = index_path.read_bytes()
newline = "\r\n" if b"\r\n" in raw else "\n"
text = raw.decode("utf-8-sig").replace("\r\n", "\n").replace("\r", "\n")

server_raw = server_path.read_bytes()
server_text = server_raw.decode("utf-8-sig").replace("\r\n", "\n").replace("\r", "\n")

def require_contains(haystack, needle, label):
    if needle not in haystack:
        raise SystemExit(f"Required marker missing: {label}")

require_contains(text, "function seekdeepEnqueueImageJob(job, runner)", "correct queue contract")
require_contains(text, "SEEKDEEP_VISIBLE_REFINED_PROMPT_FROM_BACKEND_START", "backend refined prompt helper block")
require_contains(text, "SEEKDEEP_VISIBLE_REFINED_PROMPT_FROM_BACKEND_END", "backend refined prompt helper block end")
require_contains(server_text, '"refined_prompt"', "local_ai_server.py refined_prompt return")
require_contains(server_text, '"original_prompt"', "local_ai_server.py original_prompt return")

if "seekdeepMakeImageQueueJobId" in text:
    raise SystemExit("Unsafe old queue helper found: seekdeepMakeImageQueueJobId")
if "job.run" in text:
    raise SystemExit("Unsafe job.run-style queue logic found")

extract_only_block = r"""// SEEKDEEP_VISIBLE_REFINED_PROMPT_FROM_BACKEND_START
function seekdeepExtractRefinedPrompt(...candidates) {
  for (const candidate of candidates) {
    if (!candidate || typeof candidate !== 'object') continue;

    const values = [
      candidate.refined_prompt,
      candidate.refinedPrompt,
      candidate.original_refined_prompt,
      candidate.originalRefinedPrompt,
      candidate.used_prompt,
      candidate.usedPrompt,
    ];

    for (const value of values) {
      const text = String(value || '').trim();
      if (text) return text;
    }
  }

  return '';
}
// SEEKDEEP_VISIBLE_REFINED_PROMPT_FROM_BACKEND_END"""

pattern = re.compile(
    r"// SEEKDEEP_VISIBLE_REFINED_PROMPT_FROM_BACKEND_START.*?// SEEKDEEP_VISIBLE_REFINED_PROMPT_FROM_BACKEND_END",
    re.S,
)

text, count = pattern.subn(extract_only_block, text, count=1)
if count != 1:
    raise SystemExit(f"Expected to replace exactly one backend refined prompt helper block, replaced {count}.")

# There should now be only one global declaration of each of these names.
clip_count = len(re.findall(r"\bfunction\s+seekdeepClipForDiscord\s*\(", text))
line_count = len(re.findall(r"\bfunction\s+seekdeepRefinedPromptLine\s*\(", text))
extract_count = len(re.findall(r"\bfunction\s+seekdeepExtractRefinedPrompt\s*\(", text))

if clip_count != 1:
    raise SystemExit(f"Expected exactly one seekdeepClipForDiscord declaration after repair, found {clip_count}.")
if line_count != 1:
    raise SystemExit(f"Expected exactly one seekdeepRefinedPromptLine declaration after repair, found {line_count}.")
if extract_count != 1:
    raise SystemExit(f"Expected exactly one seekdeepExtractRefinedPrompt declaration after repair, found {extract_count}.")

require_contains(text, "seekdeepRefinedPromptLine(prompt, seekdeepExtractRefinedPrompt(", "final image message refined prompt line")
require_contains(text, "function seekdeepEnqueueImageJob(job, runner)", "correct queue contract after repair")

out = text if newline == "\n" else text.replace("\n", "\r\n")
index_path.write_bytes(out.encode("utf-8"))

print("Repaired duplicate refined prompt helper declarations in index.js.")
'@

  $repairPyPath = Join-Path $patchesDir "repair_refined_prompt_duplicate_helpers.py"
  [System.IO.File]::WriteAllText($repairPyPath, $repairPy, [System.Text.UTF8Encoding]::new($false))
  Write-SeekDeepPass "Wrote UTF-8 repair helper to $repairPyPath"

  Push-Location $projectRoot
  try {
    Write-SeekDeepInfo "Repairing duplicate refined prompt helper declarations"
    & ".\.venv\Scripts\python.exe" $repairPyPath $indexPath $serverPath
    if ($LASTEXITCODE -ne 0) {
      throw "Python repair helper failed with exit code $LASTEXITCODE."
    }
    Write-SeekDeepPass "Repaired duplicate helper declarations"

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
  Write-Host "SeekDeep refined prompt helper repair completed successfully." -ForegroundColor Green
  Write-Host "Broken index.js backup: $brokenIndexBackup" -ForegroundColor Yellow
  Write-Host "local_ai_server.py backup: $serverBackup" -ForegroundColor Yellow
  Write-Host "Restart both the local AI server and the bot." -ForegroundColor Yellow
  exit 0
} catch {
  Write-Host ""
  Write-SeekDeepFail $_.Exception.Message
  Write-Host "Backups are available if you need to restore manually:" -ForegroundColor Yellow
  if ($brokenIndexBackup) {
    Write-Host "Broken index.js backup: $brokenIndexBackup" -ForegroundColor Yellow
  }
  if ($serverBackup) {
    Write-Host "local_ai_server.py backup: $serverBackup" -ForegroundColor Yellow
  }
  Write-Host "Previous clean backup from failed patch:" -ForegroundColor Yellow
  Write-Host "C:\Users\natha\SeekDeep-DiscordBot\patches\backups\index.js.backend-refined-prompt-20260512-232721.bak" -ForegroundColor Yellow
  Write-Host "C:\Users\natha\SeekDeep-DiscordBot\patches\backups\local_ai_server.py.backend-refined-prompt-20260512-232721.bak" -ForegroundColor Yellow
  exit 1
}
