$ErrorActionPreference = 'Stop'

$RepoRoot = (Get-Location).Path
$IndexPath = Join-Path $RepoRoot 'index.js'
$PatchesDir = Join-Path $RepoRoot 'patches'
$BackupsDir = Join-Path $RepoRoot 'backups'

if (-not (Test-Path $IndexPath)) {
  throw "Could not find index.js at: $IndexPath`
Run this patch from the SeekDeep-DiscordBot repo root."
}

New-Item -ItemType Directory -Force -Path $PatchesDir | Out-Null
New-Item -ItemType Directory -Force -Path $BackupsDir | Out-Null

$Stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$BackupPath = Join-Path $BackupsDir "index.js.before-show-me-image-route-v1-$Stamp.bak"
Copy-Item $IndexPath $BackupPath -Force
Write-Host "Backup created: $BackupPath"

$PatcherPath = Join-Path $PatchesDir "apply_show_me_image_route_v1_$Stamp.cjs"
@'
const fs = require('fs');
const path = require('path');

const indexPath = path.join(process.cwd(), 'index.js');
let source = fs.readFileSync(indexPath, 'utf8');

function findFunctionRange(src, functionName) {
  const signature = `function ${functionName}(`;
  const start = src.indexOf(signature);
  if (start < 0) {
    throw new Error(`Could not find function ${functionName}`);
  }

  const braceStart = src.indexOf('{', start);
  if (braceStart < 0) {
    throw new Error(`Could not find opening brace for ${functionName}`);
  }

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
      if (!escaped && ch === '`') {
        inTemplate = false;
        continue;
      }
      if (!escaped && ch === '$' && next === '{') {
        depth += 1;
        i += 1;
        continue;
      }
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

    if (ch === '{') {
      depth += 1;
      continue;
    }

    if (ch === '}') {
      depth -= 1;
      if (depth === 0) {
        return { start, end: i + 1 };
      }
      continue;
    }
  }

  throw new Error(`Could not find closing brace for ${functionName}`);
}

function replaceFunction(src, functionName, replacement) {
  const range = findFunctionRange(src, functionName);
  return src.slice(0, range.start) + replacement + src.slice(range.end);
}

const hasExplicitReplacement = String.raw`function seekdeepHasExplicitImageRequest(p = '') {
  const text = normalizeUserText(p).toLowerCase().trim();

  if (!text) return false;

  const blockedIntentRe = /\b(?:table|spreadsheet|list|pros|cons|summary|explanation|code|script|powershell|status|queue|help|commands|archive|cache|recent|prompt history|model status|options|names|ideas|suggestions)\b/i;

  if (/^(?:generate|create|make|render|draw|paint|sketch|illustrate|design)\s+(?:(?:for\s+)?me\s+)?\S+/i.test(text) && !blockedIntentRe.test(text)) {
    return true;
  }

  if (/^(?:show\s+me|show)\s+(?:an?\s+|some\s+)?\S+/i.test(text) && !blockedIntentRe.test(text)) {
    return true;
  }

  if (/\b(generate|create|make|draw|render|paint|illustrate|design)\s+(?:me\s+)?(?:an?\s+|some\s+)?(?:image|picture|photo|pic|art|artwork|drawing|wallpaper|banner|logo|icon|poster|portrait)\b/i.test(text)) {
    return true;
  }

  if (/\b(image|picture|photo|pic|artwork|drawing|wallpaper|banner|logo|icon|poster|portrait)\s+(?:of|for)\b/i.test(text)) {
    return true;
  }

  if (/\b(?:image|picture|photo|pic)\b/i.test(text)) {
    return true;
  }

  if (/\b(?:draw|sketch|paint|illustrate)\s+me\s+(?:an?\s+|some\s+)?\S+/i.test(text)) {
    return true;
  }

  if (/\b(?:draw|sketch|paint|illustrate)\s+(?:an?\s+|some\s+)?\S+/i.test(text) && seekdeepHasVisualSubjectWords(text)) {
    return true;
  }

  if (/^(?:draw|sketch|paint|illustrate|render)\s+(?:me\s+)?(?:an?\s+|some\s+)?\S+/i.test(text) && !/\b(?:image prompt|prompt only|description only)\b/i.test(text)) {
    return true;
  }

  return false;
}`;

