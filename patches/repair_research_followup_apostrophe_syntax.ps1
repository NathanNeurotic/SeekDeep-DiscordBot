# SeekDeep / Seekotics repair broken apostrophe from research follow-up patch
#
# Fixes:
#   SyntaxError: Unexpected identifier 'll'
#
# Cause:
#   A single-quoted JavaScript string contains:
#     I'll
#   without escaping the apostrophe.
#
# This repair:
# - Backs up index.js first
# - Escapes the affected apostrophe / repairs possible mojibake variants
# - Keeps the research-followup patch in place
# - Runs:
#     node --check .\index.js
#     .\.venv\Scripts\python.exe -m py_compile .\local_ai_server.py

$ErrorActionPreference = "Stop"

try {
  [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
} catch {}

function Write-Info {
  param([string]$Message)
  Write-Host "[SeekDeep apostrophe-repair] $Message" -ForegroundColor Cyan
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

  $indexBackup = Join-Path $backupDir "index.js.apostrophe-repair-$stamp.bak"
  Copy-Item -LiteralPath $indexPath -Destination $indexBackup -Force
  Write-Pass "Backed up index.js to $indexBackup"

  $utf8NoBom = [System.Text.UTF8Encoding]::new($false)

  $patchPy = @'
from pathlib import Path
import sys

if len(sys.argv) != 2:
    raise SystemExit("Usage: repair_apostrophe_syntax.py <index.js>")

path = Path(sys.argv[1])
raw = path.read_bytes()
newline = "\r\n" if b"\r\n" in raw else "\n"
text = raw.decode("utf-8-sig").replace("\r\n", "\n").replace("\r", "\n")

before = text

# Repair the exact broken single-quoted JavaScript string.
text = text.replace(
    "const answer = 'Yes. Send the exact thing you want searched or compared. For product specs, generations, prices, or current info, I'll use web search instead of guessing.';",
    "const answer = \"Yes. Send the exact thing you want searched or compared. For product specs, generations, prices, or current info, I'll use web search instead of guessing.\";"
)

# Repair mojibake variant if it exists inside the JS source.
text = text.replace(
    "const answer = 'Yes. Send the exact thing you want searched or compared. For product specs, generations, prices, or current info, Iâ€™ll use web search instead of guessing.';",
    "const answer = \"Yes. Send the exact thing you want searched or compared. For product specs, generations, prices, or current info, I'll use web search instead of guessing.\";"
)

# Repair any escaped/half-repaired variants to one canonical double-quoted line.
text = text.replace(
    "const answer = 'Yes. Send the exact thing you want searched or compared. For product specs, generations, prices, or current info, I\\'ll use web search instead of guessing.';",
    "const answer = \"Yes. Send the exact thing you want searched or compared. For product specs, generations, prices, or current info, I'll use web search instead of guessing.\";"
)

if text == before:
    raise SystemExit("No matching broken apostrophe line was found. Upload current index.js if node --check still fails.")

if "current info, I'll use web search instead of guessing.\"" not in text:
    raise SystemExit("Canonical repaired string not found after patch.")

out = text if newline == "\n" else text.replace("\n", "\r\n")
path.write_bytes(out.encode("utf-8"))
print("Repaired broken apostrophe syntax.")
'@

  $patchPyPath = Join-Path $patchesDir "repair_apostrophe_syntax.py"
  [System.IO.File]::WriteAllText($patchPyPath, $patchPy, $utf8NoBom)

  Push-Location $projectRoot
  try {
    Write-Info "Applying apostrophe syntax repair"
    & ".\.venv\Scripts\python.exe" $patchPyPath $indexPath
    if ($LASTEXITCODE -ne 0) {
      throw "Patch helper failed with exit code $LASTEXITCODE."
    }
    Write-Pass "Applied apostrophe syntax repair"

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
  Write-Pass "Apostrophe syntax repair completed."
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
