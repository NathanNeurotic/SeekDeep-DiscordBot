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
$IndexBackupPath = Join-Path $BackupsDir "index.js.before-build-prompt-with-memory-safe-v14-$Stamp.bak"
$PatchJsPath = Join-Path $PatchesDir "apply_build_prompt_with_memory_safe_v14_$Stamp.cjs"

Copy-Item $IndexPath $IndexBackupPath -Force
Write-Host "Backup created: $IndexBackupPath"

@'
const fs = require('fs');
const path = require('path');

const indexPath = path.join(process.cwd(), 'index.js');
const source = fs.readFileSync(indexPath, 'utf8');
let text = source;
const changes = [];

function replaceBareCalls(src, originalName, replacementName) {
  const re = new RegExp(`\\b${originalName}\\s*\\(`, 'g');
  let count = 0;

  const out = src.replace(re, (match, offset) => {
    const before = src.slice(Math.max(0, offset - 80), offset);
    const prev = src[offset - 1] || '';

    if (/\bfunction\s+$/.test(before)) return match;
    if (prev === '.' || prev === '$' || /[A-Za-z0-9_]/.test(prev)) return match;

    count += 1;
    return `${replacementName}(`;
  });

  if (count > 0) changes.push(`replaced ${count} ${originalName}(...) callsite(s) with ${replacementName}(...)`);
  return out;
}

text = replaceBareCalls(text, 'buildPromptWithMemory', 'seekdeepBuildPromptWithMemorySafeV14');

const marker = '// SEEKDEEP_BUILD_PROMPT_WITH_MEMORY_SAFE_V14_START';
if (!text.includes(marker)) {
  const block = `
// SEEKDEEP_BUILD_PROMPT_WITH_MEMORY_SAFE_V14_START
function seekdeepBuildPromptWithMemorySafeV14(prompt, key) {
  try {
    if (typeof buildPromptWithMemory === 'function') {
      return buildPromptWithMemory(prompt, key);
    }
  } catch {}

  const normalizer =
    (typeof normalizeUserText === 'function' && normalizeUserText) ||
    (typeof seekdeepNormalizeUserTextSafeV12 === 'function' && seekdeepNormalizeUserTextSafeV12) ||
    ((value = '') => String(value || '').replace(/\\s+/g, ' ').trim());

  const cleanPrompt = normalizer(prompt || '');

  let recent = '';
  try {
    if (typeof seekdeepGetRecentContextSafeV13 === 'function') {
      recent = seekdeepGetRecentContextSafeV13(key);
    } else if (typeof getRecentContext === 'function') {
      recent = getRecentContext(key);
    }
  } catch {
    recent = '';
  }

  let shouldUse = false;
  try {
    if (typeof seekdeepShouldUseMemorySafeV13 === 'function') {
      shouldUse = !!seekdeepShouldUseMemorySafeV13(cleanPrompt);
    } else if (typeof shouldUseMemory === 'function') {
      shouldUse = !!shouldUseMemory(cleanPrompt);
    }
  } catch {
    shouldUse = false;
  }

  if (!recent || !shouldUse) return cleanPrompt;

  return [
    'Recent Discord context is provided only to resolve this follow-up.',
    'Use it only if it is directly relevant to the current user message.',
    'If the current user message has clearly changed topic, ignore old context.',
    'Do not prefix your answer with "SeekDeep:" or "Assistant:".',
    '',
    recent,
    '',
    'Current user message: ' + cleanPrompt,
  ].join('\\n');
}
// SEEKDEEP_BUILD_PROMPT_WITH_MEMORY_SAFE_V14_END
`;

  const anchors = [
    '// SEEKDEEP_MEMORY_COMPAT_REPAIR_V13_START',
    "client.on('messageCreate'",
    'function seekdeepLogRoute(route',
  ];

  let inserted = false;
  for (const anchor of anchors) {
    const idx = text.indexOf(anchor);
    if (idx >= 0) {
      text = text.slice(0, idx) + block + '\n' + text.slice(idx);
      changes.push('inserted buildPromptWithMemory safety wrapper');
      inserted = true;
      break;
    }
  }

  if (!inserted) {
    throw new Error('Could not find a safe insertion anchor for buildPromptWithMemory safety wrapper.');
  }
} else {
  changes.push('buildPromptWithMemory safety wrapper already present');
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
  Write-Host "- Fixes ReferenceError: buildPromptWithMemory is not defined."
  Write-Host "- Adds a safe buildPromptWithMemory wrapper that falls back to the repaired memory helpers from v13."
  Write-Host "- Rewrites direct buildPromptWithMemory(...) callsites to the safe wrapper so show me / vision / follow-up chat no longer crash if the original function drifted out."
} catch {
  Write-Host ""
  Write-Host "Patch failed. Restoring backup..."
  Copy-Item $IndexBackupPath $IndexPath -Force
  Write-Host "Restored: $IndexBackupPath"
  throw
}
