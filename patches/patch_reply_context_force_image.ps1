# SeekDeep / Seekotics force image route for reply-context generate
#
# Fixes:
# - Replying to a message with "@SEEKOTICS generate" can replace prompt with reply text,
#   but then the dispatcher may still route that reply text to chat.
#
# Desired:
# - If the user sends a generate-only trigger while replying to a visual-ish message,
#   force image routing.
#
# Also improves replied-context visual detection for critique-like messages such as:
#   "Nothing matrix here. Matrix is greenish. Ripto..."
#
# Safety:
# - Backs up index.js first
# - Patches index.js only
# - Preserves:
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
  Write-Host "[SeekDeep reply-force-image] $Message" -ForegroundColor Cyan
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

  $indexBackup = Join-Path $backupDir "index.js.reply-context-force-image-$stamp.bak"
  Copy-Item -LiteralPath $indexPath -Destination $indexBackup -Force
  Write-Pass "Backed up index.js to $indexBackup"

  $utf8NoBom = [System.Text.UTF8Encoding]::new($false)

  $patchPy = @'
from pathlib import Path
import re
import sys

if len(sys.argv) != 2:
    raise SystemExit("Usage: patch_reply_context_force_image.py <index.js>")

path = Path(sys.argv[1])
raw = path.read_bytes()
newline = "\r\n" if b"\r\n" in raw else "\n"
text = raw.decode("utf-8-sig").replace("\r\n", "\n").replace("\r", "\n")

def require_contains(haystack: str, needle: str, label: str):
    if needle not in haystack:
        raise SystemExit(f"Required anchor not found: {label}")

for needle, label in [
    ("client.on('messageCreate'", "messageCreate handler"),
    ("seekdeepApplyReplyContextToPrompt(message, prompt)", "reply-context hook"),
    ("seekdeepEnqueueImageJob(job, runner)", "queue contract"),
]:
    require_contains(text, needle, label)

if "seekdeepMakeImageQueueJobId" in text:
    raise SystemExit("Unsafe old queue helper found: seekdeepMakeImageQueueJobId")
if "job.run" in text:
    raise SystemExit("Unsafe job.run-style queue logic found")

# Make reply-context visual detection less brittle for critique/correction text that includes
# known visual names/modifiers but isn't formatted as a clean prompt.
if "function seekdeepReplyContextLooksVisualPrompt" in text:
    fn_start = text.find("function seekdeepReplyContextLooksVisualPrompt")
    brace = text.find("{", fn_start)
    depth = 0
    i = brace
    end = -1
    while i < len(text):
        if text[i] == "{":
            depth += 1
        elif text[i] == "}":
            depth -= 1
            if depth == 0:
                end = i + 1
                break
        i += 1
    if end < 0:
        raise SystemExit("Could not find end of seekdeepReplyContextLooksVisualPrompt.")

    fn = text[fn_start:end]
    if "SEEKDEEP_REPLY_VISUAL_CRITIQUE_CUE_START" not in fn:
        insert = r"""
  // SEEKDEEP_REPLY_VISUAL_CRITIQUE_CUE_START
  if (/\b(ripto|spyro|matrix|predator|toad|mario|pepe|sailor\s*moon|homer|simpson|animal\s*crossing|nintendo)\b/i.test(p) &&
      /\b(matrix|green|greenish|predator|style|version|make|more|less|looks|image|picture|art|render|generate)\b/i.test(p)) {
    return true;
  }
  // SEEKDEEP_REPLY_VISUAL_CRITIQUE_CUE_END

"""
        # Insert after lower = p.toLowerCase(); if available, else after visualCue definition.
        anchor = "  const lower = p.toLowerCase();\n"
        if anchor in fn:
            fn = fn.replace(anchor, anchor + insert, 1)
        else:
            anchor = "  const visualCue = "
            pos = fn.find(anchor)
            if pos < 0:
                raise SystemExit("Could not insert critique visual cue in reply visual function.")
            line_end = fn.find("\n", pos)
            fn = fn[:line_end + 1] + insert + fn[line_end + 1:]
        text = text[:fn_start] + fn + text[end:]

