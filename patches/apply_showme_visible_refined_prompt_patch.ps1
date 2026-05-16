# SeekDeep / Seekotics show-me image routing + visible refined prompt patch
#
# Fixes:
# - "@SEEKOTICS show me a couger" falling through to Qwen chat.
# - Refined image prompts only appearing in backend logs.
#
# Adds:
# - Plain "show me ..." / "show ..." image routing for short visual requests.
# - Discord image response includes:
#     Refined Prompt: ...
#
# Preserves:
# - stabilized dispatcher
# - post archive routing
# - model-status routing if present
# - regenerate routing if present
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

  $backupPath = Join-Path $backupDir "index.js.showme-visible-refined-prompt-$stamp.bak"
  Copy-Item -LiteralPath $indexPath -Destination $backupPath -Force
  Write-SeekDeepPass "Backed up index.js to $backupPath"

  $patchPy = @'
from pathlib import Path
import re
import sys

if len(sys.argv) != 2:
    raise SystemExit("Usage: patch_showme_visible_refined_prompt.py <index.js>")

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

require_contains(text, "SEEKDEEP_STABILIZED_DISPATCH_HELPERS_START", "stabilized dispatcher marker")
require_contains(text, "function seekdeepHasExplicitImageRequest", "explicit image request detector")
require_contains(text, "function isNaturalImagePrompt", "natural image prompt detector")
require_contains(text, "function seekdeepEnqueueImageJob(job, runner)", "correct image queue contract")

if "seekdeepMakeImageQueueJobId" in text:
    raise SystemExit("Unsafe old queue helper found: seekdeepMakeImageQueueJobId")
if "job.run" in text:
    raise SystemExit("Unsafe job.run-style queue logic found")

# 1) Add plain "show me ..." / "show ..." image trigger.
start, open_brace, close_brace, fn = find_function_block(text, "seekdeepHasExplicitImageRequest")

if "SEEKDEEP_SHOW_ME_IMAGE_TRIGGER_START" not in fn:
    insertion = r"""
  // SEEKDEEP_SHOW_ME_IMAGE_TRIGGER_START
  // Accept direct visual requests like:
  //   show me a cougar
  //   show me a couger
  //   show a frog wizard
  // Keep obvious command/help/status/list requests out of image generation.
  if (/^(?:show\s+me|show)\s+(?:an?\s+|some\s+)?\S+/i.test(text) &&
      !/\b(?:status|queue|help|commands|archive|cache|recent|prompt history|model status|list|ideas|suggestions|options|names)\b/i.test(text)) {
    return true;
  }
  // SEEKDEEP_SHOW_ME_IMAGE_TRIGGER_END

"""
    # Insert after the empty-text guard.
    marker = "  if (!text) return false;\n\n"
    if marker not in fn:
        raise SystemExit("Could not find empty-text guard in seekdeepHasExplicitImageRequest.")
    fn2 = fn.replace(marker, marker + insertion, 1)
    text = text[:start] + fn2 + text[close_brace + 1:]

# 2) Ensure image prompt stripping removes "show me" and plain art verbs before sending to image backend.
# This fixes backend prompt quality after route expansion.
show_strip_replacements = [
    (
        ".replace(/^(?:draw|sketch|paint|illustrate|render)\\s+me\\s+/i, '')\n        .replace(/^(?:draw|sketch|paint|illustrate|render)\\s+/i, '')",
        ".replace(/^(?:draw|sketch|paint|illustrate|render|show)\\s+me\\s+/i, '')\n        .replace(/^(?:draw|sketch|paint|illustrate|render|show)\\s+/i, '')"
    ),
    (
        "prompt.replace(/^draw\\s+me\\s+/i, '').trim() || prompt",
        "prompt\n        .replace(/^(?:draw|sketch|paint|illustrate|render|show)\\s+me\\s+/i, '')\n        .replace(/^(?:draw|sketch|paint|illustrate|render|show)\\s+/i, '')\n        .trim() || prompt"
    ),
]
for old, new in show_strip_replacements:
    if old in text:
        text = text.replace(old, new, 1)

# 3) Add visible refined prompt helper.
visible_helper = r"""
// SEEKDEEP_VISIBLE_REFINED_PROMPT_START
function seekdeepClipForDiscord(value = '', max = 900) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  if (!text || text.length <= max) return text;
  return `${text.slice(0, Math.max(0, max - 1)).trim()}…`;
}

function seekdeepRefinedPromptLine(originalPrompt = '', refinedPrompt = '') {
  const original = String(originalPrompt || '').trim();
  const refined = String(refinedPrompt || '').trim();

  if (!refined || refined === original) return '';

  return `Refined Prompt: ${seekdeepClipForDiscord(refined, 900)}`;
}
// SEEKDEEP_VISIBLE_REFINED_PROMPT_END
"""

