
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

