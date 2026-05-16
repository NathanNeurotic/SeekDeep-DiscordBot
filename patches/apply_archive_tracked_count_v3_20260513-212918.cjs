const fs = require('fs');
const path = require('path');

const indexPath = path.join(process.cwd(), 'index.js');
let source = fs.readFileSync(indexPath, 'utf8');

function findFunctionRange(src, functionName) {
  const re = new RegExp('(?:async\\s+)?function\\s+' + functionName.replace(/[.*+?^${}()|[\\]\\]/g, '\\$&') + '\\s*\\(');
  const m = re.exec(src);
  if (!m) throw new Error('Could not find function ' + functionName);
  const start = m.index;
  const braceStart = src.indexOf('{', start);
  if (braceStart === -1) throw new Error('Could not find opening brace for ' + functionName);

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
  throw new Error('Could not find end of function ' + functionName);
}

function replaceFunction(src, functionName, replacement) {
  const range = findFunctionRange(src, functionName);
  return src.slice(0, range.start) + replacement + src.slice(range.end);
}

function stripMarkedBlock(src, startMarker, endMarker) {
  const start = src.indexOf(startMarker);
  const end = src.indexOf(endMarker);
  if (start !== -1 && end !== -1 && end > start) {
    return src.slice(0, start) + src.slice(end + endMarker.length);
  }
  return src;
}

function insertAtFunctionTop(src, functionName, insertion) {
  const range = findFunctionRange(src, functionName);
  const body = src.slice(range.start, range.end);
  if (body.includes(insertion.trim().split('\n')[0].trim())) return src;
  const brace = body.indexOf('{');
  if (brace === -1) throw new Error('Could not find body brace for ' + functionName);
  const replaced = body.slice(0, brace + 1) + '\n' + insertion + body.slice(brace + 1);
  return src.slice(0, range.start) + replaced + src.slice(range.end);
}

function insertBeforeReturnBoolean(src, functionName, insertion) {
  const range = findFunctionRange(src, functionName);
  const body = src.slice(range.start, range.end);
  if (body.includes(insertion.trim().split('\n')[0].trim())) return src;
  const needle = 'return Boolean(';
  const idx = body.indexOf(needle);
  if (idx === -1) throw new Error('Could not find return Boolean anchor in ' + functionName);
  const replaced = body.slice(0, idx) + insertion + body.slice(idx);
  return src.slice(0, range.start) + replaced + src.slice(range.end);
}

const helperStart = '// SEEKDEEP_ARCHIVE_COIN_THREAD_NAMES_START';
const helperEnd = '// SEEKDEEP_ARCHIVE_COIN_THREAD_NAMES_END';
const oldBrandStart = '// SEEKDEEP_ARCHIVE_THREAD_BRANDING_START';
const oldBrandEnd = '// SEEKDEEP_ARCHIVE_THREAD_BRANDING_END';

