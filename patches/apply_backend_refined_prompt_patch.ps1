# SeekDeep / Seekotics backend-refined-prompt surfacing patch
#
# Goal:
# - Keep working "show me ..." image routing.
# - Make the final Discord image message show:
#     Refined Prompt: ...
#
# Strategy:
# 1) Patch local_ai_server.py so /image returns the actual prompt used by the image backend:
#      refined_prompt
#      original_prompt
# 2) Patch index.js so the generated image completion message renders Refined Prompt when present.
#
# Safety:
# - Backs up index.js first (required)
# - Also backs up local_ai_server.py
# - Preserves seekdeepEnqueueImageJob(job, runner)
# - Preserves stabilized dispatcher
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

  $indexBackupPath = Join-Path $backupDir "index.js.backend-refined-prompt-$stamp.bak"
  $serverBackupPath = Join-Path $backupDir "local_ai_server.py.backend-refined-prompt-$stamp.bak"

  Copy-Item -LiteralPath $indexPath -Destination $indexBackupPath -Force
  Write-SeekDeepPass "Backed up index.js to $indexBackupPath"

  Copy-Item -LiteralPath $serverPath -Destination $serverBackupPath -Force
  Write-SeekDeepPass "Backed up local_ai_server.py to $serverBackupPath"

  $patchPy = @'
from pathlib import Path
import re
import sys

if len(sys.argv) != 3:
    raise SystemExit("Usage: patch_backend_refined_prompt.py <index.js> <local_ai_server.py>")

index_path = Path(sys.argv[1])
server_path = Path(sys.argv[2])

def read_normalized(path: Path):
    raw = path.read_bytes()
    newline = "\r\n" if b"\r\n" in raw else "\n"
    text = raw.decode("utf-8-sig")
    text = text.replace("\r\n", "\n").replace("\r", "\n")
    return text, newline

def write_normalized(path: Path, text: str, newline: str):
    out = text if newline == "\n" else text.replace("\n", "\r\n")
    path.write_bytes(out.encode("utf-8"))

index_text, index_nl = read_normalized(index_path)
server_text, server_nl = read_normalized(server_path)

def require_contains(haystack, needle, label):
    if needle not in haystack:
        raise SystemExit(f"Required anchor not found: {label}")

# ------------------------------------------------------------------
# Patch local_ai_server.py
# ------------------------------------------------------------------
require_contains(server_text, '@app.post("/image")', 'image endpoint')
require_contains(server_text, 'result = image_pipe(**args)', 'image pipeline call')

if "refined_prompt" not in server_text or '"refined_prompt"' not in server_text:
    server_text = server_text.replace(
        "    result = image_pipe(**args)\n",
        "    final_prompt_for_response = str(args.get(\"prompt\", req.prompt.strip())).strip()\n\n    result = image_pipe(**args)\n",
        1
    )

    # Patch return dict conservatively.
    return_anchor = """    return {\n        "image_b64": image_to_b64_png(img),"""
    if return_anchor in server_text:
        server_text = server_text.replace(
            return_anchor,
            """    return {\n        "image_b64": image_to_b64_png(img),\n        "original_prompt": req.prompt.strip(),\n        "refined_prompt": final_prompt_for_response,""",
            1
        )
    else:
        # Fallback: inject into first return dict in image endpoint.
        m = re.search(r'(\n\s*return\s*\{\n)', server_text)
        if not m:
            raise SystemExit("Could not locate image endpoint return dict to add refined_prompt.")
        insert_at = m.end()
        server_text = server_text[:insert_at] + '        "original_prompt": req.prompt.strip(),\n        "refined_prompt": final_prompt_for_response,\n' + server_text[insert_at:]

# ------------------------------------------------------------------
# Patch index.js
# ------------------------------------------------------------------
require_contains(index_text, "function seekdeepEnqueueImageJob(job, runner)", "correct image queue contract")
if "seekdeepMakeImageQueueJobId" in index_text:
    raise SystemExit("Unsafe old queue helper found: seekdeepMakeImageQueueJobId")
if "job.run" in index_text:
    raise SystemExit("Unsafe job.run-style queue logic found")

