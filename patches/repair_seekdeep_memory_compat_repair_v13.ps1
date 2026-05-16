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
$IndexBackupPath = Join-Path $BackupsDir "index.js.before-memory-compat-repair-v13-$Stamp.bak"
$PatchJsPath = Join-Path $PatchesDir "apply_memory_compat_repair_v13_$Stamp.cjs"

Copy-Item $IndexPath $IndexBackupPath -Force
Write-Host "Backup created: $IndexBackupPath"

@'
const fs = require('fs');
const path = require('path');

const indexPath = path.join(process.cwd(), 'index.js');
let source = fs.readFileSync(indexPath, 'utf8');
let text = source;
const changes = [];

function replaceBareCalls(src, originalName, replacementName) {
  const re = new RegExp(`\\b${originalName}\\s*\\(`, 'g');
  let count = 0;

  const out = src.replace(re, (match, offset) => {
    const before = src.slice(Math.max(0, offset - 64), offset);

    // Do not rename the original function declaration if it still exists.
    if (/\bfunction\s+$/.test(before)) return match;

    // Do not touch methods/properties: obj.remember(...)
    const previousChar = src[offset - 1] || '';
    if (previousChar === '.' || previousChar === '$' || /[A-Za-z0-9_]/.test(previousChar)) return match;

    count += 1;
    return `${replacementName}(`;
  });

  if (count > 0) changes.push(`replaced ${count} ${originalName}(...) callsite(s) with ${replacementName}(...)`);
  return out;
}

// Replace callsites first, before inserting the compatibility helpers.
text = replaceBareCalls(text, 'memoryKeyFrom', 'seekdeepMemoryKeyFromSafeV13');
text = replaceBareCalls(text, 'remember', 'seekdeepRememberSafeV13');
text = replaceBareCalls(text, 'getRecentContext', 'seekdeepGetRecentContextSafeV13');
text = replaceBareCalls(text, 'shouldUseMemory', 'seekdeepShouldUseMemorySafeV13');

const helperMarker = '// SEEKDEEP_MEMORY_COMPAT_REPAIR_V13_START';
if (!text.includes(helperMarker)) {
  const helperBlock = `
// SEEKDEEP_MEMORY_COMPAT_REPAIR_V13_START
const SEEKDEEP_MEMORY_COMPAT_STORE_V13 = globalThis.__seekdeepMemoryCompatStoreV13 || new Map();
globalThis.__seekdeepMemoryCompatStoreV13 = SEEKDEEP_MEMORY_COMPAT_STORE_V13;

function seekdeepMemoryNormalizeSafeV13(value = '') {
  if (typeof normalizeUserText === 'function') return normalizeUserText(value);
  if (typeof seekdeepNormalizeUserTextSafeV12 === 'function') return seekdeepNormalizeUserTextSafeV12(value);
  return String(value || '').replace(/\\s+/g, ' ').trim();
}

function seekdeepMemoryKeyFromSafeV13(source) {
  try {
    if (typeof memoryKeyFrom === 'function') return memoryKeyFrom(source);
  } catch {}

  if (!source) return 'global';
  if (source.channelId) return 'channel:' + source.channelId;
  if (source.channel?.id) return 'channel:' + source.channel.id;
  if (source.channel_id) return 'channel:' + source.channel_id;
  if (source.channelID) return 'channel:' + source.channelID;
  return 'global';
}

function seekdeepRememberSafeV13(key, role, value) {
  try {
    if (typeof remember === 'function') return remember(key, role, value);
  } catch {}

  const clean = seekdeepMemoryNormalizeSafeV13(value || '');
  if (!key || !clean) return;

  const maxEntries = Math.max(4, Number(typeof MAX_MEMORY_ENTRIES !== 'undefined' ? MAX_MEMORY_ENTRIES : process.env.MAX_CONTEXT_MESSAGES || 14));
  const maxChars = Math.max(1000, Number(typeof MAX_MEMORY_CHARS !== 'undefined' ? MAX_MEMORY_CHARS : process.env.MAX_CONTEXT_CHARS || 6500));

  const existing = SEEKDEEP_MEMORY_COMPAT_STORE_V13.get(key) || [];
  existing.push({
    role: role === 'assistant' ? 'assistant' : 'user',
    text: clean.slice(0, 1800),
    at: Date.now(),
  });

  let trimmed = existing.slice(-maxEntries);
  while (trimmed.map((entry) => entry.text).join('\\n').length > maxChars && trimmed.length > 4) {
    trimmed = trimmed.slice(1);
  }

  SEEKDEEP_MEMORY_COMPAT_STORE_V13.set(key, trimmed);
}

function seekdeepGetRecentContextSafeV13(key) {
  try {
    if (typeof getRecentContext === 'function') return getRecentContext(key);
  } catch {}

  const entries = (SEEKDEEP_MEMORY_COMPAT_STORE_V13.get(key) || []).slice(-8);
  if (!entries.length) return '';

  return entries
    .map((entry) => {
      const clean = String(entry.text || '')
        .replace(/\\nSources:\\n[\\s\\S]*$/i, '')
        .slice(0, 900);
      return (entry.role === 'assistant' ? 'Assistant' : 'User') + ': ' + clean;
    })
    .join('\\n');
}

function seekdeepShouldUseMemorySafeV13(prompt = '') {
  try {
    if (typeof shouldUseMemory === 'function') return shouldUseMemory(prompt);
  } catch {}

  const p = seekdeepMemoryNormalizeSafeV13(prompt).toLowerCase().trim();
  if (!p) return false;

  if (/^(?:what would be a .*nickname\\b|what is a .*nickname\\b|give me .*nickname\\b|what should i call you\\b|who are you\\b|what can you do\\b)/i.test(p)) {
    return false;
  }

  const words = p.split(/\\s+/).filter(Boolean);
  if (words.length <= 2) return true;
  return /\\b(?:it|that|this|those|these|again|same|previous|earlier|continue|redo|more|less|make it|change it|fix it|refine it)\\b/i.test(p);
}
// SEEKDEEP_MEMORY_COMPAT_REPAIR_V13_END
`;

  const anchors = [
    "client.on('messageCreate'",
    '// SEEKDEEP_NORMALIZE_USER_TEXT_SAFE_V12_START',
    'function seekdeepLogRoute(route',
  ];

  let inserted = false;
  for (const anchor of anchors) {
    const idx = text.indexOf(anchor);
    if (idx >= 0) {
      text = text.slice(0, idx) + helperBlock + '\n' + text.slice(idx);
      changes.push('inserted memory compatibility helpers');
      inserted = true;
      break;
    }
  }

  if (!inserted) {
    throw new Error('Could not find a safe insertion anchor for memory compatibility helpers.');
  }
} else {
  changes.push('memory compatibility helpers already present');
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
  Write-Host "- Fixes ReferenceError: memoryKeyFrom is not defined."
  Write-Host "- Adds safe fallback memory helpers for memoryKeyFrom, remember, getRecentContext, and shouldUseMemory."
  Write-Host "- Rewrites direct memory helper callsites to safe wrappers so status/help/image routing does not crash if the old memory block drifted."
} catch {
  Write-Host ""
  Write-Host "Patch failed. Restoring backup..."
  Copy-Item $IndexBackupPath $IndexPath -Force
  Write-Host "Restored: $IndexBackupPath"
  throw
}