const helperBlock = [
  helperStart,
  "const SEEKDEEP_ARCHIVE_THREAD_NAME_CONFIG_PATH = path.join(__dirname, 'data', 'archive-guild-config.json');",
  "const SEEKDEEP_ARCHIVE_COUNT_SOURCE = 'seekdeep-archive-posts-v3';",
  '',
  'function seekdeepArchiveThreadReadConfig() {',
  '  try {',
  "    if (typeof seekdeepReadArchiveGuildConfig === 'function') return seekdeepReadArchiveGuildConfig();",
  '    if (!fs.existsSync(SEEKDEEP_ARCHIVE_THREAD_NAME_CONFIG_PATH)) return { guilds: {} };',
  "    const parsed = JSON.parse(fs.readFileSync(SEEKDEEP_ARCHIVE_THREAD_NAME_CONFIG_PATH, 'utf8'));",
  "    if (!parsed || typeof parsed !== 'object') return { guilds: {} };",
  "    if (!parsed.guilds || typeof parsed.guilds !== 'object') parsed.guilds = {};",
  '    return parsed;',
  '  } catch (err) {',
  "    console.warn('SeekDeep archive thread config read failed:', err?.message || err);",
  '    return { guilds: {} };',
  '  }',
  '}',
  '',
  'function seekdeepArchiveThreadWriteConfig(config) {',
  '  try {',
  "    if (typeof seekdeepWriteArchiveGuildConfig === 'function') return seekdeepWriteArchiveGuildConfig(config);",
  "    const safe = config && typeof config === 'object' ? config : { guilds: {} };",
  "    if (!safe.guilds || typeof safe.guilds !== 'object') safe.guilds = {};",
  '    fs.mkdirSync(path.dirname(SEEKDEEP_ARCHIVE_THREAD_NAME_CONFIG_PATH), { recursive: true });',
  "    fs.writeFileSync(SEEKDEEP_ARCHIVE_THREAD_NAME_CONFIG_PATH, JSON.stringify(safe, null, 2) + '\\n', 'utf8');",
  '    return true;',
  '  } catch (err) {',
  "    console.warn('SeekDeep archive thread config write failed:', err?.message || err);",
  '    return false;',
  '  }',
  '}',
  '',
  "function seekdeepArchiveThreadEnsureGuildConfig(config, guildId = '') {",
  "  if (!config.guilds || typeof config.guilds !== 'object') config.guilds = {};",
  "  const gid = String(guildId || '').trim();",
  '  if (!gid) return { userArchives: {} };',
  "  if (!config.guilds[gid] || typeof config.guilds[gid] !== 'object') config.guilds[gid] = {};",
  "  if (!config.guilds[gid].userArchives || typeof config.guilds[gid].userArchives !== 'object') config.guilds[gid].userArchives = {};",
  '  return config.guilds[gid];',
  '}',
  '',
  'function seekdeepArchiveThreadClampName(value) {',
  "  const clean = String(value || '')",
  "    .replace(/[\\r\\n\\t]+/g, ' ')",
  "    .replace(/@everyone/gi, 'everyone')",
  "    .replace(/@here/gi, 'here')",
  "    .replace(/\\s+/g, ' ')",
  '    .trim();',
  "  return Array.from(clean || '\\u{1FA99} \\u2022 Archive \\u2022 unknown \\u2022 0').slice(0, 96).join('').trim() || '\\u{1FA99} \\u2022 Archive \\u2022 unknown \\u2022 0';",
  '}',
  '',
  'function seekdeepArchiveThreadDisplayName(subject) {',
  '  subject = subject || {};',
  "  const raw = String(subject.displayName || subject.nickname || subject.globalName || subject.username || subject.user?.globalName || subject.user?.username || subject.id || subject.user?.id || 'unknown')",
  "    .replace(/[\\x00-\\x08\\x0B\\x0C\\x0E-\\x1F\\x7F]/g, '')",
  "    .replace(/[\\r\\n\\t]+/g, ' ')",
  "    .replace(/@everyone/gi, 'everyone')",
  "    .replace(/@here/gi, 'here')",
  "    .replace(/<#[0-9]+>/g, '')",
  "    .replace(/<@&?[0-9]+>/g, '')",
  "    .replace(/[`*_~|>\\[\\]{}]/g, '')",
  "    .replace(/\\s+/g, ' ')",
  '    .trim();',
  "  return Array.from(raw || 'unknown').slice(0, 42).join('').trim() || 'unknown';",
  '}',
  '',
  'function seekdeepArchiveThreadCoinEmoji() {',
  "  return seekdeepArchiveThreadClampName(String(process.env.SEEKDEEP_ARCHIVE_THREAD_EMOJI || '\\u{1FA99}')).slice(0, 8).trim() || '\\u{1FA99}';",
  '}',
  '',
  'function seekdeepArchiveThreadBullet() {',
  "  return seekdeepArchiveThreadClampName(String(process.env.SEEKDEEP_ARCHIVE_THREAD_BULLET || '\\u2022')).slice(0, 4).trim() || '\\u2022';",
  '}',
  '',
  'function seekdeepArchiveThreadBuildName(subject, count = 0) {',
  '  const safeCount = Math.max(0, Number(count || 0) || 0);',
  '  const bullet = seekdeepArchiveThreadBullet();',
  '  const parts = [',
  '    seekdeepArchiveThreadCoinEmoji(),',
  "    'Archive',",
  '    seekdeepArchiveThreadDisplayName(subject),',
  '    String(safeCount),',
  '  ];',
  "  return seekdeepArchiveThreadClampName(parts.join(' ' + bullet + ' '));",
  '}',
  '',
  'function seekdeepLegacyArchiveUserThreadName(user) {',
  '  user = user || {};',
  "  const username = String(user.username || user.globalName || user.displayName || user.id || 'unknown-user')",
  "    .replace(/[^a-zA-Z0-9_. -]+/g, '')",
  "    .replace(/\\s+/g, '-')",
  "    .replace(/-+/g, '-')",
  "    .slice(0, 48) || 'unknown-user';",
  "  const idSuffix = user.id ? '-' + String(user.id).slice(-6) : '';",
  "  return ('archive-' + username + idSuffix).slice(0, 90);",
  '}',
  '',
  "function seekdeepArchiveThreadGetUserProfile(guildId = '', userId = '') {",
  "  const gid = String(guildId || '').trim();",
  "  const uid = String(userId || '').trim();",
  '  if (!gid || !uid) return {};',
  '  const config = seekdeepArchiveThreadReadConfig();',
  '  const guildConfig = seekdeepArchiveThreadEnsureGuildConfig(config, gid);',
  '  return Object.assign({}, guildConfig.userArchives[uid] || {});',
  '}',
  '',
  'function seekdeepArchiveThreadTrustedCount(profile = {}) {',
  '  if (!profile || typeof profile !== \'object\') return 0;',
  '  if (profile.countSource !== SEEKDEEP_ARCHIVE_COUNT_SOURCE) return 0;',
  '  return Math.max(0, Number(profile.count || 0) || 0);',
  '}',
  '',
  'function seekdeepArchiveThreadHadUntrustedCount(profile = {}) {',
  '  if (!profile || typeof profile !== \'object\') return false;',
  '  if (profile.countSource === SEEKDEEP_ARCHIVE_COUNT_SOURCE) return false;',
  '  return profile.count !== undefined || profile.archiveCount !== undefined || profile.totalMessageSent !== undefined || profile.messageCount !== undefined;',
  '}',
  '',
  "function seekdeepArchiveThreadSaveUserProfile(guildId = '', userId = '', profile = {}) {",
  "  const gid = String(guildId || '').trim();",
  "  const uid = String(userId || '').trim();",
  '  if (!gid || !uid) return false;',
  '  const config = seekdeepArchiveThreadReadConfig();',
  '  const guildConfig = seekdeepArchiveThreadEnsureGuildConfig(config, gid);',
  '  const existing = guildConfig.userArchives[uid] || {};',
  '  guildConfig.userArchives[uid] = Object.assign({}, existing, profile || {}, { updatedAt: new Date().toISOString() });',
  '  return seekdeepArchiveThreadWriteConfig(config);',
  '}',
  '',
  'async function seekdeepArchiveThreadResolveMember(target, user) {',
  '  try {',
  '    const guild = target?.guild || target?.message?.guild || target?.channel?.guild || null;',
  "    const userId = String(user?.id || target?.user?.id || target?.author?.id || target?.member?.user?.id || target?.message?.author?.id || '').trim();",
  '    if (!guild || !userId) return null;',
  '    if (target?.member?.user?.id === userId && target.member.displayName) return target.member;',
  '    const cached = guild.members?.cache?.get?.(userId) || null;',
  '    if (cached) return cached;',
  "    if (typeof guild.members?.fetch === 'function') return await guild.members.fetch(userId).catch(() => null);",
  '  } catch {}',
  '  return null;',
  '}',
  '',
  'async function seekdeepMaybeRenameArchiveThread(thread, desiredName) {',
  '  try {',
  '    const name = seekdeepArchiveThreadClampName(desiredName);',
  "    if (thread && name && thread.name !== name && typeof thread.setName === 'function') {",
  "      await thread.setName(name, 'SeekDeep archive tracked-count name update');",
  '    }',
  '  } catch (err) {',
  "    console.warn('SeekDeep archive thread rename failed:', err?.message || err);",
  '  }',
  '}',
  '',
  'async function seekdeepArchiveThreadRecordPost(archiveInfo, target) {',
  '  archiveInfo = archiveInfo || {};',
  '  const thread = archiveInfo.thread || null;',
  '  const channel = archiveInfo.channel || thread?.parent || null;',
  "  const guildId = channel?.guild?.id || target?.guild?.id || target?.message?.guild?.id || '';",
  '  const user = archiveInfo.archiveUser || target?.user || target?.author || target?.member?.user || target?.message?.author || null;',
  "  const userId = String(user?.id || '').trim();",
  "  if (!guildId || !userId) return archiveInfo.threadName || thread?.name || '';",
  '  const member = await seekdeepArchiveThreadResolveMember(target, user);',
  '  const subject = member || user;',
  '  const profile = seekdeepArchiveThreadGetUserProfile(guildId, userId);',
  '  const currentCount = seekdeepArchiveThreadTrustedCount(profile);',
  '  const nextCount = currentCount + 1;',
  '  const nextName = seekdeepArchiveThreadBuildName(subject, nextCount);',
  '  const savePayload = {',
  '    threadId: thread?.id || profile.threadId || \'\',',
  '    count: nextCount,',
  '    countSource: SEEKDEEP_ARCHIVE_COUNT_SOURCE,',
  '    lastNickname: seekdeepArchiveThreadDisplayName(subject),',
  '    lastArchivedAt: new Date().toISOString(),',
  '  };',
  '  if (seekdeepArchiveThreadHadUntrustedCount(profile)) {',
  '    savePayload.legacyUntrustedCount = Number(profile.count || profile.archiveCount || 0) || 0;',
  '    savePayload.legacyUntrustedCountIgnoredAt = new Date().toISOString();',
  '  }',
  '  seekdeepArchiveThreadSaveUserProfile(guildId, userId, savePayload);',
  '  await seekdeepMaybeRenameArchiveThread(thread, nextName);',
  '  return nextName;',
  '}',
  '',
  'function seekdeepArchiveCountPromptText(raw = \'\') {',
  '  const base = String(raw || \'\')',
  '    .replace(/^(?:\\s*(?:<@!?\\d+>|<@&\\d+>|@seekdeep|@seekotics|seekdeep|seekotics)\\s*)+/i, \'\')',
  '    .replace(/\\s+/g, \' \')',
  '    .trim();',
  '  return base;',
  '}',
  '',
  'function seekdeepArchiveIsCountPrompt(raw = \'\') {',
  '  return /^archive\\s+count\\b/i.test(seekdeepArchiveCountPromptText(raw));',
  '}',
  '',
  'function seekdeepArchiveCanManageOtherCounts(member) {',
  '  try {',
  '    return Boolean(member?.permissions?.has?.(\'Administrator\') || member?.permissions?.has?.(\'ManageGuild\') || member?.permissions?.has?.(\'ManageChannels\'));',
  '  } catch { return false; }',
  '}',
  '',
  'async function seekdeepHandleArchiveCountMessage(message, raw = \'\') {',
  '  if (!message || !seekdeepArchiveIsCountPrompt(raw || message.content || \'\')) return false;',
  '  if (!message.guild) {',
  '    await message.reply({ content: \'Archive counts only work inside a server.\', allowedMentions: { repliedUser: false } });',
  '    return true;',
  '  }',
  '  const text = seekdeepArchiveCountPromptText(raw || message.content || \'\');',
  '  const targetUser = Array.from(message.mentions?.users?.values?.() || []).find((u) => u?.id && u.id !== message.client?.user?.id) || message.author;',
  '  const isOther = targetUser.id !== message.author.id;',
  '  if (isOther && !seekdeepArchiveCanManageOtherCounts(message.member)) {',
  '    await message.reply({ content: \'Only server admins/managers can change another user\\\'s archive count.\', allowedMentions: { repliedUser: false } });',
  '    return true;',
  '  }',
  '  const setMatch = text.match(/^archive\\s+count(?:\\s+<@!?\\d+>|\\s+@\\S+)?\\s+(?:set\\s+)?(\\d{1,5})\\s*$/i);',
  '  const resetMatch = /^archive\\s+count(?:\\s+<@!?\\d+>|\\s+@\\S+)?\\s+reset\\s*$/i.test(text);',
  '  const showOnly = /^archive\\s+count(?:\\s+<@!?\\d+>|\\s+@\\S+)?\\s*$/i.test(text);',
  '  const member = await seekdeepArchiveThreadResolveMember(message, targetUser);',
  '  const subject = member || targetUser;',
  '  const profile = seekdeepArchiveThreadGetUserProfile(message.guild.id, targetUser.id);',
  '  let count = seekdeepArchiveThreadTrustedCount(profile);',
  '  let changed = false;',
  '  if (setMatch) { count = Math.max(0, Number(setMatch[1] || 0) || 0); changed = true; }',
  '  else if (resetMatch) { count = 0; changed = true; }',
  '  else if (!showOnly) {',
  '    await message.reply({ content: \'Use `archive count`, `archive count set 1`, or `archive count reset`. Admins can target a user: `archive count @user set 1`.\', allowedMentions: { repliedUser: false } });',
  '    return true;',
  '  }',
  '  let archiveInfo = null;',
  '  try { archiveInfo = await seekdeepGetOrCreateUserArchiveThread(message, targetUser); } catch (err) {',
  '    await message.reply({ content: \'Archive count lookup failed: \' + (err?.message || String(err)), allowedMentions: { repliedUser: false } });',
  '    return true;',
  '  }',
  '  const thread = archiveInfo.thread;',
  '  if (changed) {',
  '    seekdeepArchiveThreadSaveUserProfile(message.guild.id, targetUser.id, {',
  '      threadId: thread?.id || profile.threadId || \'\',',
  '      count,',
  '      countSource: SEEKDEEP_ARCHIVE_COUNT_SOURCE,',
  '      lastNickname: seekdeepArchiveThreadDisplayName(subject),',
  '      countManuallySetAt: new Date().toISOString(),',
  '      countManuallySetBy: message.author.id,',
  '    });',
  '  }',
  '  const finalName = seekdeepArchiveThreadBuildName(subject, count);',
  '  await seekdeepMaybeRenameArchiveThread(thread, finalName);',
  '  await message.reply({',
  '    content: [',
  '      changed ? \'Archive count updated.\' : \'Archive count.\',',
  '      \'Thread: \' + (thread?.id ? \'<#\' + thread.id + \'>\' : finalName),',
  '      \'Name: `\' + finalName.replace(/`/g, \'\\\\`\') + \'`\',',
  '      \'Tracked archived posts: `\' + String(count) + \'`\',',
  '    ].join(\'\\n\'),',
  '    allowedMentions: { repliedUser: false },',
  '  });',
  '  return true;',
  '}',
  '',
  'async function seekdeepHandleArchiveThreadTitleMessage(message, raw = \'\') {',
  '  const prompt = String(raw || message?.content || \'\').trim();',
  '  if (await seekdeepHandleArchiveCountMessage(message, prompt)) return true;',
  '  const cleaned = typeof seekdeepCleanMessageCommandPrompt === \'function\'',
  '    ? String(seekdeepCleanMessageCommandPrompt(prompt) || \'\').replace(/\\s+/g, \' \').trim().toLowerCase()',
  '    : prompt.replace(/^(?:\\s*(?:<@!?\\d+>|<@&\\d+>|@seekdeep|@seekotics|seekdeep|seekotics)\\s*)+/i, \'\').replace(/\\s+/g, \' \').trim().toLowerCase();',
  '  if (!/^archive\\s+(?:thread\\s+)?(?:title|name|brand|rename)\\b/i.test(cleaned) && !/^archive\\s+set\\s+(?:thread\\s+)?(?:title|name|brand)\\b/i.test(cleaned)) return false;',
  '  await message.reply({',
  "    content: ['Archive thread titles are automatic now:', '`\\u{1FA99} \\u2022 Archive \\u2022 current nickname \\u2022 tracked archived-post count`', 'Use `archive count set 1` only to repair a corrupted count.'].join('\\n'),",
  '    allowedMentions: { repliedUser: false },',
  '  });',
  '  return true;',
  '}',
  helperEnd,
  ''
].join('\n');

