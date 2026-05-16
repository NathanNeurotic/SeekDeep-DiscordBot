$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$ProjectRoot = (Get-Location).Path
$IndexPath = Join-Path $ProjectRoot 'index.js'
$PythonPath = Join-Path $ProjectRoot '.venv\Scripts\python.exe'
$LocalAiPath = Join-Path $ProjectRoot 'local_ai_server.py'
$BackupsDir = Join-Path $ProjectRoot 'backups'
$PatchesDir = Join-Path $ProjectRoot 'patches'

if (-not (Test-Path $IndexPath)) {
  throw "index.js not found at $IndexPath. Run this from the SeekDeep project root."
}

New-Item -ItemType Directory -Path $BackupsDir -Force | Out-Null
New-Item -ItemType Directory -Path $PatchesDir -Force | Out-Null

$Stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$BackupPath = Join-Path $BackupsDir "index.js.before-archive-coin-thread-names-v1-$Stamp.bak"
Copy-Item $IndexPath $BackupPath -Force
Write-Host "Backup created: $BackupPath"

$PatchJsPath = Join-Path $PatchesDir "apply_archive_coin_thread_names_v1_$Stamp.cjs"
@'
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

const helperStart = '// SEEKDEEP_ARCHIVE_COIN_THREAD_NAMES_START';
const helperEnd = '// SEEKDEEP_ARCHIVE_COIN_THREAD_NAMES_END';
const oldBrandStart = '// SEEKDEEP_ARCHIVE_THREAD_BRANDING_START';
const oldBrandEnd = '// SEEKDEEP_ARCHIVE_THREAD_BRANDING_END';

const helperBlock = [
  helperStart,
  "const SEEKDEEP_ARCHIVE_THREAD_NAME_CONFIG_PATH = path.join(__dirname, 'data', 'archive-guild-config.json');",
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
  "  if (!gid) return { userArchives: {} };",
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
  "  return Array.from(clean || '🪙 • Archive • unknown • 0').slice(0, 96).join('').trim() || '🪙 • Archive • unknown • 0';",
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
  "  return seekdeepArchiveThreadClampName(String(process.env.SEEKDEEP_ARCHIVE_THREAD_EMOJI || '🪙')).slice(0, 8).trim() || '🪙';",
  '}',
  '',
  'function seekdeepArchiveThreadBullet() {',
  "  return seekdeepArchiveThreadClampName(String(process.env.SEEKDEEP_ARCHIVE_THREAD_BULLET || '•')).slice(0, 4).trim() || '•';",
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
  '    .slice(0, 48) || \'unknown-user\';',
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
  "function seekdeepArchiveThreadSaveUserProfile(guildId = '', userId = '', profile = {}) {",
  "  const gid = String(guildId || '').trim();",
  "  const uid = String(userId || '').trim();",
  '  if (!gid || !uid) return false;',
  '  const config = seekdeepArchiveThreadReadConfig();',
  '  const guildConfig = seekdeepArchiveThreadEnsureGuildConfig(config, gid);',
  '  guildConfig.userArchives[uid] = Object.assign({}, guildConfig.userArchives[uid] || {}, profile || {}, { updatedAt: new Date().toISOString() });',
  '  return seekdeepArchiveThreadWriteConfig(config);',
  '}',
  '',
  'async function seekdeepArchiveThreadResolveMember(target, user) {',
  '  try {',
  '    const guild = target?.guild || target?.message?.guild || target?.channel?.guild || null;',
  '    const userId = String(user?.id || target?.user?.id || target?.author?.id || target?.member?.user?.id || target?.message?.author?.id || \'\').trim();',
  '    if (!guild || !userId) return null;',
  '    if (target?.member?.user?.id === userId && target.member.displayName) return target.member;',
  '    const cached = guild.members?.cache?.get?.(userId) || null;',
  '    if (cached) return cached;',
  '    if (typeof guild.members?.fetch === \'function\') return await guild.members.fetch(userId).catch(() => null);',
  '  } catch {}',
  '  return null;',
  '}',
  '',
  'async function seekdeepMaybeRenameArchiveThread(thread, desiredName) {',
  '  try {',
  '    const name = seekdeepArchiveThreadClampName(desiredName);',
  '    if (thread && name && thread.name !== name && typeof thread.setName === \'function\') {',
  "      await thread.setName(name, 'SeekDeep archive thread name update');",
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
  '  const guildId = channel?.guild?.id || target?.guild?.id || target?.message?.guild?.id || \'\';',
  '  const user = archiveInfo.archiveUser || target?.user || target?.author || target?.member?.user || target?.message?.author || null;',
  '  const userId = String(user?.id || \'\').trim();',
  '  if (!guildId || !userId) return archiveInfo.threadName || thread?.name || \'\';',
  '  const member = await seekdeepArchiveThreadResolveMember(target, user);',
  '  const subject = member || user;',
  '  const profile = seekdeepArchiveThreadGetUserProfile(guildId, userId);',
  '  const nextCount = Math.max(0, Number(profile.count || 0) || 0) + 1;',
  '  const nextName = seekdeepArchiveThreadBuildName(subject, nextCount);',
  '  seekdeepArchiveThreadSaveUserProfile(guildId, userId, {',
  '    threadId: thread?.id || profile.threadId || \'\',',
  '    count: nextCount,',
  '    lastNickname: seekdeepArchiveThreadDisplayName(subject),',
  '    lastArchivedAt: new Date().toISOString(),',
  '  });',
  '  await seekdeepMaybeRenameArchiveThread(thread, nextName);',
  '  return nextName;',
  '}',
  '',
  'async function seekdeepHandleArchiveThreadTitleMessage(message, raw = \'\') {',
  '  const prompt = String(raw || message?.content || \'\').trim();',
  '  const cleaned = typeof seekdeepCleanMessageCommandPrompt === \'function\'',
  '    ? String(seekdeepCleanMessageCommandPrompt(prompt) || \'\').replace(/\\s+/g, \' \').trim().toLowerCase()',
  '    : prompt.replace(/^(?:\\s*(?:<@!?\\d+>|<@&\\d+>|@seekdeep|@seekotics|seekdeep|seekotics)\\s*)+/i, \'\').replace(/\\s+/g, \' \').trim().toLowerCase();',
  '  if (!/^archive\\s+(?:thread\\s+)?(?:title|name|brand|rename)\\b/i.test(cleaned) && !/^archive\\s+set\\s+(?:thread\\s+)?(?:title|name|brand)\\b/i.test(cleaned)) return false;',
  '  await message.reply({',
  "    content: ['Archive thread titles are automatic now:', '`🪙 • Archive • current nickname • current amount`', 'The nickname and amount update when archives are posted.'].join('\\n'),",
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
  "  return ('🪙 • Archive • ' + username + ' • ' + (Math.max(0, Number(count || 0) || 0))).slice(0, 90);",
  '}'
].join('\n');

