# SeekDeep / Seekotics remove IP/endpoint info from status output
#
# Purpose:
# - Remove local IP/URL details from /status and status-style responses.
# - Specifically removes:
#     Endpoint: http://127.0.0.1:7865
#   from statusText().
# - Adds a defensive sanitizer so if any localhost/127.0.0.1/private-IP URL leaks into
#   status text later, it is redacted before Discord sees it.
#
# Files patched:
# - index.js
#
# Safety:
# - Backs up index.js first
# - Patches only index.js
# - Does not change backend URLs used internally
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
  Write-Host "[SeekDeep status-privacy] $Message" -ForegroundColor Cyan
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

  $indexBackup = Join-Path $backupDir "index.js.status-privacy-no-ip-$stamp.bak"
  Copy-Item -LiteralPath $indexPath -Destination $indexBackup -Force
  Write-Pass "Backed up index.js to $indexBackup"

  $utf8NoBom = [System.Text.UTF8Encoding]::new($false)

  $patchPy = @'
from pathlib import Path
import re
import sys

if len(sys.argv) != 2:
    raise SystemExit("Usage: patch_status_privacy_no_ip.py <index.js>")

path = Path(sys.argv[1])
raw = path.read_bytes()
newline = "\r\n" if b"\r\n" in raw else "\n"
text = raw.decode("utf-8-sig").replace("\r\n", "\n").replace("\r", "\n")

def fail(msg):
    raise SystemExit(msg)

def require(needle, label):
    if needle not in text:
        fail(f"Required anchor not found: {label}")

for needle, label in [
    ("async function statusText()", "statusText function"),
    ("fetchJson(`${LOCAL_AI_BASE_URL}/health`)", "internal health fetch"),
    ("seekdeepEnqueueImageJob(job, runner)", "queue contract"),
]:
    require(needle, label)

if "seekdeepMakeImageQueueJobId" in text:
    fail("Unsafe old queue helper found: seekdeepMakeImageQueueJobId")
if "job.run" in text:
    fail("Unsafe job.run-style queue logic found")

# Insert sanitizer near status metrics helpers.
if "function seekdeepRedactStatusConnectionInfo" not in text:
    helper = r"""
function seekdeepRedactStatusConnectionInfo(value = '') {
  return String(value || '')
    // Full local/private URLs with optional paths.
    .replace(/\bhttps?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\]|10(?:\.\d{1,3}){3}|192\.168(?:\.\d{1,3}){2}|172\.(?:1[6-9]|2\d|3[0-1])(?:\.\d{1,3}){2})(?::\d{1,5})?(?:\/[^\s]*)?/gi, 'local service')
    // Bare local/private host:port.
    .replace(/\b(?:localhost|127\.0\.0\.1|0\.0\.0\.0|10(?:\.\d{1,3}){3}|192\.168(?:\.\d{1,3}){2}|172\.(?:1[6-9]|2\d|3[0-1])(?:\.\d{1,3}){2}):\d{1,5}\b/gi, 'local service')
    // Any leftover explicit loopback labels.
    .replace(/\b(?:127\.0\.0\.1|0\.0\.0\.0|localhost|\[::1\])\b/gi, 'local service');
}

"""
    anchor = "function seekdeepCurrentLoadedModelFromHealth(health = {}) {"
    pos = text.find(anchor)
    if pos < 0:
        fail("Could not locate status helper insertion anchor.")
    text = text[:pos] + helper + text[pos:]

# Remove the explicit Endpoint line from statusText().
text = text.replace("    `Endpoint: ${LOCAL_AI_BASE_URL}`,\n", "")

# Wrap statusText's final joined text with the sanitizer.
# Exact shape in known-good file:
#   return [
#     ...
#   ].join('\n');
if "return seekdeepRedactStatusConnectionInfo([\n    'Local AI server status'," not in text:
    old = "  return [\n    'Local AI server status',"
    new = "  return seekdeepRedactStatusConnectionInfo([\n    'Local AI server status',"
    if old not in text:
        fail("Could not locate statusText return array start.")
    text = text.replace(old, new, 1)

    old_end = "    `Offline model loading: ${health.offline_model_loading ? 'YES' : 'NO'}`,\n  ].join('\\n');\n}"
    new_end = "    `Offline model loading: ${health.offline_model_loading ? 'YES' : 'NO'}`,\n  ].join('\\n'));\n}"
    if old_end not in text:
        fail("Could not locate statusText return array end.")
    text = text.replace(old_end, new_end, 1)

# Validation: statusText body should not contain the Endpoint line anymore.
status_start = text.find("async function statusText()")
status_end = text.find("\n}\n\n// SEEKDEEP_BATCH1_UTILITY_START", status_start)
if status_start < 0 or status_end < 0:
    fail("Could not isolate statusText after patch.")
status_body = text[status_start:status_end]

if "Endpoint:" in status_body:
    fail("Endpoint line still exists in statusText.")
if "LOCAL_AI_BASE_URL}`" in status_body:
    fail("LOCAL_AI_BASE_URL is still directly displayed in statusText.")
if "seekdeepRedactStatusConnectionInfo" not in status_body:
    fail("statusText is not wrapped with connection-info sanitizer.")

for needle, label in [
    ("function seekdeepRedactStatusConnectionInfo", "status connection sanitizer"),
    ("return seekdeepRedactStatusConnectionInfo([", "sanitized status return"),
    ("fetchJson(`${LOCAL_AI_BASE_URL}/health`)", "internal health fetch preserved"),
    ("seekdeepEnqueueImageJob(job, runner)", "queue contract preserved"),
]:
    require(needle, label)

out = text if newline == "\n" else text.replace("\n", "\r\n")
path.write_bytes(out.encode("utf-8"))
print("Patched status output to remove/redact IP and endpoint information.")
'@

  $patchPyPath = Join-Path $patchesDir "patch_status_privacy_no_ip.py"
  [System.IO.File]::WriteAllText($patchPyPath, $patchPy, $utf8NoBom)

  Push-Location $projectRoot
  try {
    Write-Info "Applying status privacy patch"
    & ".\.venv\Scripts\python.exe" $patchPyPath $indexPath
    if ($LASTEXITCODE -ne 0) {
      throw "Patch helper failed with exit code $LASTEXITCODE."
    }
    Write-Pass "Applied status privacy patch"

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
  Write-Pass "Status privacy patch completed."
  Write-Host "Backup created: $indexBackup" -ForegroundColor Yellow
  Write-Host "Restart the Discord bot before testing." -ForegroundColor Yellow
  Write-Host ""
  Write-Host "Retest:" -ForegroundColor Cyan
  Write-Host "@SEEKOTICS status" -ForegroundColor White
  Write-Host "Expected: no Endpoint line and no 127.0.0.1 / localhost / private IP URLs." -ForegroundColor White
  exit 0
} catch {
  Write-Host ""
  Write-Fail $_.Exception.Message
  Write-Host "Backup available:" -ForegroundColor Yellow
  if ($indexBackup) { Write-Host $indexBackup -ForegroundColor Yellow }
  exit 1
}
