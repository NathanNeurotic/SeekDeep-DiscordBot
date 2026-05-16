# SeekDeep / Seekotics broader image-vs-chat intent routing patch
#
# Purpose:
# - Reduce reliance on brittle image trigger phrases.
# - Add a safe rule-based fallback that routes natural visual requests to image generation.
# - Preserve hard commands and existing stabilized dispatcher behavior.
# - Do NOT add AI/Qwen routing yet.
#
# This patch intentionally avoids model-based intent classification for now.
#
# Files patched:
# - index.js
#
# Workflow guarantees:
# - Backs up index.js first
# - Uses UTF-8-safe patching
# - Runs:
#     node --check .\index.js
#     .\.venv\Scripts\python.exe -m py_compile .\local_ai_server.py

$ErrorActionPreference = "Stop"

try {
  [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
} catch {}

function Write-Info {
  param([string]$Message)
  Write-Host "[SeekDeep intent-router] $Message" -ForegroundColor Cyan
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

  $indexBackup = Join-Path $backupDir "index.js.broader-image-intent-routing-$stamp.bak"
  Copy-Item -LiteralPath $indexPath -Destination $indexBackup -Force
  Write-Pass "Backed up index.js to $indexBackup"

  $utf8NoBom = [System.Text.UTF8Encoding]::new($false)

  $patchPy = @'
from pathlib import Path
import re
import sys

if len(sys.argv) != 2:
    raise SystemExit("Usage: patch_broader_image_intent_routing.py <index.js>")

path = Path(sys.argv[1])
raw = path.read_bytes()
newline = "\r\n" if b"\r\n" in raw else "\n"
text = raw.decode("utf-8-sig").replace("\r\n", "\n").replace("\r", "\n")

def require_contains(haystack: str, needle: str, label: str):
    if needle not in haystack:
        raise SystemExit(f"Required anchor not found: {label}")

require_contains(text, "function isNaturalImagePrompt", "isNaturalImagePrompt")
require_contains(text, "seekdeepEnqueueImageJob(job, runner)", "correct queue contract")
require_contains(text, "post archive", "post archive hard-command context")

if "seekdeepMakeImageQueueJobId" in text:
    raise SystemExit("Unsafe old queue helper found: seekdeepMakeImageQueueJobId")
if "job.run" in text:
    raise SystemExit("Unsafe job.run-style queue logic found")

helper_block = r"""
// SEEKDEEP_BROADER_IMAGE_INTENT_ROUTER_START
function seekdeepLooksLikeTextQuestion(prompt = '') {
  const p = String(prompt || '').trim().toLowerCase();
  if (!p) return true;

  return (
    /^(what|who|why|how|when|where|is|are|can|could|would|should|do|does|did)\b/.test(p) ||
    /\b(explain|summarize|summary|describe in words|tell me about|what is|who is|why is|how do|how to|steps|instructions|guide|advice|compare|difference between|translate|rewrite|proofread|fix this text|code|script|powershell|javascript|python|error|bug|logs?|status|queue status|admin status|cache status|archive status|help|commands)\b/.test(p)
  );
}

function seekdeepLooksLikeVisualRequest(prompt = '') {
  const p = String(prompt || '').trim().toLowerCase();
  if (!p) return false;

  if (seekdeepLooksLikeTextQuestion(p)) return false;

  const visualNouns = /\b(image|picture|pic|photo|art|artwork|drawing|illustration|painting|poster|album cover|cover art|banner|wallpaper|logo|icon|emblem|badge|character design|scene|portrait|sticker|thumbnail|concept art|screenshot|visual)\b/i;
  const creationVerbs = /\b(make|create|generate|render|draw|paint|sketch|illustrate|visualize|depict|design|show|give me|turn this into)\b/i;
  const scenePreps = /\b(of|with|wearing|holding|standing|sitting|smoking|on a|in a|inside|outside|under|over|during|at sunset|at night|in the style of)\b/i;
  const subjectCues = /\b(pepe|frog|cat|kitten|dog|dragon|robot|monster|anime|sailor moon|wizard|castle|forest|tower|gothic|metal|punk|emo|screamo|hardcore|neon|album|poster)\b/i;

  if (visualNouns.test(p) && (creationVerbs.test(p) || scenePreps.test(p) || subjectCues.test(p))) return true;
  if (creationVerbs.test(p) && subjectCues.test(p) && scenePreps.test(p)) return true;

  // Natural phrasing without explicit "draw/generate":
  // "Pepe and Sailor Moon smoking on a balcony at sunset"
  // "a gothic tower over a dead forest"
  if (/^(a|an|the)?\s*[\w\s'-]{3,80}\b(with|wearing|holding|smoking|standing|sitting|on a|in a|inside|outside|under|over|during|at sunset|at night)\b/.test(p) && subjectCues.test(p)) {
    return true;
  }

  return false;
}
// SEEKDEEP_BROADER_IMAGE_INTENT_ROUTER_END
"""

if "SEEKDEEP_BROADER_IMAGE_INTENT_ROUTER_START" not in text:
    # Put the helper immediately before isNaturalImagePrompt so it is available anywhere later.
    text = text.replace("function isNaturalImagePrompt", helper_block + "\nfunction isNaturalImagePrompt", 1)

# Patch isNaturalImagePrompt to include the broad fallback if not already present.
fn_match = re.search(r"function\s+isNaturalImagePrompt\s*\([^)]*\)\s*\{", text)
if not fn_match:
    raise SystemExit("Could not locate isNaturalImagePrompt function.")

open_brace = text.find("{", fn_match.end() - 1)

def find_matching_brace(src, open_index):
    depth = 0
    i = open_index
    in_single = in_double = in_template = False
    in_line_comment = in_block_comment = False
    escape = False

    while i < len(src):
        c = src[i]
        n = src[i + 1] if i + 1 < len(src) else ""

        if in_line_comment:
            if c in "\r\n":
                in_line_comment = False
            i += 1
            continue

        if in_block_comment:
            if c == "*" and n == "/":
                in_block_comment = False
                i += 2
                continue
            i += 1
            continue

        if in_single:
            if escape:
                escape = False
            elif c == "\\":
                escape = True
            elif c == "'":
                in_single = False
            i += 1
            continue

        if in_double:
            if escape:
                escape = False
            elif c == "\\":
                escape = True
            elif c == '"':
                in_double = False
            i += 1
            continue

        if in_template:
            if escape:
                escape = False
            elif c == "\\":
                escape = True
            elif c == "`":
                in_template = False
            i += 1
            continue

        if c == "/" and n == "/":
            in_line_comment = True
            i += 2
            continue

        if c == "/" and n == "*":
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

        if c == "`":
            in_template = True
            i += 1
            continue

        if c == "{":
            depth += 1
        elif c == "}":
            depth -= 1
            if depth == 0:
                return i

        i += 1

    raise SystemExit("Could not find matching brace.")

close_brace = find_matching_brace(text, open_brace)
fn = text[fn_match.start():close_brace + 1]

if "seekdeepLooksLikeVisualRequest" not in fn:
    insert = """
  if (seekdeepLooksLikeVisualRequest(prompt)) return true;
"""
    # Insert before the function's final closing brace.
    fn = fn[:-1] + insert + "}"
    text = text[:fn_match.start()] + fn + text[close_brace + 1:]

# Add extra route logging where image route is used, if possible and not already present.
# This preserves behavior; it only improves logs for broad-rule hits.
if "route=image-intent-rule" not in text:
    text = text.replace(
        "if (isNaturalImagePrompt(prompt)) {\n",
        "if (isNaturalImagePrompt(prompt)) {\n      if (seekdeepLooksLikeVisualRequest(prompt)) seekdeepLogRoute('image-intent-rule', prompt);\n",
        1,
    )

for needle, label in [
    ("SEEKDEEP_BROADER_IMAGE_INTENT_ROUTER_START", "broader image intent helper marker"),
    ("function seekdeepLooksLikeTextQuestion", "text-question guard"),
    ("function seekdeepLooksLikeVisualRequest", "visual request classifier"),
    ("if (seekdeepLooksLikeVisualRequest(prompt)) return true;", "isNaturalImagePrompt fallback"),
    ("seekdeepEnqueueImageJob(job, runner)", "correct queue contract preserved"),
]:
    require_contains(text, needle, label)

out = text if newline == "\n" else text.replace("\n", "\r\n")
path.write_bytes(out.encode("utf-8"))
print("Patched broader rule-based image intent routing.")
'@

  $patchPyPath = Join-Path $patchesDir "patch_broader_image_intent_routing.py"
  [System.IO.File]::WriteAllText($patchPyPath, $patchPy, $utf8NoBom)

  Push-Location $projectRoot
  try {
    Write-Info "Applying broader image intent routing patch"
    & ".\.venv\Scripts\python.exe" $patchPyPath $indexPath
    if ($LASTEXITCODE -ne 0) {
      throw "Patch helper failed with exit code $LASTEXITCODE."
    }
    Write-Pass "Applied broader image intent routing patch"

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
  Write-Pass "Broader image-vs-chat intent routing patch completed."
  Write-Host "Backup created: $indexBackup" -ForegroundColor Yellow
  Write-Host "Restart the Discord bot before testing." -ForegroundColor Yellow
  Write-Host ""
  Write-Host "Test cases:" -ForegroundColor Cyan
  Write-Host "@SEEKOTICS I want a picture of a gothic tower over a dead forest" -ForegroundColor White
  Write-Host "@SEEKOTICS Pepe and Sailor Moon smoking on a balcony at sunset" -ForegroundColor White
  Write-Host "@SEEKOTICS what is a gothic tower" -ForegroundColor White
  exit 0
} catch {
  Write-Host ""
  Write-Fail $_.Exception.Message
  Write-Host "Backup available:" -ForegroundColor Yellow
  if ($indexBackup) { Write-Host $indexBackup -ForegroundColor Yellow }
  exit 1
}
