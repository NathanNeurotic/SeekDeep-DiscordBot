# SeekDeep / Seekotics plain-verb image trigger patch
# Fixes plain imperative image prompts like:
#   @SEEKOTICS illustrate sailor moon smokin a spliffy with tattoos
#   @SEEKOTICS draw a frog wizard
#   @SEEKOTICS sketch haunted armor in the rain
#   @SEEKOTICS paint a neon skyline
#
# Preserves:
# - stabilized dispatcher
# - current queue contract: seekdeepEnqueueImageJob(job, runner)
# - current draw me / sketch me behavior
# - current text regenerate and model-status patches if already applied
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
  Write-Host "[SeekDeep patch] $Message" -ForegroundColor Cyan
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

  $backupPath = Join-Path $backupDir "index.js.plain-verb-image-trigger-$stamp.bak"
  Copy-Item -LiteralPath $indexPath -Destination $backupPath -Force
  Write-SeekDeepPass "Backed up index.js to $backupPath"

  $patchPy = @'
from pathlib import Path
import sys

if len(sys.argv) != 2:
    raise SystemExit("Usage: patch_plain_verb_image_trigger.py <index.js>")

path = Path(sys.argv[1])
raw = path.read_bytes()
newline = "\r\n" if b"\r\n" in raw else "\n"
text = raw.decode("utf-8-sig")
text = text.replace("\r\n", "\n").replace("\r", "\n")

def require_contains(haystack, needle, label):
    if needle not in haystack:
        raise SystemExit(f"Required anchor not found: {label}")

def replace_once(haystack, old, new, label):
    count = haystack.count(old)
    if count != 1:
        raise SystemExit(f"Expected exactly one anchor for {label}, found {count}.")
    return haystack.replace(old, new, 1)

require_contains(text, "SEEKDEEP_STABILIZED_DISPATCH_HELPERS_START", "stabilized dispatcher marker")
require_contains(text, "function seekdeepHasExplicitImageRequest(p = '')", "explicit image request detector")
require_contains(text, "function seekdeepEnqueueImageJob(job, runner)", "correct image queue contract")
require_contains(text, "function isNaturalImagePrompt(prompt)", "natural image route detector")

if "seekdeepMakeImageQueueJobId" in text:
    raise SystemExit("Unsafe old queue helper found: seekdeepMakeImageQueueJobId")
if "job.run" in text:
    raise SystemExit("Unsafe job.run-style queue logic found")

if "SEEKDEEP_PLAIN_VERB_IMAGE_TRIGGER_START" not in text:
    old = "  if (/\\b(?:draw|sketch|paint|illustrate)\\s+(?:an?\\s+|some\\s+)?\\S+/i.test(text) && seekdeepHasVisualSubjectWords(text)) {\n    return true;\n  }\n\n  return false;\n}"
    new = """  if (/\\b(?:draw|sketch|paint|illustrate)\\s+(?:an?\\s+|some\\s+)?\\S+/i.test(text) && seekdeepHasVisualSubjectWords(text)) {\n    return true;\n  }\n\n  // SEEKDEEP_PLAIN_VERB_IMAGE_TRIGGER_START\n  // Accept direct imperative art requests even when the user does not include\n  // the word \"image\" and even when the subject is a proper noun the visual\n  // subject detector may not recognize yet.\n  // Examples:\n  //   illustrate sailor moon smokin a spliffy with tattoos\n  //   draw a frog wizard\n  //   sketch haunted armor in the rain\n  //   paint a neon skyline\n  if (/^(?:draw|sketch|paint|illustrate|render)\\s+(?:me\\s+)?(?:an?\\s+|some\\s+)?\\S+/i.test(text) && !/\\b(?:image prompt|prompt only|description only)\\b/i.test(text)) {\n    return true;\n  }\n  // SEEKDEEP_PLAIN_VERB_IMAGE_TRIGGER_END\n\n  return false;\n}"""
    text = replace_once(text, old, new, "plain-verb image trigger insertion")

if "@SEEKOTICS illustrate a neon frog wizard" not in text:
    target = "    '@SEEKOTICS /image red dragon',\n"
    if target in text:
        text = text.replace(target, target + "    '@SEEKOTICS illustrate a neon frog wizard',\n", 1)

for needle, label in [
    ("SEEKDEEP_PLAIN_VERB_IMAGE_TRIGGER_START", "plain-verb trigger marker"),
    ("function seekdeepHasExplicitImageRequest(p = '')", "explicit image request detector"),
    ("function isNaturalImagePrompt(prompt)", "natural image route detector"),
    ("function seekdeepEnqueueImageJob(job, runner)", "correct image queue contract"),
]:
    require_contains(text, needle, label)

out = text if newline == "\n" else text.replace("\n", "\r\n")
path.write_bytes(out.encode("utf-8"))
print("Patched index.js with plain-verb image trigger support.")
'@

  $patchPyPath = Join-Path $patchesDir "patch_plain_verb_image_trigger.py"
  [System.IO.File]::WriteAllText($patchPyPath, $patchPy, [System.Text.UTF8Encoding]::new($false))
  Write-SeekDeepPass "Wrote UTF-8 patch helper to $patchPyPath"

  Push-Location $projectRoot
  try {
    Write-SeekDeepInfo "Applying plain-verb image trigger patch"
    & ".\.venv\Scripts\python.exe" $patchPyPath $indexPath
    if ($LASTEXITCODE -ne 0) {
      throw "Python patch helper failed with exit code $LASTEXITCODE."
    }
    Write-SeekDeepPass "Applied plain-verb image trigger patch"

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
  Write-Host "SeekDeep plain-verb image trigger patch completed successfully." -ForegroundColor Green
  Write-Host "Backup created: $backupPath" -ForegroundColor Green
  Write-Host "Test in Discord: @SEEKOTICS illustrate sailor moon smokin a spliffy with tattoos" -ForegroundColor Yellow
  exit 0
} catch {
  Write-Host ""
  Write-SeekDeepFail $_.Exception.Message
  Write-Host "index.js backup is available here if you need to restore:" -ForegroundColor Yellow
  if ($backupPath) {
    Write-Host $backupPath -ForegroundColor Yellow
  }
  exit 1
}
