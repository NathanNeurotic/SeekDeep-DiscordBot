# SeekDeep / Seekotics image cooldown notification repair
#
# Fixes:
# - Image cooldown blocks repeated image requests but sends no visible reply.
#
# Strategy:
# - Keep the existing cooldown implementation.
# - Patch the cooldown rejection branch so it replies with seconds remaining.
# - Preserve the existing cooldown gate and queue contract.
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

  $backupPath = Join-Path $backupDir "index.js.cooldown-notification-repair-$stamp.bak"
  Copy-Item -LiteralPath $indexPath -Destination $backupPath -Force
  Write-SeekDeepPass "Backed up index.js to $backupPath"

  $patchPy = @'
from pathlib import Path
import re
import sys

if len(sys.argv) != 2:
    raise SystemExit("Usage: repair_image_cooldown_notification.py <index.js>")

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

def find_function_block(src, names):
    for function_name in names:
        m = re.search(r'(?:async\s+)?function\s+' + re.escape(function_name) + r'\s*\(', src)
        if not m:
            continue

        open_brace = src.find('{', m.end())
        if open_brace < 0:
            continue

        close_brace = find_matching_brace(src, open_brace)
        return function_name, m.start(), open_brace, close_brace, src[m.start():close_brace + 1]

    raise SystemExit("Could not locate any target function: " + ", ".join(names))

require_contains(text, "const SEEKDEEP_IMAGE_COOLDOWN_MS", "existing cooldown duration")
require_contains(text, "function seekdeepImageCooldownRemaining", "existing cooldown remaining helper")
require_contains(text, "function seekdeepRememberImageCooldown", "existing cooldown remember helper")
require_contains(text, "function seekdeepImageCooldownText", "existing cooldown text helper")
require_contains(text, "function seekdeepEnqueueImageJob(job, runner)", "correct queue contract")

if "seekdeepMakeImageQueueJobId" in text:
    raise SystemExit("Unsafe old queue helper found: seekdeepMakeImageQueueJobId")
if "job.run" in text:
    raise SystemExit("Unsafe job.run-style queue logic found")

helper_block = r"""
// SEEKDEEP_IMAGE_COOLDOWN_REPLY_REPAIR_START
async function seekdeepReplyImageCooldownRemaining(source, remainingMs) {
  const remainingSeconds = Math.max(1, Math.ceil(Number(remainingMs || 0) / 1000));
  const baseText = typeof seekdeepImageCooldownText === 'function'
    ? seekdeepImageCooldownText(remainingMs)
    : `Image generation cooldown is active. Try again in ${remainingSeconds} second${remainingSeconds === 1 ? '' : 's'}.`;

  const content = seekdeepAppendResponseFooter(baseText, {
    startedAt: source?.__seekdeepRequestStartedAt,
    modelUsed: typeof seekdeepNoModelLabel === 'function' ? seekdeepNoModelLabel() : 'local command (no AI model)',
  });

  if (typeof source?.reply === 'function') {
    try {
      return await source.reply({
        content,
        allowedMentions: { repliedUser: false },
      });
    } catch (err) {
      console.warn('Cooldown reply failed:', err?.message || err);
    }
  }

  if (source?.channel && typeof source.channel.send === 'function') {
    try {
      return await source.channel.send({
        content,
        allowedMentions: { repliedUser: false },
      });
    } catch (err) {
      console.warn('Cooldown channel fallback failed:', err?.message || err);
    }
  }

  return null;
}
// SEEKDEEP_IMAGE_COOLDOWN_REPLY_REPAIR_END
"""

if "SEEKDEEP_IMAGE_COOLDOWN_REPLY_REPAIR_START" not in text:
    text = text.replace("function seekdeepEnqueueImageJob(job, runner)", helper_block + "\nfunction seekdeepEnqueueImageJob(job, runner)", 1)

