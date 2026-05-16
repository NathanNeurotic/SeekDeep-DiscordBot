# SeekDeep archive permission UX repair v1
# - Adds archive permission preflight helpers
# - Gives clear Discord permission guidance instead of generic local archive failures
# - Preserves local fallback behavior
# - Backs up index.js first and restores automatically on validation failure

$ErrorActionPreference = 'Stop'

$ProjectRoot = (Get-Location).Path
$IndexPath = Join-Path $ProjectRoot 'index.js'
$PythonPath = Join-Path $ProjectRoot '.venv\Scripts\python.exe'
$ServerPath = Join-Path $ProjectRoot 'local_ai_server.py'
$PatchDir = Join-Path $ProjectRoot 'patches'
$BackupDir = Join-Path $ProjectRoot 'backups'
$DiagnosticsDir = Join-Path $ProjectRoot 'diagnostics'
$Stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$BackupPath = Join-Path $BackupDir "index.js.before-archive-permission-ux-$Stamp.bak"
$PatcherPath = Join-Path $PatchDir "apply_archive_permission_ux_$Stamp.cjs"

New-Item -ItemType Directory -Path $PatchDir -Force | Out-Null
New-Item -ItemType Directory -Path $BackupDir -Force | Out-Null
New-Item -ItemType Directory -Path $DiagnosticsDir -Force | Out-Null

if (!(Test-Path $IndexPath)) {
  throw "index.js not found at $IndexPath"
}

Copy-Item $IndexPath $BackupPath -Force
Write-Host "Backup created: $BackupPath"

$Patcher = @'
const fs = require('fs');
const path = process.argv[2];
if (!path) throw new Error('Usage: node patcher.cjs <index.js>');
let text = fs.readFileSync(path, 'utf8');
let changed = 0;
function countOf(haystack, needle){ return haystack.split(needle).length - 1; }
function replaceOne(needle, repl, label, options = {}) {
  const count = countOf(text, needle);
  if (count === 0) {
    if (options.optional) return false;
    throw new Error(`Anchor not found for ${label}`);
  }
  if (count > 1 && !options.allowMultiple) throw new Error(`Anchor for ${label} matched ${count} times`);
  text = text.replace(needle, repl);
  changed++;
  return true;
}
function replaceRegex(regex, repl, label, optional = false) {
  if (!regex.test(text)) {
    if (optional) return false;
    throw new Error(`Regex anchor not found for ${label}`);
  }
  text = text.replace(regex, repl);
  changed++;
  return true;
}

// Ensure PermissionFlagsBits import exists for permission preflight helpers.
if (!/\bPermissionFlagsBits\b/.test(text.split("} from 'discord.js';")[0] || '')) {
  replaceRegex(/(\s+MessageFlags,\r?\n)/, `$1  PermissionFlagsBits,\n`, 'discord.js PermissionFlagsBits import');
}

