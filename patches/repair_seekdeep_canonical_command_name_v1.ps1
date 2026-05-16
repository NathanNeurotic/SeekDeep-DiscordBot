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
$IndexBackupPath = Join-Path $BackupsDir "index.js.before-canonical-command-name-v1-$Stamp.bak"
$PatchJsPath = Join-Path $PatchesDir "apply_canonical_command_name_v1_$Stamp.cjs"

Copy-Item $IndexPath $IndexBackupPath -Force
Write-Host "Backup created: $IndexBackupPath"

@'

const fs = require('fs');
const path = require('path');

const indexPath = path.join(process.cwd(), 'index.js');
let source = fs.readFileSync(indexPath, 'utf8');
let out = source;
const changes = [];

function replaceAllLiteral(find, replace, label) {
  const count = (out.match(new RegExp(find.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')) || []).length;
  if (count > 0) {
    out = out.split(find).join(replace);
    changes.push(`${label}: ${count}`);
  }
}

function replaceRegex(regex, replacer, label) {
  let count = 0;
  out = out.replace(regex, (...args) => {
    count += 1;
    return typeof replacer === 'function' ? replacer(...args) : replacer;
  });
  if (count > 0) changes.push(`${label}: ${count}`);
}

// Canonical visible command prefix should be @SeekDeep.
replaceAllLiteral('@SEEKOTICS', '@SeekDeep', 'updated visible command prefix');
replaceAllLiteral('SEEKOTICS COMMAND MAP', 'SEEKDEEP COMMAND MAP', 'updated command map title');
replaceAllLiteral('Seekotics command map', 'SeekDeep command map', 'updated title-case command map title');
replaceAllLiteral('seekotics command map', 'seekdeep command map', 'updated lower-case command map title');

// Some earlier help text may mention SEEKOTICS in prose without the @ mention.
replaceRegex(/\bUse `@SeekDeep help` for the full supported command map\./g, 'Use `@SeekDeep help` for the full supported command map.', 'normalized help hint');
replaceRegex(/\bSeekotics\b/g, 'SeekDeep', 'updated visible bot name');

if (out === source) {
  throw new Error('No visible @SEEKOTICS / Seekotics help text was found to update.');
}

fs.writeFileSync(indexPath, out, 'utf8');
console.log('Patched index.js successfully.');
for (const c of changes) console.log('- ' + c);

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
  Write-Host "- User-facing help, command examples, and suggestion text now use @SeekDeep as the canonical bot mention."
  Write-Host "- Internal compatibility for @SEEKOTICS / seekotics aliases is preserved."
  Write-Host "- Help header now says SEEKDEEP COMMAND MAP."
} catch {
  Write-Host ""
  Write-Host "Patch failed. Restoring backup..."
  Copy-Item $IndexBackupPath $IndexPath -Force
  Write-Host "Restored: $IndexBackupPath"
  throw
}
