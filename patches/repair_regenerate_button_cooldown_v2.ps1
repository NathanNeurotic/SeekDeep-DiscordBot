# SeekDeep / Seekotics regenerate button cooldown repair v2
#
# Fixes:
# - Regenerate button bypasses image cooldown.
#
# Strategy:
# - Patch the image queue boundary itself:
#     seekdeepEnqueueImageJob(job, runner)
# - Only applies cooldown blocking when job.source indicates regenerate/reroll/redo.
# - This catches button regenerate even when the button handler name/customId shape changed.
# - Sends a user-visible cooldown notice when a source message/interaction is available.
# - If no source object is available, rejects the regenerate job before it reaches the image backend.
#
# Preserves:
# - normal image jobs
# - existing text image cooldown
# - refined prompt display
# - queue contract: seekdeepEnqueueImageJob(job, runner)
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

  $backupPath = Join-Path $backupDir "index.js.regenerate-button-cooldown-v2-$stamp.bak"
  Copy-Item -LiteralPath $indexPath -Destination $backupPath -Force
  Write-SeekDeepPass "Backed up index.js to $backupPath"

  $patchPy = @'
from pathlib import Path
import re
import sys

if len(sys.argv) != 2:
    raise SystemExit("Usage: repair_regenerate_button_cooldown_v2.py <index.js>")

path = Path(sys.argv[1])
raw = path.read_bytes()
newline = "\r\n" if b"\r\n" in raw else "\n"
text = raw.decode("utf-8-sig")
text = text.replace("\r\n", "\n").replace("\r", "\n")

def require_contains(haystack, needle, label):
    if needle not in haystack:
        raise SystemExit(f"Required anchor not found: {label}")

def find_matching_brace(src, open_index):
    depth = 0
    i = open_index
    in_single = in_double = in_template = False
    in_line_comment = in_block_comment = False
    escape = False

    while i < len(src):
        c = src[i]
        n = src[i + 1] if i + 1 < len(src) else ''

        if in_line_comment:
            if c in '\r\n':
                in_line_comment = False
            i += 1
            continue

        if in_block_comment:
            if c == '*' and n == '/':
                in_block_comment = False
                i += 2
                continue
            i += 1
            continue

        if in_single:
            if escape:
                escape = False
            elif c == '\\':
                escape = True
            elif c == "'":
                in_single = False
            i += 1
            continue

        if in_double:
            if escape:
                escape = False
            elif c == '\\':
                escape = True
            elif c == '"':
                in_double = False
            i += 1
            continue

        if in_template:
            if escape:
                escape = False
            elif c == '\\':
                escape = True
            elif c == '`':
                in_template = False
            i += 1
            continue

        if c == '/' and n == '/':
            in_line_comment = True
            i += 2
            continue

        if c == '/' and n == '*':
            in_block_comment = True
            i += 2
            continue

        if c == "'":
            in_single = True
            i += 1
            continue

        if c == '"':
            in_double = True
            i += 1
            continue

        if c == '`':
            in_template = True
            i += 1
            continue

        if c == '{':
            depth += 1
        elif c == '}':
            depth -= 1
            if depth == 0:
                return i

        i += 1

    raise SystemExit("Could not find matching closing brace.")

def find_function_block(src, function_name):
    m = re.search(r'(?:async\s+)?function\s+' + re.escape(function_name) + r'\s*\(', src)
    if not m:
        raise SystemExit(f"Could not locate function {function_name}.")

    open_brace = src.find('{', m.end())
    if open_brace < 0:
        raise SystemExit(f"Could not locate opening brace for {function_name}.")

    close_brace = find_matching_brace(src, open_brace)
    return m.start(), open_brace, close_brace, src[m.start():close_brace + 1]

require_contains(text, "const SEEKDEEP_IMAGE_COOLDOWN_MS", "existing cooldown duration")
require_contains(text, "function seekdeepImageCooldownRemaining", "existing cooldown remaining helper")
require_contains(text, "function seekdeepEnqueueImageJob(job, runner)", "correct queue contract")

