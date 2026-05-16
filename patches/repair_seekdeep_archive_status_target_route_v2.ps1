$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$ProjectRoot = (Get-Location).Path
$IndexPath = Join-Path $ProjectRoot 'index.js'
$PythonPath = Join-Path $ProjectRoot '.venv\Scripts\python.exe'
$LocalAiPath = Join-Path $ProjectRoot 'local_ai_server.py'
$BackupsDir = Join-Path $ProjectRoot 'backups'
$PatchesDir = Join-Path $ProjectRoot 'patches'

if (-not (Test-Path $IndexPath)) {
  throw "index.js not found at $IndexPath. Run this from the SeekDeep-DiscordBot project root."
}

New-Item -ItemType Directory -Path $BackupsDir -Force | Out-Null
New-Item -ItemType Directory -Path $PatchesDir -Force | Out-Null

$Stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$IndexBackupPath = Join-Path $BackupsDir "index.js.before-archive-status-target-route-v2-$Stamp.bak"
$PatchJsPath = Join-Path $PatchesDir "apply_archive_status_target_route_v2_$Stamp.cjs"

Copy-Item $IndexPath $IndexBackupPath -Force
Write-Host "Backup created: $IndexBackupPath"

@'

const fs = require('fs');
const path = require('path');

const indexPath = path.join(process.cwd(), 'index.js');
let source = fs.readFileSync(indexPath, 'utf8');
let out = source;
const changes = [];

