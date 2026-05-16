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
$IndexBackupPath = Join-Path $BackupsDir "index.js.before-shared-archive-setup-bootstrap-v2-$Stamp.bak"
$PatchJsPath = Join-Path $PatchesDir "apply_shared_archive_setup_bootstrap_v2_$Stamp.cjs"

Copy-Item $IndexPath $IndexBackupPath -Force
Write-Host "Backup created: $IndexBackupPath"

@'
const fs = require('fs');
const path = require('path');

const indexPath = path.join(process.cwd(), 'index.js');
let source = fs.readFileSync(indexPath, 'utf8');
let out = source;
const changes = [];
const warnings = [];

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
  const match = re.exec(src);
  if (!match) throw new Error('Could not find function ' + functionName);

  const start = match.index;
  const braceStart = src.indexOf('{', match.index + match[0].length - 1);
  if (braceStart < 0) throw new Error('Could not find opening brace for ' + functionName);

  const endBrace = findBalancedEnd(src, braceStart, '{', '}');
  if (endBrace < 0) throw new Error('Could not find closing brace for ' + functionName);

  return { start, end: endBrace + 1 };
}

function replaceFunction(functionName, replacement) {
  const range = findFunctionRange(out, functionName);
  out = out.slice(0, range.start) + replacement + out.slice(range.end);
  changes.push('replaced ' + functionName);
}

function insertBeforeFunction(functionName, block, marker) {
  if (marker && out.includes(marker)) {
    changes.push(marker + ' already present');
    return;
  }
  const range = findFunctionRange(out, functionName);
  out = out.slice(0, range.start) + block + '\n\n' + out.slice(range.start);
  changes.push('inserted ' + (marker || block.split('\n')[0]));
}

const ensureSharedHelper = [
"// SEEKDEEP_SHARED_ARCHIVE_SETUP_BOOTSTRAP_V2_START",
"async function seekdeepEnsureSharedArchiveThreadForChannel(channel, target = null, options = {}) {",
"  if (!channel || !channel.threads) {",
"    throw new Error('Shared Archive requires a configured text channel with thread support.');",
"  }",
"",
"  const guild = channel.guild || target?.guild || target?.message?.guild || target?.channel?.guild || null;",
"  const guildId = String(guild?.id || channel?.guild?.id || '').trim();",
"  const profile = guildId && typeof seekdeepSharedArchiveGetProfile === 'function'",
"    ? seekdeepSharedArchiveGetProfile(guildId)",
"    : {};",
"",
"  let currentCount = typeof seekdeepSharedArchiveTrustedCount === 'function'",
"    ? seekdeepSharedArchiveTrustedCount(profile)",
"    : Math.max(0, Number(profile?.count || 0) || 0);",
"",
"  let thread = null;",
"",
"  if (profile?.threadId && channel?.threads?.fetch) {",
"    thread = await channel.threads.fetch(profile.threadId).catch(() => null);",
"  }",
"",
"  const baseName = typeof seekdeepSharedArchiveThreadBuildName === 'function'",
"    ? seekdeepSharedArchiveThreadBuildName(0)",
"    : '🪙 • Shared Archive • 0';",
"  const sharedPrefix = String(baseName).replace(/\\s+0$/, '').trim();",
"  const matchesSharedThread = (candidate) => {",
"    if (!candidate) return false;",
"    const name = String(candidate.name || '').trim();",
"    if (!name) return false;",
"    if (profile?.threadId && candidate.id === profile.threadId) return true;",
"    if (profile?.threadName && name === profile.threadName) return true;",
"    if (name === 'Shared') return true;",
"    if (sharedPrefix && name.startsWith(sharedPrefix)) return true;",
"    return /Shared\\s+Archive/i.test(name);",
"  };",
"",
"  if (!thread) {",
"    const active = await channel.threads.fetchActive().catch(() => null);",
"    thread = active?.threads?.find?.(matchesSharedThread) || null;",
"  }",
"",
"  if (!thread) {",
"    const archivedPublic = await channel.threads.fetchArchived({ type: 'public' }).catch(() => null);",
"    thread = archivedPublic?.threads?.find?.(matchesSharedThread) || null;",
"  }",
"",
"  if (thread?.archived) {",
"    await thread.setArchived(false, 'SeekDeep shared archive bootstrap').catch(() => null);",
"  }",
"",
"  if (thread && (!currentCount || profile?.countSource !== SEEKDEEP_SHARED_ARCHIVE_COUNT_SOURCE)) {",
"    if (typeof seekdeepScanThreadArchiveEntryCount === 'function') {",
"      currentCount = await seekdeepScanThreadArchiveEntryCount(thread, 'SeekDeep Shared Archive Entry');",
"    }",
"  }",
"",
"  const threadName = typeof seekdeepSharedArchiveThreadBuildName === 'function'",
"    ? seekdeepSharedArchiveThreadBuildName(currentCount)",
"    : ('🪙 • Shared Archive • ' + String(Math.max(0, Number(currentCount || 0) || 0))).slice(0, 96);",
"",
"  if (!thread) {",
"    thread = await channel.threads.create({",
"      name: threadName,",
"      autoArchiveDuration: 10080,",
"      reason: options?.reason || 'SeekDeep shared image archive thread bootstrap',",
"    });",
"    await thread.send('🪙 SeekDeep shared archive.\\nSaved generations from this server will appear here.').catch(() => null);",
"  } else if (thread.name !== threadName) {",
"    if (typeof seekdeepMaybeRenameArchiveThread === 'function') {",
"      await seekdeepMaybeRenameArchiveThread(thread, threadName);",
"    } else {",
"      await thread.setName(threadName, 'SeekDeep shared archive bootstrap name update').catch(() => null);",
"    }",
"  }",
"",
"  if (guildId && typeof seekdeepSharedArchiveSaveProfile === 'function') {",
"    seekdeepSharedArchiveSaveProfile(guildId, {",
"      threadId: thread.id,",
"      threadName,",
"      count: currentCount,",
"      countSource: SEEKDEEP_SHARED_ARCHIVE_COUNT_SOURCE,",
"      bootstrapSource: options?.source || 'shared-archive-setup-bootstrap-v2',",
"      bootstrapAt: new Date().toISOString(),",
"    });",
"  }",
"",
"  return { channel, thread, threadName, count: currentCount, shared: true };",
"}",
"// SEEKDEEP_SHARED_ARCHIVE_SETUP_BOOTSTRAP_V2_END"
].join('\n');

