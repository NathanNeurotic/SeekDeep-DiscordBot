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
$IndexBackupPath = Join-Path $BackupsDir "index.js.before-generate-role-mention-route-v7-$Stamp.bak"
$PatchJsPath = Join-Path $PatchesDir "apply_generate_role_mention_route_v7_$Stamp.cjs"

Copy-Item $IndexPath $IndexBackupPath -Force
Write-Host "Backup created: $IndexBackupPath"

@'

const fs = require('fs');
const path = require('path');

const indexPath = path.join(process.cwd(), 'index.js');
let source = fs.readFileSync(indexPath, 'utf8');
let out = source;
const changes = [];

function findBalancedEnd(src, openIndex, openChar, closeChar) {
  let i = openIndex, depth = 0, state = 'code';
  while (i < src.length) {
    const ch = src[i], next = src[i + 1];
    if (state === 'code') {
      if (ch === openChar) depth += 1;
      else if (ch === closeChar) {
        depth -= 1;
        if (depth === 0) return i;
      } else if (ch === "'") state = 'single';
      else if (ch === '"') state = 'double';
      else if (ch === '`') state = 'template';
      else if (ch === '/' && next === '/') { state = 'linecomment'; i += 1; }
      else if (ch === '/' && next === '*') { state = 'blockcomment'; i += 1; }
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
      if (ch === '*' && next === '/') { state = 'code'; i += 1; }
    }
    i += 1;
  }
  return -1;
}

function findFunctionRange(src, functionName) {
  const re = new RegExp('(?:async\\s+)?function\\s+' + functionName + '\\s*\\(', 'm');
  const match = re.exec(src);
  if (!match) throw new Error('Could not find function ' + functionName);

  const start = match.index;
  const braceStart = src.indexOf('{', match.index + match[0].length - 1);
  if (braceStart < 0) throw new Error('Could not find opening brace for ' + functionName);

  const endBrace = findBalancedEnd(src, braceStart, '{', '}');
  if (endBrace < 0) throw new Error('Could not find end of function ' + functionName);

  return { start, end: endBrace + 1 };
}

function replaceFunction(functionName, replacement) {
  const range = findFunctionRange(out, functionName);
  out = out.slice(0, range.start) + replacement + out.slice(range.end);
  changes.push('replaced ' + functionName);
}

function patchFunction(functionName, patcher) {
  const range = findFunctionRange(out, functionName);
  const oldText = out.slice(range.start, range.end);
  const newText = patcher(oldText);
  if (newText === oldText) {
    throw new Error('No changes made inside ' + functionName);
  }
  out = out.slice(0, range.start) + newText + out.slice(range.end);
  changes.push('patched ' + functionName);
}

function insertAfterFunction(functionName, block, markerText) {
  if (out.includes(markerText)) {
    changes.push(markerText + ' already present');
    return;
  }
  const range = findFunctionRange(out, functionName);
  out = out.slice(0, range.end) + '\n\n' + block + out.slice(range.end);
  changes.push('inserted ' + markerText);
}

const normalizerBlock = [
"// SEEKDEEP_COMMAND_ADDRESSING_NORMALIZER_START",
"function seekdeepStripCommandAddressingForRouting(value = '') {",
"  return normalizeUserText(value)",
"    .replace(/^(?:\\s*(?:<@(?:!|&)?\\d+>|@seekdeep|@seekotics|seekdeep|seekotics)\\s*)+/i, ' ')",
"    .replace(/^[@/\\s]+/g, ' ')",
"    .replace(/\\s+/g, ' ')",
"    .trim();",
"}",
"// SEEKDEEP_COMMAND_ADDRESSING_NORMALIZER_END"
].join('\n');

insertAfterFunction('seekdeepLooksLikeVisionPrompt', normalizerBlock, 'SEEKDEEP_COMMAND_ADDRESSING_NORMALIZER_START');

patchFunction('seekdeepHasExplicitImageRequest', (fn) => {
  let patched = fn.replace(
    /const text = normalizeUserText\(p\)\.toLowerCase\(\)\.trim\(\);/,
    "const text = seekdeepStripCommandAddressingForRouting(p).toLowerCase().trim();"
  );
  patched = patched.replace(
    /const text = normalizeUserText\(p \|\| ''\)\.toLowerCase\(\)\.trim\(\);/,
    "const text = seekdeepStripCommandAddressingForRouting(p).toLowerCase().trim();"
  );
  return patched;
});

