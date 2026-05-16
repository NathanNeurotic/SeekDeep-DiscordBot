$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$ProjectRoot = (Get-Location).Path
$IndexPath = Join-Path $ProjectRoot 'index.js'
$PythonPath = Join-Path $ProjectRoot '.venv\Scripts\python.exe'
$LocalAiPath = Join-Path $ProjectRoot 'local_ai_server.py'
$BackupsDir = Join-Path $ProjectRoot 'backups'
$PatchesDir = Join-Path $ProjectRoot 'patches'

if (-not (Test-Path $IndexPath)) {
  throw "index.js not found at $IndexPath. Run this patch from the SeekDeep project root."
}

New-Item -ItemType Directory -Path $BackupsDir -Force | Out-Null
New-Item -ItemType Directory -Path $PatchesDir -Force | Out-Null

$Stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$BackupPath = Join-Path $BackupsDir "index.js.before-archive-channel-config-v2-$Stamp.bak"
Copy-Item $IndexPath $BackupPath -Force
Write-Host "Backup created: $BackupPath"

$PatchJsPath = Join-Path $PatchesDir "apply_archive_channel_config_v2_$Stamp.cjs"
@'
const fs = require('fs');
const path = require('path');

const indexPath = path.join(process.cwd(), 'index.js');
let source = fs.readFileSync(indexPath, 'utf8');

function findFunctionRange(src, functionName) {
  const signature = new RegExp('(?:async\\s+)?function\\s+' + functionName.replace(/[.*+?^${}()|[\\]\\]/g, '\\$&') + '\\s*\\(');
  const match = signature.exec(src);
  if (!match) throw new Error('Could not find function ' + functionName);

  const start = match.index;
  const braceStart = src.indexOf('{', start);
  if (braceStart === -1) throw new Error('Could not find opening brace for ' + functionName);

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
      if (ch === '\\') i += 1;
      else if (ch === '`') state = 'code';
    } else if (state === 'linecomment') {
      if (ch === '\n') state = 'code';
    } else if (state === 'blockcomment') {
      if (ch === '*' && next === '/') {
        state = 'code';
        i += 1;
      }
    }

    i += 1;
  }

  throw new Error('Could not find end of function ' + functionName);
}

function replaceFunction(src, functionName, replacement) {
  const range = findFunctionRange(src, functionName);
  return src.slice(0, range.start) + replacement + src.slice(range.end);
}

