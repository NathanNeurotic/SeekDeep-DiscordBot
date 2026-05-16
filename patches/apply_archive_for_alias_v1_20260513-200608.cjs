const fs = require('fs');
const path = require('path');

const indexPath = path.join(process.cwd(), 'index.js');
let source = fs.readFileSync(indexPath, 'utf8');

function findFunctionRange(src, functionName) {
  const signature = `function ${functionName}`;
  const start = src.indexOf(signature);
  if (start === -1) throw new Error(`Could not find ${signature}`);

  let braceStart = src.indexOf('{', start);
  if (braceStart === -1) throw new Error(`Could not find opening brace for ${functionName}`);

  let i = braceStart;
  let depth = 0;
  let state = 'code';
  while (i < src.length) {
    const ch = src[i];
    const next = src[i + 1];

    if (state === 'code') {
      if (ch === '{') {
        depth += 1;
      } else if (ch === '}') {
        depth -= 1;
        if (depth === 0) {
          return { start, end: i + 1 };
        }
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
      if (ch === '\\') {
        i += 1;
      } else if (ch === "'") {
        state = 'code';
      }
    } else if (state === 'double') {
      if (ch === '\\') {
        i += 1;
      } else if (ch === '"') {
        state = 'code';
      }
    } else if (state === 'template') {
      if (ch === '\\') {
        i += 1;
      } else if (ch === '`') {
        state = 'code';
      }
    } else if (state === 'linecomment') {
      if (ch === '\n') {
        state = 'code';
      }
    } else if (state === 'blockcomment') {
      if (ch === '*' && next === '/') {
        state = 'code';
        i += 1;
      }
    }

    i += 1;
  }

  throw new Error(`Could not find end of function ${functionName}`);
}

function replaceFunction(src, functionName, replacement) {
  const range = findFunctionRange(src, functionName);
  return src.slice(0, range.start) + replacement + src.slice(range.end);
}

const newArchiveOpenPrompt = String.raw`function seekdeepIsArchiveOpenPrompt(value = '') {
  const raw = String(value || '').trim();
  const withoutLeadingAddress = raw
    .replace(/^(?:\s*(?:<@!?\d+>|<@&\d+>|@seekdeep|@seekotics|seekdeep|seekotics)\s*)+/i, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  const withoutLeadingAddressLower = withoutLeadingAddress.toLowerCase();
  const cleaned = typeof seekdeepCleanMessageCommandPrompt === 'function'
    ? String(seekdeepCleanMessageCommandPrompt(raw) || '').replace(/\s+/g, ' ').trim().toLowerCase()
    : withoutLeadingAddressLower;

  return Boolean(
    /^(?:archive|open\s+archive)(?:\s+for)?\s+(?:shared|me)$/i.test(cleaned) ||
    /^(?:archive|open\s+archive)(?:\s+for)?\s+<@!?\d+>$/i.test(withoutLeadingAddress) ||
    /^(?:archive|open\s+archive)(?:\s+for)?\s+@/i.test(withoutLeadingAddressLower)
  );
}`;

const newArchiveOpenHandler = String.raw`async function seekdeepHandleArchiveOpenMessage(message, prompt = '') {
  if (!message || !seekdeepIsArchiveOpenPrompt(prompt || message.content || '')) return false;

  if (!message.guild) {
    await message.reply({
      content: 'Archive threads only work inside a server.',
      allowedMentions: { repliedUser: false },
    });
    return true;
  }

  const raw = String(prompt || message.content || '');
  const clean = typeof seekdeepCleanMessageCommandPrompt === 'function'
    ? String(seekdeepCleanMessageCommandPrompt(raw) || '').replace(/\s+/g, ' ').trim().toLowerCase()
    : raw.toLowerCase().trim();

  if (typeof seekdeepLogRoute === 'function') {
    seekdeepLogRoute('archive-open-message', raw);
  }

  if (/\bshared\b/i.test(clean)) {
    const { thread } = await seekdeepGetOrCreateSharedArchiveThread(message);
    await message.reply({
      content: `Shared archive: <#${thread.id}>`,
      allowedMentions: { repliedUser: false },
    });
    return true;
  }

  let targetUser = message.author;
  const selfUserId = message.client?.user?.id || null;
  const mentionedUsers = Array.from(message.mentions?.users?.values?.() || []);
  const mentioned = mentionedUsers.find((user) => user && user.id !== selfUserId) || null;

  if (mentioned) {
    targetUser = mentioned;
  } else if (!/\bme\b/i.test(clean)) {
    await message.reply({
      content: 'Use `archive me`, `archive shared`, `archive @user`, or `archive for @user`.',
      allowedMentions: { repliedUser: false },
    });
    return true;
  }

  const { thread, threadName } = await seekdeepGetOrCreateUserArchiveThread(message, targetUser);

  await message.reply({
    content: [
      mentioned ? `Archive for <@${targetUser.id}>: <#${thread.id}>` : `Your archive: <#${thread.id}>`,
      `Thread: ${threadName}`,
    ].join('\n'),
    allowedMentions: { repliedUser: false },
  });

  return true;
}`;

const before = source;
source = replaceFunction(source, 'seekdeepIsArchiveOpenPrompt', newArchiveOpenPrompt);
source = replaceFunction(source, 'seekdeepHandleArchiveOpenMessage', newArchiveOpenHandler);

if (source === before) {
  throw new Error('Patch made no changes; refusing to continue.');
}

fs.writeFileSync(indexPath, source, 'utf8');
console.log('Patched index.js successfully.');
