# SeekDeep / Seekotics missing route logger repair
#
# Fixes:
#   SeekDeep request failed.
#   Error:
#   seekdeepLogRoute is not defined
#
# Cause:
# - Some routes now call seekdeepLogRoute(...)
# - The helper is missing after patch stack / restore.
#
# Adds safe fallback helpers if missing:
# - seekdeepLogRoute(route, prompt)
# - seekdeepNoModelLabel()
# - seekdeepNowMs()
#
# Validation:
# - node --check .\index.js
# - python -m py_compile .\local_ai_server.py

$ErrorActionPreference = "Stop"

try {
  [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
} catch {}

function Write-Info { param([string]$Message) Write-Host "[SeekDeep route-logger-repair] $Message" -ForegroundColor Cyan }
function Write-Pass { param([string]$Message) Write-Host "[PASS] $Message" -ForegroundColor Green }
function Write-Fail { param([string]$Message) Write-Host "[FAIL] $Message" -ForegroundColor Red }

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

  $backup = Join-Path $backupDir "index.js.before-route-logger-repair-$stamp.bak"
  Copy-Item -LiteralPath $indexPath -Destination $backup -Force
  Write-Pass "Backed up index.js to $backup"

  $patchPy = @'
from pathlib import Path
import sys

if len(sys.argv) != 2:
    raise SystemExit("Usage: patch_missing_route_logger.py <index.js>")

path = Path(sys.argv[1])
raw = path.read_bytes()
newline = "\r\n" if b"\r\n" in raw else "\n"
text = raw.decode("utf-8-sig").replace("\r\n", "\n").replace("\r", "\n")

if "seekdeepLogRoute" not in text:
    raise SystemExit("index.js does not reference seekdeepLogRoute; wrong failure state or already changed.")

helpers = r"""function seekdeepNowMs() {
  return Date.now();
}

function seekdeepNoModelLabel() {
  if (typeof SEEKDEEP_NO_MODEL_USED_LABEL !== 'undefined') {
    return SEEKDEEP_NO_MODEL_USED_LABEL;
  }
  return 'local command (no AI model)';
}

function seekdeepLogRoute(route, prompt = '') {
  const safeRoute = String(route || 'unknown').trim() || 'unknown';
  const safePrompt = String(prompt || '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 500);

  try {
    console.log(`[SeekDeep] route=${safeRoute} prompt=${safePrompt}`);
  } catch {}
}
"""

insert_pos = -1

# Prefer inserting before message handlers so all routes see it.
for needle in ["client.on('messageCreate'", 'client.on("messageCreate"', "client.on('interactionCreate'", 'client.on("interactionCreate"']:
    insert_pos = text.find(needle)
    if insert_pos >= 0:
        break

if insert_pos < 0:
    raise SystemExit("Could not find client handler insertion point.")

if "function seekdeepNowMs" not in text:
    text = text[:insert_pos] + helpers + "\n\n" + text[insert_pos:]
else:
    missing = []
    if "function seekdeepNoModelLabel" not in text:
        missing.append(r"""function seekdeepNoModelLabel() {
  if (typeof SEEKDEEP_NO_MODEL_USED_LABEL !== 'undefined') {
    return SEEKDEEP_NO_MODEL_USED_LABEL;
  }
  return 'local command (no AI model)';
}""")
    if "function seekdeepLogRoute" not in text:
        missing.append(r"""function seekdeepLogRoute(route, prompt = '') {
  const safeRoute = String(route || 'unknown').trim() || 'unknown';
  const safePrompt = String(prompt || '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 500);

  try {
    console.log(`[SeekDeep] route=${safeRoute} prompt=${safePrompt}`);
  } catch {}
}""")
    if missing:
        text = text[:insert_pos] + "\n\n".join(missing) + "\n\n" + text[insert_pos:]

for needle, label in [
    ("function seekdeepLogRoute", "route logger"),
    ("function seekdeepNoModelLabel", "no-model helper"),
    ("function seekdeepNowMs", "timestamp helper"),
]:
    if needle not in text:
        raise SystemExit(f"Missing required helper after patch: {label}")

for bad in ["}, target = null) {", "state = {) {", "state = {,"]:
    if bad in text:
        raise SystemExit(f"Malformed code detected after patch: {bad}")

out = text if newline == "\n" else text.replace("\n", "\r\n")
path.write_bytes(out.encode("utf-8"))
print("Patched missing route logger helpers.")
'@

  $patchPyPath = Join-Path $patchesDir "patch_missing_route_logger.py"
  [System.IO.File]::WriteAllText($patchPyPath, $patchPy, [System.Text.UTF8Encoding]::new($false))

  Push-Location $projectRoot
  try {
    Write-Info "Applying missing route logger repair"
    & ".\.venv\Scripts\python.exe" $patchPyPath $indexPath
    if ($LASTEXITCODE -ne 0) { throw "Patch helper failed with exit code $LASTEXITCODE." }
    Write-Pass "Applied missing route logger repair"

    Write-Info "Running node --check .\index.js"
    & node --check ".\index.js"
    if ($LASTEXITCODE -ne 0) { throw "node --check failed with exit code $LASTEXITCODE." }
    Write-Pass "node --check passed"

    Write-Info "Running Python compile check"
    & ".\.venv\Scripts\python.exe" -m py_compile ".\local_ai_server.py"
    if ($LASTEXITCODE -ne 0) { throw "Python compile check failed with exit code $LASTEXITCODE." }
    Write-Pass "Python compile check passed"
  } finally {
    Pop-Location
  }

  Write-Host ""
  Write-Pass "Missing route logger repair completed."
  Write-Host "Backup created: $backup" -ForegroundColor Yellow
  Write-Host "Restart the bot before testing." -ForegroundColor Yellow
  Write-Host ""
  Write-Host "Retest:" -ForegroundColor Cyan
  Write-Host "@SEEKOTICS generate a red test orb" -ForegroundColor White
  Write-Host "@SEEKOTICS archive shared" -ForegroundColor White
  exit 0
} catch {
  Write-Host ""
  Write-Fail $_.Exception.Message
  Write-Host "Backup available:" -ForegroundColor Yellow
  if ($backup) { Write-Host $backup -ForegroundColor Yellow }
  exit 1
}
