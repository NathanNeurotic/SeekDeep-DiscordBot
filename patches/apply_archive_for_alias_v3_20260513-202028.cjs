const fs = require('fs');
const path = require('path');

const indexPath = path.join(process.cwd(), 'index.js');
let source = fs.readFileSync(indexPath, 'utf8');

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function findFunctionRange(src, functionName) {
  const escapedName = escapeRegExp(functionName);
  const signatureRe = new RegExp(`(^|\\n)([ \\t]*(?:async\\s+)*function\\s+${escapedName}\\s*\\()`, 'm');
  const match = signatureRe.exec(src);

  if (!match) {
    throw new Error(`Could not find function declaration for ${functionName}`);
  }

  const linePrefixLength = match[1] ? match[1].length : 0;
  const start = match.index + linePrefixLength;
  const braceStart = src.indexOf('{', start);
  if (braceStart === -1) throw new Error(`Could not find opening brace for ${functionName}`);

  let depth = 0;
  let state = 'code';
  let templateExprDepth = 0;

  for (let i = braceStart; i < src.length; i += 1) {
    const ch = src[i];
    const next = src[i + 1];
    const prev = src[i - 1];

    if (state === 'code') {
      if (ch === '{') {
        depth += 1;
      } else if (ch === '}') {
        depth -= 1;
        if (depth === 0) return { start, end: i + 1 };
      } else if (ch === "'") {
        state = 'single';
      } else if (ch === '"') {
        state = 'double';
      } else if (ch === '`') {
        state = 'template';
      } else if (ch === '/' && next === '/') {
        state = 'linecomment';
        i += 1;
      } else if (ch === '/' && next === '*') {
        state = 'blockcomment';
        i += 1;
      }
    } else if (state === 'single') {
      if (ch === '\\') i += 1;
      else if (ch === "'") state = 'code';
    } else if (state === 'double') {
      if (ch === '\\') i += 1;
      else if (ch === '"') state = 'code';
    } else if (state === 'template') {
      if (ch === '\\') {
        i += 1;
      } else if (ch === '`') {
        state = 'code';
      } else if (ch === '$' && next === '{') {
        state = 'templateExpr';
        templateExprDepth = 1;
        i += 1;
      }
    } else if (state === 'templateExpr') {
      if (ch === "'") {
        state = 'templateExprSingle';
      } else if (ch === '"') {
        state = 'templateExprDouble';
      } else if (ch === '`') {
        state = 'templateExprTemplate';
      } else if (ch === '/' && next === '/') {
        state = 'templateExprLineComment';
        i += 1;
      } else if (ch === '/' && next === '*') {
        state = 'templateExprBlockComment';
        i += 1;
      } else if (ch === '{') {
        templateExprDepth += 1;
      } else if (ch === '}') {
        templateExprDepth -= 1;
        if (templateExprDepth === 0) state = 'template';
      }
    } else if (state === 'templateExprSingle') {
      if (ch === '\\') i += 1;
      else if (ch === "'") state = 'templateExpr';
    } else if (state === 'templateExprDouble') {
      if (ch === '\\') i += 1;
      else if (ch === '"') state = 'templateExpr';
    } else if (state === 'templateExprTemplate') {
      if (ch === '\\') i += 1;
      else if (ch === '`' && prev !== '\\') state = 'templateExpr';
    } else if (state === 'templateExprLineComment') {
      if (ch === '\n') state = 'templateExpr';
    } else if (state === 'templateExprBlockComment') {
      if (ch === '*' && next === '/') {
        state = 'templateExpr';
        i += 1;
      }
    } else if (state === 'linecomment') {
      if (ch === '\n') state = 'code';
    } else if (state === 'blockcomment') {
      if (ch === '*' && next === '/') {
        state = 'code';
        i += 1;
      }
    }
  }

  throw new Error(`Could not find end of function ${functionName}`);
}

function replaceFunction(src, functionName, replacement) {
  const range = findFunctionRange(src, functionName);
  return src.slice(0, range.start) + replacement + src.slice(range.end);
}

