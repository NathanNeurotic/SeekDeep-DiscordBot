const fs = require('fs');
const path = require('path');
const indexPath = process.argv[2] || path.join(process.cwd(), 'index.js');
let source = fs.readFileSync(indexPath, 'utf8');
let out = source;
const changes = [];
function findBalancedEnd(src, openIndex, openChar, closeChar) {
  let i = openIndex, depth = 0, state = 'code';
  while (i < src.length) {
    const ch = src[i], next = src[i + 1];
    if (state === 'code') {
      if (ch === openChar) depth += 1;
      else if (ch === closeChar) { depth -= 1; if (depth === 0) return i; }
      else if (ch === "'") state = 'single';
      else if (ch === '"') state = 'double';
      else if (ch === '`') state = 'template';
      else if (ch === '/' && next === '/') { state = 'linecomment'; i += 1; }
      else if (ch === '/' && next === '*') { state = 'blockcomment'; i += 1; }
    } else if (state === 'single') { if (ch === '\\') i += 1; else if (ch === "'") state = 'code'; }
    else if (state === 'double') { if (ch === '\\') i += 1; else if (ch === '"') state = 'code'; }
    else if (state === 'template') { if (ch === '\\') i += 1; else if (ch === '`') state = 'code'; }
    else if (state === 'linecomment') { if (ch === '\n') state = 'code'; }
    else if (state === 'blockcomment') { if (ch === '*' && next === '/') { state = 'code'; i += 1; } }
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
function insertAfterFunction(functionName, block, markerText) {
  if (out.includes(markerText)) return false;
  const range = findFunctionRange(out, functionName);
  out = out.slice(0, range.end) + '\n\n' + block + out.slice(range.end);
  changes.push('inserted ' + markerText);
  return true;
}
const normalizer = `// SEEKDEEP_COMMAND_ADDRESSING_NORMALIZER_V8_START
function seekdeepStripCommandAddressingForRouting(value = '') {
  return normalizeUserText(value)
    .replace(/^(?:\s*(?:<@(?:!|&)?\d+>|@seekdeep|@seekotics|seekdeep|seekotics)\s*)+/i, ' ')
    .replace(/^[@/\s]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}
// SEEKDEEP_COMMAND_ADDRESSING_NORMALIZER_V8_END`;
if (/function\s+seekdeepStripCommandAddressingForRouting\s*\(/.test(out)) replaceFunction('seekdeepStripCommandAddressingForRouting', normalizer);
else insertAfterFunction('seekdeepLooksLikeVisionPrompt', normalizer, 'SEEKDEEP_COMMAND_ADDRESSING_NORMALIZER_V8_START');
replaceFunction('seekdeepCleanMessageCommandPrompt', `function seekdeepCleanMessageCommandPrompt(value) {
  return String(value || '')
    .replace(/<@(?:!|&)?\d+>/g, ' ')
    .replace(/\bseekotics\b/gi, ' ')
    .replace(/\bseekdeep\b/gi, ' ')
    .replace(/^[@/\s]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}`);
replaceFunction('seekdeepHasVisualSubjectWords', `function seekdeepHasVisualSubjectWords(p = '') {
  return /\b(cat|dog|frog|pepe|girl|woman|man|person|character|creature|monster|plant|flower|tree|forest|castle|city|room|car|robot|machine|dragon|elf|wizard|goblin|demon|angel|portrait|scene|background|landscape|avatar|emote|cannabis|marijuana|goomba|mario|mushroom)\b/i.test(p);
}`);
replaceFunction('seekdeepHasExplicitImageRequest', `function seekdeepHasExplicitImageRequest(p = '') {
  const text = seekdeepStripCommandAddressingForRouting(p).toLowerCase().trim();
  if (!text) return false;

  if (/\b(?:image prompt|prompt only|description only)\b/i.test(text)) return false;
  if (/\b(?:table|spreadsheet|list|pros|cons|summary|explanation|code|script|powershell|javascript|python|logs?|error|bug)\b/i.test(text)) return false;
  if (/\b(?:status|queue|help|commands|archive|cache|recent|prompt history|model status)\b/i.test(text)) return false;

  if (/^(?:generate|create|make|render|draw|paint|sketch|illustrate|design)\s+(?:(?:for\s+)?me\s+)?(?:an?\s+|some\s+|the\s+)?\S+/i.test(text)) return true;
  if (/^(?:show\s+me|show)\s+(?:an?\s+|some\s+|the\s+)?\S+/i.test(text)) return true;
  if (/\b(generate|create|make|draw|render|paint|illustrate|design)\s+(?:me\s+)?(?:an?\s+|some\s+)?(?:image|picture|photo|pic|art|artwork|drawing|wallpaper|banner|logo|icon|poster|portrait)\b/i.test(text)) return true;
  if (/\b(image|picture|photo|pic|artwork|drawing|wallpaper|banner|logo|icon|poster|portrait)\s+(?:of|for)\b/i.test(text)) return true;
  if (/\b(?:image|picture|photo|pic)\b/i.test(text)) return true;
  if (/\b(?:draw|sketch|paint|illustrate)\s+me\s+(?:an?\s+|some\s+)?\S+/i.test(text)) return true;
  if (/\b(?:draw|sketch|paint|illustrate)\s+(?:an?\s+|some\s+)?\S+/i.test(text) && seekdeepHasVisualSubjectWords(text)) return true;
  if (/^(?:draw|sketch|paint|illustrate|render)\s+(?:me\s+)?(?:an?\s+|some\s+)?\S+/i.test(text)) return true;

  return false;
}`);
replaceFunction('seekdeepLooksLikeImagePrompt', `function seekdeepLooksLikeImagePrompt(text = '') {
  const p = seekdeepStripCommandAddressingForRouting(text).toLowerCase().trim();
  if (!p) return false;

  if (typeof seekdeepLooksLikeVisionPrompt === 'function' && seekdeepLooksLikeVisionPrompt(p)) return false;
  if (/\b(image prompt|prompt only|describe an image|description only)\b/i.test(p)) return false;
  if (seekdeepShouldStayChatInsteadOfImage(p)) return false;
  if (seekdeepHasExplicitImageRequest(p)) return true;
  if (/\b(generate|create|make|draw|render|paint|illustrate|design|show me|show)\b/i.test(p) && seekdeepHasVisualSubjectWords(p)) return true;
  if (seekdeepHasLikelyVisualDescription(p)) return true;

  return false;
}`);
replaceFunction('seekdeepExtractImagePrompt', `function seekdeepExtractImagePrompt(text = '') {
  // SEEKDEEP_RAW_IMAGE_EXTRACT_CLEAN_START
  let t = seekdeepCleanImageModeTokens(text);
  // SEEKDEEP_RAW_IMAGE_EXTRACT_CLEAN_END

  t = String(t || '')
    .replace(/^(?:\s*(?:<@(?:!|&)?\d+>|@seekdeep|@seekotics|seekdeep|seekotics)\s*)+/i, ' ')
    .replace(/<@(?:!|&)?\d+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  t = t.replace(/^(?:hey|yo|hi|hello)\s+/i, '');
  t = t.replace(/^(?:seekdeep|seekotics|neurabot|plugtalk)[,:]?\s+/i, '');
  t = t.replace(/^(?:please\s+)?(?:can you|could you|would you)\s+/i, '');
  t = t.replace(/^(?:please\s+)?(?:show\s+me|show|make\s+me|generate|create|draw\s+me|draw|sketch|render|paint|illustrate|design)\s+(?:(?:for\s+)?me\s+)?/i, '');
  t = t.replace(/^(?:an?\s+|the\s+|some\s+)?(?:image|picture|photo|pic|art|artwork|drawing|wallpaper|banner|logo|icon|poster|portrait)\s+(?:of|for)\s+/i, '');
  t = t.replace(/^(?:i need|need|i want|want)\s+(?:an?\s+|some\s+)?(?:image|picture|photo|pic|art|artwork|drawing|wallpaper|banner|logo|icon|poster|portrait)?\s*(?:of|for)?\s*/i, '');
  t = t.replace(/\s+/g, ' ').trim();

  // SEEKDEEP_OBJECT_ACCURACY_EXTRACT_NORMALIZE
  t = seekdeepNormalizeObjectAccuracyPrompt(t);

  return t;
}`);
if (out === source) throw new Error('Patch made no changes; refusing to continue.');
fs.writeFileSync(indexPath, out, 'utf8');
console.log('Patched index.js successfully.');
for (const c of changes) console.log('- ' + c);