const helper = `// SEEKDEEP_ARCHIVE_PERMISSION_UX_START
function seekdeepDiscordErrorCode(err = null) {
  return err?.code || err?.rawError?.code || err?.status || '';
}

function seekdeepIsDiscordPermissionError(err = null) {
  const code = String(seekdeepDiscordErrorCode(err));
  const message = String(err?.message || err?.rawError?.message || err || '');
  return code === '50001' || code === '50013' || /missing access|missing permissions/i.test(message);
}

function seekdeepArchivePermissionError(message, cause = null) {
  const err = new Error(message);
  if (cause) err.cause = cause;
  err.code = cause?.code || cause?.rawError?.code || 'SEEKDEEP_ARCHIVE_PERMISSION_REQUIRED';
  err.isSeekDeepArchivePermissionError = true;
  return err;
}

async function seekdeepGetBotGuildMember(guild = null) {
  if (!guild) return null;
  return guild.members?.me || await guild.members?.fetchMe?.().catch(() => null) || null;
}

async function seekdeepAssertCanCreateArchiveChannel(guild = null, wantedName = 'seekdeep-archive') {
  const me = await seekdeepGetBotGuildMember(guild);
  const canManageChannels = Boolean(me?.permissions?.has?.(PermissionFlagsBits.ManageChannels));
  if (!canManageChannels) {
    throw seekdeepArchivePermissionError(
      'Archive channel #' + wantedName + ' does not exist and the bot lacks Manage Channels. Create #' + wantedName + ' manually, grant the bot role access, or grant Manage Channels so SeekDeep can create it.'
    );
  }
}

async function seekdeepAssertArchiveChannelPermissions(channel = null, guild = null) {
  if (!channel) return true;
  const me = await seekdeepGetBotGuildMember(guild || channel.guild || null);
  const permissions = me && typeof channel.permissionsFor === 'function'
    ? channel.permissionsFor(me)
    : null;

  if (!permissions || typeof permissions.has !== 'function') return true;

  const required = [
    ['View Channel', PermissionFlagsBits.ViewChannel],
    ['Send Messages', PermissionFlagsBits.SendMessages],
    ['Create Public Threads', PermissionFlagsBits.CreatePublicThreads],
    ['Send Messages in Threads', PermissionFlagsBits.SendMessagesInThreads],
    ['Attach Files', PermissionFlagsBits.AttachFiles],
    ['Read Message History', PermissionFlagsBits.ReadMessageHistory],
  ];

  const missing = required
    .filter(([, bit]) => !permissions.has(bit))
    .map(([name]) => name);

  if (missing.length) {
    throw seekdeepArchivePermissionError(
      'Archive channel #' + (channel.name || channel.id) + ' is missing bot permissions: ' + missing.join(', ') + '.'
    );
  }

  return true;
}

function seekdeepBuildArchiveFailureText(err = null, savedPath = '') {
  const saved = savedPath ? 'Saved locally as fallback.' : 'No fallback file was written.';

  if (err?.isSeekDeepArchivePermissionError || seekdeepIsDiscordPermissionError(err)) {
    return [
      'Discord thread archive is blocked by server/channel permissions.',
      saved,
      '',
      'Required bot role permissions in the archive channel:',
      'View Channel, Send Messages, Create Public Threads, Send Messages in Threads, Attach Files, Read Message History.',
      '',
      'If #seekdeep-archive does not already exist, either create it manually or grant Manage Channels so SeekDeep can create it.',
      'Optional stable setup: create #seekdeep-archive manually, copy its channel ID, and set SEEKDEEP_ARCHIVE_CHANNEL_ID in .env.',
    ].filter(Boolean).join('\\n');
  }

  return [
    'Discord thread archive failed.',
    saved,
    err?.message ? 'Reason: ' + String(err.message).slice(0, 500) : '',
  ].filter(Boolean).join('\\n');
}
// SEEKDEEP_ARCHIVE_PERMISSION_UX_END`;

if (!text.includes('SEEKDEEP_ARCHIVE_PERMISSION_UX_START')) {
  replaceRegex(/(function seekdeepArchiveMetadataLines\(state, target\) \{[\s\S]*?return lines\.filter\(Boolean\);\r?\n\}\r?\n)/, `$1\n${helper}\n`, 'archive permission helper insertion');
}

replaceOne(
`  if (channel) return channel;`,
`  if (channel) {
    await seekdeepAssertArchiveChannelPermissions(channel, guild);
    return channel;
  }`,
'archive existing channel permission preflight',
{ optional: true }
);

replaceOne(
`  channel = await guild.channels.create({
    name: wantedName,
    type: 0,
    reason: 'SeekDeep server archive channel',
  });

  await channel.send('SeekDeep archive channel initialized. User archive threads will be created here.').catch(() => null);
  return channel;`,
`  await seekdeepAssertCanCreateArchiveChannel(guild, wantedName);

  try {
    channel = await guild.channels.create({
      name: wantedName,
      type: 0,
      reason: 'SeekDeep server archive channel',
    });
  } catch (err) {
    throw seekdeepArchivePermissionError(\`Could not create archive channel #\${wantedName}: \${err?.message || err}\`, err);
  }

  await seekdeepAssertArchiveChannelPermissions(channel, guild);
  await channel.send('SeekDeep archive channel initialized. User archive threads will be created here.').catch(() => null);
  return channel;`,
'archive channel create preflight and friendly error',
{ optional: true }
);

replaceOne(
`    thread = await channel.threads.create({
      name: threadName,
      autoArchiveDuration: 10080,
      reason: \`SeekDeep archive thread for \${user?.id || 'unknown user'}\`,
    });`,
`    try {
      thread = await channel.threads.create({
        name: threadName,
        autoArchiveDuration: 10080,
        reason: \`SeekDeep archive thread for \${user?.id || 'unknown user'}\`,
      });
    } catch (err) {
      throw seekdeepArchivePermissionError(\`Could not create archive thread \${threadName}: \${err?.message || err}\`, err);
    }`,
'archive thread create friendly error',
{ optional: true }
);

replaceOne(
`        content: seekdeepAppendResponseFooter([
          'Discord thread archive failed.',
          savedPath ? 'Saved locally as fallback.' : 'No fallback file was written.',
          err?.message ? \`Reason: \${String(err.message).slice(0, 500)}\` : '',
        ].filter(Boolean).join('\\n'), {
          startedAt,
          modelUsed: seekdeepNoModelLabel(),
        }),`,
`        content: seekdeepAppendResponseFooter(seekdeepBuildArchiveFailureText(err, savedPath), {
          startedAt,
          modelUsed: seekdeepNoModelLabel(),
        }),`,
'normal archive button failure text',
{ optional: true }
);

