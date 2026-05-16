$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$ProjectRoot = (Get-Location).Path
$IndexPath = Join-Path $ProjectRoot 'index.js'
$PythonPath = Join-Path $ProjectRoot '.venv\Scripts\python.exe'
$LocalAiPath = Join-Path $ProjectRoot 'local_ai_server.py'
$BackupsDir = Join-Path $ProjectRoot 'backups'
$PatchesDir = Join-Path $ProjectRoot 'patches'

if (-not (Test-Path $IndexPath)) {
  throw "index.js not found at $IndexPath. Run this from the SeekDeep project root."
}

New-Item -ItemType Directory -Path $BackupsDir -Force | Out-Null
New-Item -ItemType Directory -Path $PatchesDir -Force | Out-Null

$Stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$BackupPath = Join-Path $BackupsDir "index.js.before-archive-for-alias-v2-$Stamp.bak"
$PatchJsPath = Join-Path $PatchesDir "apply_archive_for_alias_v2_$Stamp.cjs"

Copy-Item $IndexPath $BackupPath -Force
Write-Host "Backup created: $BackupPath"

try {
@'
const fs = require('fs');
const path = require('path');

const indexPath = path.join(process.cwd(), 'index.js');
let source = fs.readFileSync(indexPath, 'utf8');

function findFunctionRange(src, functionName) {
  const signature = `function ${functionName}`;
  const start = src.indexOf(signature);
  if (start === -1) throw new Error(`Could not find ${signature}`);

  const braceStart = src.indexOf('{', start);
  if (braceStart === -1) throw new Error(`Could not find opening brace for ${functionName}`);

  let depth = 0;
  let state = 'code';

  for (let i = braceStart; i < src.length; i += 1) {
    const ch = src[i];
    const next = src[i + 1];

    if (state === 'code') {
      if (ch === '{') {
        depth += 1;
      } else if (ch === '}') {
        depth -= 1;
        if (depth === 0) return { start, end: i + 1 };
      } else if (ch === "'") {
        state = 'single';
      } else if (ch === '"') {
        state = 'double';
      } else if (ch === '`') {
        state = 'template';
      } else if (ch === '/' && next === '/') {
        state = 'linecomment';
        i += 1;
      } else if (ch === '/' && next === '*') {
        state = 'blockcomment';
        i += 1;
      }
    } else if (state === 'single') {
      if (ch === '\\') i += 1;
      else if (ch === "'") state = 'code';
    } else if (state === 'double') {
      if (ch === '\\') i += 1;
      else if (ch === '"') state = 'code';
    } else if (state === 'template') {
      if (ch === '\\') i += 1;
      else if (ch === '`') state = 'code';
    } else if (state === 'linecomment') {
      if (ch === '\n') state = 'code';
    } else if (state === 'blockcomment') {
      if (ch === '*' && next === '/') {
        state = 'code';
        i += 1;
      }
    }
  }

  throw new Error(`Could not find end of function ${functionName}`);
}

function replaceFunction(src, functionName, replacement) {
  const range = findFunctionRange(src, functionName);
  return src.slice(0, range.start) + replacement + src.slice(range.end);
}

const newArchiveOpenPrompt = "function seekdeepIsArchiveOpenPrompt(value = '') {\n  const raw = String(value || '').trim();\n  const stripLeadingArchiveAddress = (input = '') => String(input || '')\n    .replace(/^(?:\\s*(?:<@!?\\d+>|<@&\\d+>|@seekdeep|@seekotics|seekdeep|seekotics)\\s*)+/i, ' ')\n    .replace(/^[/\\s]+/g, ' ')\n    .replace(/\\s+/g, ' ')\n    .trim();\n\n  const withoutLeadingAddress = stripLeadingArchiveAddress(raw);\n  const withoutLeadingAddressLower = withoutLeadingAddress.toLowerCase();\n  const cleanedBase = typeof seekdeepCleanMessageCommandPrompt === 'function'\n    ? seekdeepCleanMessageCommandPrompt(raw)\n    : withoutLeadingAddress;\n  const cleaned = stripLeadingArchiveAddress(cleanedBase).toLowerCase();\n\n  return Boolean(\n    /^(?:archive|open\\s+archive)(?:\\s+for)?\\s+(?:shared|me)$/i.test(cleaned) ||\n    /^(?:archive|open\\s+archive)(?:\\s+for)?\\s+<@!?\\d+>$/i.test(withoutLeadingAddress) ||\n    /^(?:archive|open\\s+archive)(?:\\s+for)?\\s+@/i.test(withoutLeadingAddressLower)\n  );\n}";
const newArchiveOpenHandler = "async function seekdeepHandleArchiveOpenMessage(message, prompt = '') {\n  if (!message || !seekdeepIsArchiveOpenPrompt(prompt || message.content || '')) return false;\n\n  if (!message.guild) {\n    await message.reply({\n      content: 'Archive threads only work inside a server.',\n      allowedMentions: { repliedUser: false },\n    });\n    return true;\n  }\n\n  const raw = String(prompt || message.content || '');\n  const cleanBase = typeof seekdeepCleanMessageCommandPrompt === 'function'\n    ? seekdeepCleanMessageCommandPrompt(raw)\n    : raw;\n  const clean = String(cleanBase || '')\n    .replace(/^(?:\\s*(?:<@!?\\d+>|<@&\\d+>|@seekdeep|@seekotics|seekdeep|seekotics)\\s*)+/i, ' ')\n    .replace(/\\s+/g, ' ')\n    .trim()\n    .toLowerCase();\n\n  if (typeof seekdeepLogRoute === 'function') {\n    seekdeepLogRoute('archive-open-message', raw);\n  }\n\n  if (/\\bshared\\b/i.test(clean)) {\n    const { thread } = await seekdeepGetOrCreateSharedArchiveThread(message);\n    await message.reply({\n      content: `Shared archive: <#${thread.id}>`,\n      allowedMentions: { repliedUser: false },\n    });\n    return true;\n  }\n\n  let targetUser = message.author;\n  const selfUserId = message.client?.user?.id || null;\n  const mentionedUsers = Array.from(message.mentions?.users?.values?.() || []);\n  const mentioned = mentionedUsers.find((user) => user && user.id !== selfUserId) || null;\n\n  if (mentioned) {\n    targetUser = mentioned;\n  } else if (!/\\bme\\b/i.test(clean)) {\n    await message.reply({\n      content: 'Use `archive me`, `archive shared`, `archive @user`, or `archive for @user`.',\n      allowedMentions: { repliedUser: false },\n    });\n    return true;\n  }\n\n  const { thread, threadName } = await seekdeepGetOrCreateUserArchiveThread(message, targetUser);\n\n  await message.reply({\n    content: [\n      mentioned ? `Archive for <@${targetUser.id}>: <#${thread.id}>` : `Your archive: <#${thread.id}>`,\n      `Thread: ${threadName}`,\n    ].join('\\n'),\n    allowedMentions: { repliedUser: false },\n  });\n\n  return true;\n}";

const before = source;
source = replaceFunction(source, 'seekdeepIsArchiveOpenPrompt', newArchiveOpenPrompt);
source = replaceFunction(source, 'seekdeepHandleArchiveOpenMessage', newArchiveOpenHandler);

if (source === before) {
  throw new Error('Patch made no changes; refusing to continue.');
}

fs.writeFileSync(indexPath, source, 'utf8');
console.log('Patched archive open aliases successfully.');

'@ | Set-Content -Path $PatchJsPath -Encoding UTF8

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

  Write-Host "Patch applied successfully."
} catch {
  Write-Host "Patch failed. Restoring backup..." -ForegroundColor Yellow
  Copy-Item $BackupPath $IndexPath -Force
  Write-Host "Restored: $BackupPath" -ForegroundColor Yellow
  throw
}
