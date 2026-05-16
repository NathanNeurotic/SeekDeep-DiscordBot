# SeekDeep / Seekotics missing mention helper repair
#
# Fixes:
#   Discord client error: ReferenceError: seekdeepCountBotMentionTags is not defined
#
# Cause:
# - The messageCreate handler now calls seekdeepCountBotMentionTags(...)
#   but that helper is missing after the recent patch stack.
#
# Behavior:
# - Adds safe mention helper functions if missing:
#     seekdeepCountBotMentionTags(...)
#     seekdeepStripBotMentions(...)
#     seekdeepMessageMentionsBot(...)
#
# Validation:
# - node --check .\index.js
# - python -m py_compile .\local_ai_server.py

$ErrorActionPreference = "Stop"

try {
  [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
} catch {}

function Write-Info { param([string]$Message) Write-Host "[SeekDeep mention-helper-repair] $Message" -ForegroundColor Cyan }
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

  $backup = Join-Path $backupDir "index.js.before-mention-helper-repair-$stamp.bak"
  Copy-Item -LiteralPath $indexPath -Destination $backup -Force
  Write-Pass "Backed up index.js to $backup"

  $patchPy = @'
from pathlib import Path
import re
import sys

if len(sys.argv) != 2:
    raise SystemExit("Usage: patch_missing_mention_helpers.py <index.js>")

path = Path(sys.argv[1])
raw = path.read_bytes()
newline = "\r\n" if b"\r\n" in raw else "\n"
text = raw.decode("utf-8-sig").replace("\r\n", "\n").replace("\r", "\n")


def fail(msg):
    raise SystemExit(msg)


if "seekdeepCountBotMentionTags" not in text:
    fail("index.js does not reference seekdeepCountBotMentionTags; wrong failure state or already changed.")


helpers = r"""function seekdeepBotUserId() {
  return String(client?.user?.id || process.env.DISCORD_CLIENT_ID || process.env.CLIENT_ID || '').trim();
}

function seekdeepCountBotMentionTags(value = '') {
  const text = String(value || '');
  const botId = seekdeepBotUserId();

  if (!botId) {
    return 0;
  }

  const normalMention = new RegExp(`<@${botId}>`, 'g');
  const nicknameMention = new RegExp(`<@!${botId}>`, 'g');

  return (text.match(normalMention) || []).length + (text.match(nicknameMention) || []).length;
}

function seekdeepStripBotMentions(value = '') {
  const text = String(value || '');
  const botId = seekdeepBotUserId();

  if (!botId) {
    return text
      .replace(/\b@?SEEKOTICS\b/gi, ' ')
      .replace(/\b@?SeekDeep\b/gi, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  return text
    .replace(new RegExp(`<@!?${botId}>`, 'g'), ' ')
    .replace(/\b@?SEEKOTICS\b/gi, ' ')
    .replace(/\b@?SeekDeep\b/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function seekdeepMessageMentionsBot(message = null) {
  if (!message) return false;

  const botId = seekdeepBotUserId();
  const content = String(message.content || '');

  if (botId && seekdeepCountBotMentionTags(content) > 0) {
    return true;
  }

  if (botId && message.mentions?.users?.has?.(botId)) {
    return true;
  }

  return /\b@?SEEKOTICS\b/i.test(content) || /\b@?SeekDeep\b/i.test(content);
}
"""

if "function seekdeepCountBotMentionTags" not in text:
    # Put these before messageCreate handler because the error is inside that handler.
    pos = text.find("client.on('messageCreate'")
    if pos < 0:
        pos = text.find('client.on("messageCreate"')
    if pos < 0:
        pos = text.find("client.on('interactionCreate'")
    if pos < 0:
        fail("Could not find client handler insertion point.")

    text = text[:pos] + helpers + "\n\n" + text[pos:]


# Optional: if code strips bot mentions manually in a fragile way later, leave it alone.
# The missing symbol is the immediate hard crash.

for needle, label in [
    ("function seekdeepBotUserId", "bot id helper"),
    ("function seekdeepCountBotMentionTags", "mention count helper"),
    ("function seekdeepStripBotMentions", "strip helper"),
    ("function seekdeepMessageMentionsBot", "mentions helper"),
]:
    if needle not in text:
        fail(f"Missing required helper after patch: {label}")

for bad in ["}, target = null) {", "state = {) {", "state = {,"]:
    if bad in text:
        fail(f"Malformed code detected after patch: {bad}")

out = text if newline == "\n" else text.replace("\n", "\r\n")
path.write_bytes(out.encode("utf-8"))
print("Patched missing mention helpers.")
'@

  $patchPyPath = Join-Path $patchesDir "patch_missing_mention_helpers.py"
  [System.IO.File]::WriteAllText($patchPyPath, $patchPy, [System.Text.UTF8Encoding]::new($false))

  Push-Location $projectRoot
  try {
    Write-Info "Applying missing mention helper repair"
    & ".\.venv\Scripts\python.exe" $patchPyPath $indexPath
    if ($LASTEXITCODE -ne 0) { throw "Patch helper failed with exit code $LASTEXITCODE." }
    Write-Pass "Applied missing mention helper repair"

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
  Write-Pass "Missing mention helper repair completed."
  Write-Host "Backup created: $backup" -ForegroundColor Yellow
  Write-Host "Restart the bot before testing." -ForegroundColor Yellow
  Write-Host ""
  Write-Host "Retest:" -ForegroundColor Cyan
  Write-Host "@SEEKOTICS archive shared" -ForegroundColor White
  Write-Host "@SEEKOTICS generate a red test orb" -ForegroundColor White
  exit 0
} catch {
  Write-Host ""
  Write-Fail $_.Exception.Message
  Write-Host "Backup available:" -ForegroundColor Yellow
  if ($backup) { Write-Host $backup -ForegroundColor Yellow }
  exit 1
}