replaceOne(
`          ? seekdeepAppendResponseFooter(
              [
                'Discord thread archive failed.',
                savedPath ? 'Saved locally as fallback.' : 'No fallback file was written.',
                err?.message ? \`Reason: \${String(err.message).slice(0, 500)}\` : '',
              ].filter(Boolean).join('\\n'),
              {
                startedAt,
                modelUsed: typeof seekdeepNoModelLabel === 'function' ? seekdeepNoModelLabel() : 'local command (no AI model)',
              }
            )
          : 'Discord thread archive failed.',`,
`          ? seekdeepAppendResponseFooter(
              seekdeepBuildArchiveFailureText(err, savedPath),
              {
                startedAt,
                modelUsed: typeof seekdeepNoModelLabel === 'function' ? seekdeepNoModelLabel() : 'local command (no AI model)',
              }
            )
          : seekdeepBuildArchiveFailureText(err, savedPath),`,
'emergency archive button failure text',
{ optional: true }
);

replaceOne(
`  const { thread, threadName } = await seekdeepGetOrCreateUserArchiveThread(message, targetUser);

  await message.reply({
    content: [
      mentioned ? \`Archive for <@\${targetUser.id}>: <#\${thread.id}>\` : \`Your archive: <#\${thread.id}>\`,
      \`Thread: \${threadName}\`,
    ].join('\\n'),
    allowedMentions: { repliedUser: false },
  });`,
`  let archiveOpenResult = null;

  try {
    archiveOpenResult = await seekdeepGetOrCreateUserArchiveThread(message, targetUser);
  } catch (err) {
    console.warn('Archive open blocked:', err?.message || err);
    await message.reply({
      content: seekdeepBuildArchiveFailureText(err, ''),
      allowedMentions: { repliedUser: false },
    }).catch(() => null);
    return true;
  }

  const { thread, threadName } = archiveOpenResult;

  await message.reply({
    content: [
      mentioned ? \`Archive for <@\${targetUser.id}>: <#\${thread.id}>\` : \`Your archive: <#\${thread.id}>\`,
      \`Thread: \${threadName}\`,
    ].join('\\n'),
    allowedMentions: { repliedUser: false },
  });`,
'archive open message friendly permission handling',
{ optional: true }
);

replaceOne(
`        content: 'Archive lookup failed locally. Check the bot console for details.',`,
`        content: typeof seekdeepBuildArchiveFailureText === 'function'
          ? seekdeepBuildArchiveFailureText(err, '')
          : 'Archive lookup failed locally. Check the bot console for details.',`,
'outer archive lookup fallback text',
{ optional: true }
);

if (changed === 0) {
  throw new Error('No changes were applied; file may already be patched or anchors drifted.');
}
fs.writeFileSync(path, text);
console.log(`SeekDeep archive permission UX patch applied. Changes: ${changed}`);
'@

Set-Content -Path $PatcherPath -Value $Patcher -Encoding UTF8

try {
  Write-Host "Applying archive permission UX patch..."
  node $PatcherPath $IndexPath

  Write-Host "Running node syntax check..."
  node --check $IndexPath | Tee-Object -FilePath (Join-Path $DiagnosticsDir "node-check-archive-permission-ux-$Stamp.txt")

  if ((Test-Path $PythonPath) -and (Test-Path $ServerPath)) {
    Write-Host "Running Python compile check..."
    & $PythonPath -m py_compile $ServerPath 2>&1 | Tee-Object -FilePath (Join-Path $DiagnosticsDir "python-check-archive-permission-ux-$Stamp.txt")
  } else {
    Write-Host "Python compile check skipped because .venv or local_ai_server.py was not found."
  }

  Write-Host ""
  Write-Host "Archive permission UX patch completed successfully."
  Write-Host "Restart the bot, then test:"
  Write-Host "  @SeekDeep archive @YourUser"
  Write-Host "  Archive button on a generated image"
  Write-Host ""
  Write-Host "Backup kept at: $BackupPath"
} catch {
  Write-Host ""
  Write-Host "Patch or validation failed. Restoring backup..." -ForegroundColor Yellow
  Copy-Item $BackupPath $IndexPath -Force
  Write-Host "Restored: $BackupPath"
  Write-Host "Failure: $($_.Exception.Message)" -ForegroundColor Red
  exit 1
}
