const fs = require('fs');
const path = require('path');

const indexPath = path.join(process.cwd(), 'index.js');
let source = fs.readFileSync(indexPath, 'utf8');
let out = source;
const changes = [];
const warnings = [];

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

function patchFunction(functionName, patcher, required = true) {
  try {
    const range = findFunctionRange(out, functionName);
    const oldText = out.slice(range.start, range.end);
    const newText = patcher(oldText);
    if (newText === oldText) {
      if (required) throw new Error('No changes made inside ' + functionName);
      warnings.push('no changes made inside optional ' + functionName);
      return;
    }
    out = out.slice(0, range.start) + newText + out.slice(range.end);
    changes.push('patched ' + functionName);
  } catch (err) {
    if (required) throw err;
    warnings.push('optional patch skipped for ' + functionName + ': ' + (err?.message || err));
  }
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

const imageActionReplacement = [
"function seekdeepImageActionComponents(actionId, downloadUrl = null) {",
"  const primary = new ActionRowBuilder().addComponents(",
"    new ButtonBuilder()",
"      .setCustomId(`seekdeep:regen:original:${actionId}`)",
"      .setLabel('Original')",
"      .setStyle(ButtonStyle.Secondary),",
"    new ButtonBuilder()",
"      .setCustomId(`seekdeep:regen:refined:${actionId}`)",
"      .setLabel('Refined')",
"      .setStyle(ButtonStyle.Primary),",
"    new ButtonBuilder()",
"      .setCustomId(`seekdeep:regen:both:${actionId}`)",
"      .setLabel('Both')",
"      .setStyle(ButtonStyle.Success)",
"  );",
"",
"  const secondaryButtons = [",
"    new ButtonBuilder()",
"      .setCustomId(`seekdeep:archive:${actionId}`)",
"      .setLabel('Archive')",
"      .setStyle(ButtonStyle.Success),",
"    new ButtonBuilder()",
"      .setCustomId(`seekdeep:sharedarchive:${actionId}`)",
"      .setLabel('Shared Archive')",
"      .setStyle(ButtonStyle.Primary),",
"  ];",
"",
"  if (downloadUrl) {",
"    secondaryButtons.push(",
"      new ButtonBuilder()",
"        .setLabel('Download')",
"        .setStyle(ButtonStyle.Link)",
"        .setURL(downloadUrl)",
"    );",
"  }",
"",
"  return [primary, new ActionRowBuilder().addComponents(...secondaryButtons)];",
"}",
"",
"function seekdeepImageActionRow(actionId, downloadUrl = null) {",
"  // Backward-compatible fallback for old callers. New message sends should use seekdeepImageActionComponents(...).",
"  const buttons = [",
"    new ButtonBuilder()",
"      .setCustomId(`seekdeep:regen:original:${actionId}`)",
"      .setLabel('Original')",
"      .setStyle(ButtonStyle.Secondary),",
"    new ButtonBuilder()",
"      .setCustomId(`seekdeep:regen:refined:${actionId}`)",
"      .setLabel('Refined')",
"      .setStyle(ButtonStyle.Primary),",
"    new ButtonBuilder()",
"      .setCustomId(`seekdeep:regen:both:${actionId}`)",
"      .setLabel('Both')",
"      .setStyle(ButtonStyle.Success),",
"    new ButtonBuilder()",
"      .setCustomId(`seekdeep:archive:${actionId}`)",
"      .setLabel('Archive')",
"      .setStyle(ButtonStyle.Success),",
"    new ButtonBuilder()",
"      .setCustomId(`seekdeep:sharedarchive:${actionId}`)",
"      .setLabel('Shared Archive')",
"      .setStyle(ButtonStyle.Primary),",
"  ];",
"  return new ActionRowBuilder().addComponents(...buttons);",
"}"
].join('\n');

replaceFunction('seekdeepImageActionRow', imageActionReplacement);

out = out.replace(/components:\s*\[\s*seekdeepImageActionRow\(([^)]*)\)\s*\]/g, (m, args) => {
  changes.push('converted image action components call');
  return `components: seekdeepImageActionComponents(${args})`;
});