const newArchiveUserThreadName = [
  'function seekdeepArchiveUserThreadName(user, count = 0) {',
  "  if (typeof seekdeepArchiveThreadBuildName === 'function') return seekdeepArchiveThreadBuildName(user, count);",
  '  user = user || {};',
  "  const username = String(user.username || user.globalName || user.displayName || user.id || 'unknown-user')",
  "    .replace(/[^a-zA-Z0-9_. -]+/g, '')",
  "    .replace(/\\s+/g, '-')",
  "    .replace(/-+/g, '-')",
  "    .slice(0, 48) || 'unknown-user';",
  "  return ('\\u{1FA99} \\u2022 Archive \\u2022 ' + username + ' \\u2022 ' + (Math.max(0, Number(count || 0) || 0))).slice(0, 90);",
  '}'
].join('\n');

const newGetOrCreateUserArchiveThread = [
  'async function seekdeepGetOrCreateUserArchiveThread(target, userOverride) {',
  '  target = target || null;',
  '  const channel = await seekdeepGetOrCreateGuildArchiveChannel(target);',
  '  const user = userOverride || target?.user || target?.author || target?.member?.user || target?.message?.author || null;',
  "  const guildId = channel?.guild?.id || target?.guild?.id || target?.message?.guild?.id || '';",
  "  const userId = String(user?.id || '').trim();",
  "  const member = typeof seekdeepArchiveThreadResolveMember === 'function' ? await seekdeepArchiveThreadResolveMember(target, user) : null;",
  '  const subject = member || user;',
  "  const profile = userId && guildId && typeof seekdeepArchiveThreadGetUserProfile === 'function'",
  '    ? seekdeepArchiveThreadGetUserProfile(guildId, userId)',
  '    : {};',
  "  let currentCount = typeof seekdeepArchiveThreadTrustedCount === 'function' ? seekdeepArchiveThreadTrustedCount(profile) : 0;",
  '  const untrustedCountWasIgnored = typeof seekdeepArchiveThreadHadUntrustedCount === \'function\' && seekdeepArchiveThreadHadUntrustedCount(profile);',
  "  const threadName = typeof seekdeepArchiveThreadBuildName === 'function'",
  '    ? seekdeepArchiveThreadBuildName(subject, currentCount)',
  '    : seekdeepArchiveUserThreadName(subject, currentCount);',
  '',
  '  let thread = null;',
  '  if (profile.threadId) {',
  '    thread = channel.threads?.cache?.get?.(profile.threadId) || null;',
  "    if (!thread && typeof channel.threads?.fetch === 'function') thread = await channel.threads.fetch(profile.threadId).catch(() => null);",
  '    if (thread?.archived) {',
  "      try { await thread.setArchived(false, 'SeekDeep archive write'); } catch {}",
  '    }',
  '  }',
  '',
  '  if (!thread) thread = await seekdeepFindArchiveThread(channel, threadName);',
  '',
  "  if (!thread && typeof seekdeepLegacyArchiveUserThreadName === 'function') {",
  '    const legacyName = seekdeepLegacyArchiveUserThreadName(user);',
  '    if (legacyName !== threadName) thread = await seekdeepFindArchiveThread(channel, legacyName);',
  '  }',
  '',
  '  if (!thread && userId) {',
  '    const active = await channel.threads.fetchActive().catch(() => null);',
  "    const display = typeof seekdeepArchiveThreadDisplayName === 'function' ? seekdeepArchiveThreadDisplayName(subject).toLowerCase() : '';",
  "    thread = active?.threads?.find?.((candidate) => /archive/i.test(candidate?.name || '') && (!display || String(candidate?.name || '').toLowerCase().includes(display))) || null;",
  '  }',
  '',
  '  if (!thread) {',
  '    thread = await channel.threads.create({',
  '      name: threadName,',
  '      autoArchiveDuration: 10080,',
  "      reason: 'SeekDeep archive thread for ' + (user?.id || 'unknown user'),",
  '    });',
  '    await thread.send([',
  "      '\\u{1FA99} SeekDeep archive for ' + (user?.id ? '<@' + user.id + '>' : 'unknown user') + '.',",
  "      'Thread format: coin emoji / bullet / Archive / current nickname / tracked archived-post count',",
  "      'New archived generations for this user will be posted here.'",
  "    ].join('\\n')).catch(() => null);",
  '  }',
  '',
  '  const finalThreadName = typeof seekdeepArchiveThreadBuildName === \'function\'',
  '    ? seekdeepArchiveThreadBuildName(subject, currentCount)',
  '    : seekdeepArchiveUserThreadName(subject, currentCount);',
  '',
  "  if (userId && guildId && typeof seekdeepArchiveThreadSaveUserProfile === 'function') {",
  '    const savePayload = {',
  '      threadId: thread.id,',
  '      count: currentCount,',
  '      countSource: SEEKDEEP_ARCHIVE_COUNT_SOURCE,',
  "      lastNickname: typeof seekdeepArchiveThreadDisplayName === 'function' ? seekdeepArchiveThreadDisplayName(subject) : '',",
  '    };',
  '    if (untrustedCountWasIgnored) {',
  '      savePayload.legacyUntrustedCount = Number(profile.count || profile.archiveCount || 0) || 0;',
  '      savePayload.legacyUntrustedCountIgnoredAt = new Date().toISOString();',
  '    }',
  '    seekdeepArchiveThreadSaveUserProfile(guildId, userId, savePayload);',
  "    if (typeof seekdeepMaybeRenameArchiveThread === 'function') await seekdeepMaybeRenameArchiveThread(thread, finalThreadName);",
  '  }',
  '',
  '  return { channel, thread, threadName: finalThreadName, archiveUser: user, archiveMember: member, archiveCount: currentCount };',
  '}'
].join('\n');

