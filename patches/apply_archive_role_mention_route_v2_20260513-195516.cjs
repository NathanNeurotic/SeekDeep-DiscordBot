const fs = require('fs');

const indexPath = process.argv[2];
if (!indexPath) throw new Error('Missing index.js path argument.');

let src = fs.readFileSync(indexPath, 'utf8');
let next = src;
const changes = [];

const marker = 'SEEKDEEP_ARCHIVE_ROLE_MENTION_ROUTE_V2';

if (next.includes(marker)) {
  console.log('Archive role-mention route v2 marker already present; no text changes needed.');
} else {
  const functionStart = next.indexOf('function seekdeepIsArchiveOpenPrompt');
  const nextFunctionStart = next.indexOf('async function seekdeepHandleArchiveOpenMessage', functionStart);

  if (functionStart < 0 || nextFunctionStart < 0 || nextFunctionStart <= functionStart) {
    throw new Error('Could not locate seekdeepIsArchiveOpenPrompt before seekdeepHandleArchiveOpenMessage. Refusing to patch blindly.');
  }

  const oldFunctionBlock = next.slice(functionStart, nextFunctionStart);

  if (!/function\s+seekdeepIsArchiveOpenPrompt\s*\(/.test(oldFunctionBlock)) {
    throw new Error('Located archive section did not contain seekdeepIsArchiveOpenPrompt. Refusing to patch.');
  }

  const newFunctionBlock = `// ${marker}_START
function seekdeepNormalizeArchiveOpenPrompt(value = '') {
  const raw = String(value || '').trim();

  return raw
    // Discord can resolve @SeekDeep as a role mention (<@&id>) instead of the bot user mention.
    // Treat only leading user/role mentions as command-addressing noise. Later user mentions are
    // preserved so "archive @user" still targets the requested user.
    .replace(/^\\s*(?:<@(?:!|&)?\\d+>\\s*)+/g, ' ')
    .replace(/\\bseekotics\\b/gi, ' ')
    .replace(/\\bseekdeep\\b/gi, ' ')
    .replace(/^[@/\\s]+/g, ' ')
    .replace(/\\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function seekdeepIsArchiveOpenPrompt(value = '') {
  const raw = String(value || '').trim();
  const withoutAddress = seekdeepNormalizeArchiveOpenPrompt(raw);
  const cleaned = typeof seekdeepCleanMessageCommandPrompt === 'function'
    ? seekdeepCleanMessageCommandPrompt(value)
    : withoutAddress;
  const cleanedWithoutAddress = seekdeepNormalizeArchiveOpenPrompt(cleaned);

  const candidates = Array.from(new Set([
    withoutAddress,
    cleanedWithoutAddress,
  ].filter(Boolean)));

  return candidates.some((candidate) => Boolean(
    /^(?:archive\\s+(?:shared|me)|open\\s+archive(?:\\s+(?:shared|me))?)$/i.test(candidate) ||
    /^(?:archive|open\\s+archive)\\s+<@!?\\d+>$/i.test(candidate) ||
    /^archive\\s+@/i.test(candidate)
  ));
}
// ${marker}_END

`;

  next = next.slice(0, functionStart) + newFunctionBlock + next.slice(nextFunctionStart);
  changes.push('replaced seekdeepIsArchiveOpenPrompt with role-mention-aware archive command detection');
}

if (!next.includes('function seekdeepNormalizeArchiveOpenPrompt')) {
  throw new Error('Patch verification failed: normalization helper was not found after patch.');
}

if (!next.includes('(?:<@(?:!|&)?\\d+>\\s*)+')) {
  throw new Error('Patch verification failed: leading user/role mention normalizer was not found after patch.');
}

if (next !== src) {
  fs.writeFileSync(indexPath, next, 'utf8');
  for (const change of changes) console.log(`Applied: ${change}`);
} else {
  console.log('No file changes were required.');
}