const newArchiveOpenPrompt = "function seekdeepIsArchiveOpenPrompt(value = '') {\n  const raw = String(value || '').trim();\n  const stripLeadingArchiveAddress = (input = '') => String(input || '')\n    .replace(/^(?:\\s*(?:<@!?\\d+>|<@&\\d+>|@seekdeep|@seekotics|seekdeep|seekotics)\\s*)+/i, ' ')\n    .replace(/^[/\\s]+/g, ' ')\n    .replace(/\\s+/g, ' ')\n    .trim();\n\n  const withoutLeadingAddress = stripLeadingArchiveAddress(raw);\n  const withoutLeadingAddressLower = withoutLeadingAddress.toLowerCase();\n  const cleanedBase = typeof seekdeepCleanMessageCommandPrompt === 'function'\n    ? seekdeepCleanMessageCommandPrompt(raw)\n    : withoutLeadingAddress;\n  const cleaned = stripLeadingArchiveAddress(cleanedBase).toLowerCase();\n\n  return Boolean(\n    /^(?:archive|open\\s+archive)(?:\\s+for)?\\s+(?:shared|me)$/i.test(cleaned) ||\n    /^(?:archive|open\\s+archive)(?:\\s+for)?\\s+<@!?\\d+>$/i.test(withoutLeadingAddress) ||\n    /^(?:archive|open\\s+archive)(?:\\s+for)?\\s+@/i.test(withoutLeadingAddressLower)\n  );\n}";

const newArchiveOpenHandler = "async function seekdeepHandleArchiveOpenMessage(message, prompt = '') {\n  if (!message || !seekdeepIsArchiveOpenPrompt(prompt || message.content || '')) return false;\n\n  if (!message.guild) {\n    await message.reply({\n      content: 'Archive threads only work inside a server.',\n      allowedMentions: { repliedUser: false },\n    });\n    return true;\n  }\n\n  const raw = String(prompt || message.content || '');\n  const cleanBase = typeof seekdeepCleanMessageCommandPrompt === 'function'\n    ? seekdeepCleanMessageCommandPrompt(raw)\n    : raw;\n  const clean = String(cleanBase || '')\n    .replace(/^(?:\\s*(?:<@!?\\d+>|<@&\\d+>|@seekdeep|@seekotics|seekdeep|seekotics)\\s*)+/i, ' ')\n    .replace(/\\s+/g, ' ')\n    .trim()\n    .toLowerCase();\n\n  if (typeof seekdeepLogRoute === 'function') {\n    seekdeepLogRoute('archive-open-message', raw);\n  }\n\n  if (/\\bshared\\b/i.test(clean)) {\n    const { thread } = await seekdeepGetOrCreateSharedArchiveThread(message);\n    await message.reply({\n      content: `Shared archive: <#${thread.id}>`,\n      allowedMentions: { repliedUser: false },\n    });\n    return true;\n  }\n\n  let targetUser = message.author;\n  const selfUserId = message.client?.user?.id || null;\n  const mentionedUsers = Array.from(message.mentions?.users?.values?.() || []);\n  const mentioned = mentionedUsers.find((user) => user && user.id !== selfUserId) || null;\n\n  if (mentioned) {\n    targetUser = mentioned;\n  } else if (!/\\bme\\b/i.test(clean)) {\n    await message.reply({\n      content: 'Use `archive me`, `archive shared`, `archive @user`, or `archive for @user`.',\n      allowedMentions: { repliedUser: false },\n    });\n    return true;\n  }\n\n  const { thread, threadName } = await seekdeepGetOrCreateUserArchiveThread(message, targetUser);\n\n  await message.reply({\n    content: [\n      mentioned ? `Archive for <@${targetUser.id}>: <#${thread.id}>` : `Your archive: <#${thread.id}>`,\n      `Thread: ${threadName}`,\n    ].join('\\n'),\n    allowedMentions: { repliedUser: false },\n  });\n\n  return true;\n}";

const before = source;
source = replaceFunction(source, 'seekdeepIsArchiveOpenPrompt', newArchiveOpenPrompt);
source = replaceFunction(source, 'seekdeepHandleArchiveOpenMessage', newArchiveOpenHandler);

if (source === before) {
  throw new Error('Patch made no changes; refusing to continue.');
}

fs.writeFileSync(indexPath, source, 'utf8');
console.log('Patched archive open aliases successfully.');