const helperStart = '// SEEKDEEP_ARCHIVE_CHANNEL_CONFIG_START';
const helperEnd = '// SEEKDEEP_ARCHIVE_CHANNEL_CONFIG_END';
const helperBlock = [
  helperStart,
  "const SEEKDEEP_ARCHIVE_GUILD_CONFIG_PATH = path.join(__dirname, 'data', 'archive-guild-config.json');",
  '',
  'function seekdeepReadArchiveGuildConfig() {',
  '  try {',
  '    if (!fs.existsSync(SEEKDEEP_ARCHIVE_GUILD_CONFIG_PATH)) return { guilds: {} };',
  "    const parsed = JSON.parse(fs.readFileSync(SEEKDEEP_ARCHIVE_GUILD_CONFIG_PATH, 'utf8'));",
  "    if (!parsed || typeof parsed !== 'object') return { guilds: {} };",
  "    if (!parsed.guilds || typeof parsed.guilds !== 'object') parsed.guilds = {};",
  '    return parsed;',
  '  } catch (err) {',
  "    console.warn('SeekDeep archive guild config read failed:', err?.message || err);",
  '    return { guilds: {} };',
  '  }',
  '}',
  '',
  'function seekdeepWriteArchiveGuildConfig(config) {',
  '  try {',
  '    const safe = config && typeof config === \'object\' ? config : { guilds: {} };',
  '    if (!safe.guilds || typeof safe.guilds !== \'object\') safe.guilds = {};',
  '    fs.mkdirSync(path.dirname(SEEKDEEP_ARCHIVE_GUILD_CONFIG_PATH), { recursive: true });',
  "    fs.writeFileSync(SEEKDEEP_ARCHIVE_GUILD_CONFIG_PATH, JSON.stringify(safe, null, 2) + '\\n', 'utf8');",
  '    return true;',
  '  } catch (err) {',
  "    console.warn('SeekDeep archive guild config write failed:', err?.message || err);",
  '    return false;',
  '  }',
  '}',
  '',
  'function seekdeepGetArchiveChannelIdForGuild(guildId = \'\') {',
  '  const id = String(guildId || \'\').trim();',
  '  if (!id) return \'\';',
  '  const config = seekdeepReadArchiveGuildConfig();',
  '  return String(config.guilds?.[id]?.archiveChannelId || \'\').trim();',
  '}',
  '',
  'function seekdeepSetArchiveChannelIdForGuild(guildId = \'\', channelId = \'\', configuredBy = \'\') {',
  '  const gid = String(guildId || \'\').trim();',
  '  const cid = String(channelId || \'\').trim();',
  '  if (!gid || !cid) return false;',
  '  const config = seekdeepReadArchiveGuildConfig();',
  '  if (!config.guilds || typeof config.guilds !== \'object\') config.guilds = {};',
  '  config.guilds[gid] = {',
  '    archiveChannelId: cid,',
  '    configuredBy: String(configuredBy || \'\'),',
  '    configuredAt: new Date().toISOString(),',
  '  };',
  '  return seekdeepWriteArchiveGuildConfig(config);',
  '}',
  '',
  'function seekdeepArchiveRequiredPermissionNames() {',
  "  return ['ViewChannel', 'SendMessages', 'SendMessagesInThreads', 'CreatePublicThreads', 'AttachFiles', 'ReadMessageHistory'];",
  '}',
  '',
  'function seekdeepArchiveChannelPermissionReport(channel, guild) {',
  '  const missing = [];',
  '  try {',
  '    const botMember = guild?.members?.me || guild?.members?.cache?.get?.(guild?.client?.user?.id);',
  '    const perms = channel?.permissionsFor?.(botMember);',
  '    for (const name of seekdeepArchiveRequiredPermissionNames()) {',
  '      if (!perms || !perms.has(name)) missing.push(name);',
  '    }',
  '  } catch (err) {',
  '    missing.push(...seekdeepArchiveRequiredPermissionNames());',
  '  }',
  '  return { ok: missing.length === 0, missing };',
  '}',
  '',
  'function seekdeepHasArchiveConfigPermission(message) {',
  '  try {',
  '    const perms = message?.member?.permissions;',
  '    if (!perms) return false;',
  '    return perms.has(\'Administrator\') || perms.has(\'ManageGuild\') || perms.has(\'ManageChannels\');',
  '  } catch {',
  '    return false;',
  '  }',
  '}',
  '',
  'function seekdeepArchiveSetupHelpText(guild = null) {',
  '  return [',
  "    'Archive channel is not configured for this server yet.',",
  "    'A server admin can assign one with:',",
  "    '`@SeekDeep archive setup #channel`',",
  "    '`@SeekDeep archive setup here`',",
  "    '',",
  "    'Required bot permissions in the assigned channel:',",
  "    seekdeepArchiveRequiredPermissionNames().map((name) => '- ' + name).join('\\n'),",
  "    '',",
  "    'No archive channel was auto-created. Local fallback remains available when Discord archive delivery cannot run.'",
  '  ].filter(Boolean).join(\'\\n\');',
  '}',
  '',
  'function seekdeepCleanArchiveConfigPrompt(value = \'\') {',
  '  return String(value || \'\')',
  "    .replace(/<@!?\\d+>/g, ' ')",
  "    .replace(/<@&\\d+>/g, ' ')",
  "    .replace(/\\bseekdeep\\b/gi, ' ')",
  "    .replace(/\\bseekotics\\b/gi, ' ')",
  "    .replace(/^[@/\\s]+/g, ' ')",
  "    .replace(/\\s+/g, ' ')",
  '    .trim();',
  '}',
  '',
  'function seekdeepIsArchiveConfigPrompt(value = \'\') {',
  '  const cleaned = seekdeepCleanArchiveConfigPrompt(value).toLowerCase();',
  "  return /^(?:archive\\s+(?:setup|configure|config|channel|set\\s+channel)|set\\s+archive\\s+channel)(?:\\b|$)/i.test(cleaned);",
  '}',
  '',
  'function seekdeepExtractArchiveSetupChannel(message, prompt = \'\') {',
  '  const raw = String(prompt || message?.content || \'\');',
  '  const mentioned = message?.mentions?.channels?.first?.();',
  '  if (mentioned) return mentioned;',
  '  const mentionMatch = raw.match(/<#(\\d+)>/);',
  '  if (mentionMatch) return message?.guild?.channels?.cache?.get?.(mentionMatch[1]) || null;',
  '  const cleaned = seekdeepCleanArchiveConfigPrompt(raw).toLowerCase();',
  "  if (/\\b(?:here|this\\s+channel)\\b/i.test(cleaned)) return message?.channel || null;",
  '  return null;',
  '}',
  '',
  'async function seekdeepHandleArchiveConfigMessage(message, prompt = \'\') {',
  '  if (!message || !seekdeepIsArchiveConfigPrompt(prompt || message.content || \'\')) return false;',
  '  if (typeof seekdeepLogRoute === \'function\') seekdeepLogRoute(\'archive-config-message\', prompt || message.content || \'\');',
  '',
  '  if (!message.guild) {',
  '    await message.reply({ content: \'Archive channel setup only works inside a server.\', allowedMentions: { repliedUser: false } });',
  '    return true;',
  '  }',
  '',
  '  const currentId = seekdeepGetArchiveChannelIdForGuild(message.guild.id);',
  '  const requestedChannel = seekdeepExtractArchiveSetupChannel(message, prompt);',
  '',
  '  if (!seekdeepHasArchiveConfigPermission(message)) {',
  '    await message.reply({',
  "      content: ['Only someone with Manage Server, Manage Channels, or Administrator can assign the SeekDeep archive channel.', currentId ? ('Current configured channel: <#' + currentId + '>') : 'No archive channel is configured yet.'].join('\\n'),",
  '      allowedMentions: { repliedUser: false },',
  '    });',
  '    return true;',
  '  }',
  '',
  '  if (!requestedChannel) {',
  '    await message.reply({',
  "      content: [currentId ? ('Current configured channel: <#' + currentId + '>') : 'No archive channel is configured yet.', 'Assign one with `@SeekDeep archive setup #channel` or `@SeekDeep archive setup here`.'].join('\\n'),",
  '      allowedMentions: { repliedUser: false },',
  '    });',
  '    return true;',
  '  }',
  '',
  '  if (!requestedChannel.guild || requestedChannel.guild.id !== message.guild.id || typeof requestedChannel.send !== \'function\' || !requestedChannel.threads) {',
  '    await message.reply({ content: \'That target must be a text channel in this server with thread support.\', allowedMentions: { repliedUser: false } });',
  '    return true;',
  '  }',
  '',
  '  const report = seekdeepArchiveChannelPermissionReport(requestedChannel, message.guild);',
  '  if (!report.ok) {',
  '    await message.reply({',
  "      content: ['I can assign that channel after the bot role has these missing permissions in <#' + requestedChannel.id + '>:', report.missing.map((name) => '- ' + name).join('\\n')].join('\\n'),",
  '      allowedMentions: { repliedUser: false },',
  '    });',
  '    return true;',
  '  }',
  '',
  '  if (!seekdeepSetArchiveChannelIdForGuild(message.guild.id, requestedChannel.id, message.author?.id || \'\')) {',
  '    await message.reply({ content: \'Archive channel validation passed, but writing the local config file failed. Check file permissions for `data/archive-guild-config.json`.\', allowedMentions: { repliedUser: false } });',
  '    return true;',
  '  }',
  '',
  '  await message.reply({',
  "    content: ['Archive channel assigned for this server: <#' + requestedChannel.id + '>', 'Future archives will use this channel instead of auto-creating a static channel.'].join('\\n'),",
  '    allowedMentions: { repliedUser: false },',
  '  });',
  '  return true;',
  '}',
  helperEnd,
  ''
].join('\n');

