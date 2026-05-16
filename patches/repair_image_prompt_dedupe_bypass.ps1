# SeekDeep / Seekotics image prompt dedupe bypass repair
#
# Purpose:
# - Stop prompt-level duplicate suppression from eating image-intent messages.
# - Let the image cooldown system handle repeated image requests instead.
#
# Why:
# - Natural image requests now route correctly, but prompt dedupe can still suppress
#   repeated/near-repeated pings before the user sees a clear cooldown response.
# - Image requests already have a per-user cooldown, so prompt dedupe is redundant there.
#
# Files patched:
# - index.js
#
# Workflow guarantees:
# - Backs up index.js first
# - UTF-8-safe patching
# - Preserves hard commands and queue contract:
#     seekdeepEnqueueImageJob(job, runner)
# - Runs:
#     node --check .\index.js
#     .\.venv\Scripts\python.exe -m py_compile .\local_ai_server.py

$ErrorActionPreference = "Stop"

try {
  [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
} catch {}

function Write-Info {
  param([string]$Message)
  Write-Host "[SeekDeep image-dedupe-repair] $Message" -ForegroundColor Cyan
}

function Write-Pass {
  param([string]$Message)
  Write-Host "[PASS] $Message" -ForegroundColor Green
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
  $patchesDir = Join-Path $projectRoot "patches"
  $backupDir = Join-Path $patchesDir "backups"
  $stamp = Get-Date -Format "yyyyMMdd-HHmmss"

  if (-not (Test-Path -LiteralPath $indexPath)) { throw "index.js not found." }
  if (-not (Test-Path -LiteralPath $serverPath)) { throw "local_ai_server.py not found." }

  New-Item -ItemType Directory -Path $patchesDir -Force | Out-Null
  New-Item -ItemType Directory -Path $backupDir -Force | Out-Null

  Write-Info "Project root: $projectRoot"

  $indexBackup = Join-Path $backupDir "index.js.image-prompt-dedupe-bypass-$stamp.bak"
  Copy-Item -LiteralPath $indexPath -Destination $indexBackup -Force
  Write-Pass "Backed up index.js to $indexBackup"

  $utf8NoBom = [System.Text.UTF8Encoding]::new($false)

  $patchPy = @'
from pathlib import Path
import re
import sys

if len(sys.argv) != 2:
    raise SystemExit("Usage: patch_image_prompt_dedupe_bypass.py <index.js>")

path = Path(sys.argv[1])
raw = path.read_bytes()
newline = "\r\n" if b"\r\n" in raw else "\n"
text = raw.decode("utf-8-sig").replace("\r\n", "\n").replace("\r", "\n")

def require_contains(haystack: str, needle: str, label: str):
    if needle not in haystack:
        raise SystemExit(f"Required anchor not found: {label}")

require_contains(text, "function seekdeepIsPromptDedupeExempt", "dedupe exemption function")
require_contains(text, "function seekdeepLooksLikeVisualRequest", "visual request classifier")
require_contains(text, "seekdeepClaimPromptOnce", "prompt dedupe call")
require_contains(text, "seekdeepEnqueueImageJob(job, runner)", "correct queue contract")
require_contains(text, "post archive", "post archive hard-command context")

if "seekdeepMakeImageQueueJobId" in text:
    raise SystemExit("Unsafe old queue helper found: seekdeepMakeImageQueueJobId")
if "job.run" in text:
    raise SystemExit("Unsafe job.run-style queue logic found")

if "SEEKDEEP_IMAGE_PROMPT_DEDUPE_BYPASS_START" not in text:
    anchor = """  if (!p) return false;

"""
    insert = """  if (!p) return false;

  // SEEKDEEP_IMAGE_PROMPT_DEDUPE_BYPASS_START
  // Image requests already have per-user cooldown handling. Do not let the older
  // prompt-level dedupe silently eat valid image-intent messages.
  if (typeof seekdeepLooksLikeVisualRequest === 'function' && seekdeepLooksLikeVisualRequest(p)) return true;
  if (typeof isNaturalImagePrompt === 'function' && isNaturalImagePrompt(p)) return true;
  // SEEKDEEP_IMAGE_PROMPT_DEDUPE_BYPASS_END

"""
    fn_pos = text.find("function seekdeepIsPromptDedupeExempt")
    if fn_pos < 0:
        raise SystemExit("Could not locate seekdeepIsPromptDedupeExempt.")

    local = text[fn_pos:fn_pos + 1500]
    if anchor not in local:
        raise SystemExit("Could not locate insertion anchor inside seekdeepIsPromptDedupeExempt.")

    text = text[:fn_pos] + local.replace(anchor, insert, 1) + text[fn_pos + len(local):]

for needle, label in [
    ("SEEKDEEP_IMAGE_PROMPT_DEDUPE_BYPASS_START", "image dedupe bypass marker"),
    ("seekdeepLooksLikeVisualRequest(p)", "visual request dedupe bypass"),
    ("isNaturalImagePrompt(p)", "natural image prompt dedupe bypass"),
    ("seekdeepClaimPromptOnce", "prompt dedupe call preserved"),
    ("seekdeepEnqueueImageJob(job, runner)", "queue contract preserved"),
]:
    require_contains(text, needle, label)

out = text if newline == "\n" else text.replace("\n", "\r\n")
path.write_bytes(out.encode("utf-8"))
print("Patched image prompt dedupe bypass.")
'@

  $patchPyPath = Join-Path $patchesDir "patch_image_prompt_dedupe_bypass.py"
  [System.IO.File]::WriteAllText($patchPyPath, $patchPy, $utf8NoBom)

  Push-Location $projectRoot
  try {
    Write-Info "Applying image prompt dedupe bypass repair"
    & ".\.venv\Scripts\python.exe" $patchPyPath $indexPath
    if ($LASTEXITCODE -ne 0) {
      throw "Patch helper failed with exit code $LASTEXITCODE."
    }
    Write-Pass "Applied image prompt dedupe bypass repair"

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
  Write-Pass "Image prompt dedupe bypass repair completed."
  Write-Host "Backup created: $indexBackup" -ForegroundColor Yellow
  Write-Host "Restart the Discord bot before testing." -ForegroundColor Yellow
  Write-Host ""
  Write-Host "Expected behavior:" -ForegroundColor Cyan
  Write-Host "- repeated image requests should get cooldown messages, not silent duplicate suppression" -ForegroundColor White
  Write-Host "- hard commands remain protected" -ForegroundColor White
  Write-Host "- chat prompts can still use prompt dedupe" -ForegroundColor White
  exit 0
} catch {
  Write-Host ""
  Write-Fail $_.Exception.Message
  Write-Host "Backup available:" -ForegroundColor Yellow
  if ($indexBackup) { Write-Host $indexBackup -ForegroundColor Yellow }
  exit 1
}