if "seekdeepMakeImageQueueJobId" in text:
    raise SystemExit("Unsafe old queue helper found: seekdeepMakeImageQueueJobId")
if "job.run" in text:
    raise SystemExit("Unsafe job.run-style queue logic found")

helper_block = r"""
// SEEKDEEP_REGENERATE_QUEUE_COOLDOWN_START
function seekdeepIsRegenerateImageJob(job = {}) {
  const values = [
    job.source,
    job.type,
    job.kind,
    job.action,
    job.actionType,
    job.command,
    job.reason,
    job.id,
  ].map((value) => String(value || '').toLowerCase());

  return values.some((value) => /\b(?:regenerate|regen|reroll|redo)\b/.test(value));
}

function seekdeepCooldownUserIdFromJob(job = {}) {
  return String(
    job.userId ||
    job.user?.id ||
    job.author?.id ||
    job.member?.user?.id ||
    job.interaction?.user?.id ||
    job.interaction?.member?.user?.id ||
    job.message?.author?.id ||
    job.sourceMessage?.author?.id ||
    job.requestMessage?.author?.id ||
    job.ownerId ||
    'unknown'
  ).trim() || 'unknown';
}

function seekdeepCooldownSourceFromJob(job = {}) {
  return job.interaction || job.sourceInteraction || job.buttonInteraction || job.message || job.sourceMessage || job.requestMessage || null;
}

async function seekdeepNotifyRegenerateJobCooldown(job = {}, remainingMs = 0) {
  const source = seekdeepCooldownSourceFromJob(job);
  const remainingSeconds = Math.max(1, Math.ceil(Number(remainingMs || 0) / 1000));
  const baseText = typeof seekdeepImageCooldownText === 'function'
    ? seekdeepImageCooldownText(remainingMs)
    : `Image generation cooldown is active. Try again in ${remainingSeconds} second${remainingSeconds === 1 ? '' : 's'}.`;

  const modelUsed = typeof seekdeepNoModelLabel === 'function'
    ? seekdeepNoModelLabel()
    : 'local command (no AI model)';

  const content = typeof seekdeepAppendResponseFooter === 'function'
    ? seekdeepAppendResponseFooter(baseText, {
        startedAt: source?.__seekdeepRequestStartedAt || job.enqueuedAt || Date.now(),
        modelUsed,
      })
    : `${baseText}\n\nModel Used: ${modelUsed}`;

  try {
    if (source && typeof source.reply === 'function') {
      return await source.reply({
        content,
        allowedMentions: { repliedUser: false },
        ephemeral: true,
      });
    }
  } catch (err) {
    console.warn('Regenerate cooldown source.reply failed:', err?.message || err);
  }

  try {
    if (source && typeof source.followUp === 'function') {
      return await source.followUp({
        content,
        ephemeral: true,
      });
    }
  } catch (err) {
    console.warn('Regenerate cooldown source.followUp failed:', err?.message || err);
  }

  try {
    if (source && typeof source.editReply === 'function') {
      return await source.editReply({
        content,
      });
    }
  } catch (err) {
    console.warn('Regenerate cooldown source.editReply failed:', err?.message || err);
  }

  try {
    if (source?.channel && typeof source.channel.send === 'function') {
      return await source.channel.send({
        content,
        allowedMentions: { repliedUser: false },
      });
    }
  } catch (err) {
    console.warn('Regenerate cooldown channel fallback failed:', err?.message || err);
  }

  console.warn(`Regenerate cooldown blocked job ${job?.id || '(unknown id)'} for ${remainingSeconds}s, but no reply target was available.`);
  return null;
}
// SEEKDEEP_REGENERATE_QUEUE_COOLDOWN_END
"""

if "SEEKDEEP_REGENERATE_QUEUE_COOLDOWN_START" not in text:
    text = text.replace("function seekdeepEnqueueImageJob(job, runner)", helper_block + "\nfunction seekdeepEnqueueImageJob(job, runner)", 1)

start, open_brace, close_brace, fn = find_function_block(text, "seekdeepEnqueueImageJob")