const looksLikeReplacement = String.raw`function seekdeepLooksLikeImagePrompt(text = '') {
  const p = normalizeUserText(text).toLowerCase().trim();
  if (!p) return false;

  if (typeof seekdeepLooksLikeVisionPrompt === 'function' && seekdeepLooksLikeVisionPrompt(p)) {
    return false;
  }

  if (/\b(image prompt|prompt only|describe an image|description only)\b/i.test(p)) {
    return false;
  }

  if (seekdeepShouldStayChatInsteadOfImage(p)) {
    return false;
  }

  if (seekdeepHasExplicitImageRequest(p)) {
    return true;
  }

  if (/\b(generate|create|make|draw|render|paint|illustrate|design|show me|show)\b/i.test(p) && seekdeepHasVisualSubjectWords(p)) {
    return true;
  }

  if (seekdeepHasLikelyVisualDescription(p)) {
    return true;
  }

  return false;
}`;

const extractReplacement = String.raw`function seekdeepExtractImagePrompt(text = '') {
  let t = typeof seekdeepCleanImageModeTokens === 'function' ? seekdeepCleanImageModeTokens(text) : String(text || '');

  t = t.replace(/<@!?\d+>/g, ' ').trim();
  t = t.replace(/^(?:hey|yo|hi|hello)\s+/i, '');
  t = t.replace(/^(?:seekdeep|seekotics|neurabot|plugtalk)[,:]?\s+/i, '');
  t = t.replace(/^(?:please\s+)?(?:can you|could you|would you)\s+/i, '');
  t = t.replace(/^(?:please\s+)?(?:show me|show|make me|generate|create|draw|sketch|render|paint|illustrate|design)\s+(?:(?:for\s+)?me\s+)?/i, '');
  t = t.replace(/^(?:an?\s+)?(?:image|picture|photo|pic|art|artwork|drawing|wallpaper|banner|logo|icon|poster|portrait)\s+(?:of|for)\s+/i, '');
  t = t.replace(/^(?:i need|need|i want|want)\s+(?:an?\s+|some\s+)?(?:image|picture|photo|pic|art|artwork|drawing|wallpaper|banner|logo|icon|poster|portrait)?\s*(?:of|for)?\s*/i, '');
  t = t.replace(/^me\s+/i, '');
  t = t.replace(/\s+/g, ' ').trim();

  if (typeof seekdeepNormalizeObjectAccuracyPrompt === 'function') {
    t = seekdeepNormalizeObjectAccuracyPrompt(t);
  }

  return t;
}`;

source = replaceFunction(source, 'seekdeepHasExplicitImageRequest', hasExplicitReplacement);
source = replaceFunction(source, 'seekdeepLooksLikeImagePrompt', looksLikeReplacement);
source = replaceFunction(source, 'seekdeepExtractImagePrompt', extractReplacement);

fs.writeFileSync(indexPath, source, 'utf8');
console.log('Patched index.js successfully.');
console.log('- replaced seekdeepHasExplicitImageRequest');
console.log('- replaced seekdeepLooksLikeImagePrompt');
console.log('- replaced seekdeepExtractImagePrompt');
'@ | Set-Content -Path $PatcherPath -Encoding UTF8

Write-Host "Applying patch with: $PatcherPath"
node $PatcherPath
if ($LASTEXITCODE -ne 0) {
  Write-Warning 'Patch failed. Restoring backup...'
  Copy-Item $BackupPath $IndexPath -Force
  throw "Node patcher failed with exit code $LASTEXITCODE"
}

Write-Host 'Running node --check...'
node --check $IndexPath
if ($LASTEXITCODE -ne 0) {
  Write-Warning 'Patch failed. Restoring backup...'
  Copy-Item $BackupPath $IndexPath -Force
  throw "node --check failed with exit code $LASTEXITCODE"
}

Write-Host ''
Write-Host 'Patch applied successfully.'
Write-Host 'Changed behavior:'
Write-Host '- "show me <image idea>" is treated as an image request again.'
Write-Host '- obvious non-image prompts like show me status/help/archive remain out of image routing.'
Write-Host '- extracted image prompt should be the subject only (example: "a banana eating a monkey").'
