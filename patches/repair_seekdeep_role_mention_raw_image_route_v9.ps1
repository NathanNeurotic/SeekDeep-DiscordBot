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
$IndexBackupPath = Join-Path $BackupsDir "index.js.before-role-mention-raw-image-route-v9-$Stamp.bak"
$PatchJsPath = Join-Path $PatchesDir "apply_role_mention_raw_image_route_v9_$Stamp.cjs"

Copy-Item $IndexPath $IndexBackupPath -Force
Write-Host "Backup created: $IndexBackupPath"

@'

const fs = require('fs');
const path = require('path');

const indexPath = path.join(process.cwd(), 'index.js');
let source = fs.readFileSync(indexPath, 'utf8');
let out = source;
const changes = [];

const marker = '    // SEEKDEEP_RAW_IMAGE_MESSAGE_ROUTE_START';
const markerIndex = out.indexOf(marker);
if (markerIndex < 0) {
  throw new Error('Could not find SEEKDEEP_RAW_IMAGE_MESSAGE_ROUTE_START marker.');
}

if (!out.includes('SEEKDEEP_ROLE_MENTION_RAW_IMAGE_ROUTE_V9_START')) {
  const insertAfter = out.indexOf('\n', markerIndex);
  if (insertAfter < 0) throw new Error('Could not find newline after raw image route marker.');

  const routePromptBlock = [
'    // SEEKDEEP_ROLE_MENTION_RAW_IMAGE_ROUTE_V9_START',
"    const seekdeepRawImageRoutePrompt = typeof seekdeepStripCommandAddressingForRouting === 'function'",
'      ? seekdeepStripCommandAddressingForRouting(prompt)',
"      : (typeof seekdeepCleanMessageCommandPrompt === 'function' ? seekdeepCleanMessageCommandPrompt(prompt) : normalizeUserText(prompt));",
'    // SEEKDEEP_ROLE_MENTION_RAW_IMAGE_ROUTE_V9_END'
  ].join('\n');

  out = out.slice(0, insertAfter + 1) + routePromptBlock + '\n' + out.slice(insertAfter + 1);
  changes.push('inserted sanitized raw-image route prompt');
}

// Replace only the first if-line after the marker. This is deliberately local to the raw-image route block.
let rawBlockStart = out.indexOf(marker);
let ifStart = out.indexOf('    if (seekdeepForceImageFromReplyContext', rawBlockStart);
if (ifStart < 0) {
  throw new Error('Could not find raw-image route if condition after marker.');
}
let ifEnd = out.indexOf('\n', ifStart);
if (ifEnd < 0) throw new Error('Could not find end of raw-image route if condition line.');

const oldIfLine = out.slice(ifStart, ifEnd);
const newIfLine = "    if (seekdeepForceImageFromReplyContext || (!seekdeepShouldKeepPromptAsChatBeforeImage(seekdeepRawImageRoutePrompt) && ((typeof seekdeepIsGenericImageFollowupPrompt === 'function' && seekdeepIsGenericImageFollowupPrompt(seekdeepRawImageRoutePrompt)) || (typeof seekdeepLooksLikeShortNamedVisualSubject === 'function' && seekdeepLooksLikeShortNamedVisualSubject(seekdeepRawImageRoutePrompt)) || isNaturalImagePrompt(seekdeepRawImageRoutePrompt)))) {";
if (oldIfLine !== newIfLine) {
  out = out.slice(0, ifStart) + newIfLine + out.slice(ifEnd);
  changes.push('changed raw-image route condition to use sanitized prompt');
}

// Restrict following replacements to the raw image route block before research hook.
rawBlockStart = out.indexOf(marker);
let rawBlockEnd = out.indexOf('    // SEEKDEEP_RESEARCH_TABLE_MESSAGE_HOOK_START', rawBlockStart);
if (rawBlockEnd < 0) {
  rawBlockEnd = out.indexOf("    seekdeepLogRoute('chat'", rawBlockStart);
}
if (rawBlockEnd < 0) throw new Error('Could not find end of raw-image route block.');

let before = out.slice(0, rawBlockStart);
let block = out.slice(rawBlockStart, rawBlockEnd);
let after = out.slice(rawBlockEnd);

function replaceInBlock(label, find, replace) {
  if (block.includes(find)) {
    block = block.split(find).join(replace);
    changes.push(label);
  }
}

replaceInBlock(
  'image-intent-rule log uses sanitized prompt',
  "if (seekdeepLooksLikeVisualRequest(prompt)) seekdeepLogRoute('image-intent-rule', prompt);",
  "if (seekdeepLooksLikeVisualRequest(seekdeepRawImageRoutePrompt)) seekdeepLogRoute('image-intent-rule', seekdeepRawImageRoutePrompt);"
);

replaceInBlock(
  'image mode options use sanitized prompt',
  '? seekdeepImageModeOptionsFromPrompt(prompt)',
  '? seekdeepImageModeOptionsFromPrompt(seekdeepRawImageRoutePrompt)'
);

replaceInBlock(
  'image extraction uses sanitized prompt',
  "const imagePrompt = (typeof seekdeepExtractImagePrompt === 'function' ? seekdeepExtractImagePrompt(prompt) : prompt) || seekdeepMessageImageModeOptions.cleanPrompt || prompt;",
  "const imagePrompt = (typeof seekdeepExtractImagePrompt === 'function' ? seekdeepExtractImagePrompt(seekdeepRawImageRoutePrompt) : seekdeepRawImageRoutePrompt) || seekdeepMessageImageModeOptions.cleanPrompt || seekdeepRawImageRoutePrompt;"
);

replaceInBlock(
  'natural-image memory records sanitized prompt',
  "remember(key, 'user', `[natural-image] ${prompt}`);",
  "remember(key, 'user', `[natural-image] ${seekdeepRawImageRoutePrompt}`);"
);

out = before + block + after;

if (out === source) {
  throw new Error('Patch made no changes; refusing to continue.');
}

fs.writeFileSync(indexPath, out, 'utf8');
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
  Write-Host "- The raw image message route now strips leading bot user/role mentions before deciding chat vs image."
  Write-Host "- @SeekDeep draw me a goomba should route=image, not route=chat."
  Write-Host "- @SeekDeep generate a goomba should route=image, not route=chat."
  Write-Host "- Extracted image prompts should be clean, e.g. 'a goomba'."
} catch {
  Write-Host ""
  Write-Host "Patch failed. Restoring backup..."
  Copy-Item $IndexBackupPath $IndexPath -Force
  Write-Host "Restored: $IndexBackupPath"
  throw
}
