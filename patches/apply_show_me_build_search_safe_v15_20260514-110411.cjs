const fs = require('fs');
const path = require('path');

const indexPath = path.join(process.cwd(), 'index.js');
const source = fs.readFileSync(indexPath, 'utf8');
let text = source;
const changes = [];

function findFunctionBounds(src, functionName) {
  const patterns = [
    new RegExp(`async\\s+function\\s+${functionName}\\s*\\(`),
    new RegExp(`function\\s+${functionName}\\s*\\(`),
  ];

  let match = null;
  for (const re of patterns) {
    match = re.exec(src);
    if (match) break;
  }
  if (!match) return null;

  const start = match.index;
  const braceStart = src.indexOf('{', match.index);
  if (braceStart < 0) throw new Error(`Could not find opening brace for ${functionName}`);

  let depth = 0;
  for (let i = braceStart; i < src.length; i += 1) {
    const ch = src[i];
    if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) {
        return { start, end: i + 1 };
      }
    }
  }
  throw new Error(`Could not find closing brace for ${functionName}`);
}

function replaceFunction(src, functionName, newCode) {
  const bounds = findFunctionBounds(src, functionName);
  if (!bounds) {
    changes.push(`skipped ${functionName} (not found)`);
    return src;
  }
  changes.push(`replaced ${functionName}`);
  return src.slice(0, bounds.start) + newCode + src.slice(bounds.end);
}

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

const cleanFn = `function seekdeepCleanMessageCommandPrompt(value) {
  return String(value || '')
    .replace(/<@!?\\d+>/g, ' ')
    .replace(/<@&\\d+>/g, ' ')
    .replace(/\\bseekotics\\b/gi, ' ')
    .replace(/\\bseekdeep\\b/gi, ' ')
    .replace(/^[@/\\s]+/g, ' ')
    .replace(/\\s+/g, ' ')
    .trim();
}`;

const explicitFn = `function seekdeepHasExplicitImageRequest(p = '') {
  const text = seekdeepCleanMessageCommandPrompt(
    (typeof normalizeUserText === 'function' ? normalizeUserText(p) : String(p || ''))
  ).toLowerCase().trim();

  if (!text) return false;

  if (/^(?:show\\s+me|show|draw\\s+me|draw|generate(?:\\s+me)?|create(?:\\s+me)?|make(?:\\s+me)?|render(?:\\s+me)?|paint(?:\\s+me)?|sketch(?:\\s+me)?|illustrate(?:\\s+me)?|design(?:\\s+me)?)\\s+\\S+/i.test(text) &&
      !/\\b(?:status|queue|help|commands|archive|cache|recent|prompt history|model status|list|ideas|suggestions|options|names|script|code|powershell|table|spreadsheet|summary|explanation)\\b/i.test(text)) {
    return true;
  }

  if (/\\b(generate|create|make|draw|render|paint|illustrate|design)\\s+(?:me\\s+)?(?:an?\\s+|some\\s+)?(?:image|picture|photo|pic|art|artwork|drawing|wallpaper|banner|logo|icon|poster|portrait)\\b/i.test(text)) {
    return true;
  }

  if (/\\b(image|picture|photo|pic|artwork|drawing|wallpaper|banner|logo|icon|poster|portrait)\\s+(?:of|for)\\b/i.test(text)) {
    return true;
  }

  if (typeof seekdeepHasVisualSubjectWords === 'function' && /\\b(?:draw|sketch|paint|illustrate|show me|show)\\b/i.test(text) && seekdeepHasVisualSubjectWords(text)) {
    return true;
  }

  return false;
}`;

const looksFn = `function seekdeepLooksLikeImagePrompt(text = '') {
  const p = seekdeepCleanMessageCommandPrompt(
    (typeof normalizeUserText === 'function' ? normalizeUserText(text) : String(text || ''))
  ).toLowerCase().trim();

  if (!p) return false;

  if (typeof seekdeepLooksLikeVisionPrompt === 'function' && seekdeepLooksLikeVisionPrompt(p)) {
    return false;
  }

  if (/\\b(image prompt|prompt only|describe an image|description only)\\b/i.test(p)) {
    return false;
  }

  if (typeof seekdeepShouldStayChatInsteadOfImage === 'function' && seekdeepShouldStayChatInsteadOfImage(p)) {
    return false;
  }

  if (seekdeepHasExplicitImageRequest(p)) {
    return true;
  }

  if (/\\b(show\\s+me|show|generate|create|make|draw|render|paint|illustrate|design)\\b/i.test(p) &&
      (!(typeof seekdeepHasVisualSubjectWords === 'function') || seekdeepHasVisualSubjectWords(p))) {
    return true;
  }

  if (typeof seekdeepHasLikelyVisualDescription === 'function' && seekdeepHasLikelyVisualDescription(p)) {
    return true;
  }

  return false;
}`;

