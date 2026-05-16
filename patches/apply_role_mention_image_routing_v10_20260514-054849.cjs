const fs = require('fs');
const path = require('path');

const indexPath = path.join(process.cwd(), 'index.js');
let source = fs.readFileSync(indexPath, 'utf8');
let text = source;
const changes = [];

function findFunctionRange(src, name) {
  const sig = `function ${name}(`;
  const start = src.indexOf(sig);
  if (start < 0) return null;
  const braceStart = src.indexOf('{', start);
  if (braceStart < 0) throw new Error(`Could not find opening brace for ${name}`);
  let depth = 0;
  for (let i = braceStart; i < src.length; i++) {
    const ch = src[i];
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) {
        return { start, end: i + 1 };
      }
    }
  }
  throw new Error(`Could not find closing brace for ${name}`);
}

function replaceFunction(name, replacement) {
  const range = findFunctionRange(text, name);
  if (!range) throw new Error(`Could not find function ${name}`);
  text = text.slice(0, range.start) + replacement + text.slice(range.end);
  changes.push(`replaced ${name}`);
}

const cleanFn = `function seekdeepCleanMessageCommandPrompt(value) {\n  return String(value || '')\n    .replace(/<@!?\\d+>/g, ' ')\n    .replace(/<@&\\d+>/g, ' ')\n    .replace(/\\bseekotics\\b/gi, ' ')\n    .replace(/\\bseekdeep\\b/gi, ' ')\n    .replace(/^[@\\/\\s:,-]+/g, ' ')\n    .replace(/\\s+/g, ' ')\n    .trim();\n}`;
replaceFunction('seekdeepCleanMessageCommandPrompt', cleanFn);

if (!text.includes('function seekdeepStripCommandAddressingForRouting(')) {
  const anchor = 'function seekdeepIsArchiveMigrationPrompt(value) {';
  const idx = text.indexOf(anchor);
  if (idx < 0) throw new Error('Could not find insertion anchor after seekdeepCleanMessageCommandPrompt');
  const helper = `\nfunction seekdeepStripCommandAddressingForRouting(value) {\n  return String(value || '')\n    .replace(/<@!?\\d+>/g, ' ')\n    .replace(/<@&\\d+>/g, ' ')\n    .replace(/^\\s*(?:@?seekdeep|@?seekotics)[,:]?\\s+/i, ' ')\n    .replace(/^[@\\/\\s:,-]+/g, ' ')\n    .replace(/\\s+/g, ' ')\n    .trim();\n}\n\n`;
  text = text.slice(0, idx) + helper + text.slice(idx);
  changes.push('inserted seekdeepStripCommandAddressingForRouting');
}

const extractFn = `function seekdeepExtractImagePrompt(text = '') {\n  // SEEKDEEP_RAW_IMAGE_EXTRACT_CLEAN_START\n  let t = seekdeepCleanImageModeTokens(text);\n  // SEEKDEEP_RAW_IMAGE_EXTRACT_CLEAN_END\n\n  t = typeof seekdeepStripCommandAddressingForRouting === 'function'\n    ? seekdeepStripCommandAddressingForRouting(t)\n    : String(t || '').replace(/<@!?\\d+>/g, ' ').replace(/<@&\\d+>/g, ' ').trim();\n  t = t.replace(/^(?:hey|yo|hi|hello)\\s+/i, '');\n  t = t.replace(/^(?:please\\s+)?(?:can you|could you|would you)\\s+/i, '');\n  t = t.replace(/^(?:please\\s+)?(?:show me|make me|generate|create|draw(?:\\s+me)?|sketch|render|paint|illustrate|design)\\s+(?:(?:for\\s+)?me\\s+)?/i, '');\n  t = t.replace(/^(?:an?\\s+)?(?:image|picture|photo|pic|art|artwork|drawing|wallpaper|banner|logo|icon|poster|portrait)\\s+(?:of|for)\\s+/i, '');\n  t = t.replace(/^(?:i need|need|i want|want)\\s+(?:an?\\s+|some\\s+)?(?:image|picture|photo|pic|art|artwork|drawing|wallpaper|banner|logo|icon|poster|portrait)?\\s*(?:of|for)?\\s*/i, '');\n  t = t.replace(/\\s+/g, ' ').trim();\n  // SEEKDEEP_OBJECT_ACCURACY_EXTRACT_NORMALIZE\n  t = seekdeepNormalizeObjectAccuracyPrompt(t);\n\n  return t;\n}`;
replaceFunction('seekdeepExtractImagePrompt', extractFn);