const sharedHelpers = [
"// SEEKDEEP_SHARED_ARCHIVE_BUTTON_V1_START",
"const SEEKDEEP_SHARED_ARCHIVE_COUNT_SOURCE = 'seekdeep-shared-archive-posts-v1';",
"",
"function seekdeepSharedArchiveThreadBuildName(count = 0) {",
"  const bullet = typeof seekdeepArchiveThreadBullet === 'function' ? seekdeepArchiveThreadBullet() : '\\u2022';",
"  const coin = typeof seekdeepArchiveThreadCoinEmoji === 'function' ? seekdeepArchiveThreadCoinEmoji() : '\\u{1FA99}';",
"  const safeCount = Math.max(0, Number(count || 0) || 0);",
"  const name = [coin, 'Shared Archive', String(safeCount)].join(' ' + bullet + ' ');",
"  return typeof seekdeepArchiveThreadClampName === 'function' ? seekdeepArchiveThreadClampName(name) : name.slice(0, 96);",
"}",
"",
"function seekdeepSharedArchiveGetProfile(guildId = '') {",
"  const gid = String(guildId || '').trim();",
"  if (!gid) return {};",
"  const config = typeof seekdeepArchiveThreadReadConfig === 'function' ? seekdeepArchiveThreadReadConfig() : {};",
"  const guildConfig = typeof seekdeepArchiveThreadEnsureGuildConfig === 'function' ? seekdeepArchiveThreadEnsureGuildConfig(config, gid) : ((config.guilds ||= {})[gid] ||= {});",
"  return Object.assign({}, guildConfig.sharedArchive || {});",
"}",
"",
"function seekdeepSharedArchiveSaveProfile(guildId = '', profile = {}) {",
"  const gid = String(guildId || '').trim();",
"  if (!gid) return false;",
"  const config = typeof seekdeepArchiveThreadReadConfig === 'function' ? seekdeepArchiveThreadReadConfig() : {};",
"  const guildConfig = typeof seekdeepArchiveThreadEnsureGuildConfig === 'function' ? seekdeepArchiveThreadEnsureGuildConfig(config, gid) : ((config.guilds ||= {})[gid] ||= {});",
"  guildConfig.sharedArchive = Object.assign({}, guildConfig.sharedArchive || {}, profile || {}, { updatedAt: new Date().toISOString() });",
"  return typeof seekdeepArchiveThreadWriteConfig === 'function' ? seekdeepArchiveThreadWriteConfig(config) : false;",
"}",
"",
"function seekdeepSharedArchiveTrustedCount(profile = {}) {",
"  if (!profile || profile.countSource !== SEEKDEEP_SHARED_ARCHIVE_COUNT_SOURCE) return 0;",
"  return Math.max(0, Number(profile.count || 0) || 0);",
"}",
"",
"async function seekdeepScanThreadArchiveEntryCount(thread, marker = 'SeekDeep Shared Archive Entry') {",
"  if (!thread?.messages?.fetch) return 0;",
"  let before = undefined;",
"  let scanned = 0;",
"  let count = 0;",
"  for (let page = 0; page < 10; page += 1) {",
"    const messages = await thread.messages.fetch({ limit: 100, ...(before ? { before } : {}) }).catch(() => null);",
"    if (!messages || !messages.size) break;",
"    const sorted = Array.from(messages.values()).sort((a, b) => Number(b.createdTimestamp || 0) - Number(a.createdTimestamp || 0));",
"    for (const message of sorted) {",
"      scanned += 1;",
"      if (String(message?.content || '').includes(marker)) count += 1;",
"    }",
"    before = sorted[sorted.length - 1]?.id;",
"    if (!before || messages.size < 100 || scanned >= 1000) break;",
"  }",
"  return count;",
"}",
"",
"async function seekdeepFindSharedArchiveThreadForStatus(channel, guild = null) {",
"  if (!channel) return null;",
"  const guildId = String(guild?.id || channel?.guild?.id || '').trim();",
"  const profile = guildId ? seekdeepSharedArchiveGetProfile(guildId) : {};",
"  const desiredPrefix = seekdeepSharedArchiveThreadBuildName(0).replace(/\\s+0$/, '');",
"  const findCandidate = (threads) => threads?.find?.((thread) => {",
"    const name = String(thread?.name || '');",
"    return (profile.threadId && thread?.id === profile.threadId) || name === 'Shared' || name.startsWith(desiredPrefix);",
"  }) || null;",
"",
"  const active = await channel.threads.fetchActive().catch(() => null);",
"  let thread = findCandidate(active?.threads);",
"  if (thread) return thread;",
"",
"  const archivedPublic = await channel.threads.fetchArchived({ type: 'public' }).catch(() => null);",
"  thread = findCandidate(archivedPublic?.threads);",
"  if (thread?.archived) await thread.setArchived(false, 'SeekDeep shared archive lookup').catch(() => null);",
"  return thread || null;",
"}",
"",
"async function seekdeepRecordSharedArchivePost(archiveInfo, target) {",
"  const thread = archiveInfo?.thread || null;",
"  const guildId = String(thread?.guild?.id || thread?.parent?.guild?.id || archiveInfo?.channel?.guild?.id || target?.guild?.id || target?.message?.guild?.id || '').trim();",
"  if (!guildId || !thread) return archiveInfo?.threadName || thread?.name || '';",
"",
"  const profile = seekdeepSharedArchiveGetProfile(guildId);",
"  let currentCount = seekdeepSharedArchiveTrustedCount(profile);",
"  if (!currentCount && !profile.countSource) {",
"    currentCount = await seekdeepScanThreadArchiveEntryCount(thread, 'SeekDeep Shared Archive Entry');",
"  }",
"  const nextCount = currentCount + 1;",
"  const nextName = seekdeepSharedArchiveThreadBuildName(nextCount);",
"  seekdeepSharedArchiveSaveProfile(guildId, {",
"    threadId: thread.id,",
"    threadName: nextName,",
"    count: nextCount,",
"    countSource: SEEKDEEP_SHARED_ARCHIVE_COUNT_SOURCE,",
"    lastArchivedAt: new Date().toISOString(),",
"  });",
"  if (typeof seekdeepMaybeRenameArchiveThread === 'function') await seekdeepMaybeRenameArchiveThread(thread, nextName);",
"  else if (thread.name !== nextName) await thread.setName(nextName, 'SeekDeep shared archive count update').catch(() => null);",
"  return nextName;",
"}",
"",
"function seekdeepSharedArchiveMetadataLines(state, target) {",
"  state = state || {};",
"  const requester = target?.user || target?.author || target?.member?.user || target?.message?.author || null;",
"  const requesterLine = requester?.id ? '<@' + requester.id + '>' : (requester?.username || 'unknown');",
"  const prompt = String(state.prompt || state.originalPrompt || state.refinedPrompt || state.generationPrompt || 'image').replace(/\\s+/g, ' ').trim();",
"  const width = Number(state.width || state.w || 1024) || 1024;",
"  const height = Number(state.height || state.h || 1024) || 1024;",
"  return [",
"    '**SeekDeep Shared Archive Entry**',",
"    'Requester: ' + requesterLine,",
"    'Prompt: ' + prompt,",
"    'Size: ' + width + 'x' + height,",
"    'Archived: ' + new Date().toISOString(),",
"  ];",
"}",
"// SEEKDEEP_SHARED_ARCHIVE_BUTTON_V1_END"
].join('\n');