helper_block = r"""
// SEEKDEEP_VISIBLE_REFINED_PROMPT_FROM_BACKEND_START
function seekdeepClipForDiscord(value = '', max = 900) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  if (!text || text.length <= max) return text;
  return `${text.slice(0, Math.max(0, max - 1)).trim()}…`;
}

function seekdeepExtractRefinedPrompt(...candidates) {
  for (const candidate of candidates) {
    if (!candidate || typeof candidate !== 'object') continue;

    const values = [
      candidate.refined_prompt,
      candidate.refinedPrompt,
      candidate.original_refined_prompt,
      candidate.originalRefinedPrompt,
      candidate.used_prompt,
      candidate.usedPrompt,
    ];

    for (const value of values) {
      const text = String(value || '').trim();
      if (text) return text;
    }
  }

  return '';
}

function seekdeepRefinedPromptLine(originalPrompt = '', refinedPrompt = '') {
  const original = String(originalPrompt || '').trim();
  const refined = String(refinedPrompt || '').trim();

  if (!refined || refined === original) return '';

  return `Refined Prompt: ${seekdeepClipForDiscord(refined, 900)}`;
}
// SEEKDEEP_VISIBLE_REFINED_PROMPT_FROM_BACKEND_END
"""

if "SEEKDEEP_VISIBLE_REFINED_PROMPT_FROM_BACKEND_START" not in index_text:
    index_text = index_text.replace(
        "function seekdeepEnqueueImageJob(job, runner)",
        helper_block + "\nfunction seekdeepEnqueueImageJob(job, runner)",
        1
    )

# Patch common final image message lines.
line = "        seekdeepRefinedPromptLine(prompt, seekdeepExtractRefinedPrompt(typeof result !== 'undefined' ? result : undefined, typeof imageResult !== 'undefined' ? imageResult : undefined, typeof data !== 'undefined' ? data : undefined, typeof payload !== 'undefined' ? payload : undefined, typeof normalized !== 'undefined' ? normalized : undefined)),"

if "seekdeepExtractRefinedPrompt(typeof result !== 'undefined'" not in index_text:
    anchors = [
        "        `Generated locally: ${prompt}`,",
        "        `Regenerated locally: ${prompt}`,",
        "        `Image generated locally: ${prompt}`,",
    ]

    patched_any = False
    for anchor in anchors:
        if anchor in index_text:
            index_text = index_text.replace(anchor, anchor + "\n" + line, 1)
            patched_any = True

    if not patched_any:
        raise SystemExit("Could not find final image response content block to add refined prompt display.")

# Ensure arrays touched can filter empty strings.
index_text = index_text.replace("      ].join('\\n'), {", "      ].filter(Boolean).join('\\n'), {")
index_text = index_text.replace("      ].join(\"\\n\"), {", "      ].filter(Boolean).join(\"\\n\"), {")

for needle, label in [
    ("SEEKDEEP_VISIBLE_REFINED_PROMPT_FROM_BACKEND_START", "visible refined prompt helper block"),
    ("function seekdeepExtractRefinedPrompt", "backend refined prompt extractor"),
    ("function seekdeepRefinedPromptLine", "backend refined prompt formatter"),
    ("seekdeepRefinedPromptLine(prompt, seekdeepExtractRefinedPrompt(", "final image response refined prompt line"),
]:
    require_contains(index_text, needle, label)

write_normalized(server_path, server_text, server_nl)
write_normalized(index_path, index_text, index_nl)
print("Patched local_ai_server.py and index.js to surface backend refined prompt.")
'@

  $patchPyPath = Join-Path $patchesDir "patch_backend_refined_prompt.py"
  [System.IO.File]::WriteAllText($patchPyPath, $patchPy, [System.Text.UTF8Encoding]::new($false))
  Write-SeekDeepPass "Wrote UTF-8 patch helper to $patchPyPath"

  Push-Location $projectRoot
  try {
    Write-SeekDeepInfo "Applying backend refined prompt surfacing patch"
    & ".\.venv\Scripts\python.exe" $patchPyPath $indexPath $serverPath
    if ($LASTEXITCODE -ne 0) {
      throw "Python patch helper failed with exit code $LASTEXITCODE."
    }
    Write-SeekDeepPass "Applied backend refined prompt surfacing patch"

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
  Write-Host "SeekDeep backend refined prompt surfacing patch completed successfully." -ForegroundColor Green
  Write-Host "index.js backup: $indexBackupPath" -ForegroundColor Yellow
  Write-Host "local_ai_server.py backup: $serverBackupPath" -ForegroundColor Yellow
  Write-Host "Restart both the local AI server and the bot after patching." -ForegroundColor Yellow
  exit 0
} catch {
  Write-Host ""
  Write-SeekDeepFail $_.Exception.Message
  Write-Host "Backups are available if you need to restore:" -ForegroundColor Yellow
  if ($indexBackupPath) {
    Write-Host "index.js backup: $indexBackupPath" -ForegroundColor Yellow
  }
  if ($serverBackupPath) {
    Write-Host "local_ai_server.py backup: $serverBackupPath" -ForegroundColor Yellow
  }
  exit 1
}
