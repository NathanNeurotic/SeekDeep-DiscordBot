$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$ProjectRoot = (Get-Location).Path
$IndexPath = Join-Path $ProjectRoot 'index.js'
$LocalAiPath = Join-Path $ProjectRoot 'local_ai_server.py'
$PythonPath = Join-Path $ProjectRoot '.venv\Scripts\python.exe'
$BackupsDir = Join-Path $ProjectRoot 'backups'
$PatchesDir = Join-Path $ProjectRoot 'patches'

if (-not (Test-Path $IndexPath)) {
  throw "index.js not found at $IndexPath. Run this from the SeekDeep-DiscordBot project root."
}
if (-not (Test-Path $LocalAiPath)) {
  throw "local_ai_server.py not found at $LocalAiPath. Run this from the SeekDeep-DiscordBot project root."
}

New-Item -ItemType Directory -Path $BackupsDir -Force | Out-Null
New-Item -ItemType Directory -Path $PatchesDir -Force | Out-Null

$Stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$IndexBackupPath = Join-Path $BackupsDir "index.js.before-image-route-refine-v3-$Stamp.bak"
$LocalAiBackupPath = Join-Path $BackupsDir "local_ai_server.py.before-image-route-refine-v3-$Stamp.bak"
$PatchJsPath = Join-Path $PatchesDir "apply_image_route_refine_v3_$Stamp.cjs"

Copy-Item $IndexPath $IndexBackupPath -Force
Copy-Item $LocalAiPath $LocalAiBackupPath -Force
Write-Host "Backup created: $IndexBackupPath"
Write-Host "Backup created: $LocalAiBackupPath"

@'
const fs = require('fs');
const path = require('path');

const root = process.cwd();
const indexPath = path.join(root, 'index.js');
const localAiPath = path.join(root, 'local_ai_server.py');

let indexSource = fs.readFileSync(indexPath, 'utf8');
let pySource = fs.readFileSync(localAiPath, 'utf8');
const changes = [];