insertBeforeFunction('seekdeepGetOrCreateSharedArchiveThread', sharedHelpers, 'SEEKDEEP_SHARED_ARCHIVE_BUTTON_V1_START');

const sharedThreadReplacement = [
"async function seekdeepGetOrCreateSharedArchiveThread(target) {",
"  const channel = await seekdeepGetOrCreateGuildArchiveChannel(target);",
"  const guildId = String(channel?.guild?.id || target?.guild?.id || target?.message?.guild?.id || '').trim();",
"  const profile = guildId ? seekdeepSharedArchiveGetProfile(guildId) : {};",
"  let currentCount = seekdeepSharedArchiveTrustedCount(profile);",
"  let thread = null;",
"",
"  if (profile.threadId && channel?.threads?.fetch) {",
"    thread = await channel.threads.fetch(profile.threadId).catch(() => null);",
"    if (thread?.archived) await thread.setArchived(false, 'SeekDeep shared archive write').catch(() => null);",
"  }",
"",
"  if (!thread && typeof seekdeepFindSharedArchiveThreadForStatus === 'function') {",
"    thread = await seekdeepFindSharedArchiveThreadForStatus(channel, channel?.guild || target?.guild || null);",
"  }",
"",
"  if (thread && !currentCount && !profile.countSource) {",
"    currentCount = await seekdeepScanThreadArchiveEntryCount(thread, 'SeekDeep Shared Archive Entry');",
"  }",
"",
"  const threadName = seekdeepSharedArchiveThreadBuildName(currentCount);",
"",
"  if (!thread) {",
"    thread = await channel.threads.create({",
"      name: threadName,",
"      autoArchiveDuration: 10080,",
"      reason: 'SeekDeep shared image archive thread',",
"    });",
"    await thread.send('ðŸª™ SeekDeep shared archive.\\nSaved generations from this server will appear here.').catch(() => null);",
"  } else if (thread.name !== threadName) {",
"    if (typeof seekdeepMaybeRenameArchiveThread === 'function') await seekdeepMaybeRenameArchiveThread(thread, threadName);",
"    else await thread.setName(threadName, 'SeekDeep shared archive tracked-count name update').catch(() => null);",
"  }",
"",
"  if (guildId) {",
"    seekdeepSharedArchiveSaveProfile(guildId, {",
"      threadId: thread.id,",
"      threadName,",
"      count: currentCount,",
"      countSource: SEEKDEEP_SHARED_ARCHIVE_COUNT_SOURCE,",
"    });",
"  }",
"",
"  return { channel, thread, threadName, count: currentCount, shared: true };",
"}"
].join('\n');

