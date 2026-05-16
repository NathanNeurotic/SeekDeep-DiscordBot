# SeekDeep / Seekotics archive label syntax damage repair v2
#
# Fixes:
# - __metaArchive scope: file.fullPath -> __metaPath: file.fullPath
# - Other accidental "Archive scope" identifier damage
#
# This v2 avoids the false-positive from v1 where the literal UI string:
#   "Archive scope:"
# was treated as an invalid JS identifier.
#
# Files patched:
# - index.js only

$ErrorActionPreference = "Stop"

try {
  [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
} catch {}

function Write-Info {
  param([string]$Message)
  Write-Host "[SeekDeep archive-syntax-repair-v2] $Message" -ForegroundColor Cyan
}

function Write-Pass {
  param([string]$Message)
  Write-Host "[PASS] $Message" -ForegroundColor Green
}

function Write-Fail {
  param([string]$Message)
  Write-Host "[FAIL] $Message" -ForegroundColor Red
}

try {
  $projectRoot = Join-Path $env:USERPROFILE "SeekDeep-DiscordBot"
  if (-not (Test-Path -LiteralPath (Join-Path $projectRoot "index.js"))) {
    $projectRoot = (Get-Location).Path
  }

  $indexPath = Join-Path $projectRoot "index.js"
  $serverPath = Join-Path $projectRoot "local_ai_server.py"
  $backupDir = Join-Path $projectRoot "patches\backups"
  $stamp = Get-Date -Format "yyyyMMdd-HHmmss"

  if (-not (Test-Path -LiteralPath $indexPath)) { throw "index.js not found." }
  if (-not (Test-Path -LiteralPath $serverPath)) { throw "local_ai_server.py not found." }

  New-Item -ItemType Directory -Path $backupDir -Force | Out-Null
  $backup = Join-Path $backupDir "index.js.archive-label-syntax-repair-v2-$stamp.bak"
  Copy-Item -LiteralPath $indexPath -Destination $backup -Force
  Write-Pass "Backed up index.js to $backup"

  $text = [System.IO.File]::ReadAllText($indexPath)

  # Exact damage caused by global "Path:" -> "Archive scope:" replacement.
  $exactRepairs = [ordered]@{
    "__metaArchive scope:"    = "__metaPath:"
    "__archiveArchive scope:" = "__archivePath:"
    "__fileArchive scope:"    = "__filePath:"
    "__fullArchive scope:"    = "__fullPath:"
    "__savedArchive scope:"   = "__savedPath:"
    "metaArchive scope:"      = "metaPath:"
    "archiveArchive scope:"   = "archivePath:"
    "fileArchive scope:"      = "filePath:"
    "fullArchive scope:"      = "fullPath:"
    "savedArchive scope:"     = "savedPath:"
  }

  foreach ($key in $exactRepairs.Keys) {
    $text = $text.Replace($key, $exactRepairs[$key])
  }

  # More precise regex repair:
  # Only fix unquoted identifiers containing "Archive scope:" where "scope" is immediately followed by a colon
  # and the prefix is a JS identifier, not a visible text string.
  $text = [regex]::Replace(
    $text,
    "(?m)(?<prefix>[{,]\s*)(?<name>[A-Za-z_$][A-Za-z0-9_$]*Archive)\s+scope\s*:",
    '${prefix}${name}Scope:'
  )

  # Privacy-friendly display labels, restricted to quoted strings only.
  $text = $text.Replace("'Path checked:'", "'Archive scope checked:'")
  $text = $text.Replace('"Path checked:"', '"Archive scope checked:"')
  $text = $text.Replace("'Path:'", "'Archive scope:'")
  $text = $text.Replace('"Path:"', '"Archive scope:"')

  [System.IO.File]::WriteAllText($indexPath, $text, [System.Text.UTF8Encoding]::new($false))
  Write-Pass "Repaired archive label syntax damage"

  Push-Location $projectRoot
  try {
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
  Write-Pass "Archive syntax repair v2 completed."
  Write-Host "Backup created: $backup" -ForegroundColor Yellow
  Write-Host "Restart the bot, then retest /archivestatus and /postarchive." -ForegroundColor Yellow
  exit 0
} catch {
  Write-Host ""
  Write-Fail $_.Exception.Message
  Write-Host "Backup available:" -ForegroundColor Yellow
  if ($backup) { Write-Host $backup -ForegroundColor Yellow }
  exit 1
}
