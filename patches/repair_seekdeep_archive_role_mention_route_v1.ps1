$ErrorActionPreference = 'Stop'

$root = (Get-Location).Path
$indexPath = Join-Path $root 'index.js'
$localAiPath = Join-Path $root 'local_ai_server.py'
$venvPython = Join-Path $root '.venv\Scripts\python.exe'
$backupDir = Join-Path $root 'backups'
$patchDir = Join-Path $root 'patches'
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$backupPath = Join-Path $backupDir "index.js.before-archive-role-mention-route-v1-$stamp.bak"
$patcherPath = Join-Path $patchDir "apply_archive_role_mention_route_v1_$stamp.cjs"

if (!(Test-Path $indexPath)) {
  throw "index.js not found. Run this from C:\Users\natha\SeekDeep-DiscordBot."
}

New-Item -ItemType Directory -Path $backupDir -Force | Out-Null
New-Item -ItemType Directory -Path $patchDir -Force | Out-Null
Copy-Item $indexPath $backupPath -Force
Write-Host "Backup created: $backupPath"

$patcher = @'
const fs = require('fs');

const indexPath = process.argv[2];
if (!indexPath) throw new Error('Missing index.js path argument.');

let src = fs.readFileSync(indexPath, 'utf8');
let next = src;
const changes = [];

if (next.includes('SEEKDEEP_ARCHIVE_ROLE_MENTION_ROUTE_V1')) {
  console.log('Archive role-mention route patch marker already present; no text changes needed.');
} else {
  const oldBlock = `  const withoutBotMention = raw
    .replace(/<@!?\\d+>/g, (mention, offset) => {
      // Preserve non-leading mentions so "archive @user" still routes.
      const before = raw.slice(0, offset).trim();
      return before ? mention : ' ';
    })`;

  const newBlock = `  const withoutBotMention = raw
    // SEEKDEEP_ARCHIVE_ROLE_MENTION_ROUTE_V1_START
    // Discord can resolve @SeekDeep as a role mention (<@&id>) instead of the bot user mention.
    // Treat only leading user/role mentions as command-addressing noise, while preserving later
    // user mentions so "archive @user" still targets the correct person.
    .replace(/<@(?:!|&)?\\d+>/g, (mention, offset) => {
      const before = raw.slice(0, offset).trim();
      return before ? mention : ' ';
    })
    // SEEKDEEP_ARCHIVE_ROLE_MENTION_ROUTE_V1_END`;

  if (!next.includes(oldBlock)) {
    throw new Error('Could not find the archive-open mention normalization block. index.js has drifted; refusing to patch blindly.');
  }

  next = next.replace(oldBlock, newBlock);
  changes.push('archive-open message detection now accepts leading role mentions such as <@&role> archive @user');
}

if (next !== src) {
  fs.writeFileSync(indexPath, next, 'utf8');
  for (const change of changes) console.log(`Applied: ${change}`);
}
'@

Set-Content -Path $patcherPath -Value $patcher -Encoding UTF8

try {
  Write-Host "Applying patch with: $patcherPath"
  & node $patcherPath $indexPath
  if ($LASTEXITCODE -ne 0) { throw "Node patcher failed with exit code $LASTEXITCODE" }

  Write-Host "Running node syntax check..."
  & node --check $indexPath
  if ($LASTEXITCODE -ne 0) { throw "node --check failed with exit code $LASTEXITCODE" }

  if ((Test-Path $venvPython) -and (Test-Path $localAiPath)) {
    Write-Host "Running Python compile check..."
    & $venvPython -m py_compile $localAiPath
    if ($LASTEXITCODE -ne 0) { throw "Python compile check failed with exit code $LASTEXITCODE" }
  } else {
    Write-Host "Python compile check skipped: .venv python or local_ai_server.py not found."
  }

  Write-Host ""
  Write-Host "Patch complete: archive message routing now accepts a leading role mention alias."
  Write-Host "Backup kept at: $backupPath"
} catch {
  Write-Host ""
  Write-Host "Patch failed. Restoring backup..." -ForegroundColor Red
  Copy-Item $backupPath $indexPath -Force
  Write-Host "Restored: $backupPath" -ForegroundColor Yellow
  throw
}
