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
$IndexBackupPath = Join-Path $BackupsDir "index.js.before-normalize-user-text-repair-v12-$Stamp.bak"
$PatchJsPath = Join-Path $PatchesDir "apply_normalize_user_text_repair_v12_$Stamp.cjs"

Copy-Item $IndexPath $IndexBackupPath -Force
Write-Host "Backup created: $IndexBackupPath"

@'
const fs = require('fs');
const path = require('path');

const indexPath = path.join(process.cwd(), 'index.js');
let source = fs.readFileSync(indexPath, 'utf8');
let text = source;
const changes = [];

function hasTopLevelNormalizeUserText(src) {
  return /\bfunction\s+normalizeUserText\s*\(/.test(src) ||
    /\b(?:const|let|var)\s+normalizeUserText\s*=/.test(src);
}

if (!hasTopLevelNormalizeUserText(text)) {
  const fallback = `
// SEEKDEEP_NORMALIZE_USER_TEXT_REPAIR_V12_START
function normalizeUserText(text = '') {
  return String(text || '')
    .replace(/\\bhteir\\b/gi, 'their')
    .replace(/\\btehir\\b/gi, 'their')
    .replace(/\\byoou\\b/gi, 'you')
    .replace(/\\bhae\\b/gi, 'have')
    .replace(/\\bcna'th\\b/gi, "can't")
    .replace(/\\s+/g, ' ')
    .trim();
}
// SEEKDEEP_NORMALIZE_USER_TEXT_REPAIR_V12_END
`;

  const anchors = [
    'const CHANNEL_MEMORY = new Map();',
    'function stripBotMentions(content) {',
    'function clampText(text, limit = MAX_DISCORD_CHARS) {',
  ];

  let inserted = false;
  for (const anchor of anchors) {
    const idx = text.indexOf(anchor);
    if (idx >= 0) {
      text = text.slice(0, idx) + fallback + '\n' + text.slice(idx);
      inserted = true;
      changes.push('inserted missing normalizeUserText fallback');
      break;
    }
  }

  if (!inserted) {
    throw new Error('normalizeUserText is missing, but no safe insertion anchor was found.');
  }
} else {
  changes.push('normalizeUserText definition already exists; no fallback inserted');
}

// Make stripBotMentions role-safe without depending on later helpers.
function findFunctionRange(src, functionName) {
  const signatures = [
    `function ${functionName}(`,
    `async function ${functionName}(`,
  ];

  let start = -1;
  for (const sig of signatures) {
    const idx = src.indexOf(sig);
    if (idx >= 0) {
      start = idx;
      break;
    }
  }

  if (start < 0) return null;

  const braceStart = src.indexOf('{', start);
  if (braceStart < 0) throw new Error(`Could not find opening brace for ${functionName}`);

  let depth = 0;
  let inSingle = false;
  let inDouble = false;
  let inTemplate = false;
  let inLineComment = false;
  let inBlockComment = false;
  let escaped = false;

  for (let i = braceStart; i < src.length; i += 1) {
    const ch = src[i];
    const next = src[i + 1];

    if (inLineComment) {
      if (ch === '\n') inLineComment = false;
      continue;
    }

    if (inBlockComment) {
      if (ch === '*' && next === '/') {
        inBlockComment = false;
        i += 1;
      }
      continue;
    }

    if (inSingle) {
      if (!escaped && ch === "'") inSingle = false;
      escaped = !escaped && ch === '\\';
      continue;
    }

    if (inDouble) {
      if (!escaped && ch === '"') inDouble = false;
      escaped = !escaped && ch === '\\';
      continue;
    }

    if (inTemplate) {
      if (!escaped && ch === '`') inTemplate = false;
      escaped = !escaped && ch === '\\';
      continue;
    }

    if (ch === '/' && next === '/') {
      inLineComment = true;
      i += 1;
      continue;
    }

    if (ch === '/' && next === '*') {
      inBlockComment = true;
      i += 1;
      continue;
    }

    if (ch === "'") {
      inSingle = true;
      escaped = false;
      continue;
    }

    if (ch === '"') {
      inDouble = true;
      escaped = false;
      continue;
    }

    if (ch === '`') {
      inTemplate = true;
      escaped = false;
      continue;
    }

    if (ch === '{') depth += 1;
    if (ch === '}') {
      depth -= 1;
      if (depth === 0) return { start, end: i + 1 };
    }
  }

  throw new Error(`Could not find closing brace for ${functionName}`);
}

const stripRange = findFunctionRange(text, 'stripBotMentions');
if (stripRange) {
  const replacement = `function stripBotMentions(content) {
  const text = String(content || '');
  const botId = String(client?.user?.id || '').trim();

  return text
    .replace(botId ? new RegExp('<@!?' + botId + '>', 'g') : /$^/, ' ')
    .replace(/<@&\\d+>/g, ' ')
    .replace(/^\\s*@?(?:seekdeep|seekotics)\\b[,:-]?\\s*/i, ' ')
    .replace(/\\s+/g, ' ')
    .trim();
}`;

  const current = text.slice(stripRange.start, stripRange.end);
  if (current !== replacement) {
    text = text.slice(0, stripRange.start) + replacement + text.slice(stripRange.end);
    changes.push('replaced stripBotMentions with role-safe implementation');
  } else {
    changes.push('stripBotMentions already role-safe');
  }
} else {
  changes.push('stripBotMentions not found; normalizeUserText repair still applied');
}

// Belt-and-suspenders: if the message handler still has a direct normalizeUserText(stripBotMentions(...))
// use a tiny local fallback wrapper at the call site. This prevents another hard crash if a future edit
// shadows/removes normalizeUserText again.
if (!text.includes('function seekdeepNormalizeUserTextSafeV12(')) {
  const helper = `
// SEEKDEEP_NORMALIZE_USER_TEXT_SAFE_V12_START
function seekdeepNormalizeUserTextSafeV12(value = '') {
  if (typeof normalizeUserText === 'function') return normalizeUserText(value);
  return String(value || '').replace(/\\s+/g, ' ').trim();
}
// SEEKDEEP_NORMALIZE_USER_TEXT_SAFE_V12_END
`;

  const idx = text.indexOf("client.on('messageCreate'");
  if (idx >= 0) {
    text = text.slice(0, idx) + helper + '\n' + text.slice(idx);
    changes.push('inserted normalizeUserText safe wrapper');
  } else {
    changes.push('messageCreate anchor not found; safe wrapper not inserted');
  }
}

const directCall = 'let prompt = normalizeUserText(stripBotMentions(message.content));';
if (text.includes(directCall)) {
  text = text.replace(directCall, 'let prompt = seekdeepNormalizeUserTextSafeV12(stripBotMentions(message.content));');
  changes.push('replaced message handler direct normalizeUserText call');
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
  Write-Host "- Restores normalizeUserText if it was accidentally removed or scoped away."
  Write-Host "- Message routing no longer crashes with ReferenceError: normalizeUserText is not defined."
  Write-Host "- stripBotMentions remains role-mention-safe for @SeekDeep role pings."
} catch {
  Write-Host ""
  Write-Host "Patch failed. Restoring backup..."
  Copy-Item $IndexBackupPath $IndexPath -Force
  Write-Host "Restored: $IndexBackupPath"
  throw
}