replaceFunction('seekdeepGetOrCreateSharedArchiveThread', sharedThreadReplacement);

const sharedArchiveStateFn = [
"async function seekdeepArchiveImageStateToSharedDiscordThread(state, target) {",
"  state = state || {};",
"  target = target || null;",
"",
"  const archiveInfo = await seekdeepGetOrCreateSharedArchiveThread(target);",
"  const thread = archiveInfo.thread;",
"  let threadName = archiveInfo.threadName;",
"",
"  const payload = {",
"    content: seekdeepSharedArchiveMetadataLines(state, target).join('\\n'),",
"  };",
"",
"  let filePath = '';",
"  try {",
"    filePath = await seekdeepMaterializeArchiveFileFromState(state, target);",
"    if (filePath) payload.files = [filePath];",
"  } catch (err) {",
"    console.warn('SeekDeep shared archive attachment materialization failed:', err?.message || err);",
"  }",
"",
"  if (!payload.files || !payload.files.length) {",
"    const fallbackAttachment = target?.message?.attachments?.first?.() || target?.attachments?.first?.() || null;",
"    const fallbackUrl = String(state.attachmentUrl || state.url || state.downloadUrl || state.proxyURL || fallbackAttachment?.url || fallbackAttachment?.proxyURL || '').trim();",
"    payload.content += fallbackUrl ? '\\nImage URL: ' + fallbackUrl : '\\nImage attachment unavailable.';",
"  }",
"",
"  await thread.send(payload);",
"",
"  if (typeof seekdeepRecordSharedArchivePost === 'function') {",
"    threadName = await seekdeepRecordSharedArchivePost(archiveInfo, target);",
"  }",
"",
"  if (filePath && /[\\\\/]saved_generations[\\\\/]temp_archive_uploads[\\\\/]/i.test(filePath)) {",
"    try { fs.unlinkSync(filePath); } catch {}",
"  }",
"",
"  return {",
"    ok: true,",
"    backend: 'discord-shared-thread',",
"    threadId: thread.id,",
"    threadName,",
"    channelId: thread.parentId || thread.parent?.id || '',",
"    postedImage: Boolean(payload.files && payload.files.length),",
"    shared: true,",
"  };",
"}"
].join('\n');

insertBeforeFunction('seekdeepArchiveImageStateToDiscordThread', sharedArchiveStateFn, 'seekdeepArchiveImageStateToSharedDiscordThread');

