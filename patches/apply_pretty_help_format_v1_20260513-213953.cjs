const fs = require('fs');
const path = require('path');

const indexPath = path.join(process.cwd(), 'index.js');
let source = fs.readFileSync(indexPath, 'utf8');

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function findFunctionRange(src, functionName) {
  const re = new RegExp(`(?:async\\s+)?function\\s+${escapeRegExp(functionName)}\\s*\\(`, 'm');
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

const prettyHelpFunction = [
"function seekdeepHelpText(source = null) {",
"  const prefix = '@SEEKOTICS';",
"  const robot = String.fromCodePoint(0x1F916);",
"  const check = String.fromCodePoint(0x2705);",
"  const speech = String.fromCodePoint(0x1F4AC);",
"  const art = String.fromCodePoint(0x1F3A8);",
"  const eye = String.fromCodePoint(0x1F441);",
"  const coin = String.fromCodePoint(0x1FA99);",
"  const folder = String.fromCodePoint(0x1F5C3);",
"  const counter = String.fromCodePoint(0x1F522);",
"  const clock = String.fromCodePoint(0x1F558);",
"  const tools = String.fromCodePoint(0x1F9F0);",
"  const bullet = '\\u2022';",
"",
"  return [",
"    '# ' + robot + ' SEEKOTICS COMMAND MAP',",
"    '',",
"    '## ' + check + ' Start',",
"    '```text',",
"    prefix + ' help',",
"    prefix + ' archive help',",
"    prefix + ' status',",
"    prefix + ' ping',",
"    prefix + ' what model are you using?',",
"    '```',",
"    '',",
"    '## ' + speech + ' Chat / Web / Prompting',",
"    '```text',",
"    prefix + ' ask <question>',",
"    '/ask prompt:<text> web:auto|off|always',",
"    prefix + ' refine <prompt>',",
"    '/refine prompt:<text>',",
"    '```',",
"    'Use `web:off` for local-only answers.',",
"    '',",
"    '## ' + art + ' Images',",
"    '```text',",
"    prefix + ' draw me <image idea>',",
"    prefix + ' generate <image idea>',",
"    prefix + ' I need a picture of <image idea>',",
"    '/image prompt:<text> width:<n> height:<n> seed:<n>',",
"    prefix + ' regenerate',",
"    '```',",
"    'Buttons: `Original` `Refined` `Both` `Download` `Archive`',",
"    '',",
"    '## ' + eye + ' Vision',",
"    '```text',",
"    'Reply to an image/video:',",
"    prefix + ' what is this?',",
"    '/vision file:<upload> prompt:<question>',",
"    '```',",
"    '',",
"    '## ' + coin + ' Archive Setup',",
"    '```text',",
"    prefix + ' archive config',",
"    prefix + ' archive setup here',",
"    prefix + ' archive setup #channel',",
"    '```',",
"    'Only Admin / Manage Server / Manage Channels can change this.',",
"    '',",
"    '## ' + folder + ' Archive Use',",
"    '```text',",
"    prefix + ' archive me',",
"    prefix + ' archive shared',",
"    prefix + ' archive @user',",
"    prefix + ' archive for @user',",
"    prefix + ' archive status',",
"    prefix + ' post archive',",
"    '```',",
"    '',",
"    '## ' + counter + ' Archive Count / Thread Names',",
"    '```text',",
"    prefix + ' archive count set <number>',",
"    prefix + ' archive count @user set <number>',",
"    '```',",
"    'Thread style: `' + coin + ' ' + bullet + ' Archive ' + bullet + ' current nickname ' + bullet + ' archived-image count`',",
"    '',",
"    '## ' + clock + ' Recent / Cache / Queue',",
"    '```text',",
"    prefix + ' recent images [limit]',",
"    prefix + ' recent prompts',",
"    prefix + ' cache status',",
"    prefix + ' queue status',",
"    '```',",
"    '',",
"    '## ' + tools + ' Maintenance',",
"    '```text',",
"    prefix + ' migrate archive',",
"    prefix + ' remigrate archive',",
"    '```',",
"    'Restricted to server managers.',",
"    '',",
"    'Unsupported near-commands return: `Did you mean ...?`',",
"  ].join('\\n');",
"}"
].join('\n');

const before = source;
source = replaceFunction(source, 'seekdeepHelpText', prettyHelpFunction);

const wrappedUtilityHelp = "      await sendLongMessageReply(message, asTextBlock(content));";
const rawHelpUtility = [
  "      if (utilityKind === 'help') {",
  "        await sendLongMessageReply(message, content);",
  "      } else {",
  "        await sendLongMessageReply(message, asTextBlock(content));",
  "      }",
].join('\n');

if (source.includes(rawHelpUtility)) {
  // Already patched. Leave as-is.
} else if (source.includes(wrappedUtilityHelp)) {
  source = source.replace(wrappedUtilityHelp, rawHelpUtility);
} else {
  // Some later patch may have changed spacing. Use a conservative regex around the exact send call.
  const utilityReplyRegex = /await\s+sendLongMessageReply\(message,\s*asTextBlock\(content\)\s*\);/;
  if (!utilityReplyRegex.test(source)) {
    throw new Error('Could not find utility help reply send call; refusing to patch blindly.');
  }
  source = source.replace(utilityReplyRegex, rawHelpUtility.trim());
}

// If any direct help paths wrap seekdeepHelpText in asTextBlock, unwrap only those help calls.
source = source.replace(/asTextBlock\(seekdeepHelpText\(([^)]*)\)\)/g, 'seekdeepHelpText($1)');

if (source === before) throw new Error('Patch made no changes; refusing to continue.');
fs.writeFileSync(indexPath, source, 'utf8');
console.log('Patched pretty help formatting successfully.');
