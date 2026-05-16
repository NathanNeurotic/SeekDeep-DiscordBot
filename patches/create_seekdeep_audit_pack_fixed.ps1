$ErrorActionPreference = "Stop"
$projectRoot = Join-Path $env:USERPROFILE "SeekDeep-DiscordBot"
if (-not (Test-Path -LiteralPath (Join-Path $projectRoot "index.js"))) { $projectRoot = (Get-Location).Path }
$stamp = Get-Date -Format "yyyyMMdd-HHmmss"
$outDir = Join-Path $env:USERPROFILE "Downloads"
$workDir = Join-Path $env:TEMP "seekdeep-audit-pack-$stamp"
$zipPath = Join-Path $outDir "seekdeep-audit-pack-$stamp.zip"
New-Item -ItemType Directory -Path "$workDir\project","$workDir\diagnostics","$workDir\recent-backups","$workDir\recent-patches" -Force | Out-Null
foreach ($file in @("index.js","local_ai_server.py","package.json","package-lock.json","README.md","AGENTS.md")) {
  $src = Join-Path $projectRoot $file
  if (Test-Path -LiteralPath $src) { Copy-Item -LiteralPath $src -Destination (Join-Path $workDir "project\$file") -Force }
}
$patchesDir = Join-Path $projectRoot "patches"
if (Test-Path -LiteralPath $patchesDir) {
  Get-ChildItem -LiteralPath $patchesDir -File -ErrorAction SilentlyContinue |
    Where-Object { $_.Extension -in ".ps1",".py" } |
    Sort-Object LastWriteTime -Descending |
    Select-Object -First 30 |
    ForEach-Object { Copy-Item -LiteralPath $_.FullName -Destination (Join-Path $workDir "recent-patches\$($_.Name)") -Force }
  $backupDir = Join-Path $patchesDir "backups"
  if (Test-Path -LiteralPath $backupDir) {
    Get-ChildItem -LiteralPath $backupDir -File -Filter "index.js*.bak" -ErrorAction SilentlyContinue |
      Sort-Object LastWriteTime -Descending |
      Select-Object -First 12 |
      ForEach-Object { Copy-Item -LiteralPath $_.FullName -Destination (Join-Path $workDir "recent-backups\$($_.Name)") -Force }
  }
}
Push-Location $projectRoot
try {
  & node --check ".\index.js" *> (Join-Path $workDir "diagnostics\node-check.txt")
  "EXITCODE=$LASTEXITCODE" | Add-Content -LiteralPath (Join-Path $workDir "diagnostics\node-check.txt")
  $lines = Get-Content -LiteralPath ".\index.js"
  $context = New-Object System.Collections.Generic.List[string]
  $start = [Math]::Max(1, 3520)
  $end = [Math]::Min($lines.Count, 3620)
  for ($i = $start; $i -le $end; $i++) { $context.Add(("{0,6}: {1}" -f $i, $lines[$i - 1])) }
  $context | Set-Content -LiteralPath (Join-Path $workDir "diagnostics\index-context-around-archive.txt") -Encoding UTF8
  Select-String -Path ".\index.js" -Pattern "seekdeepArchiveImageStateToDiscordThread|seekdeepMaterializeArchiveFileFromState|seekdeepGetOrCreateUserArchiveThread|}, target = null" -Context 4,8 |
    Out-String -Width 240 |
    Set-Content -LiteralPath (Join-Path $workDir "diagnostics\archive-function-search.txt") -Encoding UTF8
  try { & git status --short *> (Join-Path $workDir "diagnostics\git-status.txt") } catch {}
} finally { Pop-Location }
@"
SeekDeep audit pack
Created: $(Get-Date -Format o)
Project root: $projectRoot
Excluded: .env, node_modules, .venv, models, saved_generations, .git
"@ | Set-Content -LiteralPath (Join-Path $workDir "MANIFEST.txt") -Encoding UTF8
if (Test-Path -LiteralPath $zipPath) { Remove-Item -LiteralPath $zipPath -Force }
Compress-Archive -Path (Join-Path $workDir "*") -DestinationPath $zipPath -Force
Remove-Item -LiteralPath $workDir -Recurse -Force
Write-Host "[PASS] Created audit zip: $zipPath" -ForegroundColor Green
