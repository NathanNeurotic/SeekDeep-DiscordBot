# SeekDeep / Seekotics refined prompt display repair for image posts
#
# Fixes:
# - Z-Image prompt refinement logs in console, but final Discord image posts do not show:
#     Refined Prompt: ...
#
# Root issue:
# - Some image response branches still only print:
#     Generated locally: ...
#     Regenerated locally: ...
#   without adding seekdeepRefinedPromptLine(...)
#
# This patch adds refined prompt display to missing generated/regenerated image message branches.
#
# Files patched:
# - index.js
#
# Required checks:
#   node --check .\index.js
#   .\.venv\Scripts\python.exe -m py_compile .\local_ai_server.py

$ErrorActionPreference = "Stop"

try {
  [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
} catch {}

function Write-Info {
  param([string]$Message)
  Write-Host "[SeekDeep refined prompt repair] $Message" -ForegroundColor Cyan
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

  $indexBackup = Join-Path $backupDir "index.js.refined-prompt-display-repair-$stamp.bak"
  Copy-Item -LiteralPath $indexPath -Destination $indexBackup -Force
  Write-Pass "Backed up index.js to $indexBackup"

  $utf8NoBom = [System.Text.UTF8Encoding]::new($false)

  $patchPy = @'
from pathlib import Path
import re
import sys

if len(sys.argv) != 2:
    raise SystemExit("Usage: repair_refined_prompt_display.py <index.js>")

path = Path(sys.argv[1])
raw = path.read_bytes()
newline = "\r\n" if b"\r\n" in raw else "\n"
text = raw.decode("utf-8-sig").replace("\r\n", "\n").replace("\r", "\n")

def require_contains(haystack, needle, label):
    if needle not in haystack:
        raise SystemExit(f"Required anchor not found: {label}")

require_contains(text, "function seekdeepRefinedPromptLine", "refined prompt line helper")
require_contains(text, "function seekdeepExtractRefinedPrompt", "refined prompt extractor helper")
require_contains(text, "async function makeImageResult", "makeImageResult")
require_contains(text, "refinedPrompt: promptInfo.refinedPrompt", "makeImageResult refinedPrompt return")
require_contains(text, "Regenerated locally:", "regenerated image output")
require_contains(text, "Generated locally:", "generated image output")

patched = 0

# Patch generated image branches that currently lack a refined prompt line.
patterns = [
    (
        "`Generated locally: ${prompt}`,\n        `Queue Wait:",
        "`Generated locally: ${prompt}`,\n        seekdeepRefinedPromptLine(prompt, seekdeepExtractRefinedPrompt(result, normalized)),\n        `Queue Wait:",
    ),
    (
        "`Regenerated locally: ${prompt}`,\n        `Queue Wait:",
        "`Regenerated locally: ${prompt}`,\n        seekdeepRefinedPromptLine(prompt, seekdeepExtractRefinedPrompt(result, normalized)),\n        `Queue Wait:",
    ),
    (
        "`Regenerated locally: ${state.prompt}`,\n              `Queue Wait:",
        "`Regenerated locally: ${state.prompt}`,\n              seekdeepRefinedPromptLine(state.prompt, seekdeepExtractRefinedPrompt(result, normalized)),\n              `Queue Wait:",
    ),
    (
        "`Generated locally: ${state.prompt}`,\n              `Queue Wait:",
        "`Generated locally: ${state.prompt}`,\n              seekdeepRefinedPromptLine(state.prompt, seekdeepExtractRefinedPrompt(result, normalized)),\n              `Queue Wait:",
    ),
]

for old, new in patterns:
    count = text.count(old)
    if count:
        text = text.replace(old, new)
        patched += count

# Extra robust fallback: patch any generated/regenerated array item immediately followed by Queue Wait
# if it does not already have seekdeepRefinedPromptLine in between.
def patch_missing_refined(match):
    global patched
    first = match.group(1)
    queue = match.group(2)
    middle = match.group(3)
    if "seekdeepRefinedPromptLine" in middle:
        return match.group(0)

    prompt_expr = "prompt"
    if "${state.prompt}" in first:
        prompt_expr = "state.prompt"

    indent_match = re.match(r"(\s*)", queue)
    indent = indent_match.group(1) if indent_match else "        "
    patched += 1
    return first + "\n" + indent + f"seekdeepRefinedPromptLine({prompt_expr}, seekdeepExtractRefinedPrompt(result, normalized))," + "\n" + queue

regex = re.compile(
    r"(`(?:Generated|Regenerated) locally: \$\{(?:state\.)?prompt\}`,)"
    r"(?P<middle>\n(?:\s*(?!`Queue Wait:).*\n){0,5}?)"
    r"(\s*`Queue Wait:)",
    re.M,
)

# The named group makes manual function above awkward; use a simpler loop.
out = []
last = 0
for m in regex.finditer(text):
    first = m.group(1)
    middle = m.group("middle")
    queue = m.group(3)
    if "seekdeepRefinedPromptLine" in middle:
        continue
    prompt_expr = "state.prompt" if "${state.prompt}" in first else "prompt"
    indent = re.match(r"(\s*)", queue).group(1)
    replacement = first + middle + indent + f"seekdeepRefinedPromptLine({prompt_expr}, seekdeepExtractRefinedPrompt(result, normalized)),\n" + queue
    out.append(text[last:m.start()])
    out.append(replacement)
    last = m.end()
    patched += 1

if out:
    out.append(text[last:])
    text = "".join(out)

if patched < 1:
    raise SystemExit("No missing refined prompt display branch was patched. It may already be patched or the live file shape changed.")

# Confirm the specific known button-regenerate channel-send branch is patched if present.
if "`Regenerated locally: ${state.prompt}`" in text:
    idx = text.find("`Regenerated locally: ${state.prompt}`")
    nearby = text[idx:idx + 500]
    if "seekdeepRefinedPromptLine(state.prompt" not in nearby:
        raise SystemExit("Regenerate button output still lacks refined prompt line after patch.")

if "`Generated locally: ${prompt}`" in text:
    # At least one branch can already be patched, this is just a soft structural check.
    pass

require_contains(text, "seekdeepRefinedPromptLine(state.prompt, seekdeepExtractRefinedPrompt(result, normalized))", "button regenerate refined prompt line")
require_contains(text, "seekdeepRefinedPromptLine(prompt, seekdeepExtractRefinedPrompt(result, normalized))", "prompt refined prompt line")

out_text = text if newline == "\n" else text.replace("\n", "\r\n")
path.write_bytes(out_text.encode("utf-8"))
print(f"Patched {patched} missing refined prompt display branch(es).")
'@

  $patchPyPath = Join-Path $patchesDir "repair_refined_prompt_display.py"
  [System.IO.File]::WriteAllText($patchPyPath, $patchPy, $utf8NoBom)

  Push-Location $projectRoot
  try {
    Write-Info "Applying refined prompt display repair"
    & ".\.venv\Scripts\python.exe" $patchPyPath $indexPath
    if ($LASTEXITCODE -ne 0) {
      throw "Patch helper failed with exit code $LASTEXITCODE."
    }
    Write-Pass "Applied refined prompt display repair"

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
  Write-Pass "Refined prompt display repair completed."
  Write-Host "Backup created: $indexBackup" -ForegroundColor Yellow
  Write-Host "Restart the Discord bot before testing." -ForegroundColor Yellow
  exit 0
} catch {
  Write-Host ""
  Write-Fail $_.Exception.Message
  Write-Host "Backup available:" -ForegroundColor Yellow
  if ($indexBackup) { Write-Host $indexBackup -ForegroundColor Yellow }
  exit 1
}
