const fs = require('fs');
const path = require('path');

const indexPath = path.join(process.cwd(), 'index.js');
let source = fs.readFileSync(indexPath, 'utf8');

function findFunctionRange(src, functionName) {
  const re = new RegExp(`(?:async\\s+)?function\\s+${functionName.replace(/[.*+?^${}()|[\\]\\]/g, '\\$&')}\\s*\\(`, 'm');
  const match = re.exec(src);
  if (!match) throw new Error(`Could not find function ${functionName}`);
  const start = match.index;
  const braceStart = src.indexOf('{', start);
  if (braceStart === -1) throw new Error(`Could not find opening brace for ${functionName}`);

  let i = braceStart;
  let depth = 0;
  let state = 'code';
  while (i < src.length) {
    const ch = src[i];
    const next = src[i + 1];

    if (state === 'code') {
      if (ch === '{') depth += 1;
      else if (ch === '}') {
        depth -= 1;
        if (depth === 0) return { start, end: i + 1 };
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
  throw new Error(`Could not find end of function ${functionName}`);
}

function replaceFunction(src, functionName, replacement) {
  const range = findFunctionRange(src, functionName);
  return src.slice(0, range.start) + replacement + src.slice(range.end);
}

function stripMarkerBlock(src, startMarker, endMarker) {
  const start = src.indexOf(startMarker);
  if (start === -1) return src;
  const end = src.indexOf(endMarker, start);
  if (end === -1) throw new Error(`Found ${startMarker} without ${endMarker}`);
  return src.slice(0, start) + src.slice(end + endMarker.length);
}

const helpFunction = [
"function seekdeepHelpText(source = null) {",
"  const prefix = '@SEEKOTICS';",
"  return [",
"    'SEEKOTICS COMMAND MAP',",
"    '=====================',",
"    '',",
"    'START HERE',",
"    prefix + ' help',",
"    prefix + ' archive help',",
"    prefix + ' status',",
"    prefix + ' ping',",
"    prefix + ' what model are you using?',",
"    '',",
"    'CHAT + WEB',",
"    prefix + ' ask <question>',",
"    '/ask prompt:<text> web:auto|off|always',",
"    'Use web:off when you want local-only answers.',",
"    '',",
"    'PROMPT REFINEMENT',",
"    prefix + ' refine <prompt>',",
"    '/refine prompt:<text>',",
"    '',",
"    'IMAGE GENERATION',",
"    prefix + ' draw me <image idea>',",
"    prefix + ' generate <image idea>',",
"    prefix + ' I need a picture of <image idea>',",
"    '/image prompt:<text> width:<number> height:<number> seed:<number>',",
"    'Buttons after generation: Regenerate Original / Regenerate Refined / Both / Download / Archive.',",
"    'Text fallback: ' + prefix + ' regenerate, ' + prefix + ' regen',",
"    '',",
"    'VISION',",
"    'Reply to an image/video with: ' + prefix + ' what is this?',",
"    '/vision file:<upload> prompt:<optional question>',",
"    '',",
"    'ARCHIVE SETUP',",
"    prefix + ' archive config',",
"    prefix + ' archive setup here',",
"    prefix + ' archive setup #channel',",
"    'Only server admins / Manage Server / Manage Channels can change the archive channel.',",
"    '',",
"    'ARCHIVE USE',",
"    prefix + ' archive me',",
"    prefix + ' archive shared',",
"    prefix + ' archive @user',",
"    prefix + ' archive for @user',",
"    prefix + ' archive status',",
"    prefix + ' post archive',",
"    'Generated-image button: Archive',",
"    '',",
"    'ARCHIVE COUNT / THREAD NAMES',",
"    prefix + ' archive count set <number>',",
"    prefix + ' archive count @user set <number>',",
"    'Thread style: coin bullet Archive bullet current nickname bullet current archived-image count.',",
"    '',",
"    'RECENT + CACHE',",
"    prefix + ' recent images',",
"    prefix + ' recent images 5',",
"    prefix + ' recent prompts',",
"    prefix + ' cache status',",
"    prefix + ' queue status',",
"    '',",
"    'MAINTENANCE',",
"    prefix + ' migrate archive',",
"    prefix + ' remigrate archive',",
"    'Migration is restricted to server managers.',",
"    '',",
"    'COMMAND GUARD',",
"    'If a command is close but unsupported, SeekDeep should answer with: Did you mean `<supported command>`?',",
"    'Unsupported commands should not fall through into normal AI chat.'",
"  ].join('\\n');",
"}"
].join('\n');

const utilityKindFunction = [
"function seekdeepUtilityPromptKind(prompt = '') {",
"  const p = normalizeUserText(prompt).toLowerCase().trim();",
"",
"  if (!p) return '';",
"",
"  // Model identity/status is a hard local command. Keep it out of Qwen chat persona routing.",
"  if (typeof seekdeepIsModelStatusQuestion === 'function' && seekdeepIsModelStatusQuestion(p)) return 'model-status';",
"",
"  // Archive dump is a hard command. Keep it out of chat/model routing.",
"  if (typeof isPostArchivePrompt === 'function' && isPostArchivePrompt(p)) return 'post-archive';",
"  if (/^(post|show|dump|upload|send)\\s+(the\\s+)?archive\\b/.test(p)) return 'post-archive';",
"",
"  // Queue status, including common typo observed during testing.",
"  if (/^(queue|que)\\s+status\\b/.test(p)) return 'image-queue';",
"  if (/^(image\\s+queue|generation\\s+queue|image\\s+generation\\s+queue)\\b/.test(p)) return 'image-queue';",
"",
"  // Help aliases. Keep archive/help variants local instead of sending them to chat.",
"  if (/^(help|commands|command list|what can you do|what are your commands)\\b/.test(p)) return 'help';",
"  if (/^(archive|archives|image|images|vision|cache|queue|recent|status|model)\\s+(help|commands)\\b/.test(p)) return 'help';",
"  if (/^(help|commands)\\s+(archive|archives|image|images|vision|cache|queue|recent|status|model)\\b/.test(p)) return 'help';",
"",
"  if (/^(cache status|image cache status|temp cache status|cache)\\b/.test(p)) return 'cache';",
"  if (/^(archive status|saved generation status|saved generations status)\\b/.test(p)) return 'archive';",
"  if (/^(recent images|recent image|image history|recent generations|generation history)\\b/.test(p)) return 'recent-images';",
"  if (/^(recent prompts|recent prompt|prompt history|last prompts|last prompt)\\b/.test(p)) return 'recent-prompts';",
"  if (typeof seekdeepIsTextRegenerateImagePrompt === 'function' && seekdeepIsTextRegenerateImagePrompt(p)) return 'regenerate-image';",
"  if (/^(admin status|am i admin)\\b/.test(p)) return 'admin';",
"",
"  return '';",
"}"
].join('\n');

const suggestionFunctions = [
"// SEEKDEEP_COMMAND_SUGGESTIONS_V1_START",
"function seekdeepNormalizeCommandSuggestionInput(value = '') {",
"  const raw = String(value || '');",
"  const cleaned = typeof seekdeepCleanMessageCommandPrompt === 'function'",
"    ? String(seekdeepCleanMessageCommandPrompt(raw) || '')",
"    : raw",
"        .replace(/<@!?\\d+>/g, ' ')",
"        .replace(/<@&\\d+>/g, ' ')",
"        .replace(/\\bseekdeep\\b/gi, ' ')",
"        .replace(/\\bseekotics\\b/gi, ' ')",
"        .replace(/^[@/\\s]+/g, ' ');",
"",
"  return cleaned",
"    .toLowerCase()",
"    .replace(/[â€˜â€™]/g, \"'\")",
"    .replace(/[^a-z0-9@#'\\s-]+/g, ' ')",
"    .replace(/\\s+/g, ' ')",
"    .trim();",
"}",
"",
"function seekdeepCommandSuggestionDistance(a = '', b = '') {",
"  a = String(a || '');",
"  b = String(b || '');",
"  const rows = a.length + 1;",
"  const cols = b.length + 1;",
"  const dp = Array.from({ length: rows }, () => Array(cols).fill(0));",
"  for (let i = 0; i < rows; i++) dp[i][0] = i;",
"  for (let j = 0; j < cols; j++) dp[0][j] = j;",
"  for (let i = 1; i < rows; i++) {",
"    for (let j = 1; j < cols; j++) {",
"      const cost = a[i - 1] === b[j - 1] ? 0 : 1;",
"      dp[i][j] = Math.min(",
"        dp[i - 1][j] + 1,",
"        dp[i][j - 1] + 1,",
"        dp[i - 1][j - 1] + cost",
"      );",
"    }",
"  }",
"  return dp[a.length][b.length];",
"}",
"",
"function seekdeepKnownCommandSuggestions() {",
"  return [",
"    { command: '@SEEKOTICS help', aliases: ['help', 'commands', 'command list', 'archive help', 'help archive'] },",
"    { command: '@SEEKOTICS status', aliases: ['status', 'bot status', 'server status', 'backend status'] },",
"    { command: '@SEEKOTICS ping', aliases: ['ping', 'pong'] },",
"    { command: '@SEEKOTICS what model are you using?', aliases: ['model', 'models', 'model status', 'what model'] },",
"    { command: '@SEEKOTICS ask <question>', aliases: ['ask', 'question', 'chat'] },",
"    { command: '@SEEKOTICS refine <prompt>', aliases: ['refine', 'rewrite prompt', 'improve prompt'] },",
"    { command: '@SEEKOTICS draw me <image idea>', aliases: ['draw', 'draw me', 'image', 'generate image', 'picture'] },",
"    { command: '@SEEKOTICS regenerate', aliases: ['regen', 'regenerate', 'reroll'] },",
"    { command: '@SEEKOTICS archive setup here', aliases: ['archive setup here', 'archive configure here', 'set archive here'] },",
"    { command: '@SEEKOTICS archive setup #channel', aliases: ['archive setup channel', 'archive channel', 'set archive channel'] },",
"    { command: '@SEEKOTICS archive config', aliases: ['archive config', 'archive configuration', 'archive settings'] },",
"    { command: '@SEEKOTICS archive me', aliases: ['archive me', 'my archive', 'open my archive'] },",
"    { command: '@SEEKOTICS archive @user', aliases: ['archive user', 'archive @user', 'open archive user'] },",
"    { command: '@SEEKOTICS archive for @user', aliases: ['archive for user', 'archive for @user', 'archive of user'] },",
"    { command: '@SEEKOTICS archive shared', aliases: ['archive shared', 'shared archive', 'open shared archive'] },",
"    { command: '@SEEKOTICS archive status', aliases: ['archive status', 'archive stats', 'archive info'] },",
"    { command: '@SEEKOTICS archive count set <number>', aliases: ['archive count set', 'set archive count', 'archive counter'] },",
"    { command: '@SEEKOTICS post archive', aliases: ['post archive', 'dump archive', 'show archive'] },",
"    { command: '@SEEKOTICS cache status', aliases: ['cache status', 'image cache', 'temp cache'] },",
"    { command: '@SEEKOTICS queue status', aliases: ['queue status', 'que status', 'image queue'] },",
"    { command: '@SEEKOTICS recent images', aliases: ['recent images', 'recent image', 'image history', 'recent generations'] },",
"    { command: '@SEEKOTICS recent prompts', aliases: ['recent prompts', 'prompt history'] },",
"    { command: '@SEEKOTICS migrate archive', aliases: ['migrate archive', 'archive migrate', 'remigrate archive'] },",
"  ];",
"}",
"",
"function seekdeepLooksCommandLike(value = '') {",
"  const p = seekdeepNormalizeCommandSuggestionInput(value);",
"  if (!p) return false;",
"  const first = p.split(/\\s+/)[0] || '';",
"  return /^(ask|image|img|draw|picture|generate|refine|vision|look|status|stat|help|commands|archive|archiv|arcive|cache|queue|que|recent|prompt|model|ping|pong|regen|regenerate|reroll|post|migrate|remigrate|purge|clear|delete|wipe)$/.test(first);",
"}",
"",
"function seekdeepCommandSuggestionText(prompt = '') {",
"  const p = seekdeepNormalizeCommandSuggestionInput(prompt);",
"  if (!p) return '';",
"",
"  const exactAliases = new Set();",
"  for (const item of seekdeepKnownCommandSuggestions()) {",
"    for (const alias of item.aliases || []) exactAliases.add(seekdeepNormalizeCommandSuggestionInput(alias));",
"  }",
"  if (exactAliases.has(p)) return '';",
"",
"  const direct = [",
"    { re: /^(?:purge|purge archive|archive purge|clear archive|wipe archive|delete archive)$/i, command: '@SEEKOTICS archive status', note: 'Purge is not exposed as a normal chat command. Check archive status first; destructive archive cleanup should stay admin-only and explicit.' },",
"    { re: /^(?:purge cache|clear cache|delete cache|wipe cache)$/i, command: '@SEEKOTICS cache status', note: 'Cache purge is not exposed as a normal chat command. Check cache status first.' },",
"    { re: /^(?:archive count|count archive)$/i, command: '@SEEKOTICS archive count set <number>', note: 'Use the count command only when correcting the tracked archived-image count.' },",
"    { re: /^(?:archive setup|setup archive|archive set)$/i, command: '@SEEKOTICS archive setup here', note: 'Server archive setup can also target a channel: `@SEEKOTICS archive setup #channel`.' },",
"    { re: /^(?:archive channel|set archive channel)$/i, command: '@SEEKOTICS archive setup #channel', note: 'Only server admins / Manage Server / Manage Channels can change the archive channel.' },",
"  ].find((item) => item.re.test(p));",
"",
"  if (direct) {",
"    return ['Did you mean `' + direct.command + '`?', '', direct.note].filter(Boolean).join('\\n');",
"  }",
"",
"  if (!seekdeepLooksCommandLike(p)) return '';",
"",
"  let best = null;",
"  for (const item of seekdeepKnownCommandSuggestions()) {",
"    for (const alias of item.aliases || []) {",
"      const a = seekdeepNormalizeCommandSuggestionInput(alias);",
"      if (!a) continue;",
"      const prefixBoost = a.startsWith(p) || p.startsWith(a) ? -1 : 0;",
"      const sharedWords = p.split(/\\s+/).filter((word) => word.length > 2 && a.split(/\\s+/).includes(word)).length;",
"      const distance = seekdeepCommandSuggestionDistance(p.slice(0, 42), a.slice(0, 42));",
"      const score = distance + prefixBoost - sharedWords;",
"      if (!best || score < best.score) best = { score, command: item.command, alias: a, distance, sharedWords };",
"    }",
"  }",
"",
"  if (!best) return '';",
"  const allowedDistance = p.length <= 6 ? 2 : Math.max(2, Math.ceil(Math.min(p.length, best.alias.length) * 0.34));",
"  const closeEnough = best.distance <= allowedDistance || best.sharedWords >= 1;",
"  if (!closeEnough) return '';",
"",
"  return ['Did you mean `' + best.command + '`?', '', 'Use `@SEEKOTICS help` for the full supported command map.'].join('\\n');",
"}",
"// SEEKDEEP_COMMAND_SUGGESTIONS_V1_END"
].join('\n');

const routeBlock = [
"    // SEEKDEEP_COMMAND_SUGGESTION_ROUTE_V1_START",
"    const seekdeepSuggestedCommandText = typeof seekdeepCommandSuggestionText === 'function' ? seekdeepCommandSuggestionText(prompt) : '';",
"    if (seekdeepSuggestedCommandText) {",
"      seekdeepLogRoute('command-suggestion', prompt);",
"      remember(key, 'user', prompt);",
"      remember(key, 'assistant', seekdeepSuggestedCommandText);",
"      seekdeepSetResponseModel(message, seekdeepNoModelLabel());",
"      await sendLongMessageReply(message, asTextBlock(seekdeepSuggestedCommandText));",
"      return;",
"    }",
"    // SEEKDEEP_COMMAND_SUGGESTION_ROUTE_V1_END"
].join('\n');

const before = source;
source = replaceFunction(source, 'seekdeepHelpText', helpFunction);
source = replaceFunction(source, 'seekdeepUtilityPromptKind', utilityKindFunction);

source = stripMarkerBlock(source, '// SEEKDEEP_COMMAND_SUGGESTIONS_V1_START', '// SEEKDEEP_COMMAND_SUGGESTIONS_V1_END');
const utilityAnchor = 'function seekdeepUtilityPromptKind(prompt = \'\') {';
const utilityIndex = source.indexOf(utilityAnchor);
if (utilityIndex === -1) throw new Error('Could not find seekdeepUtilityPromptKind anchor after replacement.');
source = source.slice(0, utilityIndex) + suggestionFunctions + '\n\n' + source.slice(utilityIndex);

source = stripMarkerBlock(source, '    // SEEKDEEP_COMMAND_SUGGESTION_ROUTE_V1_START', '    // SEEKDEEP_COMMAND_SUGGESTION_ROUTE_V1_END');
const routeAnchor = '    const utilityKind = seekdeepUtilityPromptKind(prompt);';
if (!source.includes(routeAnchor)) throw new Error('Could not find message utilityKind route anchor.');
source = source.replace(routeAnchor, routeAnchor + '\n\n' + routeBlock);

if (source === before) throw new Error('Patch made no changes; refusing to continue.');
fs.writeFileSync(indexPath, source, 'utf8');
console.log('Patched help text and command suggestions successfully.');
