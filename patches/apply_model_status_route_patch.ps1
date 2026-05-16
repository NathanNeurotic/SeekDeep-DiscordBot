# SeekDeep / Seekotics model-status routing patch
# Adds hard local routing for text questions like:
#   @SEEKOTICS What model are you using?
#   @SEEKOTICS which model are you running?
#   @SEEKOTICS current model
#   @SEEKOTICS loaded model
#
# Preserves:
# - stabilized dispatcher order
# - post archive hard-command routing
# - text regenerate route if already applied
# - seekdeepEnqueueImageJob(job, runner)
# - existing statusText() behavior
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

  $backupPath = Join-Path $backupDir "index.js.model-status-route-$stamp.bak"
  Copy-Item -LiteralPath $indexPath -Destination $backupPath -Force
  Write-SeekDeepPass "Backed up index.js to $backupPath"

  $patchPy = @'
from pathlib import Path
import sys

if len(sys.argv) != 2:
    raise SystemExit("Usage: patch_model_status_route.py <index.js>")

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

def insert_once_before(haystack, anchor, insertion, label):
    if insertion.strip() in haystack:
        return haystack
    require_contains(haystack, anchor, label)
    return haystack.replace(anchor, insertion + "\n" + anchor, 1)

require_contains(text, "SEEKDEEP_STABILIZED_DISPATCH_HELPERS_START", "stabilized dispatcher marker")
require_contains(text, "function seekdeepUtilityPromptKind(prompt = '')", "utility routing function")
require_contains(text, "async function statusText()", "statusText function")
require_contains(text, "function seekdeepEnqueueImageJob(job, runner)", "correct image queue contract")
if "seekdeepMakeImageQueueJobId" in text:
    raise SystemExit("Unsafe old queue helper found: seekdeepMakeImageQueueJobId")
if "job.run" in text:
    raise SystemExit("Unsafe job.run-style queue logic found")

model_helper = r"""
// SEEKDEEP_MODEL_STATUS_ROUTE_START
function seekdeepIsModelStatusQuestion(prompt = '') {
  const p = normalizeUserText(prompt).toLowerCase().trim();

  if (!p) return false;

  return (
    /^(?:what|which)\s+(?:ai\s+)?model\s+(?:are\s+)?(?:you|u|this|seekdeep|seekotics|the\s+bot)\s+(?:using|running|loaded|on)\??$/.test(p) ||
    /^(?:what|which)\s+(?:ai\s+)?model\s+(?:do|does)\s+(?:you|u|seekdeep|seekotics|the\s+bot)\s+(?:use|run)\??$/.test(p) ||
    /^(?:what|which)\s+(?:ai\s+)?model\s+(?:is|does)\s+(?:seekdeep|seekotics|the\s+bot)\s+(?:using|running|loaded|use)\??$/.test(p) ||
    /^(?:what|which)\s+is\s+(?:your|the\s+bot'?s|seekdeep'?s|seekotics'?)\s+(?:ai\s+)?model\??$/.test(p) ||
    /^(?:what\s+are\s+you\s+running\s+on|what\s+do\s+you\s+run\s+on|what\s+is\s+your\s+backend)\??$/.test(p) ||
    /^(?:current|loaded|active|running)\s+(?:ai\s+)?model(?:\s+status)?\??$/.test(p) ||
    /^(?:model|models|model\s+status|local\s+model\s+status|ai\s+model\s+status)\??$/.test(p) ||
    /^show\s+(?:me\s+)?(?:the\s+)?(?:current|loaded|active|running)?\s*(?:ai\s+)?models?\??$/.test(p)
  );
}
// SEEKDEEP_MODEL_STATUS_ROUTE_END
"""

if "SEEKDEEP_MODEL_STATUS_ROUTE_START" not in text:
    text = insert_once_before(
        text,
        "function seekdeepUtilityPromptKind(prompt = '') {",
        model_helper,
        "model-status helper insertion point",
    )

if "return 'model-status'" not in text:
    old = """function seekdeepUtilityPromptKind(prompt = '') {
  const p = normalizeUserText(prompt).toLowerCase().trim();

  if (!p) return '';

  // Archive dump is a hard command. Keep it out of chat/model routing."""
    new = """function seekdeepUtilityPromptKind(prompt = '') {
  const p = normalizeUserText(prompt).toLowerCase().trim();

  if (!p) return '';

  // Model identity/status is a hard local command. Keep it out of Qwen chat persona routing.
  if (typeof seekdeepIsModelStatusQuestion === 'function' && seekdeepIsModelStatusQuestion(p)) return 'model-status';

  // Archive dump is a hard command. Keep it out of chat/model routing."""
    text = replace_once(text, old, new, "seekdeepUtilityPromptKind model-status route")