function upsertHelperBlock(src) {
  const start = src.indexOf(helperStart);
  const end = src.indexOf(helperEnd);
  if (start !== -1 && end !== -1 && end > start) {
    return src.slice(0, start) + helperBlock + src.slice(end + helperEnd.length);
  }
  const anchor = 'function seekdeepArchiveChannelName()';
  const idx = src.indexOf(anchor);
  if (idx === -1) throw new Error('Could not find archive channel helper anchor.');
  return src.slice(0, idx) + helperBlock + src.slice(idx);
}

const newGetOrCreateGuildArchiveChannel = [
  'async function seekdeepGetOrCreateGuildArchiveChannel(target) {',
  '  target = target || null;',
  '  const guild = target?.guild || target?.message?.guild || target?.channel?.guild || null;',
  "  if (!guild) throw new Error('Archive threads require a Discord server.');",
  '',
  "  const configuredId = String(process.env.SEEKDEEP_ARCHIVE_CHANNEL_ID || '').trim();",
  '  if (configuredId) {',
  '    const byId = guild.channels.cache.get(configuredId) || await guild.channels.fetch(configuredId).catch(() => null);',
  '    if (byId) return byId;',
  "    const err = new Error('SEEKDEEP_ARCHIVE_CHANNEL_ID is set, but that channel is not accessible in this server. Fix the env value or bot channel permissions.');",
  "    err.code = 'SEEKDEEP_ARCHIVE_CHANNEL_NOT_ACCESSIBLE';",
  '    throw err;',
  '  }',
  '',
  "  const storedId = typeof seekdeepGetArchiveChannelIdForGuild === 'function' ? seekdeepGetArchiveChannelIdForGuild(guild.id) : '';",
  '  if (storedId) {',
  '    const byStoredId = guild.channels.cache.get(storedId) || await guild.channels.fetch(storedId).catch(() => null);',
  '    if (byStoredId) return byStoredId;',
  '  }',
  '',
  "  const adoptNamedChannel = String(process.env.SEEKDEEP_ARCHIVE_ADOPT_NAMED_CHANNEL || 'true').toLowerCase() !== 'false';",
  '  if (adoptNamedChannel) {',
  '    const wantedName = seekdeepArchiveChannelName();',
  '    let channel = guild.channels.cache.find((candidate) =>',
  '      candidate && candidate.name === wantedName && typeof candidate.send === \'function\' && candidate.threads',
  '    );',
  '',
  '    if (!channel) {',
  '      const fetched = await guild.channels.fetch().catch(() => null);',
  '      if (fetched) {',
  '        channel = fetched.find((candidate) =>',
  '          candidate && candidate.name === wantedName && typeof candidate.send === \'function\' && candidate.threads',
  '        );',
  '      }',
  '    }',
  '',
  '    if (channel) {',
  "      if (typeof seekdeepSetArchiveChannelIdForGuild === 'function') seekdeepSetArchiveChannelIdForGuild(guild.id, channel.id, 'auto-adopted-existing-channel');",
  '      return channel;',
  '    }',
  '  }',
  '',
  "  const autoCreate = String(process.env.SEEKDEEP_ARCHIVE_AUTO_CREATE_CHANNEL || 'false').toLowerCase() === 'true';",
  '  if (autoCreate) {',
  '    const wantedName = seekdeepArchiveChannelName();',
  '    const channel = await guild.channels.create({',
  '      name: wantedName,',
  '      type: 0,',
  "      reason: 'SeekDeep server archive channel',",
  '    });',
  "    if (typeof seekdeepSetArchiveChannelIdForGuild === 'function') seekdeepSetArchiveChannelIdForGuild(guild.id, channel.id, 'auto-created-channel');",
  "    await channel.send('SeekDeep archive channel initialized. User archive threads will be created here.').catch(() => null);",
  '    return channel;',
  '  }',
  '',
  "  const err = new Error(typeof seekdeepArchiveSetupHelpText === 'function' ? seekdeepArchiveSetupHelpText(guild) : 'Archive channel is not configured for this server.');",
  "  err.code = 'SEEKDEEP_ARCHIVE_NOT_CONFIGURED';",
  '  throw err;',
  '}'
].join('\n');