patchFunction('seekdeepLooksLikeImagePrompt', (fn) => {
  let patched = fn.replace(
    /const p = normalizeUserText\(text\)\.toLowerCase\(\)\.trim\(\);/,
    "const p = seekdeepStripCommandAddressingForRouting(text).toLowerCase().trim();"
  );
  patched = patched.replace(
    /const p = normalizeUserText\(text \|\| ''\)\.toLowerCase\(\)\.trim\(\);/,
    "const p = seekdeepStripCommandAddressingForRouting(text).toLowerCase().trim();"
  );
  return patched;
});

replaceFunction('seekdeepExtractImagePrompt', [
"function seekdeepExtractImagePrompt(text = '') {",
"  // SEEKDEEP_RAW_IMAGE_EXTRACT_CLEAN_START",
"  let t = seekdeepCleanImageModeTokens(text);",
"  // SEEKDEEP_RAW_IMAGE_EXTRACT_CLEAN_END",
"",
"  t = String(t || '')",
"    .replace(/^(?:\\s*(?:<@(?:!|&)?\\d+>|@seekdeep|@seekotics|seekdeep|seekotics)\\s*)+/i, ' ')",
"    .replace(/<@(?:!|&)?\\d+>/g, ' ')",
"    .replace(/\\s+/g, ' ')",
"    .trim();",
"  t = t.replace(/^(?:hey|yo|hi|hello)\\s+/i, '');",
"  t = t.replace(/^(?:seekdeep|seekotics|neurabot|plugtalk)[,:]?\\s+/i, '');",
"  t = t.replace(/^(?:please\\s+)?(?:can you|could you|would you)\\s+/i, '');",
"  t = t.replace(/^(?:please\\s+)?(?:show\\s+me|make\\s+me|generate|create|draw\\s+me|draw|sketch|render|paint|illustrate|design)\\s+(?:(?:for\\s+)?me\\s+)?/i, '');",
"  t = t.replace(/^(?:an?\\s+|the\\s+|some\\s+)?(?:image|picture|photo|pic|art|artwork|drawing|wallpaper|banner|logo|icon|poster|portrait)\\s+(?:of|for)\\s+/i, '');",
"  t = t.replace(/^(?:i need|need|i want|want)\\s+(?:an?\\s+|some\\s+)?(?:image|picture|photo|pic|art|artwork|drawing|wallpaper|banner|logo|icon|poster|portrait)?\\s*(?:of|for)?\\s*/i, '');",
"  t = t.replace(/\\s+/g, ' ').trim();",
"  // SEEKDEEP_OBJECT_ACCURACY_EXTRACT_NORMALIZE",
"  t = seekdeepNormalizeObjectAccuracyPrompt(t);",
"",
"  return t;",
"}"
].join('\n'));

patchFunction('seekdeepHasVisualSubjectWords', (fn) => {
  if (/\bgoomba\b/i.test(fn)) return fn.replace(/\|marijuana\)/, '|marijuana|goomba|mario|mushroom)');
  return fn.replace(/\|marijuana\)/, '|marijuana|goomba|mario|mushroom)');
});

if (out.includes('function seekdeepIsDirectImageAliasPrompt')) {
  try {
    patchFunction('seekdeepIsDirectImageAliasPrompt', (fn) => {
      return fn.replace(
        /const p = normalizeUserText\(prompt\)\.trim\(\);/,
        "const p = seekdeepStripCommandAddressingForRouting(prompt).trim();"
      );
    });
  } catch (err) {
    changes.push('skipped optional seekdeepIsDirectImageAliasPrompt patch: ' + err.message);
  }
}

if (out.includes('function seekdeepStripDirectImageVerb')) {
  try {
    patchFunction('seekdeepStripDirectImageVerb', (fn) => {
      return fn.replace(
        /return normalizeUserText\(prompt\)/,
        "return seekdeepStripCommandAddressingForRouting(prompt)"
      );
    });
  } catch (err) {
    changes.push('skipped optional seekdeepStripDirectImageVerb patch: ' + err.message);
  }
}

if (out === source) throw new Error('Patch made no changes; refusing to continue.');

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
  Write-Host "- Leading Discord role mentions are stripped before image routing."
  Write-Host "- @SeekDeep generate a goomba should route to image, not Qwen chat."
  Write-Host "- @SeekDeep draw me a goomba should keep working."
  Write-Host "- The final image prompt should become a goomba instead of @SeekDeep draw me a goomba."
} catch {
  Write-Host ""
  Write-Host "Patch failed. Restoring backup..."
  Copy-Item $IndexBackupPath $IndexPath -Force
  Write-Host "Restored: $IndexBackupPath"
  throw
}