const newGetOrCreateUserArchiveThread = [
  'async function seekdeepGetOrCreateUserArchiveThread(target, userOverride) {',
  '  target = target || null;',
  '  const channel = await seekdeepGetOrCreateGuildArchiveChannel(target);',
  '  const user = userOverride || target?.user || target?.author || target?.member?.user || target?.message?.author || null;',
  '  const guildId = channel?.guild?.id || target?.guild?.id || target?.message?.guild?.id || \'\';',
  '  const userId = String(user?.id || \'\').trim();',
  '  const member = typeof seekdeepArchiveThreadResolveMember === \'function\' ? await seekdeepArchiveThreadResolveMember(target, user) : null;',
  '  const subject = member || user;',
  '  const profile = userId && guildId && typeof seekdeepArchiveThreadGetUserProfile === \'function\'',
  '    ? seekdeepArchiveThreadGetUserProfile(guildId, userId)',
  '    : {};',
  '  let currentCount = Math.max(0, Number(profile.count || 0) || 0);',
  '  const threadName = typeof seekdeepArchiveThreadBuildName === \'function\'',
  '    ? seekdeepArchiveThreadBuildName(subject, currentCount)',
  '    : seekdeepArchiveUserThreadName(subject, currentCount);',
  '',
  '  let thread = null;',
  '  if (profile.threadId) {',
  '    thread = channel.threads?.cache?.get?.(profile.threadId) || null;',
  '    if (!thread && typeof channel.threads?.fetch === \'function\') thread = await channel.threads.fetch(profile.threadId).catch(() => null);',
  '    if (thread?.archived) {',
  "      try { await thread.setArchived(false, 'SeekDeep archive write'); } catch {}",
  '    }',
  '  }',
  '',
  '  if (!thread) thread = await seekdeepFindArchiveThread(channel, threadName);',
  '',
  '  if (!thread && typeof seekdeepLegacyArchiveUserThreadName === \'function\') {',
  '    const legacyName = seekdeepLegacyArchiveUserThreadName(user);',
  '    if (legacyName !== threadName) thread = await seekdeepFindArchiveThread(channel, legacyName);',
  '  }',
  '',
  '  if (!thread && userId) {',
  '    const active = await channel.threads.fetchActive().catch(() => null);',
  '    thread = active?.threads?.find?.((candidate) => candidate?.ownerId === userId && /archive/i.test(candidate?.name || \'\')) || null;',
  '  }',
  '',
  '  if (!thread) {',
  '    thread = await channel.threads.create({',
  '      name: threadName,',
  '      autoArchiveDuration: 10080,',
  "      reason: 'SeekDeep archive thread for ' + (user?.id || 'unknown user'),",
  '    });',
  '    await thread.send([',
  "      '🪙 SeekDeep archive for ' + (user?.id ? '<@' + user.id + '>' : 'unknown user') + '.',",
  "      'Thread format: 🪙 • Archive • current nickname • current amount',",
  "      'New archived generations for this user will be posted here.'",
  "    ].join('\\n')).catch(() => null);",
  '  }',
  '',
  '  if (thread && (profile.count === undefined || profile.count === null)) {',
  '    const inferredCount = Math.max(0, Number(thread.totalMessageSent || thread.messageCount || 0) || 0);',
  '    if (inferredCount > currentCount) currentCount = inferredCount;',
  '  }',
  '',
  '  const finalThreadName = typeof seekdeepArchiveThreadBuildName === \'function\'',
  '    ? seekdeepArchiveThreadBuildName(subject, currentCount)',
  '    : seekdeepArchiveUserThreadName(subject, currentCount);',
  '',
  '  if (userId && guildId && typeof seekdeepArchiveThreadSaveUserProfile === \'function\') {',
  '    seekdeepArchiveThreadSaveUserProfile(guildId, userId, {',
  '      threadId: thread.id,',
  '      count: currentCount,',
  '      lastNickname: typeof seekdeepArchiveThreadDisplayName === \'function\' ? seekdeepArchiveThreadDisplayName(subject) : \'\',',
  '    });',
  '    if (typeof seekdeepMaybeRenameArchiveThread === \'function\') await seekdeepMaybeRenameArchiveThread(thread, finalThreadName);',
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
  '  if (typeof seekdeepArchiveThreadRecordPost === \'function\') {',
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
  '    channelId: thread.parentId || thread.parent?.id || \'\',',
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

if (source === before) throw new Error('Patch made no changes; refusing to continue.');
fs.writeFileSync(indexPath, source, 'utf8');
console.log('Patched archive coin/bullet thread naming successfully.');
'@ | Set-Content -Path $PatchJsPath -Encoding UTF8

function Restore-SeekDeepBackup {
  if (Test-Path $BackupPath) {
    Copy-Item $BackupPath $IndexPath -Force
    Write-Host "Restored: $BackupPath"
  }
}

try {
  Write-Host "Applying patch with: $PatchJsPath"
  node $PatchJsPath
  if ($LASTEXITCODE -ne 0) { throw "Node patcher failed with exit code $LASTEXITCODE" }

  Write-Host "Running node --check..."
  node --check $IndexPath
  if ($LASTEXITCODE -ne 0) { throw "node --check failed with exit code $LASTEXITCODE" }

  if ((Test-Path $PythonPath) -and (Test-Path $LocalAiPath)) {
    Write-Host "Running Python compile check..."
    & $PythonPath -m py_compile $LocalAiPath
    if ($LASTEXITCODE -ne 0) { throw "Python compile check failed with exit code $LASTEXITCODE" }
  } else {
    Write-Host "Python compile check skipped (venv python or local_ai_server.py not found)."
  }

  Write-Host "Patch applied successfully."
  Write-Host "Thread format: 🪙 • Archive • current nickname • current amount"
} catch {
  Write-Host "Patch failed. Restoring backup..."
  Restore-SeekDeepBackup
  throw
}