let before = source;
source = upsertHelperBlock(source);
source = replaceFunction(source, 'seekdeepGetOrCreateGuildArchiveChannel', newGetOrCreateGuildArchiveChannel);

if (!source.includes('seekdeepHandleArchiveConfigMessage(message, seekdeepArchiveConfigRawContent)')) {
  const routePattern = /try\s*\{\r?\n\s*const seekdeepArchiveOpenRawContent = String\(message\?\.content \|\| ''\);/;
  const routeInsert = [
    'try {',
    "    const seekdeepArchiveConfigRawContent = String(message?.content || '');",
    '    if (await seekdeepHandleArchiveConfigMessage(message, seekdeepArchiveConfigRawContent)) {',
    '      return;',
    '    }',
    '  } catch (err) {',
    "    console.error('Archive config message handler failed:', err?.stack || err?.message || err);",
    '    try {',
    '      await message.reply({',
    "        content: 'Archive channel setup failed locally. Check the bot console for details.',",
    '        allowedMentions: { repliedUser: false },',
    '      });',
    '    } catch {}',
    '    return;',
    '  }',
    '',
    '  try {',
    "    const seekdeepArchiveOpenRawContent = String(message?.content || '');"
  ].join('\n');
  if (!routePattern.test(source)) throw new Error('Could not find messageCreate archive-open route anchor.');
  source = source.replace(routePattern, routeInsert);
}

source = source.replace(
  "content: 'Archive lookup failed locally. Check the bot console for details.',",
  "content: err?.code === 'SEEKDEEP_ARCHIVE_NOT_CONFIGURED' ? err.message : 'Archive lookup failed locally. Check the bot console for details.',"
);

if (source === before) throw new Error('Patch made no changes; refusing to continue.');

fs.writeFileSync(indexPath, source, 'utf8');
console.log('Patched archive channel configuration flow successfully. (v2)');
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

  Write-Host "Patch applied successfully."
  Write-Host "Config file path: .\data\archive-guild-config.json"
} catch {
  Write-Host "Patch failed. Restoring backup..." -ForegroundColor Yellow
  Copy-Item $BackupPath $IndexPath -Force
  Write-Host "Restored: $BackupPath" -ForegroundColor Yellow
  throw
}