if "SEEKDEEP_VISIBLE_REFINED_PROMPT_START" not in text:
    # Place near image prompt refinement if possible, otherwise before queue helper.
    if "function seekdeepEnqueueImageJob(job, runner)" in text:
        text = text.replace("function seekdeepEnqueueImageJob(job, runner)", visible_helper + "\nfunction seekdeepEnqueueImageJob(job, runner)", 1)
    else:
        raise SystemExit("Could not find insertion point for visible refined prompt helper.")

# 4) Patch common generated-image response content blocks to include refined prompt if available.
# This is conservative and only touches existing arrays containing generated/regenerated image response lines.
# It supports either refinedPrompt or imagePrompt/refined variable names by checking what exists in the local scope at runtime.
visible_line = "        seekdeepRefinedPromptLine(prompt, typeof refinedPrompt !== 'undefined' ? refinedPrompt : (typeof imagePrompt !== 'undefined' ? imagePrompt : '')),"

if "seekdeepRefinedPromptLine(prompt" not in text:
    array_patterns = [
        "      const content = seekdeepAppendResponseFooter([\n        `Generated locally: ${prompt}`,",
        "      const content = seekdeepAppendResponseFooter([\n        `Regenerated locally: ${prompt}`,",
        "      const content = seekdeepAppendResponseFooter([\n        `Image generated locally: ${prompt}`,",
    ]

    patched_any = False
    for anchor in array_patterns:
        if anchor in text:
            replacement = anchor + "\n" + visible_line
            text = text.replace(anchor, replacement, 1)
            patched_any = True

    # Fallback: if response content does not use the known arrays, wrap Generated locally line block.
    if not patched_any:
        if "`Generated locally: ${prompt}`" in text:
            text = text.replace(
                "`Generated locally: ${prompt}`",
                "`Generated locally: ${prompt}`,\n        seekdeepRefinedPromptLine(prompt, typeof refinedPrompt !== 'undefined' ? refinedPrompt : (typeof imagePrompt !== 'undefined' ? imagePrompt : ''))",
                1,
            )
            patched_any = True

    if not patched_any:
        raise SystemExit("Could not find generated image response content block to add visible refined prompt.")

# 5) If content array is joined directly, remove empty refined line from output when no refinement changed.
# Common JS .filter(Boolean) is only added to arrays we touched if missing nearby.
if "seekdeepRefinedPromptLine(prompt" in text:
    text = text.replace("      ].join('\\n'), {", "      ].filter(Boolean).join('\\n'), {")
    text = text.replace("      ].join(\"\\n\"), {", "      ].filter(Boolean).join(\"\\n\"), {")

for needle, label in [
    ("SEEKDEEP_SHOW_ME_IMAGE_TRIGGER_START", "show-me image trigger marker"),
    ("SEEKDEEP_VISIBLE_REFINED_PROMPT_START", "visible refined prompt helper marker"),
    ("function seekdeepRefinedPromptLine", "visible refined prompt formatter"),
    ("seekdeepRefinedPromptLine(prompt", "generated image response includes refined prompt line"),
    ("function seekdeepEnqueueImageJob(job, runner)", "correct image queue contract"),
]:
    require_contains(text, needle, label)

if "seekdeepMakeImageQueueJobId" in text:
    raise SystemExit("Unsafe old queue helper found after patch: seekdeepMakeImageQueueJobId")
if "job.run" in text:
    raise SystemExit("Unsafe job.run-style queue logic found after patch")

out = text if newline == "\n" else text.replace("\n", "\r\n")
path.write_bytes(out.encode("utf-8"))
print("Patched index.js with show-me image routing and visible refined prompt support.")
'@

  $patchPyPath = Join-Path $patchesDir "patch_showme_visible_refined_prompt.py"
  [System.IO.File]::WriteAllText($patchPyPath, $patchPy, [System.Text.UTF8Encoding]::new($false))
  Write-SeekDeepPass "Wrote UTF-8 patch helper to $patchPyPath"

  Push-Location $projectRoot
  try {
    Write-SeekDeepInfo "Applying show-me routing + visible refined prompt patch"
    & ".\.venv\Scripts\python.exe" $patchPyPath $indexPath
    if ($LASTEXITCODE -ne 0) {
      throw "Python patch helper failed with exit code $LASTEXITCODE."
    }
    Write-SeekDeepPass "Applied show-me routing + visible refined prompt patch"

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
  Write-Host "SeekDeep show-me image routing + visible refined prompt patch completed successfully." -ForegroundColor Green
  Write-Host "Backup created: $backupPath" -ForegroundColor Green
  Write-Host "Test: @SEEKOTICS show me a couger" -ForegroundColor Yellow
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