dedupe_start = text.find("function seekdeepIsPromptDedupeExempt")
dedupe_end = text.find("// SEEKDEEP_HARD_COMMAND_DEDUPE_EXEMPT_END", dedupe_start)
if dedupe_start < 0 or dedupe_end < 0:
    raise SystemExit("Could not locate hard-command dedupe exemption block.")

dedupe_block = text[dedupe_start:dedupe_end]
if "seekdeepIsModelStatusQuestion" not in dedupe_block:
    old = "  if (typeof seekdeepUtilityPromptKind === 'function' && seekdeepUtilityPromptKind(p)) return true;\n\n  return /^(?:queue|que)\\s+status\\b/.test(p) ||"
    new = "  if (typeof seekdeepUtilityPromptKind === 'function' && seekdeepUtilityPromptKind(p)) return true;\n  if (typeof seekdeepIsModelStatusQuestion === 'function' && seekdeepIsModelStatusQuestion(p)) return true;\n\n  return /^(?:queue|que)\\s+status\\b/.test(p) ||"
    text = replace_once(text, old, new, "hard-command dedupe model-status exemption")

if "@SEEKOTICS what model are you using?" not in text:
    old = "    '@SEEKOTICS status',\n    '@SEEKOTICS ping',"
    new = "    '@SEEKOTICS status',\n    '@SEEKOTICS what model are you using?',\n    '@SEEKOTICS ping',"
    text = replace_once(text, old, new, "help text model-status line")

if "utilityKind === 'model-status'" not in text:
    old = """    if (utilityKind) {
      seekdeepLogRoute(utilityKind, prompt);
      remember(key, 'user', prompt);
      seekdeepSetResponseModel(message, seekdeepNoModelLabel());"""
    new = """    if (utilityKind === 'model-status') {
      seekdeepLogRoute('model-status', prompt);
      const status = await statusText();
      remember(key, 'user', prompt);
      remember(key, 'assistant', status);
      seekdeepSetResponseModel(message, seekdeepNoModelLabel());
      await sendLongMessageReply(message, asTextBlock(status));
      return;
    }

    if (utilityKind) {
      seekdeepLogRoute(utilityKind, prompt);
      remember(key, 'user', prompt);
      seekdeepSetResponseModel(message, seekdeepNoModelLabel());"""
    text = replace_once(text, old, new, "dispatcher model-status branch")

for needle, label in [
    ("SEEKDEEP_MODEL_STATUS_ROUTE_START", "model-status helper block"),
    ("function seekdeepIsModelStatusQuestion", "model-status detector"),
    ("return 'model-status'", "utility model-status route"),
    ("utilityKind === 'model-status'", "dispatcher model-status branch"),
    ("seekdeepLogRoute('model-status', prompt);", "dispatcher model-status route log"),
    ("const status = await statusText();", "model-status reuses statusText"),
    ("seekdeepSetResponseModel(message, seekdeepNoModelLabel());", "model-status uses no-model label"),
    ("function seekdeepEnqueueImageJob(job, runner)", "correct image queue contract"),
]:
    require_contains(text, needle, label)

post = text.find("utilityKind === 'post-archive'")
model = text.find("utilityKind === 'model-status'")
generic = text.find("if (utilityKind) {", model)
status = text.find("if (isNaturalStatusPrompt(prompt) || isExplicitStatusRequest(prompt))", generic)
chat = text.find("seekdeepLogRoute('chat', prompt);", generic)
if not (post >= 0 and model > post and generic > model and status > generic and chat > status):
    raise SystemExit("Dispatcher order is unsafe. Expected post-archive -> model-status -> generic utility -> status -> chat.")

if "seekdeepMakeImageQueueJobId" in text:
    raise SystemExit("Unsafe old queue helper found after patch: seekdeepMakeImageQueueJobId")
if "job.run" in text:
    raise SystemExit("Unsafe job.run-style queue logic found after patch")

out = text if newline == "\n" else text.replace("\n", "\r\n")
path.write_bytes(out.encode("utf-8"))
print("Patched index.js with hard model-status route.")
'@

  $patchPyPath = Join-Path $patchesDir "patch_model_status_route.py"
  [System.IO.File]::WriteAllText($patchPyPath, $patchPy, [System.Text.UTF8Encoding]::new($false))
  Write-SeekDeepPass "Wrote UTF-8 patch helper to $patchPyPath"

  Push-Location $projectRoot
  try {
    Write-SeekDeepInfo "Applying model-status route patch"
    & ".\.venv\Scripts\python.exe" $patchPyPath $indexPath
    if ($LASTEXITCODE -ne 0) {
      throw "Python patch helper failed with exit code $LASTEXITCODE."
    }
    Write-SeekDeepPass "Applied model-status route patch"

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
  Write-Host "SeekDeep model-status route patch completed successfully." -ForegroundColor Green
  Write-Host "Backup created: $backupPath" -ForegroundColor Green
  Write-Host "Test in Discord: @SEEKOTICS What model are you using?" -ForegroundColor Yellow
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
