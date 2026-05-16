# SeekDeep / Seekotics repair duplicate generic image follow-up helper
#
# Fixes:
#   SyntaxError: Identifier 'seekdeepIsGenericImageFollowupPrompt' has already been declared
#
# Cause:
# - The grounded-image patch already added seekdeepIsGenericImageFollowupPrompt(...).
# - The raw/unrefined v2 patch added a second function declaration with the same name.
#
# Repair:
# - Keeps ONE canonical seekdeepIsGenericImageFollowupPrompt(...) definition.
# - Removes duplicate declarations.
# - Canonical version supports bare:
#     generate
#     create
#     draw
#     show
#   so context reuse can work.
#
# Safety:
# - Backs up the current broken index.js first.
# - Patches only index.js.
# - Preserves queue contract:
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
  Write-Host "[SeekDeep duplicate-helper-repair] $Message" -ForegroundColor Cyan
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

  $indexBackup = Join-Path $backupDir "index.js.duplicate-generic-image-followup-repair-$stamp.bak"
  Copy-Item -LiteralPath $indexPath -Destination $indexBackup -Force
  Write-Pass "Backed up current index.js to $indexBackup"

  $utf8NoBom = [System.Text.UTF8Encoding]::new($false)

  $patchPy = @'
from pathlib import Path
import re
import sys

if len(sys.argv) != 2:
    raise SystemExit("Usage: repair_duplicate_generic_image_followup.py <index.js>")

path = Path(sys.argv[1])
raw = path.read_bytes()
newline = "\r\n" if b"\r\n" in raw else "\n"
text = raw.decode("utf-8-sig").replace("\r\n", "\n").replace("\r", "\n")

def require_contains(haystack: str, needle: str, label: str):
    if needle not in haystack:
        raise SystemExit(f"Required anchor not found: {label}")

for needle, label in [
    ("function seekdeepIsGenericImageFollowupPrompt", "generic image follow-up helper"),
    ("seekdeepEnqueueImageJob(job, runner)", "correct image queue contract"),
]:
    require_contains(text, needle, label)

if "seekdeepMakeImageQueueJobId" in text:
    raise SystemExit("Unsafe old queue helper found: seekdeepMakeImageQueueJobId")
if "job.run" in text:
    raise SystemExit("Unsafe job.run-style queue logic found")

canonical = r"""function seekdeepIsGenericImageFollowupPrompt(prompt = '') {
  const p = normalizeUserText(prompt).toLowerCase().trim();
  return /^(generate|create|make|draw|paint|sketch|illustrate|render|show)(\s+me)?(?:\s+(an?\s+)?(image|picture|pic|art|drawing|illustration|it|that|this))?$/i.test(p);
}"""

pattern = re.compile(r"function\s+seekdeepIsGenericImageFollowupPrompt\s*\(\s*prompt\s*=\s*''\s*\)\s*\{[\s\S]*?\n\}", re.MULTILINE)
matches = list(pattern.finditer(text))

if len(matches) < 2:
    # If there is only one, still normalize it to the canonical version.
    if len(matches) == 1:
        m = matches[0]
        text = text[:m.start()] + canonical + text[m.end():]
    else:
        raise SystemExit("No seekdeepIsGenericImageFollowupPrompt function matched the repair pattern.")
else:
    pieces = []
    last = 0
    for i, m in enumerate(matches):
        pieces.append(text[last:m.start()])
        if i == 0:
            pieces.append(canonical)
        else:
            # Drop duplicate function declaration. Preserve spacing lightly.
            pieces.append("")
        last = m.end()
    pieces.append(text[last:])
    text = "".join(pieces)

# Clean up excess blank lines caused by removing duplicate helper.
text = re.sub(r"\n{4,}", "\n\n\n", text)

# Verify exactly one declaration remains.
count = text.count("function seekdeepIsGenericImageFollowupPrompt")
if count != 1:
    raise SystemExit(f"Expected exactly one seekdeepIsGenericImageFollowupPrompt declaration, found {count}.")

for needle, label in [
    ("function seekdeepIsGenericImageFollowupPrompt", "canonical helper remains"),
    ("(?:\\s+(an?\\s+)?(image|picture|pic|art|drawing|illustration|it|that|this))?", "bare generate optional target support"),
    ("seekdeepEnqueueImageJob(job, runner)", "queue contract preserved"),
]:
    require_contains(text, needle, label)

out = text if newline == "\n" else text.replace("\n", "\r\n")
path.write_bytes(out.encode("utf-8"))
print("Repaired duplicate seekdeepIsGenericImageFollowupPrompt declaration.")
'@

  $patchPyPath = Join-Path $patchesDir "repair_duplicate_generic_image_followup.py"
  [System.IO.File]::WriteAllText($patchPyPath, $patchPy, $utf8NoBom)

  Push-Location $projectRoot
  try {
    Write-Info "Repairing duplicate helper declaration"
    & ".\.venv\Scripts\python.exe" $patchPyPath $indexPath
    if ($LASTEXITCODE -ne 0) {
      throw "Patch helper failed with exit code $LASTEXITCODE."
    }
    Write-Pass "Duplicate helper repair applied"

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
  Write-Pass "Duplicate helper repair completed."
  Write-Host "Backup created: $indexBackup" -ForegroundColor Yellow
  Write-Host "Restart the Discord bot before testing." -ForegroundColor Yellow
  Write-Host ""
  Write-Host "Retest:" -ForegroundColor Cyan
  Write-Host "@SEEKOTICS generate" -ForegroundColor White
  Write-Host "@SEEKOTICS raw generate Ripto from Spyro in the matrix" -ForegroundColor White
  Write-Host "@SEEKOTICS Generate spyro but like predator" -ForegroundColor White
  exit 0
} catch {
  Write-Host ""
  Write-Fail $_.Exception.Message
  Write-Host "Backup available:" -ForegroundColor Yellow
  if ($indexBackup) { Write-Host $indexBackup -ForegroundColor Yellow }
  exit 1
}
