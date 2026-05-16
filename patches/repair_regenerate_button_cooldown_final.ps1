# SeekDeep / Seekotics regenerate button cooldown final repair
#
# Root cause found from current live index.js:
# - The Regenerate button path checks seekdeepImageCooldownRemaining(userId)
# - But when regenerate is allowed, it never calls seekdeepRememberImageCooldown(userId)
# - Therefore repeated Regenerate button clicks keep seeing no cooldown.
#
# Fix:
# - In the action === 'regen' button branch:
#   1. Check cooldown after the interaction is deferred and state is loaded.
#   2. If cooldown active, edit the ephemeral reply with seconds left and return.
#   3. If allowed, enqueue the regenerate job.
#   4. Immediately remember the cooldown after enqueueing is accepted, before awaiting completion.
#
# Important:
# - We remember cooldown after calling seekdeepEnqueueImageJob(...) because an earlier queue-boundary
#   patch may check cooldown inside seekdeepEnqueueImageJob. Remembering before enqueue would make
#   the first allowed regenerate block itself.
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

  $backupPath = Join-Path $backupDir "index.js.regenerate-button-cooldown-final-$stamp.bak"
  Copy-Item -LiteralPath $indexPath -Destination $backupPath -Force
  Write-SeekDeepPass "Backed up index.js to $backupPath"

  $patchPy = @'
from pathlib import Path
import re
import sys

if len(sys.argv) != 2:
    raise SystemExit("Usage: repair_regenerate_button_cooldown_final.py <index.js>")

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

require_contains(text, "function seekdeepHandleImageButton(interaction)", "image button handler")
require_contains(text, "if (action === 'regen')", "regen button action branch")
require_contains(text, "function seekdeepImageCooldownRemaining", "cooldown remaining helper")
require_contains(text, "function seekdeepRememberImageCooldown", "cooldown remember helper")
require_contains(text, "function seekdeepEnqueueImageJob(job, runner)", "correct queue contract")

if "seekdeepMakeImageQueueJobId" in text:
    raise SystemExit("Unsafe old queue helper found: seekdeepMakeImageQueueJobId")
if "job.run" in text:
    raise SystemExit("Unsafe job.run-style queue logic found")

start, open_brace, close_brace, fn = find_function_block(text, "seekdeepHandleImageButton")

if "SEEKDEEP_REGENERATE_BUTTON_FINAL_COOLDOWN_START" in fn:
    raise SystemExit("Final regenerate button cooldown patch already appears to be applied.")

regen_pos = fn.find("if (action === 'regen') {")
if regen_pos < 0:
    raise SystemExit("Could not locate action === 'regen' branch inside seekdeepHandleImageButton.")

regen_open = fn.find("{", regen_pos)
regen_close = find_matching_brace(fn, regen_open)
regen_block = fn[regen_pos:regen_close + 1]

old_user_line = "    const userId = interaction?.user?.id || 'unknown';\n"
if old_user_line not in regen_block:
    raise SystemExit("Could not locate regenerate button userId line.")

cooldown_check = """    const userId = interaction?.user?.id || 'unknown';
    // SEEKDEEP_REGENERATE_BUTTON_FINAL_COOLDOWN_START
    const seekdeepButtonRegenCooldownRemaining = seekdeepImageCooldownRemaining(userId);
    if (seekdeepButtonRegenCooldownRemaining > 0) {
      if (typeof seekdeepLogRoute === 'function') seekdeepLogRoute('regenerate-cooldown', 'button-regenerate');

      const modelUsed = typeof seekdeepNoModelLabel === 'function' ? seekdeepNoModelLabel() : 'local command (no AI model)';
      await interaction.editReply({
        content: seekdeepAppendResponseFooter(seekdeepImageCooldownText(seekdeepButtonRegenCooldownRemaining), {
          startedAt,
          modelUsed,
        }),
      });

      return true;
    }
    // SEEKDEEP_REGENERATE_BUTTON_FINAL_COOLDOWN_END
"""

regen_block = regen_block.replace(old_user_line, cooldown_check, 1)

old_enqueue = "    await seekdeepEnqueueImageJob(job, async (runningJob) => {"
if old_enqueue not in regen_block:
    raise SystemExit("Could not locate awaited regenerate button enqueue call.")

regen_block = regen_block.replace(old_enqueue, "    const seekdeepButtonRegenQueuePromise = seekdeepEnqueueImageJob(job, async (runningJob) => {", 1)

old_after_enqueue = "    });\n\n    return true;"
if old_after_enqueue not in regen_block:
    raise SystemExit("Could not locate regenerate button enqueue completion block.")

new_after_enqueue = """    });

    // Start cooldown after enqueue is accepted. Do not do this before enqueue,
    // because seekdeepEnqueueImageJob may also contain a cooldown gate.
    seekdeepRememberImageCooldown(userId);
    await seekdeepButtonRegenQueuePromise;

    return true;"""
regen_block = regen_block.replace(old_after_enqueue, new_after_enqueue, 1)

fn = fn[:regen_pos] + regen_block + fn[regen_close + 1:]
text = text[:start] + fn + text[close_brace + 1:]

for needle, label in [
    ("SEEKDEEP_REGENERATE_BUTTON_FINAL_COOLDOWN_START", "final regenerate button cooldown marker"),
    ("const seekdeepButtonRegenCooldownRemaining = seekdeepImageCooldownRemaining(userId);", "regen button cooldown check"),
    ("seekdeepRememberImageCooldown(userId);", "regen button cooldown remember"),
    ("const seekdeepButtonRegenQueuePromise = seekdeepEnqueueImageJob(job, async", "regen button enqueue promise"),
    ("await seekdeepButtonRegenQueuePromise;", "regen button await queued promise"),
    ("function seekdeepEnqueueImageJob(job, runner)", "queue contract preserved"),
]:
    require_contains(text, needle, label)

out = text if newline == "\n" else text.replace("\n", "\r\n")
path.write_bytes(out.encode("utf-8"))
print("Patched regenerate button branch to remember cooldown after enqueue.")
'@

  $patchPyPath = Join-Path $patchesDir "repair_regenerate_button_cooldown_final.py"
  [System.IO.File]::WriteAllText($patchPyPath, $patchPy, [System.Text.UTF8Encoding]::new($false))
  Write-SeekDeepPass "Wrote UTF-8 repair helper to $patchPyPath"

  Push-Location $projectRoot
  try {
    Write-SeekDeepInfo "Applying final regenerate button cooldown repair"
    & ".\.venv\Scripts\python.exe" $patchPyPath $indexPath
    if ($LASTEXITCODE -ne 0) {
      throw "Python repair helper failed with exit code $LASTEXITCODE."
    }
    Write-SeekDeepPass "Applied final regenerate button cooldown repair"

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
  Write-Host "SeekDeep final regenerate button cooldown repair completed successfully." -ForegroundColor Green
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