function findBalancedEnd(src, openIndex, openChar, closeChar) {
  let i = openIndex;
  let depth = 0;
  let state = 'code';

  while (i < src.length) {
    const ch = src[i];
    const next = src[i + 1];

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
  const braceStart = src.indexOf('{', re.lastIndex - 1);
  if (braceStart < 0) throw new Error('Could not find opening brace for ' + functionName);

  const endBrace = findBalancedEnd(src, braceStart, '{', '}');
  if (endBrace < 0) throw new Error('Could not find end of function ' + functionName);
  return { start, end: endBrace + 1 };
}

function replaceFunction(src, functionName, replacement) {
  const range = findFunctionRange(src, functionName);
  changes.push('replaced function ' + functionName);
  return src.slice(0, range.start) + replacement + src.slice(range.end);
}

function insertBeforeFirstExistingMarker(src, markers, block, label) {
  const firstLine = block.split('\n')[0].trim();
  if (firstLine && src.includes(firstLine)) {
    changes.push(label + ' already present');
    return src;
  }

  for (const marker of markers) {
    const idx = src.indexOf(marker);
    if (idx >= 0) {
      changes.push('inserted ' + label);
      return src.slice(0, idx) + block + '\n\n' + src.slice(idx);
    }
  }

  throw new Error('Could not find any insertion marker for ' + label + ': ' + markers.join(' OR '));
}

function addNegativePromptToImagePostLocalPayload(src) {
  if (/negative_prompt:\s*promptInfo\.negativePrompt/.test(src)) {
    changes.push('negative_prompt image payload already present');
    return src;
  }

  const callRegex = /postLocal\s*\(\s*['"]\/image['"]\s*,\s*\{/g;
  const match = callRegex.exec(src);
  if (!match) {
    throw new Error("Could not find postLocal('/image', { payload. Refusing to guess.");
  }

  const objectOpen = src.indexOf('{', match.index);
  if (objectOpen < 0) throw new Error('Could not find opening object brace for /image payload.');
  const objectClose = findBalancedEnd(src, objectOpen, '{', '}');
  if (objectClose < 0) throw new Error('Could not find closing object brace for /image payload.');

  const body = src.slice(objectOpen + 1, objectClose);
  if (/negative_prompt\s*:/.test(body)) {
    changes.push('negative_prompt already present in /image object');
    return src;
  }

  const beforeClose = src.slice(0, objectClose);
  const afterClose = src.slice(objectClose);

  const trimmedBeforeClose = beforeClose.replace(/\s+$/g, '');
  const trailingWhitespace = beforeClose.slice(trimmedBeforeClose.length);
  const needsComma = !trimmedBeforeClose.endsWith('{') && !trimmedBeforeClose.endsWith(',');

  const insertion =
    (needsComma ? ',' : '') +
    '\n    negative_prompt: promptInfo.negativePrompt || process.env.SEEKDEEP_IMAGE_NEGATIVE_PROMPT || process.env.IMAGE_NEGATIVE_PROMPT || \'\',' +
    trailingWhitespace;

  changes.push('added negative_prompt to /image postLocal payload');
  return trimmedBeforeClose + insertion + afterClose;
}

const newPrepareImagePrompt = [
"function seekdeepPrepareImagePrompt(prompt = '') {",
"  prompt = seekdeepGroundBotanicalSlangPrompt(prompt);",
"",
"  const originalPrompt = normalizeUserText(prompt || '').trim() || 'image';",
"  const baseNegative = String(",
"    process.env.SEEKDEEP_IMAGE_NEGATIVE_PROMPT ||",
"    process.env.IMAGE_NEGATIVE_PROMPT ||",
"    'watermark, random text, misspelled text, logo text, blurry, low detail, cluttered background, plastic 3d render, generic stock photo, malformed anatomy, extra fingers, distorted eyes, duplicate face'",
"  ).replace(/\\s+/g, ' ').trim();",
"",
"  const asksText = /\\b(text|words|lettering|title|caption|says|saying|sign|label|typography|font)\\b/i.test(originalPrompt);",
"  const negativePrompt = asksText",
"    ? baseNegative.replace(/\\b(random text|misspelled text|logo text|text)\\b,?\\s*/gi, '').replace(/\\s*,\\s*,+/g, ', ').replace(/^,\\s*|,\\s*$/g, '').trim()",
"    : baseNegative;",
"",
"  if (!SEEKDEEP_IMAGE_PROMPT_REFINEMENT_ENABLED) {",
"    return { originalPrompt, refinedPrompt: originalPrompt, generationPrompt: originalPrompt, negativePrompt, changed: false };",
"  }",
"",
"  const lower = originalPrompt.toLowerCase();",
"  const parts = [originalPrompt];",
"",
"  const hasStyle = /\\b(hyper\\s*realistic|photorealistic|realistic|cinematic|anime|manga|comic|oil painting|oil-painted|watercolor|pixel art|3d|render|illustration|illustrated|stylized|painterly|graphic|vector|logo|icon|poster|album art|wallpaper|sketch|low poly|claymation|stop motion|emo|screamo|hardcore|punk|grunge|zine)\\b/i.test(originalPrompt);",
"  const hasQuality = /\\b(high quality|detailed|sharp|clean|polished|professional|masterpiece|ultra detailed|high detail|hd|4k|8k|coherent|clear)\\b/i.test(originalPrompt);",
"  const hasLighting = /\\b(lighting|lit|glow|shadow|sunset|sunrise|moonlight|neon|ambient|dramatic light|soft light|studio light|rim light|backlit|dusk|twilight)\\b/i.test(originalPrompt);",
"  const hasComposition = /\\b(composition|centered|off center|wide shot|close up|portrait|landscape|symmetrical|asymmetrical|negative space|foreground|background|depth|poster layout|editorial)\\b/i.test(originalPrompt);",
"",
"  if (seekdeepImagePromptHasAny(lower, ['logo', 'icon', 'emblem', 'badge'])) {",
"    if (!hasStyle) seekdeepImagePromptAdd(parts, 'bold emblem design, readable silhouette');",
"    if (!hasComposition) seekdeepImagePromptAdd(parts, 'centered composition, clean negative space');",
"  } else if (seekdeepImagePromptHasAny(lower, ['banner', 'wallpaper', 'cover art', 'album art', 'poster', 'album cover', 'metal', 'rock', 'emo', 'screamo', 'hardcore', 'punk'])) {",
"    if (!hasStyle) seekdeepImagePromptAdd(parts, 'graphic poster art, gritty brushwork');",
"    if (!hasComposition) seekdeepImagePromptAdd(parts, 'bold poster composition, clear focal point');",
"  } else if (/\\b(hyper\\s*realistic|photorealistic|realistic|photo)\\b/i.test(originalPrompt)) {",
"    seekdeepImagePromptAdd(parts, 'believable materials, natural structure');",
"    if (!hasLighting) seekdeepImagePromptAdd(parts, 'realistic lighting, clear depth');",
"  } else if (!hasStyle) {",
"    seekdeepImagePromptAdd(parts, 'stylized illustration');",
"  }",
"",
"  if (seekdeepImagePromptHasAny(lower, ['pepe', 'frog', 'toad', 'cat', 'dog', 'fox', 'animal', 'creature', 'dragon', 'bird', 'horse', 'goomba'])) {",
"    seekdeepImagePromptAdd(parts, 'expressive subject');",
"  }",
"",
"  if (seekdeepImagePromptHasAny(lower, ['sailor moon', 'usagi', 'girl', 'woman', 'boy', 'man', 'person', 'human', 'elf', 'character', 'portrait'])) {",
"    seekdeepImagePromptAdd(parts, 'coherent character design');",
"  }",
"",
"  if (seekdeepImagePromptHasAny(lower, ['plant', 'flower', 'tree', 'forest', 'leaf', 'leaves', 'cannabis', 'marijuana', 'moss', 'fungi', 'onion'])) {",
"    seekdeepImagePromptAdd(parts, 'organic texture, clear botanical forms');",
"  }",
"",
"  if (seekdeepImagePromptHasAny(lower, ['hyrule', 'fantasy kingdom', 'castle', 'wizard', 'dungeon', 'deku', 'queen', 'king', 'royal'])) {",
"    seekdeepImagePromptAdd(parts, 'fantasy atmosphere');",
"  }",
"",
"  if (seekdeepImagePromptHasAny(lower, ['smoking', 'smokin', 'smoke', 'spliff', 'blunt', 'joint', 'cigarette'])) {",
"    seekdeepImagePromptAdd(parts, 'rebellious mood, drifting smoke');",
"  }",
"",
"  if (seekdeepImagePromptHasAny(lower, ['sunset', 'sunrise', 'dusk', 'twilight', 'neon', 'night', 'moonlight', 'balcony', 'city lights', 'bar lights'])) {",
"    seekdeepImagePromptAdd(parts, 'atmospheric lighting');",
"  }",
"",
"  if (!hasQuality) seekdeepImagePromptAdd(parts, 'clear details');",
"",
"  let refinedPrompt = parts.join(', ').replace(/\\s+/g, ' ').trim();",
"  const maxChars = Math.max(160, Number(process.env.SEEKDEEP_IMAGE_PROMPT_MAX_CHARS || 300));",
"  if (refinedPrompt.length > maxChars) refinedPrompt = refinedPrompt.slice(0, maxChars).replace(/[,;:\\s]+$/g, '').trim();",
"",
"  return {",
"    originalPrompt,",
"    refinedPrompt,",
"    generationPrompt: refinedPrompt,",
"    negativePrompt,",
"    changed: refinedPrompt !== originalPrompt,",
"  };",
"}"
].join('\n');

indexSource = replaceFunction(indexSource, 'seekdeepPrepareImagePrompt', newPrepareImagePrompt);

// Make raw/unrefined image requests still carry a negativePrompt field when that old return object exists.
if (!/negativePrompt:\s*process\.env\.SEEKDEEP_IMAGE_NEGATIVE_PROMPT/.test(indexSource)) {
  indexSource = indexSource.replace(
    /(\s+generationPrompt:\s*rawPrompt,\s*\n\s+changed:\s*rawPrompt !== normalizeUserText\(prompt\)\.trim\(\),)/,
    "$1\n      negativePrompt: process.env.SEEKDEEP_IMAGE_NEGATIVE_PROMPT || process.env.IMAGE_NEGATIVE_PROMPT || '',"
  );
}

indexSource = addNegativePromptToImagePostLocalPayload(indexSource);

const directImageHelpers = [
"// SEEKDEEP_DIRECT_IMAGE_ALIAS_ROUTE_START",
"function seekdeepIsBareConfirmationPrompt(prompt = '') {",
"  const p = normalizeUserText(prompt).toLowerCase().trim();",
"  return /^(?:y|yes|yeah|yep|yup|ok|okay|sure|do it|correct|please do|go ahead)$/.test(p);",
"}",
"",
"function seekdeepIsDirectImageAliasPrompt(prompt = '') {",
"  const p = normalizeUserText(prompt).trim();",
"  const lower = p.toLowerCase();",
"  if (!p) return false;",
"",
"  if (seekdeepIsBareConfirmationPrompt(p)) return false;",
"  if (/\\b(help|commands|status|queue status|archive status|cache status|recent images|recent prompts|purge|delete|remove)\\b/i.test(p)) return false;",
"  if (/\\b(list|ideas?|suggestions?|options?|names?|nicknames?|summary|summarize|explain|rewrite|translate|code|script|powershell|javascript|python|logs?|error|bug)\\b/i.test(p)) return false;",
"",
"  if (/^(?:draw|draw me|sketch|sketch me|paint|paint me|render|illustrate|illustrate me|design)\\s+\\S/i.test(lower)) return true;",
"  if (/^(?:generate|create|make)\\s+(?!(?:a\\s+)?(?:list|summary|song|lyrics|description|script|code|function|patch|plan|guide|readme|email|message|reply)\\b)(?:me\\s+)?(?:a\\s+|an\\s+|the\\s+|some\\s+)?\\S/i.test(lower)) return true;",
"  if (/^(?:show me|give me)\\s+(?:a\\s+|an\\s+|the\\s+|some\\s+)?(?:image|picture|photo|pic|art|artwork|drawing|illustration|poster|logo|icon|wallpaper)\\b/i.test(lower)) return true;",
"  if (/^(?:image|picture|photo|pic|art|artwork|drawing|illustration|poster|logo|icon|wallpaper)\\s+(?:of\\s+|for\\s+)?\\S/i.test(lower)) return true;",
"",
"  return false;",
"}",
"// SEEKDEEP_DIRECT_IMAGE_ALIAS_ROUTE_END"
].join('\n');

indexSource = insertBeforeFirstExistingMarker(
  indexSource,
  ['function isNaturalStatusPrompt', 'function seekdeepUtilityPromptKind', 'async function handleMessageCreate'],
  directImageHelpers,
  'direct image alias helpers'
);

const directImageRouteBlock = [
"    // SEEKDEEP_DIRECT_IMAGE_ALIAS_MESSAGE_ROUTE_START",
"    if (typeof seekdeepIsBareConfirmationPrompt === 'function' && seekdeepIsBareConfirmationPrompt(prompt)) {",
"      seekdeepLogRoute('bare-confirmation-local', prompt);",
"      seekdeepSetResponseModel(message, seekdeepNoModelLabel());",
"      await sendLongMessageReply(message, [",
"        'No pending confirmation command is active.',",
"        '',",
"        'Use a full command instead:',",
"        '@SEEKOTICS draw me <image idea>',",
"        '@SEEKOTICS generate <image idea>'",
"      ].join('\\n'));",
"      return;",
"    }",
"",
"    if (typeof seekdeepIsDirectImageAliasPrompt === 'function' && seekdeepIsDirectImageAliasPrompt(prompt)) {",
"      const seekdeepRouteCooldownRemaining = seekdeepImageCooldownRemaining(message.author?.id || message.author?.username || 'unknown');",
"      if (seekdeepRouteCooldownRemaining > 0) {",
"        seekdeepLogRoute('image-cooldown', prompt);",
"        await seekdeepSendImageCooldownNotice(message, seekdeepRouteCooldownRemaining);",
"        seekdeepStopTypingSafelyForMessage(message);",
"        return;",
"      }",
"",
"      const seekdeepMessageImageModeOptions = typeof seekdeepImageModeOptionsFromPrompt === 'function'",
"        ? seekdeepImageModeOptionsFromPrompt(prompt)",
"        : { refine: true, ground: true, cleanPrompt: prompt };",
"      const imagePrompt = (typeof seekdeepExtractImagePrompt === 'function' ? seekdeepExtractImagePrompt(prompt) : prompt) || seekdeepMessageImageModeOptions.cleanPrompt || prompt;",
"",
"      seekdeepLogRoute('image-direct-alias', imagePrompt);",
"      remember(key, 'user', '[direct-image] ' + prompt);",
"",
"      if (seekdeepShouldUsePromptChoicePreview(seekdeepMessageImageModeOptions)) {",
"        remember(key, 'assistant', 'Prepared image prompt choices for: ' + imagePrompt);",
"        await seekdeepSendImagePromptChoiceMessage(message, imagePrompt, 1024, 1024, null, seekdeepMessageImageModeOptions);",
"      } else {",
"        remember(key, 'assistant', 'Queued image locally for: ' + imagePrompt);",
"        await seekdeepSendImageWithButtonsMessage(message, imagePrompt, 1024, 1024, null, seekdeepMessageImageModeOptions);",
"      }",
"      return;",
"    }",
"    // SEEKDEEP_DIRECT_IMAGE_ALIAS_MESSAGE_ROUTE_END"
].join('\n');

indexSource = insertBeforeFirstExistingMarker(
  indexSource,
  [
    '    const utilityKind = seekdeepUtilityPromptKind(prompt);',
    '    if (isNaturalStatusPrompt(prompt) || isExplicitStatusRequest(prompt)) {',
    '    if (typeof seekdeepHandleArchiveOpenMessage === '
  ],
  directImageRouteBlock,
  'direct image alias message route'
);

const queueDedupeHelpers = [
"// SEEKDEEP_IMAGE_QUEUE_DUPLICATE_SUPPRESSION_START",
"const SEEKDEEP_IMAGE_QUEUE_RECENT_KEYS = globalThis.__seekdeepImageQueueRecentKeys || new Map();",
"globalThis.__seekdeepImageQueueRecentKeys = SEEKDEEP_IMAGE_QUEUE_RECENT_KEYS;",
"",
"function seekdeepClaimImageQueueRecentKey(key = '', ttlMs = Number(process.env.SEEKDEEP_IMAGE_BUTTON_DUPLICATE_TTL_MS || 30000)) {",
"  const cleanKey = String(key || '').trim();",
"  if (!cleanKey) return true;",
"",
"  const now = Date.now();",
"  for (const [existingKey, expiresAt] of SEEKDEEP_IMAGE_QUEUE_RECENT_KEYS.entries()) {",
"    if (Number(expiresAt || 0) <= now) SEEKDEEP_IMAGE_QUEUE_RECENT_KEYS.delete(existingKey);",
"  }",
"",
"  const existing = Number(SEEKDEEP_IMAGE_QUEUE_RECENT_KEYS.get(cleanKey) || 0);",
"  if (existing > now) return false;",
"",
"  SEEKDEEP_IMAGE_QUEUE_RECENT_KEYS.set(cleanKey, now + Math.max(1000, Number(ttlMs || 30000)));",
"  return true;",
"}",
"// SEEKDEEP_IMAGE_QUEUE_DUPLICATE_SUPPRESSION_END"
].join('\n');

indexSource = insertBeforeFirstExistingMarker(
  indexSource,
  ['async function seekdeepSendImageWithButtonsMessage', 'function seekdeepSendImageWithButtonsMessage'],
  queueDedupeHelpers,
  'image queue duplicate suppression helpers'
);

if (!indexSource.includes('// SEEKDEEP_IMAGE_QUEUE_BUTTON_DUPLICATE_GATE_START')) {
  const gateNeedle = "  const userId = message?.author?.id || 'unknown';\n  const cooldown = seekdeepImageCooldownRemaining(userId);";
  if (indexSource.includes(gateNeedle)) {
    const gate = [
"  const userId = message?.author?.id || 'unknown';",
"  const seekdeepImageChannelId = message?.channel?.id || '';",
"  const seekdeepImageRefineMode = seekdeepImageModeOptions.refine !== false ? 'refined' : 'original';",
"  const seekdeepImageQueueRecentKey = [",
"    userId,",
"    seekdeepImageChannelId,",
"    seekdeepImageRefineMode,",
"    String(prompt || '').toLowerCase().replace(/\\s+/g, ' ').trim(),",
"  ].join('|');",
"",
"  // SEEKDEEP_IMAGE_QUEUE_BUTTON_DUPLICATE_GATE_START",
"  if (seekdeepSkipImageCooldown && !seekdeepClaimImageQueueRecentKey(seekdeepImageQueueRecentKey)) {",
"    console.warn('Duplicate image button/job suppressed for ' + seekdeepImageQueueRecentKey);",
"    return null;",
"  }",
"  // SEEKDEEP_IMAGE_QUEUE_BUTTON_DUPLICATE_GATE_END",
"",
"  const cooldown = seekdeepImageCooldownRemaining(userId);"
    ].join('\n');
    indexSource = indexSource.replace(gateNeedle, gate);
    changes.push('added duplicate gate to image send function');
  } else {
    changes.push('duplicate gate skipped: exact send function cooldown anchor not found');
  }
}

// Patch local_ai_server.py to accept per-request negative_prompt and pass it to the image pipeline.
if (!/negative_prompt:\s*str\s*=/.test(pySource)) {
  const fieldNeedle = '    seed: Optional[int] = None\n';
  if (!pySource.includes(fieldNeedle)) throw new Error('Could not find ImageRequest seed field in local_ai_server.py.');
  pySource = pySource.replace(fieldNeedle, fieldNeedle + '    negative_prompt: str = ""\n');
  changes.push('added negative_prompt field to ImageRequest');
}

if (!/request_negative_prompt\s*=/.test(pySource)) {
  const argsRegex = /    args = \{\s*\n        "prompt": req\.prompt\.strip\(\),\s*\n[\s\S]*?\n    \}\s*\n/;
  const argsMatch = argsRegex.exec(pySource);
  if (!argsMatch) throw new Error('Could not find image args block in local_ai_server.py.');

  const insert = argsMatch[0] + [
'',
'    request_negative_prompt = str(getattr(req, "negative_prompt", "") or os.getenv("IMAGE_NEGATIVE_PROMPT", "") or "").strip()',
'    if request_negative_prompt:',
'        args["negative_prompt"] = request_negative_prompt',
''
  ].join('\n');

  pySource = pySource.slice(0, argsMatch.index) + insert + pySource.slice(argsMatch.index + argsMatch[0].length);
  changes.push('added request negative_prompt to image args');
}

pySource = pySource.replace(
  /(\s+negative_prompt = os\.getenv\("IMAGE_NEGATIVE_PROMPT", ""\)\.strip\(\)\s+if negative_prompt:)\s+args\["negative_prompt"\] = negative_prompt/g,
  '$1\n            if "negative_prompt" not in args:\n                args["negative_prompt"] = negative_prompt'
);

fs.writeFileSync(indexPath, indexSource, 'utf8');
fs.writeFileSync(localAiPath, pySource, 'utf8');

console.log('Patched index.js and local_ai_server.py successfully.');
for (const change of changes) console.log('- ' + change);
'@ | Set-Content -Path $PatchJsPath -Encoding UTF8

try {
  Write-Host "Applying patch with: $PatchJsPath"
  node $PatchJsPath
  if ($LASTEXITCODE -ne 0) { throw "Node patcher failed with exit code $LASTEXITCODE" }

  Write-Host "Running node --check..."
  node --check $IndexPath
  if ($LASTEXITCODE -ne 0) { throw "node --check failed with exit code $LASTEXITCODE" }

  if (Test-Path $PythonPath) {
    Write-Host "Running Python compile check..."
    & $PythonPath -m py_compile $LocalAiPath
    if ($LASTEXITCODE -ne 0) { throw "Python compile check failed with exit code $LASTEXITCODE" }
  } else {
    Write-Host "Python compile check skipped (.venv Python not found)."
  }

  Write-Host ""
  Write-Host "Patch applied successfully."
  Write-Host "Changed behavior:"
  Write-Host "- @SeekDeep generate <subject> routes to image generation before suggestion guards."
  Write-Host "- @SeekDeep draw me <subject> routes to image generation before suggestion guards."
  Write-Host "- Bare Yes/Okay replies no longer fall through to Qwen as fake image descriptions."
  Write-Host "- Refined image prompts are shorter and keep negative terms out of the positive prompt."
  Write-Host "- Negative image guidance is sent separately to local_ai_server.py."
  Write-Host "- Duplicate image button/job clicks are suppressed when the known anchor is present."
} catch {
  Write-Host ""
  Write-Host "Patch failed. Restoring backups..."
  Copy-Item $IndexBackupPath $IndexPath -Force
  Copy-Item $LocalAiBackupPath $LocalAiPath -Force
  Write-Host "Restored: $IndexBackupPath"
  Write-Host "Restored: $LocalAiBackupPath"
  throw
}
