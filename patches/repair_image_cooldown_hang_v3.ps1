# SeekDeep / Seekotics image cooldown hang repair v3
#
# Fixes:
# - route=image-cooldown logs correctly
# - but bot keeps typing / appears hung
# - user does not receive the cooldown seconds-left notice
#
# Strategy:
# - Keep the working cooldown detection.
# - Add a more direct, non-swallowing cooldown notice sender.
# - Stop the typing loop before and after the cooldown notice.
# - Replace the existing cooldown-route reply call with the safer sender.
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

  $backupPath = Join-Path $backupDir "index.js.cooldown-hang-repair-v3-$stamp.bak"
  Copy-Item -LiteralPath $indexPath -Destination $backupPath -Force
  Write-SeekDeepPass "Backed up index.js to $backupPath"

  $patchPy = @'
from pathlib import Path
import re
import sys

if len(sys.argv) != 2:
    raise SystemExit("Usage: repair_image_cooldown_hang_v3.py <index.js>")

path = Path(sys.argv[1])
raw = path.read_bytes()
newline = "\r\n" if b"\r\n" in raw else "\n"
text = raw.decode("utf-8-sig")
text = text.replace("\r\n", "\n").replace("\r", "\n")

def require_contains(haystack, needle, label):
    if needle not in haystack:
        raise SystemExit(f"Required anchor not found: {label}")

require_contains(text, "const SEEKDEEP_IMAGE_COOLDOWN_MS", "existing cooldown duration")
require_contains(text, "function seekdeepImageCooldownRemaining", "existing cooldown remaining helper")
require_contains(text, "function seekdeepImageCooldownText", "existing cooldown text helper")
require_contains(text, "seekdeepLogRoute('image-cooldown', prompt);", "image cooldown route log")
require_contains(text, "function seekdeepEnqueueImageJob(job, runner)", "correct queue contract")

if "seekdeepMakeImageQueueJobId" in text:
    raise SystemExit("Unsafe old queue helper found: seekdeepMakeImageQueueJobId")
if "job.run" in text:
    raise SystemExit("Unsafe job.run-style queue logic found")

helper_block = r"""
// SEEKDEEP_IMAGE_COOLDOWN_HANG_REPAIR_START
function seekdeepStopTypingSafelyForMessage(message) {
  try {
    if (typeof stopSeekDeepTypingLoopForMessage === 'function') {
      stopSeekDeepTypingLoopForMessage(message);
    }
  } catch (err) {
    console.warn('Could not stop typing loop for cooldown notice:', err?.message || err);
  }
}

async function seekdeepSendImageCooldownNotice(message, remainingMs) {
  const remainingSeconds = Math.max(1, Math.ceil(Number(remainingMs || 0) / 1000));
  const fallbackText = `Image generation cooldown is active. Try again in ${remainingSeconds} second${remainingSeconds === 1 ? '' : 's'}.`;
  const baseText = typeof seekdeepImageCooldownText === 'function'
    ? seekdeepImageCooldownText(remainingMs)
    : fallbackText;

  const modelUsed = typeof seekdeepNoModelLabel === 'function'
    ? seekdeepNoModelLabel()
    : 'local command (no AI model)';

  const content = typeof seekdeepAppendResponseFooter === 'function'
    ? seekdeepAppendResponseFooter(baseText || fallbackText, {
        startedAt: message?.__seekdeepRequestStartedAt,
        modelUsed,
      })
    : `${baseText || fallbackText}\n\nModel Used: ${modelUsed}`;

  seekdeepStopTypingSafelyForMessage(message);

  try {
    if (message && typeof message.reply === 'function') {
      const sent = await message.reply({
        content,
        allowedMentions: { repliedUser: false },
      });
      seekdeepStopTypingSafelyForMessage(message);
      return sent;
    }
  } catch (err) {
    console.warn('Cooldown message.reply failed; trying channel.send:', err?.message || err);
  }

  try {
    if (message?.channel && typeof message.channel.send === 'function') {
      const sent = await message.channel.send({
        content,
        allowedMentions: { repliedUser: false },
      });
      seekdeepStopTypingSafelyForMessage(message);
      return sent;
    }
  } catch (err) {
    console.warn('Cooldown channel.send fallback failed:', err?.message || err);
  }

  seekdeepStopTypingSafelyForMessage(message);
  return null;
}
// SEEKDEEP_IMAGE_COOLDOWN_HANG_REPAIR_END
"""