if (!out.includes('SEEKDEEP_SHARED_ARCHIVE_SETUP_BOOTSTRAP_V2_START')) {
  if (out.includes('async function seekdeepGetOrCreateSharedArchiveThread') || out.includes('function seekdeepGetOrCreateSharedArchiveThread')) {
    insertBeforeFunction('seekdeepGetOrCreateSharedArchiveThread', ensureSharedHelper, 'SEEKDEEP_SHARED_ARCHIVE_SETUP_BOOTSTRAP_V2_START');
  } else {
    throw new Error('Shared Archive v1 does not appear to be installed: seekdeepGetOrCreateSharedArchiveThread was not found.');
  }
}

const getOrCreateSharedReplacement = [
"async function seekdeepGetOrCreateSharedArchiveThread(target) {",
"  const channel = await seekdeepGetOrCreateGuildArchiveChannel(target);",
"  if (typeof seekdeepEnsureSharedArchiveThreadForChannel === 'function') {",
"    return await seekdeepEnsureSharedArchiveThreadForChannel(channel, target, {",
"      source: 'shared-archive-get-or-create',",
"      reason: 'SeekDeep shared image archive thread',",
"    });",
"  }",
"",
"  throw new Error('Shared Archive bootstrap helper is not available. Re-run the Shared Archive setup patch.');",
"}"
].join('\n');

replaceFunction('seekdeepGetOrCreateSharedArchiveThread', getOrCreateSharedReplacement);