# Add force-image flag after reply-context prompt assignment.
if "SEEKDEEP_REPLY_FORCE_IMAGE_FLAG_START" not in text:
    anchor = "prompt = seekdeepReplyPromptInfo.prompt;\n"
    pos = text.find(anchor, text.find("client.on('messageCreate'"))
    if pos < 0:
        raise SystemExit("Could not locate prompt assignment after reply-context hook.")
    insert_at = pos + len(anchor)
    block = """const seekdeepForceImageFromReplyContext = Boolean(seekdeepReplyPromptInfo?.usedReplyContext);\n"""
    # Preserve indentation from assignment line.
    line_start = text.rfind("\n", 0, pos) + 1
    indent = re.match(r"\s*", text[line_start:pos]).group(0)
    block = indent + "// SEEKDEEP_REPLY_FORCE_IMAGE_FLAG_START\n" + indent + block + indent + "// SEEKDEEP_REPLY_FORCE_IMAGE_FLAG_END\n"
    text = text[:insert_at] + block + text[insert_at:]

# Patch route condition to include force-image flag.
if "seekdeepForceImageFromReplyContext ||" not in text:
    msg_start = text.find("client.on('messageCreate'")
    # Prefer existing complex image route containing isNaturalImagePrompt(prompt)
    m = re.search(r"(?m)^(?P<indent>\s*)if \((?P<inner>[^\n]*isNaturalImagePrompt\(prompt\)[^\n]*)\) \{", text[msg_start:])
    if not m:
        raise SystemExit("Could not locate image route condition containing isNaturalImagePrompt(prompt).")
    start = msg_start + m.start()
    end = msg_start + m.end()
    indent = m.group("indent")
    inner = m.group("inner")
    new_line = f"{indent}if (seekdeepForceImageFromReplyContext || ({inner})) {{"
    text = text[:start] + new_line + text[end:]

# Ensure reply-context object returns usedReplyContext=true when it consumed reply text.
# Existing function should already do this; this validation catches failed prior patch.
require_contains(text, "usedReplyContext: true", "reply-context used flag")
require_contains(text, "const seekdeepForceImageFromReplyContext", "force image flag")
require_contains(text, "seekdeepForceImageFromReplyContext ||", "force image route condition")
require_contains(text, "SEEKDEEP_REPLY_VISUAL_CRITIQUE_CUE_START", "critique visual cue")
require_contains(text, "seekdeepEnqueueImageJob(job, runner)", "queue contract preserved")

out = text if newline == "\n" else text.replace("\n", "\r\n")
path.write_bytes(out.encode("utf-8"))
print("Patched reply-context force-image routing.")
'@

  $patchPyPath = Join-Path $patchesDir "patch_reply_context_force_image.py"
  [System.IO.File]::WriteAllText($patchPyPath, $patchPy, $utf8NoBom)

  Push-Location $projectRoot
  try {
    Write-Info "Applying reply-context force-image patch"
    & ".\.venv\Scripts\python.exe" $patchPyPath $indexPath
    if ($LASTEXITCODE -ne 0) {
      throw "Patch helper failed with exit code $LASTEXITCODE."
    }
    Write-Pass "Applied reply-context force-image patch"

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
  Write-Pass "Reply-context force-image patch completed."
  Write-Host "Backup created: $indexBackup" -ForegroundColor Yellow
  Write-Host "Restart the Discord bot before testing." -ForegroundColor Yellow
  Write-Host ""
  Write-Host "Retest:" -ForegroundColor Cyan
  Write-Host "Reply to: Nothing matrix here. Matrix is greenish. Ripto..." -ForegroundColor White
  Write-Host "Send: @SEEKOTICS generate" -ForegroundColor White
  Write-Host "Expected: route=image, not Qwen chat" -ForegroundColor White
  exit 0
} catch {
  Write-Host ""
  Write-Fail $_.Exception.Message
  Write-Host "Backup available:" -ForegroundColor Yellow
  if ($indexBackup) { Write-Host $indexBackup -ForegroundColor Yellow }
  exit 1
}