# Patch the shared queue gate. The existing cooldown works, so it must already
# decide to not enqueue somewhere. We target the common pattern:
#   const cooldownRemaining = seekdeepImageCooldownRemaining(userId);
#   if (cooldownRemaining > 0) { ... return ... }
#
# We avoid changing successful queue behavior.
if "seekdeepReplyImageCooldownRemaining(message, cooldownRemaining)" not in text and "seekdeepReplyImageCooldownRemaining(source, cooldownRemaining)" not in text and "seekdeepReplyImageCooldownRemaining(interaction, cooldownRemaining)" not in text:
    patched = False

    patterns = [
        # Message source variable, common handleImagePrompt/queue wrapper.
        (
            re.compile(
                r"(const\s+cooldownRemaining\s*=\s*seekdeepImageCooldownRemaining\(\s*userId\s*\);\s*"
                r"if\s*\(\s*cooldownRemaining\s*>\s*0\s*\)\s*\{\s*)"
                r"(?P<body>.*?)(\s*return(?:\s+[^;]+)?;\s*\})",
                re.S
            ),
            "message"
        ),
        # let/var variant.
        (
            re.compile(
                r"((?:let|var)\s+cooldownRemaining\s*=\s*seekdeepImageCooldownRemaining\(\s*userId\s*\);\s*"
                r"if\s*\(\s*cooldownRemaining\s*>\s*0\s*\)\s*\{\s*)"
                r"(?P<body>.*?)(\s*return(?:\s+[^;]+)?;\s*\})",
                re.S
            ),
            "message"
        ),
        # remaining variable name variant.
        (
            re.compile(
                r"(const\s+remaining\s*=\s*seekdeepImageCooldownRemaining\(\s*userId\s*\);\s*"
                r"if\s*\(\s*remaining\s*>\s*0\s*\)\s*\{\s*)"
                r"(?P<body>.*?)(\s*return(?:\s+[^;]+)?;\s*\})",
                re.S
            ),
            "message_remaining"
        ),
    ]

    for pattern, mode in patterns:
        m = pattern.search(text)
        if not m:
            continue

        prefix = m.group(1)
        suffix = m.group(3)
        varname = "remaining" if mode == "message_remaining" else "cooldownRemaining"

        # Determine source variable by local context near the cooldown gate.
        context_start = max(0, m.start() - 1500)
        context = text[context_start:m.start()]
        source = "message"
        if "interaction" in context and "message" not in context[-500:]:
            source = "interaction"
        elif "source" in context[-500:]:
            source = "source"

        replacement = prefix + f"\n      await seekdeepReplyImageCooldownRemaining({source}, {varname});" + suffix
        text = text[:m.start()] + replacement + text[m.end():]
        patched = True
        break

    if not patched:
        # Function-level fallback: patch seekdeepEnqueueImageJob directly if cooldown is inside it.
        name, start, open_brace, close_brace, fn = find_function_block(text, ["seekdeepEnqueueImageJob"])
        if "seekdeepImageCooldownRemaining" in fn and "cooldownRemaining" in fn:
            fn2 = re.sub(
                r"(if\s*\(\s*cooldownRemaining\s*>\s*0\s*\)\s*\{\s*)",
                r"\1\n    if (job?.sourceMessage) await seekdeepReplyImageCooldownRemaining(job.sourceMessage, cooldownRemaining);\n",
                fn,
                count=1,
            )
            if fn2 == fn:
                raise SystemExit("Found cooldown in seekdeepEnqueueImageJob, but could not patch rejection branch.")
            text = text[:start] + fn2 + text[close_brace + 1:]
            patched = True

    if not patched:
        raise SystemExit("Could not locate existing cooldown rejection branch to add user notification.")

for needle, label in [
    ("SEEKDEEP_IMAGE_COOLDOWN_REPLY_REPAIR_START", "cooldown reply helper marker"),
    ("async function seekdeepReplyImageCooldownRemaining", "cooldown reply helper function"),
    ("seekdeepReplyImageCooldownRemaining", "cooldown rejection uses reply helper"),
    ("function seekdeepEnqueueImageJob(job, runner)", "correct queue contract"),
]:
    require_contains(text, needle, label)

out = text if newline == "\n" else text.replace("\n", "\r\n")
path.write_bytes(out.encode("utf-8"))
print("Patched index.js so image cooldown rejections notify the user.")
'@

  $patchPyPath = Join-Path $patchesDir "repair_image_cooldown_notification.py"
  [System.IO.File]::WriteAllText($patchPyPath, $patchPy, [System.Text.UTF8Encoding]::new($false))
  Write-SeekDeepPass "Wrote UTF-8 repair helper to $patchPyPath"

  Push-Location $projectRoot
  try {
    Write-SeekDeepInfo "Applying image cooldown notification repair"
    & ".\.venv\Scripts\python.exe" $patchPyPath $indexPath
    if ($LASTEXITCODE -ne 0) {
      throw "Python repair helper failed with exit code $LASTEXITCODE."
    }
    Write-SeekDeepPass "Applied image cooldown notification repair"

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
  Write-Host "SeekDeep image cooldown notification repair completed successfully." -ForegroundColor Green
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