if "SEEKDEEP_IMAGE_COOLDOWN_HANG_REPAIR_START" not in text:
    text = text.replace("function seekdeepEnqueueImageJob(job, runner)", helper_block + "\nfunction seekdeepEnqueueImageJob(job, runner)", 1)

# Replace older fragile cooldown reply helpers only in the image route branch.
replacements = [
    (
        "await seekdeepReplyImageCooldownRemaining(message, seekdeepRouteCooldownRemaining);",
        "await seekdeepSendImageCooldownNotice(message, seekdeepRouteCooldownRemaining);"
    ),
    (
        "await seekdeepReplyImageCooldownRemaining(message, cooldownRemaining);",
        "await seekdeepSendImageCooldownNotice(message, cooldownRemaining);"
    ),
    (
        "await seekdeepReplyImageCooldownRemaining(message, remaining);",
        "await seekdeepSendImageCooldownNotice(message, remaining);"
    ),
]

changed = 0
for old, new in replacements:
    count = text.count(old)
    if count:
        text = text.replace(old, new)
        changed += count

# If the route exists but the earlier helper call was already absent, patch the image-cooldown block directly.
if changed == 0:
    pattern = re.compile(
        r"(seekdeepLogRoute\('image-cooldown', prompt\);\s*)"
        r"(?P<body>.*?)"
        r"(\s*return;\s*)",
        re.S
    )
    m = pattern.search(text)
    if not m:
        raise SystemExit("Could not locate image-cooldown branch body to repair.")

    body = m.group("body")
    if "seekdeepSendImageCooldownNotice" not in body:
      replacement = m.group(1) + "\n        await seekdeepSendImageCooldownNotice(message, seekdeepRouteCooldownRemaining);\n" + m.group(3)
      text = text[:m.start()] + replacement + text[m.end():]
      changed = 1

# Ensure every cooldown return stops typing even if the reply throws.
if "seekdeepStopTypingSafelyForMessage(message);\n        return;" not in text:
    text = text.replace(
        "await seekdeepSendImageCooldownNotice(message, seekdeepRouteCooldownRemaining);\n        return;",
        "await seekdeepSendImageCooldownNotice(message, seekdeepRouteCooldownRemaining);\n        seekdeepStopTypingSafelyForMessage(message);\n        return;"
    )
    text = text.replace(
        "await seekdeepSendImageCooldownNotice(message, cooldownRemaining);\n        return;",
        "await seekdeepSendImageCooldownNotice(message, cooldownRemaining);\n        seekdeepStopTypingSafelyForMessage(message);\n        return;"
    )
    text = text.replace(
        "await seekdeepSendImageCooldownNotice(message, remaining);\n        return;",
        "await seekdeepSendImageCooldownNotice(message, remaining);\n        seekdeepStopTypingSafelyForMessage(message);\n        return;"
    )

for needle, label in [
    ("SEEKDEEP_IMAGE_COOLDOWN_HANG_REPAIR_START", "cooldown hang repair helper marker"),
    ("async function seekdeepSendImageCooldownNotice", "safe cooldown notice sender"),
    ("seekdeepStopTypingSafelyForMessage(message)", "typing loop stop helper usage"),
    ("seekdeepSendImageCooldownNotice(message", "image cooldown branch uses safe sender"),
    ("seekdeepLogRoute('image-cooldown', prompt);", "image cooldown route log preserved"),
    ("function seekdeepEnqueueImageJob(job, runner)", "correct queue contract"),
]:
    require_contains(text, needle, label)

out = text if newline == "\n" else text.replace("\n", "\r\n")
path.write_bytes(out.encode("utf-8"))
print(f"Repaired image cooldown branch with safe reply + typing-loop stop. Replaced {changed} call site(s).")
'@

  $patchPyPath = Join-Path $patchesDir "repair_image_cooldown_hang_v3.py"
  [System.IO.File]::WriteAllText($patchPyPath, $patchPy, [System.Text.UTF8Encoding]::new($false))
  Write-SeekDeepPass "Wrote UTF-8 repair helper to $patchPyPath"

  Push-Location $projectRoot
  try {
    Write-SeekDeepInfo "Applying image cooldown hang repair v3"
    & ".\.venv\Scripts\python.exe" $patchPyPath $indexPath
    if ($LASTEXITCODE -ne 0) {
      throw "Python repair helper failed with exit code $LASTEXITCODE."
    }
    Write-SeekDeepPass "Applied image cooldown hang repair v3"

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
  Write-Host "SeekDeep image cooldown hang repair v3 completed successfully." -ForegroundColor Green
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
  exit 1
}
