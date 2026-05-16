const fs = require('fs');
const path = require('path');

const indexPath = path.join(process.cwd(), 'index.js');
const source = fs.readFileSync(indexPath, 'utf8');
let text = source;
const changes = [];

function replaceBareCalls(src, originalName, replacementName) {
  const re = new RegExp(`\\b${originalName}\\s*\\(`, 'g');
  let count = 0;

  const out = src.replace(re, (match, offset) => {
    const before = src.slice(Math.max(0, offset - 80), offset);
    const prev = src[offset - 1] || '';

    if (/\bfunction\s+$/.test(before)) return match;
    if (prev === '.' || prev === '$' || /[A-Za-z0-9_]/.test(prev)) return match;

    count += 1;
    return `${replacementName}(`;
  });

  if (count > 0) changes.push(`replaced ${count} ${originalName}(...) callsite(s) with ${replacementName}(...)`);
  return out;
}

text = replaceBareCalls(text, 'buildPromptWithMemory', 'seekdeepBuildPromptWithMemorySafeV14');

const marker = '// SEEKDEEP_BUILD_PROMPT_WITH_MEMORY_SAFE_V14_START';
if (!text.includes(marker)) {
  const block = `
// SEEKDEEP_BUILD_PROMPT_WITH_MEMORY_SAFE_V14_START
function seekdeepBuildPromptWithMemorySafeV14(prompt, key) {
  try {
    if (typeof buildPromptWithMemory === 'function') {
      return buildPromptWithMemory(prompt, key);
    }
  } catch {}

  const normalizer =
    (typeof normalizeUserText === 'function' && normalizeUserText) ||
    (typeof seekdeepNormalizeUserTextSafeV12 === 'function' && seekdeepNormalizeUserTextSafeV12) ||
    ((value = '') => String(value || '').replace(/\\s+/g, ' ').trim());

  const cleanPrompt = normalizer(prompt || '');

  let recent = '';
  try {
    if (typeof seekdeepGetRecentContextSafeV13 === 'function') {
      recent = seekdeepGetRecentContextSafeV13(key);
    } else if (typeof getRecentContext === 'function') {
      recent = getRecentContext(key);
    }
  } catch {
    recent = '';
  }

  let shouldUse = false;
  try {
    if (typeof seekdeepShouldUseMemorySafeV13 === 'function') {
      shouldUse = !!seekdeepShouldUseMemorySafeV13(cleanPrompt);
    } else if (typeof shouldUseMemory === 'function') {
      shouldUse = !!shouldUseMemory(cleanPrompt);
    }
  } catch {
    shouldUse = false;
  }

  if (!recent || !shouldUse) return cleanPrompt;

  return [
    'Recent Discord context is provided only to resolve this follow-up.',
    'Use it only if it is directly relevant to the current user message.',
    'If the current user message has clearly changed topic, ignore old context.',
    'Do not prefix your answer with "SeekDeep:" or "Assistant:".',
    '',
    recent,
    '',
    'Current user message: ' + cleanPrompt,
  ].join('\\n');
}
// SEEKDEEP_BUILD_PROMPT_WITH_MEMORY_SAFE_V14_END
`;

  const anchors = [
    '// SEEKDEEP_MEMORY_COMPAT_REPAIR_V13_START',
    "client.on('messageCreate'",
    'function seekdeepLogRoute(route',
  ];

  let inserted = false;
  for (const anchor of anchors) {
    const idx = text.indexOf(anchor);
    if (idx >= 0) {
      text = text.slice(0, idx) + block + '\n' + text.slice(idx);
      changes.push('inserted buildPromptWithMemory safety wrapper');
      inserted = true;
      break;
    }
  }

  if (!inserted) {
    throw new Error('Could not find a safe insertion anchor for buildPromptWithMemory safety wrapper.');
  }
} else {
  changes.push('buildPromptWithMemory safety wrapper already present');
}

if (text === source) {
  throw new Error('Patch made no changes; refusing to continue.');
}

fs.writeFileSync(indexPath, text, 'utf8');
console.log('Patched index.js successfully.');
for (const change of changes) console.log('- ' + change);

