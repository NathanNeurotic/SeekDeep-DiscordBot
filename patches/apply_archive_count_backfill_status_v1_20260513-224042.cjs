
const fs = require('fs');
const path = require('path');

const indexPath = path.join(process.cwd(), 'index.js');
let source = fs.readFileSync(indexPath, 'utf8');
let out = source;
const changes = [];

function findBalancedEnd(src, openIndex, openChar, closeChar) {
  let i = openIndex, depth = 0, state = 'code';
  while (i < src.length) {
    const ch = src[i], next = src[i + 1];
    if (state === 'code') {
      if (ch === openChar) depth += 1;
      else if (ch === closeChar) {
        depth -= 1;
        if (depth === 0) return i;
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
  return -1;
}

function findFunctionRange(src, functionName) {
  const re = new RegExp('(?:async\\s+)?function\\s+' + functionName + '\\s*\\(', 'm');
  const match = re.exec(src);
  if (!match) throw new Error('Could not find function ' + functionName);

  const start = match.index;
  const braceStart = src.indexOf('{', match.index + match[0].length - 1);
  if (braceStart < 0) throw new Error('Could not find opening brace for ' + functionName);

  const endBrace = findBalancedEnd(src, braceStart, '{', '}');
  if (endBrace < 0) throw new Error('Could not find end of function ' + functionName);

  return { start, end: endBrace + 1 };
}

function replaceFunction(functionName, replacement) {
  const range = findFunctionRange(out, functionName);
  out = out.slice(0, range.start) + replacement + out.slice(range.end);
  changes.push('replaced ' + functionName);
}

function insertBeforeFunction(functionName, block, markerText) {
  if (out.includes(markerText)) {
    changes.push(markerText + ' already present');
    return;
  }
  const range = findFunctionRange(out, functionName);
  out = out.slice(0, range.start) + block + '\n\n' + out.slice(range.start);
  changes.push('inserted ' + markerText);
}

const backfillHelpers = [
"// SEEKDEEP_ARCHIVE_COUNT_BACKFILL_V1_START",
"function seekdeepArchiveMessageLooksLikeEntry(message = {}, thread = null) {",
"  const content = String(message?.content || '');",
"  if (!/SeekDeep Image Archive Entry/i.test(content)) return false;",
"  if (!/\\bRequester\\s*:/i.test(content) || !/\\bPrompt\\s*:/i.test(content)) return false;",
"",
"  const botId = String(thread?.client?.user?.id || (typeof client !== 'undefined' && client?.user?.id) || '').trim();",
"  const authorId = String(message?.author?.id || '').trim();",
"  if (botId && authorId && authorId !== botId) return false;",
"",
"  return true;",
"}",
"",
"async function seekdeepArchiveThreadCountExistingEntries(thread, options = {}) {",
"  const maxPages = Math.max(1, Math.min(25, Number(options.maxPages || process.env.SEEKDEEP_ARCHIVE_COUNT_BACKFILL_MAX_PAGES || 10)));",
"  const pageLimit = 100;",
"  const seen = new Set();",
"  let before = null;",
"  let count = 0;",
"  let scanned = 0;",
"",
"  if (!thread?.messages || typeof thread.messages.fetch !== 'function') {",
"    return { count: 0, scanned: 0, ok: false, reason: 'thread messages are not fetchable' };",
"  }",
"",
"  try {",
"    for (let page = 0; page < maxPages; page += 1) {",
"      const request = before ? { limit: pageLimit, before } : { limit: pageLimit };",
"      const batch = await thread.messages.fetch(request).catch(() => null);",
"      const values = Array.from(batch?.values?.() || []);",
"      if (!values.length) break;",
"",
"      for (const message of values) {",
"        const id = String(message?.id || '');",
"        if (id && seen.has(id)) continue;",
"        if (id) seen.add(id);",
"        scanned += 1;",
"        if (seekdeepArchiveMessageLooksLikeEntry(message, thread)) count += 1;",
"      }",
"",
"      const oldest = values[values.length - 1];",
"      const nextBefore = String(oldest?.id || '').trim();",
"      if (!nextBefore || nextBefore === before || values.length < pageLimit) break;",
"      before = nextBefore;",
"    }",
"    return { count, scanned, ok: true };",
"  } catch (err) {",
"    return { count: 0, scanned, ok: false, reason: err?.message || String(err) };",
"  }",
"}",
"",
"async function seekdeepArchiveThreadResolveCountFromThread(thread, profile = {}) {",
"  const trusted = typeof seekdeepArchiveThreadTrustedCount === 'function'",
"    ? seekdeepArchiveThreadTrustedCount(profile)",
"    : Math.max(0, Number(profile?.count || 0) || 0);",
"  const scan = await seekdeepArchiveThreadCountExistingEntries(thread);",
"  if (!scan.ok) return { count: trusted, trusted, scannedCount: 0, scannedMessages: scan.scanned || 0, scanOk: false, reason: scan.reason || '' };",
"  const resolved = Math.max(trusted, Math.max(0, Number(scan.count || 0) || 0));",
"  return { count: resolved, trusted, scannedCount: scan.count, scannedMessages: scan.scanned || 0, scanOk: true };",
"}",
"",
"function seekdeepArchiveMakeUserTargetFromMessage(message, user) {",
"  const targetUser = user || message?.author || message?.user || null;",
"  const member = targetUser?.id && message?.guild?.members?.cache?.get",
"    ? (message.guild.members.cache.get(targetUser.id) || null)",
"    : null;",
"  return {",
"    guild: message?.guild || null,",
"    guildId: message?.guild?.id || '',",
"    channel: message?.channel || null,",
"    client: message?.client || null,",
"    message,",
"    author: targetUser,",
"    user: targetUser,",
"    member: member || (targetUser ? { user: targetUser, displayName: targetUser.globalName || targetUser.username || targetUser.id } : null),",
"  };",
"}",
"",
"async function seekdeepFindUserArchiveThreadWithoutCreate(channel, target, user, subject, profile = {}) {",
"  if (!channel?.threads || !user) return null;",
"",
"  if (profile?.threadId) {",
"    let byId = channel.threads?.cache?.get?.(profile.threadId) || null;",
"    if (!byId && typeof channel.threads?.fetch === 'function') byId = await channel.threads.fetch(profile.threadId).catch(() => null);",
"    if (byId) {",
"      if (byId.archived) { try { await byId.setArchived(false, 'SeekDeep archive status/count backfill'); } catch {} }",
"      return byId;",
"    }",
"  }",
"",
"  const trusted = typeof seekdeepArchiveThreadTrustedCount === 'function' ? seekdeepArchiveThreadTrustedCount(profile) : 0;",
"  const candidateNames = [];",
"  const pushName = (name) => {",
"    const clean = String(name || '').trim();",
"    if (clean && !candidateNames.includes(clean)) candidateNames.push(clean);",
"  };",
"",
"  if (typeof seekdeepArchiveThreadBuildName === 'function') {",
"    pushName(seekdeepArchiveThreadBuildName(subject, trusted));",
"    pushName(seekdeepArchiveThreadBuildName(subject, 0));",
"  }",
"  if (typeof seekdeepArchiveUserThreadName === 'function') {",
"    pushName(seekdeepArchiveUserThreadName(subject, trusted));",
"    pushName(seekdeepArchiveUserThreadName(subject, 0));",
"  }",
"  if (typeof seekdeepLegacyArchiveUserThreadName === 'function') pushName(seekdeepLegacyArchiveUserThreadName(user));",
"",
"  for (const name of candidateNames) {",
"    const found = typeof seekdeepFindArchiveThread === 'function'",
"      ? await seekdeepFindArchiveThread(channel, name)",
"      : null;",
"    if (found) return found;",
"  }",
"",
"  const display = typeof seekdeepArchiveThreadDisplayName === 'function'",
"    ? seekdeepArchiveThreadDisplayName(subject).toLowerCase()",
"    : String(user?.username || user?.globalName || user?.id || '').toLowerCase();",
"",
"  const candidates = [];",
"  const active = await channel.threads.fetchActive().catch(() => null);",
"  candidates.push(...Array.from(active?.threads?.values?.() || []));",
"  const archivedPublic = await channel.threads.fetchArchived({ type: 'public' }).catch(() => null);",
"  candidates.push(...Array.from(archivedPublic?.threads?.values?.() || []));",
"",
"  const fuzzy = candidates.find((candidate) => {",
"    const name = String(candidate?.name || '').toLowerCase();",
"    return /archive/i.test(name) && (!display || name.includes(display));",
"  }) || null;",
"",
"  if (fuzzy?.archived) { try { await fuzzy.setArchived(false, 'SeekDeep archive status/count backfill'); } catch {} }",
"  return fuzzy;",
"}",
"// SEEKDEEP_ARCHIVE_COUNT_BACKFILL_V1_END"
].join('\n');

insertBeforeFunction('seekdeepArchiveThreadRecordPost', backfillHelpers, 'SEEKDEEP_ARCHIVE_COUNT_BACKFILL_V1_START');

const getOrCreateUserArchiveThread = [
"async function seekdeepGetOrCreateUserArchiveThread(target, userOverride) {",
"  target = target || null;",
"  const channel = await seekdeepGetOrCreateGuildArchiveChannel(target);",
"  const user = userOverride || target?.user || target?.author || target?.member?.user || target?.message?.author || null;",
"  const guildId = channel?.guild?.id || target?.guild?.id || target?.message?.guild?.id || '';",
"  const userId = String(user?.id || '').trim();",
"  const member = typeof seekdeepArchiveThreadResolveMember === 'function' ? await seekdeepArchiveThreadResolveMember(target, user) : null;",
"  const subject = member || user;",
"  const profile = userId && guildId && typeof seekdeepArchiveThreadGetUserProfile === 'function'",
"    ? seekdeepArchiveThreadGetUserProfile(guildId, userId)",
"    : {};",
"  let currentCount = typeof seekdeepArchiveThreadTrustedCount === 'function' ? seekdeepArchiveThreadTrustedCount(profile) : 0;",
"  const untrustedCountWasIgnored = typeof seekdeepArchiveThreadHadUntrustedCount === 'function' && seekdeepArchiveThreadHadUntrustedCount(profile);",
"  const threadName = typeof seekdeepArchiveThreadBuildName === 'function'",
"    ? seekdeepArchiveThreadBuildName(subject, currentCount)",
"    : seekdeepArchiveUserThreadName(subject, currentCount);",
"",
"  let thread = null;",
"  if (profile.threadId) {",
"    thread = channel.threads?.cache?.get?.(profile.threadId) || null;",
"    if (!thread && typeof channel.threads?.fetch === 'function') thread = await channel.threads.fetch(profile.threadId).catch(() => null);",
"    if (thread?.archived) {",
"      try { await thread.setArchived(false, 'SeekDeep archive write'); } catch {}",
"    }",
"  }",
"",
"  if (!thread) thread = await seekdeepFindArchiveThread(channel, threadName);",
"",
"  if (!thread && typeof seekdeepLegacyArchiveUserThreadName === 'function') {",
"    const legacyName = seekdeepLegacyArchiveUserThreadName(user);",
"    if (legacyName !== threadName) thread = await seekdeepFindArchiveThread(channel, legacyName);",
"  }",
"",
"  if (!thread && typeof seekdeepFindUserArchiveThreadWithoutCreate === 'function') {",
"    thread = await seekdeepFindUserArchiveThreadWithoutCreate(channel, target, user, subject, profile);",
"  }",
"",
"  if (!thread) {",
"    thread = await channel.threads.create({",
"      name: threadName,",
"      autoArchiveDuration: 10080,",
"      reason: 'SeekDeep archive thread for ' + (user?.id || 'unknown user'),",
"    });",
"    await thread.send([",
"      '\\u{1FA99} SeekDeep archive for ' + (user?.id ? '<@' + user.id + '>' : 'unknown user') + '.',",
"      'New archived generations will appear here.'",
"    ].join('\\n')).catch(() => null);",
"  }",
"",
"  let countInfo = { count: currentCount, trusted: currentCount, scannedCount: 0, scannedMessages: 0, scanOk: false };",
"  if (thread && typeof seekdeepArchiveThreadResolveCountFromThread === 'function') {",
"    countInfo = await seekdeepArchiveThreadResolveCountFromThread(thread, profile);",
"    currentCount = countInfo.count;",
"  }",
"",
"  const finalThreadName = typeof seekdeepArchiveThreadBuildName === 'function'",
"    ? seekdeepArchiveThreadBuildName(subject, currentCount)",
"    : seekdeepArchiveUserThreadName(subject, currentCount);",
"",
"  if (userId && guildId && typeof seekdeepArchiveThreadSaveUserProfile === 'function') {",
"    const savePayload = {",
"      threadId: thread.id,",
"      count: currentCount,",
"      countSource: SEEKDEEP_ARCHIVE_COUNT_SOURCE,",
"      lastNickname: typeof seekdeepArchiveThreadDisplayName === 'function' ? seekdeepArchiveThreadDisplayName(subject) : '',",
"      lastCountBackfillAt: new Date().toISOString(),",
"      lastCountBackfillScannedMessages: Number(countInfo.scannedMessages || 0) || 0,",
"      lastCountBackfillArchiveEntries: Number(countInfo.scannedCount || 0) || 0,",
"    };",
"    if (untrustedCountWasIgnored) {",
"      savePayload.legacyUntrustedCount = Number(profile.count || profile.archiveCount || 0) || 0;",
"      savePayload.legacyUntrustedCountIgnoredAt = new Date().toISOString();",
"    }",
"    seekdeepArchiveThreadSaveUserProfile(guildId, userId, savePayload);",
"    if (typeof seekdeepMaybeRenameArchiveThread === 'function') await seekdeepMaybeRenameArchiveThread(thread, finalThreadName);",
"  }",
"",
"  return { channel, thread, threadName: finalThreadName, archiveUser: user, archiveMember: member, archiveCount: currentCount };",
"}"
].join('\n');

replaceFunction('seekdeepGetOrCreateUserArchiveThread', getOrCreateUserArchiveThread);

const recordPost = [
"async function seekdeepArchiveThreadRecordPost(archiveInfo, target) {",
"  archiveInfo = archiveInfo || {};",
"  const thread = archiveInfo.thread || null;",
"  const channel = archiveInfo.channel || thread?.parent || null;",
"  const guildId = channel?.guild?.id || target?.guild?.id || target?.message?.guild?.id || '';",
"  const user = archiveInfo.archiveUser || target?.user || target?.author || target?.member?.user || target?.message?.author || null;",
"  const userId = String(user?.id || '').trim();",
"  if (!guildId || !userId) return archiveInfo.threadName || thread?.name || '';",
"  const member = await seekdeepArchiveThreadResolveMember(target, user);",
"  const subject = member || user;",
"  const profile = seekdeepArchiveThreadGetUserProfile(guildId, userId);",
"  let currentCount = seekdeepArchiveThreadTrustedCount(profile);",
"  if (thread && typeof seekdeepArchiveThreadResolveCountFromThread === 'function') {",
"    const resolved = await seekdeepArchiveThreadResolveCountFromThread(thread, profile);",
"    currentCount = resolved.count;",
"  }",
"  const nextCount = currentCount + 1;",
"  const nextName = seekdeepArchiveThreadBuildName(subject, nextCount);",
"  const savePayload = {",
"    threadId: thread?.id || profile.threadId || '',",
"    count: nextCount,",
"    countSource: SEEKDEEP_ARCHIVE_COUNT_SOURCE,",
"    lastNickname: seekdeepArchiveThreadDisplayName(subject),",
"    lastArchivedAt: new Date().toISOString(),",
"  };",
"  if (seekdeepArchiveThreadHadUntrustedCount(profile)) {",
"    savePayload.legacyUntrustedCount = Number(profile.count || profile.archiveCount || 0) || 0;",
"    savePayload.legacyUntrustedCountIgnoredAt = new Date().toISOString();",
"  }",
"  seekdeepArchiveThreadSaveUserProfile(guildId, userId, savePayload);",
"  await seekdeepMaybeRenameArchiveThread(thread, nextName);",
"  return nextName;",
"}"
].join('\n');

replaceFunction('seekdeepArchiveThreadRecordPost', recordPost);

const health = [
"async function seekdeepArchiveThreadHealthForTarget(target = null) {",
"  const safeTarget = target || {};",
"  const guild = safeTarget?.guild || safeTarget?.message?.guild || safeTarget?.channel?.guild || null;",
"",
"  if (!guild) {",
"    return {",
"      scope: 'this DM',",
"      hasGuild: false,",
"      channel: null,",
"      sharedThread: null,",
"      userThread: null,",
"      userThreadName: '',",
"      userArchiveCount: 0,",
"      userDisplayName: '',",
"      error: 'Discord archive threads require a server.',",
"    };",
"  }",
"",
"  let channel = null;",
"  let error = '';",
"",
"  try {",
"    channel = await seekdeepGetOrCreateGuildArchiveChannel(safeTarget);",
"  } catch (err) {",
"    error = err?.message || String(err);",
"  }",
"",
"  const user = safeTarget?.user || safeTarget?.author || safeTarget?.member?.user || safeTarget?.message?.author || null;",
"  const member = typeof seekdeepArchiveThreadResolveMember === 'function' ? await seekdeepArchiveThreadResolveMember(safeTarget, user) : null;",
"  const subject = member || user;",
"  const guildId = guild?.id || '';",
"  const userId = String(user?.id || '').trim();",
"  const profile = userId && guildId && typeof seekdeepArchiveThreadGetUserProfile === 'function'",
"    ? seekdeepArchiveThreadGetUserProfile(guildId, userId)",
"    : {};",
"  const trustedCount = typeof seekdeepArchiveThreadTrustedCount === 'function' ? seekdeepArchiveThreadTrustedCount(profile) : 0;",
"  let userThreadName = typeof seekdeepArchiveUserThreadName === 'function'",
"    ? seekdeepArchiveUserThreadName(subject || user, trustedCount)",
"    : '';",
"",
"  const sharedThread = channel ? await seekdeepFindArchiveThreadByName(channel, 'Shared') : null;",
"  const userThread = channel && user ? await seekdeepFindUserArchiveThreadWithoutCreate(channel, safeTarget, user, subject || user, profile) : null;",
"",
"  let userArchiveCount = trustedCount;",
"  let scannedCount = 0;",
"  if (userThread && typeof seekdeepArchiveThreadResolveCountFromThread === 'function') {",
"    const countInfo = await seekdeepArchiveThreadResolveCountFromThread(userThread, profile);",
"    userArchiveCount = countInfo.count;",
"    scannedCount = countInfo.scannedCount || 0;",
"    userThreadName = typeof seekdeepArchiveThreadBuildName === 'function'",
"      ? seekdeepArchiveThreadBuildName(subject || user, userArchiveCount)",
"      : seekdeepArchiveUserThreadName(subject || user, userArchiveCount);",
"",
"    if (userId && guildId && typeof seekdeepArchiveThreadSaveUserProfile === 'function') {",
"      seekdeepArchiveThreadSaveUserProfile(guildId, userId, {",
"        threadId: userThread.id,",
"        count: userArchiveCount,",
"        countSource: SEEKDEEP_ARCHIVE_COUNT_SOURCE,",
"        lastNickname: typeof seekdeepArchiveThreadDisplayName === 'function' ? seekdeepArchiveThreadDisplayName(subject || user) : '',",
"        lastCountBackfillAt: new Date().toISOString(),",
"        lastCountBackfillArchiveEntries: scannedCount,",
"      });",
"    }",
"  }",
"",
"  return {",
"    scope: 'this server',",
"    hasGuild: true,",
"    channel,",
"    sharedThread,",
"    userThread,",
"    userThreadName,",
"    userArchiveCount,",
"    userDisplayName: typeof seekdeepArchiveThreadDisplayName === 'function' ? seekdeepArchiveThreadDisplayName(subject || user) : String(user?.username || user?.id || ''),",
"    error,",
"  };",
"}"
].join('\n');

replaceFunction('seekdeepArchiveThreadHealthForTarget', health);

const buildStatus = [
"async function seekdeepBuildArchiveStatusReportV2(target = null) {",
"  const local = seekdeepLocalArchiveStatsForTarget(target);",
"  const health = await seekdeepArchiveThreadHealthForTarget(target);",
"",
"  const lines = [",
"    'Image archive status',",
"    `Scope: ${health.scope}`,",
"    health.userDisplayName ? `User: ${health.userDisplayName}` : '',",
"    `Archive channel: ${health.channel ? `<#${health.channel.id}>` : 'missing'}`,",
"    `Shared thread: ${health.sharedThread ? `<#${health.sharedThread.id}>` : 'missing'}`,",
"    `User thread: ${health.userThread ? `<#${health.userThread.id}>` : `missing${health.userThreadName ? ` (${health.userThreadName})` : ''}`}`,",
"    `Tracked archived image posts: ${Math.max(0, Number(health.userArchiveCount || 0) || 0)}`,",
"    '',",
"    'Local fallback storage:',",
"    `Images: ${local.images}`,",
"    `Metadata files: ${local.metadata}`,",
"    `Migrated markers: ${local.migratedMarkers}`,",
"    `Total local files: ${local.files}`,",
"    `Size: ${typeof seekdeepFormatBytesCompact === 'function' ? seekdeepFormatBytesCompact(local.bytes) : `${local.bytes} B`}`,",
"    `Newest local file: ${local.newest ? local.newest.name : 'none'}`,",
"  ].filter((line) => line !== '');",
"",
"  if (health.error) {",
"    lines.push('', `Archive thread warning: ${health.error}`);",
"  }",
"",
"  return lines.join('\\n');",
"}"
].join('\n');

replaceFunction('seekdeepBuildArchiveStatusReportV2', buildStatus);

const handleStatus = [
"async function seekdeepHandleArchiveStatusMessage(message, prompt = '') {",
"  if (!message || !seekdeepIsArchiveStatusPrompt(prompt || message.content || '')) {",
"    return false;",
"  }",
"",
"  if (typeof seekdeepLogRoute === 'function') {",
"    seekdeepLogRoute('archive-status-message', prompt || message.content || '');",
"  }",
"",
"  const selfUserId = message.client?.user?.id || null;",
"  const mentionedUsers = Array.from(message.mentions?.users?.values?.() || []);",
"  const mentioned = mentionedUsers.find((user) => user && user.id !== selfUserId) || null;",
"  const statusTarget = mentioned && typeof seekdeepArchiveMakeUserTargetFromMessage === 'function'",
"    ? seekdeepArchiveMakeUserTargetFromMessage(message, mentioned)",
"    : message;",
"",
"  const startedAt = typeof seekdeepNowMs === 'function' ? seekdeepNowMs() : Date.now();",
"  const report = await seekdeepBuildArchiveStatusReportV2(statusTarget);",
"",
"  const content = typeof seekdeepAppendResponseFooter === 'function'",
"    ? seekdeepAppendResponseFooter(report, {",
"        startedAt,",
"        modelUsed: typeof seekdeepNoModelLabel === 'function' ? seekdeepNoModelLabel() : 'local command (no AI model)',",
"      })",
"    : report;",
"",
"  await message.reply({",
"    content,",
"    allowedMentions: { repliedUser: false },",
"  });",
"",
"  return true;",
"}"
].join('\n');

replaceFunction('seekdeepHandleArchiveStatusMessage', handleStatus);

if (out === source) {
  throw new Error('Patch made no changes; refusing to continue.');
}

fs.writeFileSync(indexPath, out, 'utf8');
console.log('Patched index.js successfully.');
for (const change of changes) console.log('- ' + change);