const newArchiveImageState = [
  'async function seekdeepArchiveImageStateToDiscordThread(state, target) {',
  '  state = state || {};',
  '  target = target || null;',
  '',
  '  const archiveInfo = await seekdeepGetOrCreateUserArchiveThread(target);',
  '  const thread = archiveInfo.thread;',
  '  let threadName = archiveInfo.threadName;',
  '',
  '  const payload = {',
  "    content: seekdeepArchiveMetadataLines(state, target).join('\\n'),",
  '  };',
  '',
  "  let filePath = '';",
  '',
  '  try {',
  '    filePath = await seekdeepMaterializeArchiveFileFromState(state, target);',
  '    if (filePath) payload.files = [filePath];',
  '  } catch (err) {',
  "    console.warn('SeekDeep archive attachment materialization failed:', err?.message || err);",
  '  }',
  '',
  '  if (!payload.files || !payload.files.length) {',
  '    const fallbackAttachment =',
  '      target?.message?.attachments?.first?.() ||',
  '      target?.attachments?.first?.() ||',
  '      null;',
  '',
  '    const fallbackUrl = String(',
  '      state.attachmentUrl ||',
  '      state.url ||',
  '      state.downloadUrl ||',
  '      state.proxyURL ||',
  '      fallbackAttachment?.url ||',
  '      fallbackAttachment?.proxyURL ||',
  "      ''",
  '    ).trim();',
  '',
  "    payload.content += fallbackUrl ? '\\nImage URL: ' + fallbackUrl : '\\nImage attachment unavailable.';",
  '  }',
  '',
  '  await thread.send(payload);',
  '',
  "  if (typeof seekdeepArchiveThreadRecordPost === 'function') {",
  '    threadName = await seekdeepArchiveThreadRecordPost(archiveInfo, target);',
  '  }',
  '',
  '  if (filePath && /[\\\\/]saved_generations[\\\\/]temp_archive_uploads[\\\\/]/i.test(filePath)) {',
  '    try { fs.unlinkSync(filePath); } catch {}',
  '  }',
  '',
  '  return {',
  '    ok: true,',
  "    backend: 'discord-thread',",
  '    threadId: thread.id,',
  '    threadName,',
  "    channelId: thread.parentId || thread.parent?.id || '',",
  '    postedImage: Boolean(payload.files && payload.files.length),',
  '  };',
  '}'
].join('\n');