const extractFn = `function seekdeepExtractImagePrompt(text = '') {
  let t = String(text || '');

  if (typeof seekdeepCleanImageModeTokens === 'function') {
    t = seekdeepCleanImageModeTokens(t);
  }

  t = t.replace(/<@!?\\d+>/g, ' ').replace(/<@&\\d+>/g, ' ').trim();
  t = t.replace(/^(?:hey|yo|hi|hello)\\s+/i, '');
  t = t.replace(/^(?:seekdeep|seekotics|neurabot|plugtalk)[,:]?\\s+/i, '');
  t = t.replace(/^(?:please\\s+)?(?:can you|could you|would you)\\s+/i, '');
  t = t.replace(/^(?:please\\s+)?(?:show\\s+me|show|make\\s+me|generate(?:\\s+me)?|create(?:\\s+me)?|draw(?:\\s+me)?|sketch(?:\\s+me)?|render(?:\\s+me)?|paint(?:\\s+me)?|illustrate(?:\\s+me)?|design(?:\\s+me)?)\\s+/i, '');
  t = t.replace(/^(?:an?\\s+)?(?:image|picture|photo|pic|art|artwork|drawing|wallpaper|banner|logo|icon|poster|portrait)\\s+(?:of|for)\\s+/i, '');
  t = t.replace(/^(?:i need|need|i want|want)\\s+(?:an?\\s+|some\\s+)?(?:image|picture|photo|pic|art|artwork|drawing|wallpaper|banner|logo|icon|poster|portrait)?\\s*(?:of|for)?\\s*/i, '');
  t = t.replace(/\\s+/g, ' ').trim();

  if (typeof seekdeepNormalizeObjectAccuracyPrompt === 'function') {
    t = seekdeepNormalizeObjectAccuracyPrompt(t);
  }

  return t;
}`;

text = replaceFunction(text, 'seekdeepCleanMessageCommandPrompt', cleanFn);
text = replaceFunction(text, 'seekdeepHasExplicitImageRequest', explicitFn);
text = replaceFunction(text, 'seekdeepLooksLikeImagePrompt', looksFn);
text = replaceFunction(text, 'seekdeepExtractImagePrompt', extractFn);

text = replaceBareCalls(text, 'buildSearchQuery', 'seekdeepBuildSearchQuerySafeV15');

const marker = '// SEEKDEEP_BUILD_SEARCH_QUERY_SAFE_V15_START';
if (!text.includes(marker)) {
  const block = `
// SEEKDEEP_BUILD_SEARCH_QUERY_SAFE_V15_START
function seekdeepBuildSearchQuerySafeV15(prompt, key) {
  try {
    if (typeof buildSearchQuery === 'function') {
      return buildSearchQuery(prompt, key);
    }
  } catch {}

  const normalizer =
    (typeof normalizeUserText === 'function' && normalizeUserText) ||
    (typeof seekdeepNormalizeUserTextSafeV12 === 'function' && seekdeepNormalizeUserTextSafeV12) ||
    ((value = '') => String(value || '').replace(/\\s+/g, ' ').trim());

  const cleanPrompt = normalizer(prompt || '');
  const p = cleanPrompt.toLowerCase().trim();

  let priorTopic = '';
  try {
    if (typeof getLastSubstantiveUserTopic === 'function') {
      priorTopic = key ? (getLastSubstantiveUserTopic(key) || '') : '';
    }
  } catch {
    priorTopic = '';
  }

  let isFollowup = false;
  try {
    if (typeof isLikelyFollowup === 'function') {
      isFollowup = !!isLikelyFollowup(cleanPrompt);
    } else if (typeof seekdeepShouldUseMemorySafeV13 === 'function') {
      isFollowup = !!seekdeepShouldUseMemorySafeV13(cleanPrompt);
    }
  } catch {
    isFollowup = false;
  }

  const followupNeedsPrior =
    priorTopic &&
    (
      isFollowup ||
      /\\b(look it up|search it|google it|use the internet|use web|web search|check online|actually up to date|up to date|current|latest|source|sources|verify|fact check|fact-check|should have looked)\\b/i.test(p)
    );

  if (followupNeedsPrior) {
    let query = (priorTopic + ' ' + cleanPrompt)
      .replace(/\\b(you should have|should have|please|can you|could you|would you|use the internet to|use the internet|use web|web search|look it up|search it|google it|infer|the correct answer|if you don't know)\\b/gi, ' ')
      .replace(/\\s+/g, ' ')
      .trim();

    return query || priorTopic;
  }

  return cleanPrompt;
}
// SEEKDEEP_BUILD_SEARCH_QUERY_SAFE_V15_END
`;

  const anchors = [
    '// SEEKDEEP_BUILD_PROMPT_WITH_MEMORY_SAFE_V14_START',
    '// SEEKDEEP_MEMORY_COMPAT_REPAIR_V13_START',
    "client.on('messageCreate'",
    'function seekdeepLogRoute(route',
  ];

  let inserted = false;
  for (const anchor of anchors) {
    const idx = text.indexOf(anchor);
    if (idx >= 0) {
      text = text.slice(0, idx) + block + '\n' + text.slice(idx);
      changes.push('inserted buildSearchQuery safety wrapper');
      inserted = true;
      break;
    }
  }

  if (!inserted) {
    throw new Error('Could not find a safe insertion anchor for buildSearchQuery safety wrapper.');
  }
} else {
  changes.push('buildSearchQuery safety wrapper already present');
}

if (text === source) {
  throw new Error('Patch made no changes; refusing to continue.');
}

fs.writeFileSync(indexPath, text, 'utf8');
console.log('Patched index.js successfully.');
for (const change of changes) console.log('- ' + change);