function patchImageButtonFunction(fn) {
  let patched = fn;
  if (!patched.includes('sharedarchive')) {
    patched = patched
      .replace(/regenerate\|download\|archive/g, 'regenerate|download|archive|sharedarchive|shared-archive|shared_archive')
      .replace(/regenerate\|download\|archive\|save/g, 'regenerate|download|archive|sharedarchive|shared-archive|shared_archive|save')
      .replace(/regen\|archive\|save/g, 'regen|archive|sharedarchive|shared-archive|shared_archive|save')
      .replace(/regen\|archive\|save/g, 'regen|archive|sharedarchive|shared-archive|shared_archive|save');
  }

  if (!patched.includes('SEEKDEEP_SHARED_ARCHIVE_ACTION_NORMALIZE')) {
    patched = patched.replace(
      /(\n\s*actionId = parsed\[2\] \|\| '';\n\s*}\n\n\s*)(if \(!interaction\?\.deferred|let state)/,
      `$1// SEEKDEEP_SHARED_ARCHIVE_ACTION_NORMALIZE\n  action = String(action || '').toLowerCase();\n  if (action === 'save') action = 'archive';\n  if (/^shared[-_]?archive$/i.test(action)) action = 'sharedarchive';\n\n  $2`
    );
  }

  if (!patched.includes('SEEKDEEP_SHARED_ARCHIVE_BUTTON_HANDLER_START')) {
    const block = [
"  // SEEKDEEP_SHARED_ARCHIVE_BUTTON_HANDLER_START",
"  if (action === 'sharedarchive') {",
"    try {",
"      const archiveResult = typeof seekdeepArchiveImageStateToSharedDiscordThread === 'function'",
"        ? await seekdeepArchiveImageStateToSharedDiscordThread(state, interaction)",
"        : null;",
"      await interaction.editReply({",
"        content: typeof seekdeepAppendResponseFooter === 'function'",
"          ? seekdeepAppendResponseFooter(",
"              [",
"                'Archived to shared archive.',",
"                archiveResult?.threadId ? 'Thread: <#' + archiveResult.threadId + '>' : (archiveResult?.threadName ? 'Thread: ' + archiveResult.threadName : ''),",
"              ].filter(Boolean).join('\\n'),",
"              {",
"                startedAt,",
"                modelUsed: typeof seekdeepNoModelLabel === 'function' ? seekdeepNoModelLabel() : 'local command (no AI model)',",
"              }",
"            )",
"          : 'Archived to shared archive.',",
"      });",
"      return true;",
"    } catch (err) {",
"      const reason = String(err?.message || err || 'unknown error').slice(0, 1000);",
"      await interaction.editReply({",
"        content: typeof seekdeepAppendResponseFooter === 'function'",
"          ? seekdeepAppendResponseFooter(",
"              ['Shared archive failed.', reason ? 'Reason: ' + reason : ''].filter(Boolean).join('\\n'),",
"              {",
"                startedAt,",
"                modelUsed: typeof seekdeepNoModelLabel === 'function' ? seekdeepNoModelLabel() : 'local command (no AI model)',",
"              }",
"            )",
"          : 'Shared archive failed.',",
"      });",
"      return true;",
"    }",
"  }",
"  // SEEKDEEP_SHARED_ARCHIVE_BUTTON_HANDLER_END",
""
    ].join('\n');
    patched = patched.replace(/\n\s*if \(action === 'archive'\) \{/, '\n' + block + "\n  if (action === 'archive') {");
  }

  return patched;
}

patchFunction('seekdeepHandleImageButton', patchImageButtonFunction);
patchFunction('seekdeepEmergencyHandleGeneratedImageButton', patchImageButtonFunction);

// Let status locate the new shared-thread naming scheme if the older status function is present.
out = out.replace(
  "const sharedThread = channel ? await seekdeepFindArchiveThreadByName(channel, 'Shared') : null;",
  "const sharedThread = channel && typeof seekdeepFindSharedArchiveThreadForStatus === 'function' ? await seekdeepFindSharedArchiveThreadForStatus(channel, guild) : (channel ? await seekdeepFindArchiveThreadByName(channel, 'Shared') : null);"
);

// Help text must stay current.
out = out.replace("Buttons: `Original` `Refined` `Both` `Download` `Archive`", "Buttons: `Original` `Refined` `Both` `Download` `Archive` `Shared Archive`");
out = out.replace("prefix + ' archive shared',\n    prefix + ' archive @user',", "prefix + ' archive shared',\n    prefix + ' archive status shared',\n    prefix + ' archive @user',");
out = out.replace("{ command: '@SEEKOTICS archive shared', aliases: ['archive shared', 'shared archive', 'open shared archive'] },", "{ command: '@SEEKOTICS archive shared', aliases: ['archive shared', 'shared archive', 'open shared archive'] },\n    { command: 'Shared Archive button', aliases: ['shared archive button', 'save shared', 'share archive', 'pin shared'] },");

if (out === source) throw new Error('Patch made no changes; refusing to continue.');
fs.writeFileSync(indexPath, out, 'utf8');
console.log('Patched index.js successfully.');
for (const c of changes) console.log('- ' + c);
for (const w of warnings) console.log('WARNING: ' + w);

