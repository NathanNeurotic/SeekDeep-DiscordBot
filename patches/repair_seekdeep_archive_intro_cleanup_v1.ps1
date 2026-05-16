$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$ProjectRoot = (Get-Location).Path
$IndexPath = Join-Path $ProjectRoot 'index.js'
$PythonPath = Join-Path $ProjectRoot '.venv\Scripts\python.exe'
$LocalAiPath = Join-Path $ProjectRoot 'local_ai_server.py'
$BackupsDir = Join-Path $ProjectRoot 'backups'
$PatchesDir = Join-Path $ProjectRoot 'patches'

if (-not (Test-Path $IndexPath)) {
  throw "index.js not found at $IndexPath. Run this from the SeekDeep-DiscordBot project root."
}

New-Item -ItemType Directory -Path $BackupsDir -Force | Out-Null
New-Item -ItemType Directory -Path $PatchesDir -Force | Out-Null

$Stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$BackupPath = Join-Path $BackupsDir "index.js.before-archive-intro-cleanup-v1-$Stamp.bak"
$PatchJsPath = Join-Path $PatchesDir "apply_archive_intro_cleanup_v1_$Stamp.cjs"

Copy-Item $IndexPath $BackupPath -Force
Write-Host "Backup created: $BackupPath"

@'
const fs = require('fs');
const path = require('path');

const indexPath = path.join(process.cwd(), 'index.js');
let source = fs.readFileSync(indexPath, 'utf8');
let output = source;

const changes = [];

function replaceAll(label, pattern, replacement) {
  const before = output;
  output = output.replace(pattern, replacement);
  if (output !== before) changes.push(label);
}

// Remove archive-thread starter/explainer line that was being posted into the user's archive thread.
// This intentionally targets the phrase "Thread format:" only; the public help text uses "Thread style:" and is left alone.
replaceAll(
  'removed archive thread-format explainer line',
  /^[^\S\r\n]*[^\r\n]*Thread format:[^\r\n]*(?:\r?\n|$)/gm,
  ''
);

// Shorten the starter text. The thread name already communicates ownership and count.
replaceAll(
  'shortened archive starter wording',
  /New archived generations for this user will be posted here\./g,
  'New archived generations will appear here.'
);

replaceAll(
  'shortened archive starter wording without period',
  /New archived generations for this user will be posted here/g,
  'New archived generations will appear here'
);

if (output === source) {
  throw new Error('No archive intro text matched. index.js may have drifted or the intro was already cleaned up; refusing to patch blindly.');
}

fs.writeFileSync(indexPath, output, 'utf8');
console.log('Patched index.js successfully:');
for (const change of changes) console.log(`- ${change}`);
'@ | Set-Content -Path $PatchJsPath -Encoding UTF8

try {
  Write-Host "Applying patch with: $PatchJsPath"
  node $PatchJsPath
  if ($LASTEXITCODE -ne 0) { throw "Node patcher failed with exit code $LASTEXITCODE" }

  Write-Host "Running node --check..."
  node --check $IndexPath
  if ($LASTEXITCODE -ne 0) { throw "node --check failed with exit code $LASTEXITCODE" }

  if ((Test-Path $PythonPath) -and (Test-Path $LocalAiPath)) {
    Write-Host "Running Python compile check..."
    & $PythonPath -m py_compile $LocalAiPath
    if ($LASTEXITCODE -ne 0) { throw "Python compile check failed with exit code $LASTEXITCODE" }
  } else {
    Write-Host "Python compile check skipped (venv python or local_ai_server.py not found)."
  }

  Write-Host ""
  Write-Host "Patch applied successfully."
  Write-Host "Changed behavior:"
  Write-Host "- New archive thread intro posts no longer include the thread-format explainer."
  Write-Host "- New archive thread intro posts use the shorter line: New archived generations will appear here."
  Write-Host ""
  Write-Host "Note: existing Discord messages will not be edited retroactively."
} catch {
  Write-Host ""
  Write-Host "Patch failed. Restoring backup..."
  Copy-Item $BackupPath $IndexPath -Force
  Write-Host "Restored: $BackupPath"
  throw
}