if "SEEKDEEP_REGENERATE_QUEUE_COOLDOWN_GATE_START" not in fn:
    insertion = r"""
  // SEEKDEEP_REGENERATE_QUEUE_COOLDOWN_GATE_START
  if (seekdeepIsRegenerateImageJob(job)) {
    const seekdeepRegenCooldownUserId = seekdeepCooldownUserIdFromJob(job);
    const seekdeepRegenCooldownRemaining = seekdeepImageCooldownRemaining(seekdeepRegenCooldownUserId);

    if (seekdeepRegenCooldownRemaining > 0) {
      if (typeof seekdeepLogRoute === 'function') {
        seekdeepLogRoute('regenerate-cooldown', String(job?.source || job?.id || 'regenerate-job'));
      }

      await seekdeepNotifyRegenerateJobCooldown(job, seekdeepRegenCooldownRemaining);
      return null;
    }
  }
  // SEEKDEEP_REGENERATE_QUEUE_COOLDOWN_GATE_END

"""
    text = text[:open_brace + 1] + insertion + text[open_brace + 1:]

# Patch create-job calls for regenerate button path to carry interaction/source when obvious.
# This gives the queue-boundary notice a reply target. These replacements are conservative.
if "source: 'button-regenerate'" in text and "interaction," not in text[text.find("source: 'button-regenerate'"):text.find("source: 'button-regenerate'")+500]:
    text = text.replace("source: 'button-regenerate',", "source: 'button-regenerate',\n    interaction,", 1)

if "source: 'regenerate'" in text and "interaction," not in text[text.find("source: 'regenerate'"):text.find("source: 'regenerate'")+500]:
    text = text.replace("source: 'regenerate',", "source: 'regenerate',\n    interaction,", 1)

if "source: 'message-regenerate'" in text and "message," not in text[text.find("source: 'message-regenerate'"):text.find("source: 'message-regenerate'")+500]:
    text = text.replace("source: 'message-regenerate',", "source: 'message-regenerate',\n    message,", 1)

for needle, label in [
    ("SEEKDEEP_REGENERATE_QUEUE_COOLDOWN_START", "regenerate queue cooldown helper"),
    ("function seekdeepIsRegenerateImageJob", "regenerate job detector"),
    ("function seekdeepCooldownUserIdFromJob", "regenerate cooldown user id extractor"),
    ("function seekdeepNotifyRegenerateJobCooldown", "regenerate cooldown notifier"),
    ("SEEKDEEP_REGENERATE_QUEUE_COOLDOWN_GATE_START", "regenerate queue cooldown gate"),
    ("seekdeepImageCooldownRemaining(seekdeepRegenCooldownUserId)", "queue gate cooldown check"),
    ("await seekdeepNotifyRegenerateJobCooldown(job, seekdeepRegenCooldownRemaining);", "queue gate cooldown notification"),
    ("function seekdeepEnqueueImageJob(job, runner)", "correct queue contract"),
]:
    require_contains(text, needle, label)

out = text if newline == "\n" else text.replace("\n", "\r\n")
path.write_bytes(out.encode("utf-8"))
print("Patched regenerate cooldown at seekdeepEnqueueImageJob boundary.")
'@

  $patchPyPath = Join-Path $patchesDir "repair_regenerate_button_cooldown_v2.py"
  [System.IO.File]::WriteAllText($patchPyPath, $patchPy, [System.Text.UTF8Encoding]::new($false))
  Write-SeekDeepPass "Wrote UTF-8 repair helper to $patchPyPath"

  Push-Location $projectRoot
  try {
    Write-SeekDeepInfo "Applying regenerate button cooldown repair v2"
    & ".\.venv\Scripts\python.exe" $patchPyPath $indexPath
    if ($LASTEXITCODE -ne 0) {
      throw "Python repair helper failed with exit code $LASTEXITCODE."
    }
    Write-SeekDeepPass "Applied regenerate button cooldown repair v2"

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
  Write-Host "SeekDeep regenerate button cooldown repair v2 completed successfully." -ForegroundColor Green
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
