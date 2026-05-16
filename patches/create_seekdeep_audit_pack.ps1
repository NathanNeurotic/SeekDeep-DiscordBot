# SeekDeep audit packer
#
# Creates a small zip I can inspect before writing the next repair.
# Excludes large/private folders: node_modules, .venv, models, saved_generations, .git.
# Does not include .env by default.

$ErrorActionPreference = "Stop"

try {
  [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
} catch {}

function Write-Info($m) { Write-Host "[SeekDeep audit-pack] $m" -ForegroundColor Cyan }
function Write-Pass($m) { Write-Host "[PASS] $m" -ForegroundColor Green }
function Write-Warn($m) { Write-Host "[WARN] $m" -ForegroundColor Yellow }

$projectRoot = Join-Path $env:USERPROFILE "SeekDeep-DiscordBot"
if (-not (Test-Path -LiteralPath (Join-Path $projectRoot "index.js"))) {
  $projectRoot = (Get-Location).Path
}

if (-not (Test-Path -LiteralPath (Join-Path $projectRoot "index.js"))) {
  throw "index.js not found. Run this from the SeekDeep-DiscordBot folder or keep the project at $env:USERPROFILE\SeekDeep-DiscordBot."
}

$stamp = Get-Date -Format "yyyyMMdd-HHmmss"
$outDir = Join-Path $env:USERPROFILE "Downloads"
$workDir = Join-Path $env:TEMP "seekdeep-audit-pack-$stamp"
$zipPath = Join-Path $outDir "seekdeep-audit-pack-$stamp.zip"

New-Item -ItemType Directory -Path $workDir -Force | Out-Null
New-Item -ItemType Directory -Path (Join-Path $workDir "project") -Force | Out-Null
New-Item -ItemType Directory -Path (Join-Path $workDir "diagnostics") -Force | Out-Null
New-Item -ItemType Directory -Path (Join-Path $workDir "recent-backups") -Force | Out-Null
New-Item -ItemType Directory -Path (Join-Path $workDir "recent-patches") -Force | Out-Null

Write-Info "Project root: $projectRoot"

# Core files
$coreFiles = @(
  "index.js",
  "local_ai_server.py",
  "package.json",
  "package-lock.json",
  "pnpm-lock.yaml",
  "yarn.lock",
  "README.md",
  "AGENTS.md"
)

foreach ($file in $coreFiles) {
  $src = Join-Path $projectRoot $file
  if (Test-Path -LiteralPath $src) {
    Copy-Item -LiteralPath $src -Destination (Join-Path $workDir "project\$file") -Force
  }
}

# Launcher/config examples only; do not copy .env secrets.
Get-ChildItem -LiteralPath $projectRoot -File -ErrorAction SilentlyContinue |
  Where-Object {
    $_.Name -match "launcher|start|install|setup|requirements|compose|docker|\.env\.example|example\.env" -and
    $_.Name -notmatch "^\.env$"
  } |
  ForEach-Object {
    Copy-Item -LiteralPath $_.FullName -Destination (Join-Path $workDir "project\$($_.Name)") -Force
  }

# Recent patch scripts
$patchesDir = Join-Path $projectRoot "patches"
if (Test-Path -LiteralPath $patchesDir) {
  Get-ChildItem -LiteralPath $patchesDir -File -Include "*.ps1","*.py" -ErrorAction SilentlyContinue |
    Sort-Object LastWriteTime -Descending |
    Select-Object -First 30 |
    ForEach-Object {
      Copy-Item -LiteralPath $_.FullName -Destination (Join-Path $workDir "recent-patches\$($_.Name)") -Force
    }

  $backupDir = Join-Path $patchesDir "backups"
  if (Test-Path -LiteralPath $backupDir) {
    Get-ChildItem -LiteralPath $backupDir -File -Filter "index.js*.bak" -ErrorAction SilentlyContinue |
      Sort-Object LastWriteTime -Descending |
      Select-Object -First 12 |
      ForEach-Object {
        Copy-Item -LiteralPath $_.FullName -Destination (Join-Path $workDir "recent-backups\$($_.Name)") -Force
      }
  }
}

# Diagnostics
Push-Location $projectRoot
try {
  $nodeOut = Join-Path $workDir "diagnostics\node-check.txt"
  try {
    & node --check ".\index.js" *> $nodeOut
    Add-Content -LiteralPath $nodeOut -Value "`nEXITCODE=$LASTEXITCODE"
  } catch {
    Add-Content -LiteralPath $nodeOut -Value "`nNODE_CHECK_EXCEPTION=$($_.Exception.Message)"
  }

  $contextOut = Join-Path $workDir "diagnostics\index-context-around-error.txt"
  $lines = Get-Content -LiteralPath ".\index.js"
  $start = [Math]::Max(1, 3530)
  $end = [Math]::Min($lines.Count, 3605)
  for ($i = $start; $i -le $end; $i++) {
    "{0,6}: {1}" -f $i, $lines[$i - 1]
  } | Set-Content -LiteralPath $contextOut -Encoding UTF8

  $searchOut = Join-Path $workDir "diagnostics\archive-function-search.txt"
  Select-String -Path ".\index.js" -Pattern "seekdeepArchiveImageStateToDiscordThread|seekdeepMaterializeArchiveFileFromState|seekdeepGetOrCreateUserArchiveThread|seekdeepArchiveImageStateToDisk|}, target = null" -Context 4,8 |
    Out-String -Width 240 |
    Set-Content -LiteralPath $searchOut -Encoding UTF8

  $gitOut = Join-Path $workDir "diagnostics\git-status.txt"
  try {
    & git status --short *> $gitOut
  } catch {
    Set-Content -LiteralPath $gitOut -Value "git status unavailable: $($_.Exception.Message)" -Encoding UTF8
  }
} finally {
  Pop-Location
}

# Manifest
$manifest = @"
SeekDeep audit pack
Created: $(Get-Date -Format o)
Project root: $projectRoot

Included:
- project/index.js
- project/local_ai_server.py
- package/launcher/config example files if present
- recent-patches/*.ps1/*.py, max 30
- recent-backups/index.js*.bak, max 12
- diagnostics/node-check.txt
- diagnostics/index-context-around-error.txt
- diagnostics/archive-function-search.txt
- diagnostics/git-status.txt

Excluded:
- .env
- node_modules
- .venv
- models
- saved_generations
- .git
"@
Set-Content -LiteralPath (Join-Path $workDir "MANIFEST.txt") -Value $manifest -Encoding UTF8

if (Test-Path -LiteralPath $zipPath) {
  Remove-Item -LiteralPath $zipPath -Force
}

Compress-Archive -Path (Join-Path $workDir "*") -DestinationPath $zipPath -Force
Remove-Item -LiteralPath $workDir -Recurse -Force

Write-Pass "Created audit zip:"
Write-Host $zipPath -ForegroundColor Yellow
Write-Host ""
Write-Host "Upload this zip here." -ForegroundColor Cyan