let before = source;
source = stripMarkedBlock(source, helperStart, helperEnd);
source = stripMarkedBlock(source, oldBrandStart, oldBrandEnd);

const anchor = 'function seekdeepArchiveChannelName()';
const idx = source.indexOf(anchor);
if (idx === -1) throw new Error('Could not find archive channel helper anchor.');
source = source.slice(0, idx) + helperBlock + source.slice(idx);

source = replaceFunction(source, 'seekdeepArchiveUserThreadName', newArchiveUserThreadName);
source = replaceFunction(source, 'seekdeepGetOrCreateUserArchiveThread', newGetOrCreateUserArchiveThread);
source = replaceFunction(source, 'seekdeepArchiveImageStateToDiscordThread', newArchiveImageState);

try {
  source = insertBeforeReturnBoolean(source, 'seekdeepIsArchiveOpenPrompt', "  if (typeof seekdeepArchiveIsCountPrompt === 'function' && seekdeepArchiveIsCountPrompt(raw)) return true;\n\n  ");
} catch (err) {
  console.warn('Archive count prompt routing insertion skipped:', err?.message || err);
}

try {
  source = insertAtFunctionTop(source, 'seekdeepHandleArchiveOpenMessage', "  if (typeof seekdeepHandleArchiveCountMessage === 'function' && await seekdeepHandleArchiveCountMessage(message, prompt || message?.content || '')) return true;\n");
} catch (err) {
  console.warn('Archive count handler insertion skipped:', err?.message || err);
}

if (source === before) throw new Error('Patch made no changes; refusing to continue.');
fs.writeFileSync(indexPath, source, 'utf8');
console.log('Patched archive tracked-count v3 successfully.');
