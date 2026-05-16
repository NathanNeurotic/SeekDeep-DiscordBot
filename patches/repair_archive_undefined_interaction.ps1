# SeekDeep / Seekotics archive undefined interaction repair
#
# Fixes:
#   ReferenceError: interaction is not defined
#     at seekdeepListArchiveImageFiles (...)
#
# Cause:
# - Earlier archive privacy patch injected expressions like:
#     interaction || message || {}
#   inside archive helper functions where neither interaction nor message exists.
# - In JavaScript, referencing an undeclared variable directly throws ReferenceError.
#
# This repair:
# - Replaces unsafe fallback expressions with typeof-safe fallback expressions.
# - Adds a reusable seekdeepArchiveTargetFallback(...) helper.
# - Keeps guild/server scoping intact.
# - Keeps local path redaction intact.
#
# Files patched:
# - index.js only

$ErrorActionPreference = "Stop"

try {
  [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
} catch {}

function Write-Info {
  param([string]$Message)
  Write-Host "[SeekDeep archive-undefined-interaction-repair] $Message" -ForegroundColor Cyan
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
  $backup = Join-Path $backupDir "index.js.archive-undefined-interaction-repair-$stamp.bak"
  Copy-Item -LiteralPath $indexPath -Destination $backup -Force
  Write-Pass "Backed up index.js to $backup"

  $text = [System.IO.File]::ReadAllText($indexPath)
  $safeTargetExpr = "seekdeepArchiveTargetFallback(typeof archiveTarget !== 'undefined' ? archiveTarget : null)"

  # Insert safe helper if missing.
  if ($text -notmatch "function\s+seekdeepArchiveTargetFallback\s*\(") {
    $helper = @'

function seekdeepArchiveTargetFallback(preferred = null) {
  if (preferred) return preferred;
  if (typeof interaction !== 'undefined' && interaction) return interaction;
  if (typeof message !== 'undefined' && message) return message;
  if (typeof sentMessage !== 'undefined' && sentMessage) return sentMessage;
  return {};
}

'@

    $anchor = "function seekdeepGuildArchiveScopeFromTarget"
    $pos = $text.IndexOf($anchor)
    if ($pos -lt 0) {
      $anchor = "client.on('interactionCreate'"
      $pos = $text.IndexOf($anchor)
    }
    if ($pos -lt 0) { throw "Could not find insertion anchor for seekdeepArchiveTargetFallback." }

    $text = $text.Substring(0, $pos) + $helper + $text.Substring($pos)
  }

  # Replace unsafe direct references. These are safe even inside functions without interaction/message variables.
  $text = $text.Replace("(interaction || message || {})", "seekdeepArchiveTargetFallback()")
  $text = $text.Replace("(message || interaction || {})", "seekdeepArchiveTargetFallback()")
  $text = $text.Replace("(interaction || message || sentMessage || {})", "seekdeepArchiveTargetFallback()")
  $text = $text.Replace("(message || interaction || sentMessage || {})", "seekdeepArchiveTargetFallback()")

  # Replace the specific ternary injected by earlier patches.
  $text = $text.Replace(
    "typeof archiveTarget !== 'undefined' ? archiveTarget : seekdeepArchiveTargetFallback()",
    "seekdeepArchiveTargetFallback(typeof archiveTarget !== 'undefined' ? archiveTarget : null)"
  )

  $text = $text.Replace(
    "typeof archiveTarget !== 'undefined' ? archiveTarget : (interaction || message || {})",
    "seekdeepArchiveTargetFallback(typeof archiveTarget !== 'undefined' ? archiveTarget : null)"
  )

  $text = $text.Replace(
    "typeof archiveTarget !== 'undefined' ? archiveTarget : (message || interaction || {})",
    "seekdeepArchiveTargetFallback(typeof archiveTarget !== 'undefined' ? archiveTarget : null)"
  )

  # Clean ugly duplicate visible archive status from previous replacement:
  # "Archived locally for this server.\nthis server" is redundant.
  $text = $text.Replace("Archived locally for this server.`n${seekdeepArchiveScopeLabel($safeTargetExpr)}", "Archived locally for this server.")
  $text = $text.Replace("Archived locally for this server.\n${seekdeepArchiveScopeLabel($safeTargetExpr)}", "Archived locally for this server.")

  # Repair any previous object key damage if still present.
  $text = $text.Replace("__metaArchive scope:", "__metaPath:")
  $text = $text.Replace("metaArchive scope:", "metaPath:")

  [System.IO.File]::WriteAllText($indexPath, $text, [System.Text.UTF8Encoding]::new($false))
  Write-Pass "Patched unsafe archive fallback references"

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
  Write-Pass "Archive undefined-interaction repair completed."
  Write-Host "Backup created: $backup" -ForegroundColor Yellow
  Write-Host "Restart the bot, then retest /postarchive." -ForegroundColor Yellow
  exit 0
} catch {
  Write-Host ""
  Write-Fail $_.Exception.Message
  Write-Host "Backup available:" -ForegroundColor Yellow
  if ($backup) { Write-Host $backup -ForegroundColor Yellow }
  exit 1
}
