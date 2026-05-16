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
$IndexBackupPath = Join-Path $BackupsDir "index.js.before-archive-setup-alias-v1-$Stamp.bak"
$PatchJsPath = Join-Path $PatchesDir "apply_archive_setup_alias_v1_$Stamp.cjs"

Copy-Item $IndexPath $IndexBackupPath -Force
Write-Host "Backup created: $IndexBackupPath"

@'
const fs = require('fs');
const path = require('path');

const indexPath = path.join(process.cwd(), 'index.js');
let source = fs.readFileSync(indexPath, 'utf8');
let text = source;
const changes = [];

const newFn = `function seekdeepIsArchiveConfigPrompt(value = '') {
  const cleaned = seekdeepCleanArchiveConfigPrompt(value).toLowerCase();
  return /^(?:archive\\s+(?:setup|configure|config|channel|set\\s+channel)|setup\\s+archive|configure\\s+archive|config\\s+archive|set\\s+archive\\s+channel)(?:\\b|$)/i.test(cleaned);
}`;

const fnRegex = /function seekdeepIsArchiveConfigPrompt\(value = ''\) \{[\s\S]*?\n\}\n\nfunction seekdeepExtractArchiveSetupChannel/;
if (!fnRegex.test(text)) {
  throw new Error('Could not find seekdeepIsArchiveConfigPrompt immediately before seekdeepExtractArchiveSetupChannel.');
}

text = text.replace(fnRegex, newFn + '\n\nfunction seekdeepExtractArchiveSetupChannel');
changes.push('updated archive setup route matcher to accept setup archive aliases');

if (text.includes('`@SeekDeep setup archive here`')) {
  changes.push('setup archive alias already present in help text');
} else {
  const helpNeedle = "    '`@SeekDeep archive setup #channel`',\n    '`@SeekDeep archive setup here`'";
  if (text.includes(helpNeedle)) {
    text = text.replace(
      helpNeedle,
      "    '`@SeekDeep archive setup #channel`',\n    '`@SeekDeep archive setup here`',\n    '`@SeekDeep setup archive here`'"
    );
    changes.push('added setup archive alias to setup prompt text');
  } else {
    changes.push('setup prompt help anchor not found; route fix still applied');
  }
}

if (text === source) {
  throw new Error('Patch made no changes; refusing to continue.');
}

fs.writeFileSync(indexPath, text, 'utf8');
console.log('Patched index.js successfully.');
for (const change of changes) console.log('- ' + change);

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
  Write-Host "- @SeekDeep setup archive here is now treated as archive setup, not chat."
  Write-Host "- @SeekDeep archive setup here remains supported."
  Write-Host "- @SeekDeep archive setup #channel remains supported."
} catch {
  Write-Host ""
  Write-Host "Patch failed. Restoring backup..."
  Copy-Item $IndexBackupPath $IndexPath -Force
  Write-Host "Restored: $IndexBackupPath"
  throw
}
