# SeekDeep / Seekotics restore newest valid index.js + minimal quiet labels
#
# Purpose:
# - The quiet-report patch restored a backup that was still syntax-broken.
# - This script automatically searches patches\backups for the newest index.js backup
#   that passes `node --check`, restores it, then applies only safe text-label cleanup.
#
# It avoids fragile function rewrites.
#
# Safe cleanup applied:
# - "Generated locally:" -> "Generated:"
# - "Archived on the bot host:" -> "Archived to this server."
# - "Archived locally for this server." -> "Archived to this server."
#
# It does NOT attempt the deeper footer/telemetry rewrite yet. First priority is to
# restore a clean running bot without manual inspection.

$ErrorActionPreference = "Stop"

try {
  [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
} catch {}

function Write-Info {
  param([string]$Message)
  Write-Host "[SeekDeep restore-valid-index] $Message" -ForegroundColor Cyan
}

function Write-Pass {
  param([string]$Message)
  Write-Host "[PASS] $Message" -ForegroundColor Green
}

function Write-Warn {
  param([string]$Message)
  Write-Host "[WARN] $Message" -ForegroundColor Yellow
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
  $patchesDir = Join-Path $projectRoot "patches"
  $backupDir = Join-Path $patchesDir "backups"
  $stamp = Get-Date -Format "yyyyMMdd-HHmmss"

  if (-not (Test-Path -LiteralPath $indexPath)) { throw "index.js not found." }
  if (-not (Test-Path -LiteralPath $backupDir)) { throw "Backup directory not found: $backupDir" }

  $brokenBackup = Join-Path $backupDir "index.js.broken-before-auto-restore-$stamp.bak"
  Copy-Item -LiteralPath $indexPath -Destination $brokenBackup -Force
  Write-Pass "Backed up current broken index.js to $brokenBackup"

  $tempDir = Join-Path $patchesDir "tmp-valid-index-search-$stamp"
  New-Item -ItemType Directory -Path $tempDir -Force | Out-Null
  $candidatePath = Join-Path $tempDir "index.candidate.js"

  $backups = Get-ChildItem -LiteralPath $backupDir -Filter "index.js*.bak" -File |
    Sort-Object LastWriteTime -Descending

  if (-not $backups -or $backups.Count -eq 0) {
    throw "No index.js backups found."
  }

  $selected = $null
  $checked = 0

  Push-Location $projectRoot
  try {
    foreach ($backup in $backups) {
      # Skip backups created from already-known broken quiet attempts unless no other valid file exists.
      if ($backup.Name -match "quiet-generation-report|before-quiet-report-v2-recover|broken-before-auto-restore") {
        Write-Info "Skipping known quiet/broken backup: $($backup.Name)"
        continue
      }

      $checked++
      Copy-Item -LiteralPath $backup.FullName -Destination $candidatePath -Force

      & node --check $candidatePath *> $null
      if ($LASTEXITCODE -eq 0) {
        $selected = $backup
        break
      }

      Write-Info "Backup failed syntax check: $($backup.Name)"
    }

    # If filtered search failed, try absolutely everything except the broken snapshot we just created.
    if (-not $selected) {
      Write-Warn "Filtered search found no valid backup. Trying all backups."
      foreach ($backup in $backups) {
        if ($backup.FullName -eq $brokenBackup) { continue }

        $checked++
        Copy-Item -LiteralPath $backup.FullName -Destination $candidatePath -Force

        & node --check $candidatePath *> $null
        if ($LASTEXITCODE -eq 0) {
          $selected = $backup
          break
        }

        Write-Info "Backup failed syntax check: $($backup.Name)"
      }
    }

    if (-not $selected) {
      throw "No syntax-valid index.js backup found after checking $checked backups."
    }

    Copy-Item -LiteralPath $selected.FullName -Destination $indexPath -Force
    Write-Pass "Restored syntax-valid backup: $($selected.FullName)"

    # Apply only safe text replacements.
    $text = [System.IO.File]::ReadAllText($indexPath)

    $text = $text.Replace("Generated locally:", "Generated:")
    $text = $text.Replace("Archived on the bot host:`n[local archive path hidden]", "Archived to this server.")
    $text = $text.Replace("Archived on the bot host:\n[local archive path hidden]", "Archived to this server.")
    $text = $text.Replace("Archived on the bot host:", "Archived to this server.")
    $text = $text.Replace("Archived locally for this server.", "Archived to this server.")

    [System.IO.File]::WriteAllText($indexPath, $text, [System.Text.UTF8Encoding]::new($false))
    Write-Pass "Applied minimal safe report label cleanup"

    Write-Info "Running node --check .\index.js"
    & node --check ".\index.js"
    if ($LASTEXITCODE -ne 0) {
      throw "Restored file became invalid after minimal cleanup. This should not happen."
    }
    Write-Pass "node --check passed"

    if (Test-Path -LiteralPath $serverPath) {
      Write-Info "Running Python compile check"
      & ".\.venv\Scripts\python.exe" -m py_compile ".\local_ai_server.py"
      if ($LASTEXITCODE -ne 0) {
        throw "Python compile check failed with exit code $LASTEXITCODE."
      }
      Write-Pass "Python compile check passed"
    }
  } finally {
    Pop-Location
  }

  try {
    Remove-Item -LiteralPath $tempDir -Recurse -Force
  } catch {}

  Write-Host ""
  Write-Pass "Recovered to a syntax-valid index.js."
  Write-Host "Broken file backup: $brokenBackup" -ForegroundColor Yellow
  Write-Host "Restored backup: $($selected.FullName)" -ForegroundColor Yellow
  Write-Host "Restart the bot now." -ForegroundColor Yellow
  Write-Host ""
  Write-Host "Next step after this is confirmed running:" -ForegroundColor Cyan
  Write-Host "Apply quiet-report cleanup again, but only after we inspect the actual current seekdeepAppendResponseFooter shape." -ForegroundColor White
  exit 0
} catch {
  Write-Host ""
  Write-Fail $_.Exception.Message
  Write-Host "Current broken file backup:" -ForegroundColor Yellow
  if ($brokenBackup) { Write-Host $brokenBackup -ForegroundColor Yellow }
  exit 1
}