const archiveConfigReplacement = [
"async function seekdeepHandleArchiveConfigMessage(message, prompt = '') {",
"  if (!message || !seekdeepIsArchiveConfigPrompt(prompt || message.content || '')) return false;",
"  if (typeof seekdeepLogRoute === 'function') seekdeepLogRoute('archive-config-message', prompt || message.content || '');",
"",
"  if (!message.guild) {",
"    await message.reply({ content: 'Archive channel setup only works inside a server.', allowedMentions: { repliedUser: false } });",
"    return true;",
"  }",
"",
"  const currentId = seekdeepGetArchiveChannelIdForGuild(message.guild.id);",
"  const requestedChannel = seekdeepExtractArchiveSetupChannel(message, prompt);",
"",
"  if (!seekdeepHasArchiveConfigPermission(message)) {",
"    await message.reply({",
"      content: ['Only someone with Administrator, Manage Server, or Manage Channels can assign the SeekDeep archive channel.', currentId ? ('Current configured channel: <#' + currentId + '>') : seekdeepArchiveSetupHelpText(message.guild, message)].join('\\n'),",
"      allowedMentions: { repliedUser: false },",
"    });",
"    return true;",
"  }",
"",
"  if (!requestedChannel) {",
"    await message.reply({",
"      content: [currentId ? ('Current configured channel: <#' + currentId + '>') : 'No archive channel is configured yet.', 'Admins can assign or change it with ' + seekdeepArchiveSetupPromptText() + '.'].join('\\n'),",
"      allowedMentions: { repliedUser: false },",
"    });",
"    return true;",
"  }",
"",
"  if (!requestedChannel.guild || requestedChannel.guild.id !== message.guild.id || typeof requestedChannel.send !== 'function' || !requestedChannel.threads) {",
"    await message.reply({ content: 'That target must be a text channel in this server with thread support.', allowedMentions: { repliedUser: false } });",
"    return true;",
"  }",
"",
"  const report = seekdeepArchiveChannelPermissionReport(requestedChannel, message.guild);",
"  if (!report.ok) {",
"    await message.reply({",
"      content: seekdeepArchivePermissionHelpText(requestedChannel, report.missing, message),",
"      allowedMentions: { repliedUser: false },",
"    });",
"    return true;",
"  }",
"",
"  if (!seekdeepSetArchiveChannelIdForGuild(message.guild.id, requestedChannel.id, message.author?.id || '')) {",
"    await message.reply({ content: 'Archive channel validation passed, but writing the local config file failed. Check file permissions for `data/archive-guild-config.json`.', allowedMentions: { repliedUser: false } });",
"    return true;",
"  }",
"",
"  const setupLines = [",
"    'Archive channel assigned for this server: <#' + requestedChannel.id + '>',",
"  ];",
"",
"  try {",
"    if (typeof seekdeepEnsureSharedArchiveThreadForChannel === 'function') {",
"      const sharedArchive = await seekdeepEnsureSharedArchiveThreadForChannel(requestedChannel, message, {",
"        source: 'archive-channel-setup',",
"        reason: 'SeekDeep shared archive thread created during archive channel setup',",
"      });",
"      setupLines.push(sharedArchive?.thread?.id",
"        ? 'Shared archive thread ready: <#' + sharedArchive.thread.id + '>'",
"        : 'Shared archive thread ready.');",
"    }",
"  } catch (err) {",
"    const reason = String(err?.message || err || 'unknown error').slice(0, 500);",
"    setupLines.push('Shared archive thread setup failed: ' + reason);",
"    setupLines.push('Fix the archive channel thread permissions, then run `@SeekDeep archive setup here` again.');",
"  }",
"",
"  setupLines.push('Future archives will use this server-assigned channel only.');",
"",
"  await message.reply({",
"    content: setupLines.filter(Boolean).join('\\n'),",
"    allowedMentions: { repliedUser: false },",
"  });",
"  return true;",
"}"
].join('\n');

replaceFunction('seekdeepHandleArchiveConfigMessage', archiveConfigReplacement);

// Make auto-created archive channels mention shared archive readiness in the channel intro.
// Shared thread itself is still created by setup/bootstrap/lazy shared archive usage.
out = out.replace(
  "await channel.send('SeekDeep archive channel initialized. User archive threads will be created here.').catch(() => null);",
  "await channel.send('SeekDeep archive channel initialized. User and shared archive threads will be created here.').catch(() => null);"
);

// Keep help current and canonical if those strings are present.
out = out.replace(/prefix \+ ' archive shared',\n\s*prefix \+ ' archive @user',/g, "prefix + ' archive shared',\n    prefix + ' archive status shared',\n    prefix + ' archive @user',");
out = out.replace(/Buttons: `Original` `Refined` `Both` `Download` `Archive`(?! `Shared Archive`)/g, "Buttons: `Original` `Refined` `Both` `Download` `Archive` `Shared Archive`");

if (out === source) throw new Error('Patch made no changes; refusing to continue.');

fs.writeFileSync(indexPath, out, 'utf8');
console.log('Patched index.js successfully.');
for (const c of changes) console.log('- ' + c);
for (const w of warnings) console.log('WARNING: ' + w);

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
  Write-Host "- Archive channel setup now also creates/assigns the Shared Archive thread."
  Write-Host "- Shared Archive lookup now uses a stored thread ID first, then finds active/archived branded or legacy shared threads, then creates one if missing."
  Write-Host "- @SeekDeep archive shared and the Shared Archive button both recover from a missing shared thread."
  Write-Host "- Setup reply now reports the Shared Archive thread or the exact permission/setup failure."
} catch {
  Write-Host ""
  Write-Host "Patch failed. Restoring backup..."
  Copy-Item $IndexBackupPath $IndexPath -Force
  Write-Host "Restored: $IndexBackupPath"
  throw
}
