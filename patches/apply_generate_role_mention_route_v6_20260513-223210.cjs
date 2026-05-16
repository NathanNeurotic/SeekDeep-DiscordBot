const fs = require('fs');
const path = require('path');

const indexPath = path.join(process.cwd(), 'index.js');
let source = fs.readFileSync(indexPath, 'utf8');
let out = source;
const changes = [];

function replaceOnce(label, search, replacement) {
  if (!out.includes(search)) {
    throw new Error(`Missing required anchor for ${label}`);
  }
  out = out.replace(search, replacement);
  changes.push(label);
}

function replaceRegex(label, pattern, replacement, required = true) {
  const before = out;
  out = out.replace(pattern, replacement);
  if (before === out) {
    if (required) throw new Error(`Missing required regex anchor for ${label}`);
    return false;
  }
  changes.push(label);
  return true;
}

// Add a single shared normalizer for message-command routing. It strips only command-addressing
// tokens. It does not remove later user mentions used by archive/user-target commands.
const helper = [
"// SEEKDEEP_COMMAND_ADDRESSING_NORMALIZER_START",
"function seekdeepStripCommandAddressingForRouting(value = '') {",
"  return normalizeUserText(value)",
"    .replace(/^(?:\\s*(?:<@(?:!|&)?\\d+>|@seekdeep|@seekotics|seekdeep|seekotics)\\s*)+/i, ' ')",
"    .replace(/^[@/\\s]+/g, ' ')",
"    .replace(/\\s+/g, ' ')",
"    .trim();",
"}",
"// SEEKDEEP_COMMAND_ADDRESSING_NORMALIZER_END",
"",
].join("\\n");

if (!out.includes('function seekdeepStripCommandAddressingForRouting')) {
  const marker = 'function seekdeepLooksLikeVisionPrompt(text = \'\') {';
  if (!out.includes(marker)) throw new Error('Could not find seekdeepLooksLikeVisionPrompt insertion marker.');
  out = out.replace(marker, helper + marker);
  changes.push('inserted command addressing normalizer');
}

// Make the generic command cleaner strip role mentions too.
replaceRegex(
  'clean message command prompt strips role mentions',
  /function seekdeepCleanMessageCommandPrompt\(value\) \{\s*return String\(value \|\| ''\)\s*\.replace\(\/<@!\\\?\\d\+>\/g, ' '\)/,
  "function seekdeepCleanMessageCommandPrompt(value) {\\n  return String(value || '')\\n    .replace(/<@(?:!|&)?\\\\d+>/g, ' ')",
  false
);

// Fallback for a slightly different clean function shape.
replaceRegex(
  'clean message command prompt strips role mentions fallback',
  /\.replace\(\/<@!\\\?\\d\+>\/g, ' '\)/g,
  ".replace(/<@(?:!|&)?\\\\d+>/g, ' ')",
  false
);

// The actual bug: role mention + "generate ..." starts with <@&...>, so the ^generate checks fail.
// Normalize before image-intent checks.
replaceRegex(
  'explicit image request strips leading role/user mention',
  /function seekdeepHasExplicitImageRequest\(p = ''\) \{\s*const text = normalizeUserText\(p\)\.toLowerCase\(\)\.trim\(\);/,
  "function seekdeepHasExplicitImageRequest(p = '') {\\n  const text = seekdeepStripCommandAddressingForRouting(p).toLowerCase().trim();"
);

replaceRegex(
  'image prompt detector strips leading role/user mention',
  /function seekdeepLooksLikeImagePrompt\(text = ''\) \{\s*const p = normalizeUserText\(text\)\.toLowerCase\(\)\.trim\(\);/,
  "function seekdeepLooksLikeImagePrompt(text = '') {\\n  const p = seekdeepStripCommandAddressingForRouting(text).toLowerCase().trim();"
);

// Clean the final prompt too, so embeds do not say "@SeekDeep draw me a goomba".
replaceRegex(
  'image prompt extractor strips role mentions',
  /t = t\.replace\(\/<@!\\\?\\d\+>\/g, ' '\)\.trim\(\);/g,
  "t = t.replace(/<@(?:!|&)?\\\\d+>/g, ' ').trim();"
);

// Give short proper-noun-ish image subjects a little more coverage.
// This is intentionally small; it fixes the reported Goomba case without broadening all chat.
replaceRegex(
  'visual subject words include goomba/mario-style entities',
  /\breturn \/\\b\(cat\|dog\|frog\|pepe\|girl\|woman\|man\|person\|character\|creature\|monster\|plant\|flower\|tree\|forest\|castle\|city\|room\|car\|robot\|machine\|dragon\|elf\|wizard\|goblin\|demon\|angel\|portrait\|scene\|background\|landscape\|avatar\|emote\|cannabis\|marijuana\)\\b\/i\.test\(p\);/,
  "return /\\\\b(cat|dog|frog|pepe|girl|woman|man|person|character|creature|monster|plant|flower|tree|forest|castle|city|room|car|robot|machine|dragon|elf|wizard|goblin|demon|angel|portrait|scene|background|landscape|avatar|emote|cannabis|marijuana|goomba|mario|mushroom)\\\\b/i.test(p);",
  false
);

// If v5 added the direct-image helper, make sure it also strips command addressing before matching.
// This is best-effort because some installs may not have this helper yet.
replaceRegex(
  'direct image alias helper strips command addressing',
  /function seekdeepIsDirectImageAliasPrompt\(prompt = ''\) \{\s*const p = normalizeUserText\(prompt\)\.trim\(\);/,
  "function seekdeepIsDirectImageAliasPrompt(prompt = '') {\\n  const p = seekdeepStripCommandAddressingForRouting(prompt).trim();",
  false
);

replaceRegex(
  'direct image verb stripper strips command addressing',
  /function seekdeepStripDirectImageVerb\(prompt = ''\) \{\s*return normalizeUserText\(prompt\)/,
  "function seekdeepStripDirectImageVerb(prompt = '') {\\n  return seekdeepStripCommandAddressingForRouting(prompt)",
  false
);

if (out === source) {
  throw new Error('Patch made no changes; refusing to continue.');
}

fs.writeFileSync(indexPath, out, 'utf8');
console.log('Patched index.js successfully.');
for (const change of changes) console.log('- ' + change);
