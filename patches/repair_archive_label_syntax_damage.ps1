# SeekDeep / Seekotics archive label syntax damage repair
# Fixes: __metaArchive scope: -> __metaPath:
# Cause: previous patch globally replaced "Path:" with "Archive scope:" and damaged JS object keys.

$ErrorActionPreference = "Stop"
try { [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false) } catch {}

function Write-Info($m) { Write-Host "[SeekDeep archive-syntax-repair] $m" -ForegroundColor Cyan }
function Write-Pass($m) { Write-Host "[PASS] $m" -ForegroundColor Green }
function Write-Fail($m) { Write-Host "[FAIL] $m" -ForegroundColor Red }

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
  $backup = Join-Path $backupDir "index.js.archive-label-syntax-repair-$stamp.bak"
  Copy-Item -LiteralPath $indexPath -Destination $backup -Force
  Write-Pass "Backed up index.js to $backup"

  $text = [System.IO.File]::ReadAllText($indexPath)

  $text = $text.Replace("__metaArchive scope:", "__metaPath:")
  $text = $text.Replace("__archiveArchive scope:", "__archivePath:")
  $text = $text.Replace("__fileArchive scope:", "__filePath:")
  $text = $text.Replace("__fullArchive scope:", "__fullPath:")
  $text = $text.Replace("__savedArchive scope:", "__savedPath:")
  $text = $text.Replace("metaArchive scope:", "metaPath:")
  $text = $text.Replace("archiveArchive scope:", "archivePath:")
  $text = $text.Replace("fileArchive scope:", "filePath:")
  $text = $text.Replace("fullArchive scope:", "fullPath:")
  $text = $text.Replace("savedArchive scope:", "savedPath:")

  # Repair any remaining identifier-space-scope colon damage.
  $text = [regex]::Replace($text, "\b([A-Za-z_$][A-Za-z0-9_$]*Archive)\s+scope\s*:", '$1Scope:')

  # Keep display labels privacy-friendly, but only in actual string literals.
  $text = $text.Replace("'Path checked:'", "'Archive scope checked:'")
  $text = $text.Replace('"Path checked:"', '"Archive scope checked:"')
  $text = $text.Replace("'Path:'", "'Archive scope:'")
  $text = $text.Replace('"Path:"', '"Archive scope:"')

  if ([regex]::IsMatch($text, "\b[A-Za-z_$][A-Za-z0-9_$]*\s+scope\s*:")) {
    $m = [regex]::Match($text, "\b[A-Za-z_$][A-Za-z0-9_$]*\s+scope\s*:")
    throw "Possible invalid identifier remains: $($m.Value)"
  }

  [System.IO.File]::WriteAllText($indexPath, $text, [System.Text.UTF8Encoding]::new($false))
  Write-Pass "Repaired archive label syntax damage"

  Write-Info "Running node --check .\index.js"
  Push-Location $projectRoot
  try {
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
  Write-Pass "Archive syntax repair completed."
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