function findBalancedEnd(src, openIndex, openChar, closeChar) {
  let i = openIndex;
  let depth = 0;
  let state = 'code';
  while (i < src.length) {
    const ch = src[i];
    const next = src[i + 1];
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
  const m = re.exec(src);
  if (!m) throw new Error('Could not find function ' + functionName);
  const start = m.index;
  const braceStart = src.indexOf('{', m.index + m[0].length - 1);
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

function patchFunction(functionName, patcher) {
  const range = findFunctionRange(out, functionName);
  const before = out.slice(range.start, range.end);
  const after = patcher(before);
  if (after === before) throw new Error('No changes made inside ' + functionName);
  out = out.slice(0, range.start) + after + out.slice(range.end);
  changes.push('patched ' + functionName);
}

function insertAfterFunction(functionName, block, marker) {
  if (out.includes(marker)) {
    changes.push(marker + ' already present');
    return;
  }
  const range = findFunctionRange(out, functionName);
  out = out.slice(0, range.end) + '\n\n' + block + out.slice(range.end);
  changes.push('inserted ' + marker);
}

function insertBeforeAnchor(anchor, block, marker) {
  if (out.includes(marker)) {
    changes.push(marker + ' already present');
    return;
  }
  const idx = out.indexOf(anchor);
  if (idx < 0) throw new Error('Could not find anchor for ' + marker);
  out = out.slice(0, idx) + block + '\n\n' + out.slice(idx);
  changes.push('inserted ' + marker);
}

const cleanStatus = [
"function seekdeepArchiveStatusCleanPrompt(value = '') {",
"  return String(value || '')",
"    .replace(/^(?:\\s*(?:<@(?:!|&)?\\d+>|@seekdeep|@seekotics|seekdeep|seekotics)\\s*)+/i, ' ')",
"    .replace(/^[@/\\s]+/g, ' ')",
"    .replace(/\\s+/g, ' ')",
"    .trim();",
"}"
].join('\n');

const isStatus = [
"function seekdeepIsArchiveStatusPrompt(value = '') {",
"  const prompt = seekdeepArchiveStatusCleanPrompt(value).toLowerCase();",
"  return /^(?:archive\\s*status|archivestatus|status\\s+archive|archive\\s+stats|archivestats)(?:\\b|$)/.test(prompt);",
"}"
].join('\n');

replaceFunction('seekdeepArchiveStatusCleanPrompt', cleanStatus);
replaceFunction('seekdeepIsArchiveStatusPrompt', isStatus);

const helpers = [
"// SEEKDEEP_ARCHIVE_STATUS_TARGET_ROUTE_V2_START",
"function seekdeepArchiveStatusMentionedUser(message) {",
"  const selfId = message?.client?.user?.id || '';",
"  return Array.from(message?.mentions?.users?.values?.() || []).find((user) => user?.id && user.id !== selfId) || null;",
"}",
"",
"async function seekdeepArchiveStatusTargetFromMessage(message, prompt = '') {",
"  const clean = seekdeepArchiveStatusCleanPrompt(prompt || message?.content || '').toLowerCase();",
"  const mentionedUser = seekdeepArchiveStatusMentionedUser(message);",
"  const scope = /^(?:archive\\s*status|archivestatus|status\\s+archive|archive\\s+stats|archivestats)\\s+shared\\b/i.test(clean) ? 'shared' : 'user';",
"  const targetUser = scope === 'shared' ? null : (mentionedUser || message?.author || null);",
"  let targetMember = scope === 'shared' ? null : (mentionedUser ? null : message?.member || null);",
"  if (mentionedUser && message?.guild?.members?.fetch) {",
"    targetMember = await message.guild.members.fetch(mentionedUser.id).catch(() => null);",
"  }",
"  return {",
"    message,",
"    guild: message?.guild || null,",
"    guildId: message?.guild?.id || '',",
"    channel: message?.channel || null,",
"    author: targetUser || message?.author || null,",
"    user: targetUser,",
"    member: targetMember,",
"    archiveStatusScope: scope,",
"    archiveStatusRequestedBy: message?.author || null,",
"  };",
"}",
"",
"async function seekdeepArchiveFetchThreadById(channel, threadId = '') {",
"  const id = String(threadId || '').trim();",
"  if (!channel || !id) return null;",
"  let thread = channel.threads?.cache?.get?.(id) || null;",
"  if (!thread && typeof channel.threads?.fetch === 'function') thread = await channel.threads.fetch(id).catch(() => null);",
"  if (thread?.archived) { try { await thread.setArchived(false, 'SeekDeep archive status lookup'); } catch {} }",
"  return thread || null;",
"}",
"",
"async function seekdeepArchiveListThreads(channel) {",
"  const threads = [];",
"  if (!channel?.threads) return threads;",
"  const seen = new Set();",
"  const add = (thread) => {",
"    if (thread?.id && !seen.has(thread.id)) { seen.add(thread.id); threads.push(thread); }",
"  };",
"  const active = await channel.threads.fetchActive().catch(() => null);",
"  active?.threads?.forEach?.(add);",
"  const archivedPublic = await channel.threads.fetchArchived({ type: 'public' }).catch(() => null);",
"  archivedPublic?.threads?.forEach?.(add);",
"  return threads;",
"}",
"",
"async function seekdeepFindSharedArchiveThreadFlexible(channel) {",
"  const threads = await seekdeepArchiveListThreads(channel);",
"  return threads.find((thread) => /^(?:shared|.*shared\\s+archive.*)$/i.test(String(thread?.name || '').trim())) || null;",
"}",
"",
"async function seekdeepFindUserArchiveThreadFlexible(channel, subject, user, profile = {}) {",
"  if (!channel) return null;",
"  const byId = await seekdeepArchiveFetchThreadById(channel, profile?.threadId || '');",
"  if (byId) return byId;",
"  const display = typeof seekdeepArchiveThreadDisplayName === 'function' ? seekdeepArchiveThreadDisplayName(subject || user).toLowerCase() : '';",
"  const trusted = typeof seekdeepArchiveThreadTrustedCount === 'function' ? seekdeepArchiveThreadTrustedCount(profile) : 0;",
"  const expected = typeof seekdeepArchiveThreadBuildName === 'function' ? seekdeepArchiveThreadBuildName(subject || user, trusted) : '';",
"  if (expected && typeof seekdeepFindArchiveThreadByName === 'function') {",
"    const exact = await seekdeepFindArchiveThreadByName(channel, expected).catch(() => null);",
"    if (exact) return exact;",
"  }",
"  if (typeof seekdeepLegacyArchiveUserThreadName === 'function') {",
"    const legacy = seekdeepLegacyArchiveUserThreadName(user || subject || {});",
"    const legacyThread = await seekdeepFindArchiveThreadByName(channel, legacy).catch(() => null);",
"    if (legacyThread) return legacyThread;",
"  }",
"  const threads = await seekdeepArchiveListThreads(channel);",
"  const userIdSuffix = user?.id ? String(user.id).slice(-6) : '';",
"  return threads.find((thread) => {",
"    const name = String(thread?.name || '').toLowerCase();",
"    if (!/archive/.test(name)) return false;",
"    if (display && name.includes(display)) return true;",
"    if (userIdSuffix && name.includes(userIdSuffix)) return true;",
"    return false;",
"  }) || null;",
"}",
"",
"async function seekdeepCountArchiveEntryMessages(thread) {",
"  if (!thread?.messages?.fetch) return 0;",
"  let count = 0;",
"  let before = null;",
"  for (let page = 0; page < 10; page += 1) {",
"    const options = { limit: 100 };",
"    if (before) options.before = before;",
"    const messages = await thread.messages.fetch(options).catch(() => null);",
"    if (!messages || messages.size === 0) break;",
"    for (const msg of messages.values()) {",
"      const text = String(msg?.content || '');",
"      if (/SeekDeep\\s+(?:Image\\s+)?Archive\\s+Entry/i.test(text) || /SeekDeep\\s+Shared\\s+Archive\\s+Entry/i.test(text)) count += 1;",
"    }",
"    before = messages.last()?.id || null;",
"    if (!before || messages.size < 100) break;",
"  }",
"  return count;",
"}",
"",
"async function seekdeepArchiveTrustedOrBackfilledCount(thread, profile = {}) {",
"  const trusted = typeof seekdeepArchiveThreadTrustedCount === 'function' ? seekdeepArchiveThreadTrustedCount(profile) : 0;",
"  const scanned = await seekdeepCountArchiveEntryMessages(thread);",
"  return Math.max(trusted, scanned);",
"}",
"// SEEKDEEP_ARCHIVE_STATUS_TARGET_ROUTE_V2_END"
].join('\n');

insertAfterFunction('seekdeepIsArchiveStatusPrompt', helpers, 'SEEKDEEP_ARCHIVE_STATUS_TARGET_ROUTE_V2_START');

const healthFn = [
"async function seekdeepArchiveThreadHealthForTarget(target = null) {",
"  const safeTarget = target || {};",
"  const guild = safeTarget?.guild || safeTarget?.message?.guild || safeTarget?.channel?.guild || null;",
"  const statusScope = safeTarget?.archiveStatusScope || 'user';",
"",
"  if (!guild) {",
"    return {",
"      scope: 'this DM',",
"      statusScope,",
"      hasGuild: false,",
"      channel: null,",
"      sharedThread: null,",
"      userThread: null,",
"      userThreadName: '',",
"      userCount: 0,",
"      subjectName: '',",
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
"  const sharedThread = channel ? await seekdeepFindSharedArchiveThreadFlexible(channel) : null;",
"  const user = safeTarget?.user || safeTarget?.author || safeTarget?.member?.user || safeTarget?.message?.author || null;",
"  const member = user && typeof seekdeepArchiveThreadResolveMember === 'function' ? await seekdeepArchiveThreadResolveMember(safeTarget, user) : null;",
"  const subject = member || safeTarget?.member || user;",
"  const subjectName = subject && typeof seekdeepArchiveThreadDisplayName === 'function' ? seekdeepArchiveThreadDisplayName(subject) : '';",
"  const profile = guild?.id && user?.id && typeof seekdeepArchiveThreadGetUserProfile === 'function' ? seekdeepArchiveThreadGetUserProfile(guild.id, user.id) : {};",
"  const userThread = channel && statusScope !== 'shared' && user ? await seekdeepFindUserArchiveThreadFlexible(channel, subject, user, profile) : null;",
"  const userCount = userThread ? await seekdeepArchiveTrustedOrBackfilledCount(userThread, profile) : (typeof seekdeepArchiveThreadTrustedCount === 'function' ? seekdeepArchiveThreadTrustedCount(profile) : 0);",
"  const userThreadName = user ? (typeof seekdeepArchiveThreadBuildName === 'function' ? seekdeepArchiveThreadBuildName(subject, userCount) : seekdeepArchiveUserThreadName(subject, userCount)) : '';",
"",
"  return {",
"    scope: 'this server',",
"    statusScope,",
"    hasGuild: true,",
"    channel,",
"    sharedThread,",
"    userThread,",
"    userThreadName,",
"    userCount,",
"    subjectName,",
"    user,",
"    error,",
"  };",
"}"
].join('\n');

replaceFunction('seekdeepArchiveThreadHealthForTarget', healthFn);

const reportFn = [
"async function seekdeepBuildArchiveStatusReportV2(target = null) {",
"  const local = seekdeepLocalArchiveStatsForTarget(target);",
"  const health = await seekdeepArchiveThreadHealthForTarget(target);",
"  const subjectLine = health.statusScope === 'shared'",
"    ? 'Target: shared archive'",
"    : ('Target user: ' + (health.subjectName || health.user?.username || 'current user'));",
"",
"  const lines = [",
"    'Image archive status',",
"    `Scope: ${health.scope}`,",
"    subjectLine,",
"    `Archive channel: ${health.channel ? `<#${health.channel.id}>` : 'missing'}`,",
"    `Shared thread: ${health.sharedThread ? `<#${health.sharedThread.id}>` : 'missing'}`,",
"  ];",
"",
"  if (health.statusScope !== 'shared') {",
"    lines.push(`User thread: ${health.userThread ? `<#${health.userThread.id}>` : `missing${health.userThreadName ? ` (${health.userThreadName})` : ''}`}`);",
"    lines.push(`Tracked archived image posts: ${health.userThread ? String(health.userCount || 0) : '0'}`);",
"  }",
"",
"  lines.push('', 'Local fallback storage:');",
"  lines.push(`Images: ${local.images}`);",
"  lines.push(`Metadata files: ${local.metadata}`);",
"  lines.push(`Migrated markers: ${local.migratedMarkers}`);",
"  lines.push(`Total local files: ${local.files}`);",
"  lines.push(`Size: ${typeof seekdeepFormatBytesCompact === 'function' ? seekdeepFormatBytesCompact(local.bytes) : `${local.bytes} B`}`);",
"  lines.push(`Newest local file: ${local.newest ? local.newest.name : 'none'}`);",
"",
"  if (health.error) {",
"    lines.push('', `Archive thread warning: ${health.error}`);",
"  }",
"",
"  return lines.join('\\n');",
"}"
].join('\n');

replaceFunction('seekdeepBuildArchiveStatusReportV2', reportFn);

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
"  const startedAt = typeof seekdeepNowMs === 'function' ? seekdeepNowMs() : Date.now();",
"  const statusTarget = await seekdeepArchiveStatusTargetFromMessage(message, prompt || message.content || '');",
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

// Backfill actual archive-entry count before renaming existing user threads to count 0.
const backfillAnchor = "  const finalThreadName = typeof seekdeepArchiveThreadBuildName === 'function'\n    ? seekdeepArchiveThreadBuildName(subject, currentCount)\n    : seekdeepArchiveUserThreadName(subject, currentCount);";
const backfillInsert = "  if (thread && typeof seekdeepArchiveTrustedOrBackfilledCount === 'function') {\n    currentCount = await seekdeepArchiveTrustedOrBackfilledCount(thread, profile);\n  }\n\n" + backfillAnchor;
if (!out.includes('currentCount = await seekdeepArchiveTrustedOrBackfilledCount(thread, profile);')) {
  if (!out.includes(backfillAnchor)) throw new Error('Could not find getOrCreateUserArchiveThread final name anchor.');
  out = out.replace(backfillAnchor, backfillInsert);
  changes.push('inserted archive count backfill before user-thread rename');
}

// Status must run before archive-open, otherwise target/status variants can be eaten by open-command handling.
const routeAnchor = "  try {\n    const seekdeepArchiveOpenRawContent = String(message?.content || '');";
const routeBlock = [
"  // SEEKDEEP_ARCHIVE_STATUS_BEFORE_OPEN_V2_START",
"  try {",
"    const seekdeepArchiveStatusRawContentEarly = String(message?.content || '');",
"    if (await seekdeepHandleArchiveStatusMessage(message, seekdeepArchiveStatusRawContentEarly)) {",
"      return;",
"    }",
"  } catch (err) {",
"    console.error('Archive status message handler failed:', err?.stack || err?.message || err);",
"    try {",
"      await message.reply({",
"        content: 'Archive status failed locally. Check the bot console for details.',",
"        allowedMentions: { repliedUser: false },",
"      });",
"    } catch {}",
"    return;",
"  }",
"  // SEEKDEEP_ARCHIVE_STATUS_BEFORE_OPEN_V2_END",
"",
].join('\n');
insertBeforeAnchor(routeAnchor, routeBlock, 'SEEKDEEP_ARCHIVE_STATUS_BEFORE_OPEN_V2_START');

// Keep help in sync with targetable archive status.
out = out.replace("    prefix + ' archive status',\n", "    prefix + ' archive status',\n    prefix + ' archive status @user',\n    prefix + ' archive status shared',\n");

if (out === source) throw new Error('Patch made no changes; refusing to continue.');
fs.writeFileSync(indexPath, out, 'utf8');
console.log('Patched index.js successfully.');
for (const c of changes) console.log('- ' + c);

'@ | Set-Content -Path $PatchJsPath -Encoding UTF8

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

  Write-Host ""
  Write-Host "Patch applied successfully."
  Write-Host "Changed behavior:"
  Write-Host "- archive status routes before archive open."
  Write-Host "- archive status @user targets the mentioned user instead of the command author."
  Write-Host "- existing archive-entry messages are scanned to backfill tracked count before renaming."
  Write-Host "- help now lists archive status @user and archive status shared."
} catch {
  Write-Host ""
  Write-Host "Patch failed. Restoring backup..."
  Copy-Item $IndexBackupPath $IndexPath -Force
  Write-Host "Restored: $IndexBackupPath"
  throw
}