const startMarker = '    // SEEKDEEP_RAW_IMAGE_MESSAGE_ROUTE_START';
const endMarker = '    // SEEKDEEP_RAW_IMAGE_MESSAGE_ROUTE_END';
const startIdx = text.indexOf(startMarker);
if (startIdx < 0) throw new Error('Could not find raw image route start marker');
const endIdx = text.indexOf(endMarker, startIdx);
if (endIdx < 0) throw new Error('Could not find raw image route end marker');
const endLineIdx = text.indexOf('\n', endIdx);
if (endLineIdx < 0) throw new Error('Could not find end of raw image route marker line');

const replacementBlock = `    // SEEKDEEP_RAW_IMAGE_MESSAGE_ROUTE_START\n    const seekdeepRawImageRoutePrompt = typeof seekdeepStripCommandAddressingForRouting === 'function'\n      ? seekdeepStripCommandAddressingForRouting(prompt)\n      : seekdeepCleanMessageCommandPrompt(prompt);\n    if (seekdeepForceImageFromReplyContext || (!seekdeepShouldKeepPromptAsChatBeforeImage(seekdeepRawImageRoutePrompt) && ((typeof seekdeepIsGenericImageFollowupPrompt === 'function' && seekdeepIsGenericImageFollowupPrompt(seekdeepRawImageRoutePrompt)) || (typeof seekdeepLooksLikeShortNamedVisualSubject === 'function' && seekdeepLooksLikeShortNamedVisualSubject(seekdeepRawImageRoutePrompt)) || isNaturalImagePrompt(seekdeepRawImageRoutePrompt)))) {\n    // SEEKDEEP_RAW_IMAGE_MESSAGE_ROUTE_END`;

text = text.slice(0, startIdx) + replacementBlock + text.slice(endLineIdx);
changes.push('replaced raw image route header block');

const rawStart = text.indexOf(startMarker);
let rawEnd = text.indexOf('    // SEEKDEEP_RESEARCH_TABLE_MESSAGE_HOOK_START', rawStart);
if (rawEnd < 0) throw new Error('Could not find end of raw image route block');
let rawBlock = text.slice(rawStart, rawEnd);

const replacements = [
  ["if (seekdeepLooksLikeVisualRequest(prompt)) seekdeepLogRoute('image-intent-rule', prompt);", "if (seekdeepLooksLikeVisualRequest(seekdeepRawImageRoutePrompt)) seekdeepLogRoute('image-intent-rule', seekdeepRawImageRoutePrompt);", 'updated image-intent-rule logging'],
  ['? seekdeepImageModeOptionsFromPrompt(prompt)', '? seekdeepImageModeOptionsFromPrompt(seekdeepRawImageRoutePrompt)', 'updated image mode options prompt'],
  [": { refine: true, ground: true, cleanPrompt: prompt };", ": { refine: true, ground: true, cleanPrompt: seekdeepRawImageRoutePrompt };", 'updated default image mode options prompt'],
  ["const imagePrompt = (typeof seekdeepExtractImagePrompt === 'function' ? seekdeepExtractImagePrompt(prompt) : prompt) || seekdeepMessageImageModeOptions.cleanPrompt || prompt;", "const imagePrompt = (typeof seekdeepExtractImagePrompt === 'function' ? seekdeepExtractImagePrompt(seekdeepRawImageRoutePrompt) : seekdeepRawImageRoutePrompt) || seekdeepMessageImageModeOptions.cleanPrompt || seekdeepRawImageRoutePrompt;", 'updated imagePrompt extraction'],
  ["remember(key, 'user', `[natural-image] ${prompt}`);", "remember(key, 'user', `[natural-image] ${seekdeepRawImageRoutePrompt}`);", 'updated natural-image memory']
];
for (const [find, repl, label] of replacements) {
  if (rawBlock.includes(find)) {
    rawBlock = rawBlock.split(find).join(repl);
    changes.push(label);
  }
}
text = text.slice(0, rawStart) + rawBlock + text.slice(rawEnd);

if (text === source) {
  throw new Error('Patch made no changes; refusing to continue.');
}

fs.writeFileSync(indexPath, text, 'utf8');
console.log('Patched index.js successfully.');
for (const change of changes) console.log('- ' + change);

