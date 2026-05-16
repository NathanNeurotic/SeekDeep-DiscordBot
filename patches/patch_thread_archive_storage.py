from pathlib import Path
import re
import sys

if len(sys.argv) != 2:
    raise SystemExit("Usage: patch_thread_archive_storage.py <index.js>")

path = Path(sys.argv[1])
raw = path.read_bytes()
newline = "\r\n" if b"\r\n" in raw else "\n"
text = raw.decode("utf-8-sig").replace("\r\n", "\n").replace("\r", "\n")


def fail(msg):
    raise SystemExit(msg)


def find_matching_brace(source, open_brace_index):
    depth = 0
    i = open_brace_index
    in_single = False
    in_double = False
    in_template = False
    in_line_comment = False
    in_block_comment = False
    escaped = False

    while i < len(source):
        ch = source[i]
        nxt = source[i + 1] if i + 1 < len(source) else ""

        if in_line_comment:
            if ch == "\n":
                in_line_comment = False
            i += 1
            continue

        if in_block_comment:
            if ch == "*" and nxt == "/":
                in_block_comment = False
                i += 2
                continue
            i += 1
            continue

        if in_single:
            if not escaped and ch == "\\":
                escaped = True
            elif not escaped and ch == "'":
                in_single = False
            else:
                escaped = False
            i += 1
            continue

        if in_double:
            if not escaped and ch == "\\":
                escaped = True
            elif not escaped and ch == '"':
                in_double = False
            else:
                escaped = False
            i += 1
            continue

        if in_template:
            if not escaped and ch == "\\":
                escaped = True
            elif not escaped and ch == "`":
                in_template = False
            else:
                escaped = False
            i += 1
            continue

        if ch == "/" and nxt == "/":
            in_line_comment = True
            i += 2
            continue

        if ch == "/" and nxt == "*":
            in_block_comment = True
            i += 2
            continue

        if ch == "'":
            in_single = True
            i += 1
            continue

        if ch == '"':
            in_double = True
            i += 1
            continue

        if ch == "`":
            in_template = True
            i += 1
            continue

        if ch == "{":
            depth += 1
        elif ch == "}":
            depth -= 1
            if depth == 0:
                return i

        i += 1

    fail("Could not find matching closing brace.")


def get_function(source, name):
    for prefix in ("async function ", "function "):
        start = source.find(f"{prefix}{name}(")
        if start >= 0:
            break
    else:
        return None, -1, -1

    open_brace = source.find("{", start)
    if open_brace < 0:
        fail(f"Could not locate opening brace for {name}.")
    close_brace = find_matching_brace(source, open_brace)
    return source[start:close_brace + 1], start, close_brace + 1


def replace_function(source, name, new_fn):
    _, start, end = get_function(source, name)
    if start < 0:
        fail(f"Could not replace missing function: {name}")
    return source[:start] + new_fn.rstrip() + source[end:]


def get_client_handler(source, event_name):
    for quote in ("'", '"'):
        needle = f"client.on({quote}{event_name}{quote}"
        start = source.find(needle)
        if start >= 0:
            break
    else:
        return None, -1, -1

    arrow = source.find("=>", start)
    if arrow < 0:
        fail(f"Could not find arrow for client.on {event_name}")

    open_brace = source.find("{", arrow)
    if open_brace < 0:
        fail(f"Could not find opening brace for client.on {event_name}")

    close_brace = find_matching_brace(source, open_brace)
    end = close_brace + 1
    while end < len(source) and source[end].isspace():
        end += 1
    if source.startswith(");", end):
        end += 2
    elif end < len(source) and source[end] == ")":
        end += 1
        if end < len(source) and source[end] == ";":
            end += 1
    return source[start:end], start, end


if "client.on('interactionCreate'" not in text and 'client.on("interactionCreate"' not in text:
    fail("interactionCreate handler not found")
if "client.on('messageCreate'" not in text and 'client.on("messageCreate"' not in text:
    fail("messageCreate handler not found")
if "seekdeepEnqueueImageJob(job, runner)" not in text:
    fail("queue contract anchor not found")

# Ensure ChannelType is imported from discord.js if project uses named import.
discord_import = re.search(r"import\s+\{([\s\S]*?)\}\s+from\s+['\"]discord\.js['\"]\s*;", text)
if discord_import and "ChannelType" not in discord_import.group(1):
    inner = discord_import.group(1).rstrip()
    if inner.strip().endswith(","):
        new_inner = inner + "\n  ChannelType,"
    else:
        new_inner = inner + ",\n  ChannelType"
    text = text[:discord_import.start(1)] + new_inner + text[discord_import.end(1):]

helpers = r"""function seekdeepArchiveChannelName() {
  return String(process.env.SEEKDEEP_ARCHIVE_CHANNEL_NAME || 'seekdeep-archive')
    .trim()
    .replace(/^#+/, '')
    .replace(/\s+/g, '-')
    .toLowerCase() || 'seekdeep-archive';
}

function seekdeepArchiveUserThreadName(user = null) {
  const username = String(user?.username || user?.globalName || user?.displayName || user?.id || 'unknown-user')
    .replace(/[^a-zA-Z0-9_. -]+/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .slice(0, 48) || 'unknown-user';

  const idSuffix = user?.id ? `-${String(user.id).slice(-6)}` : '';
  return `archive-${username}${idSuffix}`.slice(0, 90);
}

function seekdeepArchiveStateFilePath(state = {}) {
  const candidates = [
    state?.filePath,
    state?.path,
    state?.fullPath,
    state?.savedPath,
    state?.imagePath,
    state?.outputPath,
    state?.localPath,
    state?.attachmentPath,
  ];

  for (const candidate of candidates) {
    const value = String(candidate || '').trim();
    if (!value) continue;
    try {
      if (fs.existsSync(value)) return value;
    } catch {}
  }

  return '';
}

function seekdeepArchiveMetadataLines(state = {}, target = null) {
  const prompt = state?.originalPrompt || state?.rawPrompt || state?.prompt || 'unknown prompt';
  const refinedPrompt = state?.refinedPrompt || state?.finalPrompt || '';
  const requester =
    target?.user ||
    target?.author ||
    target?.member?.user ||
    null;

  const lines = [
    '**SeekDeep Image Archive Entry**',
    requester?.id ? `Requester: <@${requester.id}>` : '',
    `Prompt: ${String(prompt).slice(0, 1500)}`,
  ];

  if (refinedPrompt && refinedPrompt !== prompt) {
    lines.push(`Refined: ${String(refinedPrompt).slice(0, 1500)}`);
  }

  if (state?.jobId) lines.push(`Job ID: ${state.jobId}`);
  if (state?.modelUsed || state?.model) lines.push(`Model: ${state.modelUsed || state.model}`);
  if (state?.seed !== undefined && state?.seed !== null) lines.push(`Seed: ${state.seed}`);
  if (state?.width && state?.height) lines.push(`Size: ${state.width}x${state.height}`);

  lines.push(`Archived: ${new Date().toISOString()}`);
  return lines.filter(Boolean);
}

async function seekdeepGetOrCreateGuildArchiveChannel(target = null) {
  const guild = target?.guild || target?.message?.guild || target?.channel?.guild || null;
  if (!guild) {
    throw new Error('Archive threads require a Discord server. DM archives are not supported by the thread backend yet.');
  }

  const configuredId = String(process.env.SEEKDEEP_ARCHIVE_CHANNEL_ID || '').trim();
  if (configuredId) {
    const existing = guild.channels.cache.get(configuredId) || await guild.channels.fetch(configuredId).catch(() => null);
    if (existing) return existing;
    console.warn(`[SeekDeep] SEEKDEEP_ARCHIVE_CHANNEL_ID was set but not found in ${guild.id}: ${configuredId}`);
  }

  const wantedName = seekdeepArchiveChannelName();
  let channel = guild.channels.cache.find((candidate) =>
    candidate &&
    candidate.name === wantedName &&
    typeof candidate.send === 'function' &&
    candidate.threads
  );

  if (!channel) {
    const fetched = await guild.channels.fetch().catch(() => null);
    if (fetched) {
      channel = fetched.find((candidate) =>
        candidate &&
        candidate.name === wantedName &&
        typeof candidate.send === 'function' &&
        candidate.threads
      );
    }
  }

  if (channel) return channel;

  const createOptions = {
    name: wantedName,
    reason: 'SeekDeep server archive channel',
  };

  if (typeof ChannelType !== 'undefined' && ChannelType.GuildText !== undefined) {
    createOptions.type = ChannelType.GuildText;
  } else {
    createOptions.type = 0;
  }

  channel = await guild.channels.create(createOptions);
  await channel.send('SeekDeep archive channel initialized. User archive threads will be created here.').catch(() => null);
  return channel;
}

async function seekdeepFindArchiveThread(channel, threadName) {
  const active = await channel.threads.fetchActive().catch(() => null);
  const activeThread = active?.threads?.find((thread) => thread?.name === threadName);
  if (activeThread) return activeThread;

  const archivedPublic = await channel.threads.fetchArchived({ type: 'public' }).catch(() => null);
  const archivedThread = archivedPublic?.threads?.find((thread) => thread?.name === threadName);
  if (archivedThread) {
    try {
      if (archivedThread.archived) await archivedThread.setArchived(false, 'SeekDeep archive write');
    } catch {}
    return archivedThread;
  }

  const archivedPrivate = await channel.threads.fetchArchived({ type: 'private' }).catch(() => null);
  const privateThread = archivedPrivate?.threads?.find((thread) => thread?.name === threadName);
  if (privateThread) {
    try {
      if (privateThread.archived) await privateThread.setArchived(false, 'SeekDeep archive write');
    } catch {}
    return privateThread;
  }

  return null;
}

async function seekdeepGetOrCreateUserArchiveThread(target = null, userOverride = null) {
  const channel = await seekdeepGetOrCreateGuildArchiveChannel(target);
  const user =
    userOverride ||
    target?.user ||
    target?.author ||
    target?.member?.user ||
    target?.message?.author ||
    null;

  const threadName = seekdeepArchiveUserThreadName(user);
  let thread = await seekdeepFindArchiveThread(channel, threadName);
  if (thread) return { channel, thread, threadName };

  thread = await channel.threads.create({
    name: threadName,
    autoArchiveDuration: 10080,
    reason: `SeekDeep archive thread for ${user?.id || 'unknown user'}`,
  });

  await thread.send([
    `Archive thread for ${user?.id ? `<@${user.id}>` : 'unknown user'}.`,
    'New archived generations for this user will be posted here.',
  ].join('\n')).catch(() => null);

  return { channel, thread, threadName };
}

async function seekdeepArchiveImageStateToDiscordThread(state = {}, target = null) {
  const { thread, threadName } = await seekdeepGetOrCreateUserArchiveThread(target);
  const filePath = seekdeepArchiveStateFilePath(state);
  const metadata = seekdeepArchiveMetadataLines(state, target).join('\n');

  const payload = { content: metadata };

  if (filePath) {
    payload.files = [filePath];
  } else if (state?.url || state?.downloadUrl || state?.attachmentUrl || state?.proxyURL) {
    payload.content += `\nImage URL: ${state.url || state.downloadUrl || state.attachmentUrl || state.proxyURL}`;
  }

  await thread.send(payload);

  return {
    ok: true,
    backend: 'discord-thread',
    threadId: thread.id,
    threadName,
    channelId: thread.parentId || thread.parent?.id || '',
  };
}

function seekdeepIsArchiveMigrationPrompt(value = '') {
  return /^(?:migrate\s*archive|migratearchive|archive\s*migrate|archive\s*migration)$/i.test(
    String(value || '')
      .replace(/<@!?\d+>/g, ' ')
      .replace(/\bseekotics\b/gi, ' ')
      .replace(/\bseekdeep\b/gi, ' ')
      .replace(/^[@/\s]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
  );
}

function seekdeepLocalArchiveFilesForMigration(target = null) {
  const safeTarget = target || {};
  const guildId = safeTarget?.guild?.id || safeTarget?.guildId || safeTarget?.message?.guild?.id || safeTarget?.message?.guildId || '';
  const baseDir = typeof __dirname !== 'undefined' ? __dirname : process.cwd();
  const dirs = [];

  if (guildId) {
    dirs.push(path.join(baseDir, 'saved_generations', 'archives', `guild-${guildId}`));
  }

  dirs.push(path.join(baseDir, 'saved_generations', 'archives'));
  dirs.push(path.join(baseDir, 'saved_generations'));

  const seen = new Set();
  const files = [];

  for (const dir of dirs) {
    try {
      if (!fs.existsSync(dir)) continue;

      for (const name of fs.readdirSync(dir)) {
        const fullPath = path.join(dir, name);
        if (seen.has(fullPath)) continue;
        seen.add(fullPath);

        let stat = null;
        try {
          stat = fs.statSync(fullPath);
        } catch {}

        if (!stat || !stat.isFile()) continue;
        if (!/\.(?:png|jpe?g|webp|gif)$/i.test(name)) continue;

        const migratedMarker = `${fullPath}.discord-thread-migrated`;
        if (fs.existsSync(migratedMarker)) continue;

        files.push({ name, fullPath, migratedMarker, stat });
      }
    } catch (err) {
      console.warn('SeekDeep archive migration scan failed:', err?.message || err);
    }
  }

  return files.sort((a, b) => Number(a.stat?.mtimeMs || 0) - Number(b.stat?.mtimeMs || 0));
}

async function seekdeepMigrateLocalArchiveToThreads(target = null, options = {}) {
  const files = seekdeepLocalArchiveFilesForMigration(target);
  const limit = Math.max(1, Math.min(Number(options.limit || 25), 100));
  const selected = files.slice(0, limit);
  let migrated = 0;
  let failed = 0;

  const user = target?.user || target?.author || target?.member?.user || null;

  for (const file of selected) {
    try {
      await seekdeepArchiveImageStateToDiscordThread({
        filePath: file.fullPath,
        prompt: `legacy local archive import: ${file.name}`,
        originalPrompt: `legacy local archive import: ${file.name}`,
        modelUsed: 'legacy local archive',
      }, target);

      try {
        fs.writeFileSync(file.migratedMarker, new Date().toISOString(), 'utf8');
      } catch {}

      migrated += 1;
    } catch (err) {
      failed += 1;
      console.warn('SeekDeep archive migration file failed:', file.fullPath, err?.message || err);
    }
  }

  return {
    totalLocalFiles: files.length,
    attempted: selected.length,
    migrated,
    failed,
    remaining: Math.max(files.length - selected.length, 0),
    userId: user?.id || '',
  };
}

async function seekdeepHandleArchiveMigrationMessage(message, prompt = '') {
  if (!message || !seekdeepIsArchiveMigrationPrompt(prompt || message.content || '')) return false;

  if (!message.guild) {
    await message.reply({
      content: 'Archive thread migration only works inside a server.',
      allowedMentions: { repliedUser: false },
    });
    return true;
  }

  const canManage =
    message.member?.permissions?.has?.('ManageGuild') ||
    message.member?.permissions?.has?.('Administrator') ||
    message.member?.permissions?.has?.('ManageChannels');

  if (!canManage) {
    await message.reply({
      content: 'Archive migration is restricted to server managers.',
      allowedMentions: { repliedUser: false },
    });
    return true;
  }

  if (typeof seekdeepLogRoute === 'function') {
    seekdeepLogRoute('archive-migrate-message', prompt || message.content || '');
  }

  const result = await seekdeepMigrateLocalArchiveToThreads(message, { limit: 25 });
  await message.reply({
    content: [
      'Archive migration pass complete.',
      `Backend: Discord archive threads`,
      `Attempted: ${result.attempted}`,
      `Migrated: ${result.migrated}`,
      `Failed: ${result.failed}`,
      `Remaining local files: ${result.remaining}`,
      '',
      result.remaining > 0 ? 'Run migratearchive again to continue the next batch.' : 'No remaining local images found for this pass.',
    ].join('\n'),
    allowedMentions: { repliedUser: false },
  });

  return true;
}"""

if "function seekdeepArchiveImageStateToDiscordThread" not in text:
    insert_pos = text.find("async function seekdeepHandleImageButton")
    if insert_pos < 0:
        insert_pos = text.find("function seekdeepHandleImageButton")
    if insert_pos < 0:
        insert_pos = text.find("client.on('interactionCreate'")
    if insert_pos < 0:
        fail("Could not find insertion point for thread archive helpers.")
    text = text[:insert_pos] + helpers + "\n\n" + text[insert_pos:]

# Patch image button archive branch if handler exists.
handler, hs, he = get_function(text, "seekdeepHandleImageButton")
if hs >= 0 and "seekdeepArchiveImageStateToDiscordThread(state, interaction)" not in handler:
    marker = "if (action === 'archive')"
    idx = handler.find(marker)
    if idx >= 0:
        open_brace = handler.find("{", idx)
        close_brace = find_matching_brace(handler, open_brace)
        new_block = r"""if (action === 'archive') {
    try {
      const archiveResult = await seekdeepArchiveImageStateToDiscordThread(state, interaction);
      await interaction.editReply({
        content: seekdeepAppendResponseFooter([
          'Archived to this server.',
          archiveResult?.threadName ? `Thread: ${archiveResult.threadName}` : '',
        ].filter(Boolean).join('\n'), {
          startedAt,
          modelUsed: seekdeepNoModelLabel(),
        }),
      });
      return true;
    } catch (err) {
      console.warn('Discord thread archive failed; falling back to local archive:', err?.message || err);

      const savedPath = typeof seekdeepArchiveImageStateToDisk === 'function'
        ? seekdeepArchiveImageStateToDisk(state)
        : '';

      await interaction.editReply({
        content: seekdeepAppendResponseFooter([
          'Discord thread archive failed.',
          savedPath ? 'Saved locally as fallback.' : 'No fallback file was written.',
          err?.message ? `Reason: ${String(err.message).slice(0, 500)}` : '',
        ].filter(Boolean).join('\n'), {
          startedAt,
          modelUsed: seekdeepNoModelLabel(),
        }),
      });
      return true;
    }
  }"""
        handler = handler[:idx] + new_block + handler[close_brace + 1:]
        text = text[:hs] + handler + text[he:]

# Patch messageCreate handler for migratearchive command.
message_handler, ms, me = get_client_handler(text, "messageCreate")
if ms >= 0 and "seekdeepHandleArchiveMigrationMessage(message" not in message_handler:
    open_brace = message_handler.find("{")
    injection = r"""
  try {
    const seekdeepArchiveMigrationRawContent = String(message?.content || '');
    if (await seekdeepHandleArchiveMigrationMessage(message, seekdeepArchiveMigrationRawContent)) {
      return;
    }
  } catch (err) {
    console.error('Archive migration message handler failed:', err?.stack || err?.message || err);
    try {
      await message.reply({
        content: 'Archive migration failed locally. Check the bot console for details.',
        allowedMentions: { repliedUser: false },
      });
    } catch {}
    return;
  }

"""
    bot_guard = re.search(r"\n\s*if\s*\([^\n]*(?:message\.author\.bot|author\?\.bot)[^\n]*\)\s*return\s*;?", message_handler)
    if bot_guard:
        insert_at = bot_guard.end()
        message_handler = message_handler[:insert_at] + injection + message_handler[insert_at:]
    else:
        message_handler = message_handler[:open_brace + 1] + injection + message_handler[open_brace + 1:]
    text = text[:ms] + message_handler + text[me:]

# Validation.
for needle, label in [
    ("function seekdeepArchiveImageStateToDiscordThread", "thread archive writer"),
    ("function seekdeepGetOrCreateUserArchiveThread", "user thread creator"),
    ("function seekdeepHandleArchiveMigrationMessage", "migration message handler"),
    ("seekdeepArchiveImageStateToDiscordThread(state, interaction)", "image archive branch"),
    ("seekdeepEnqueueImageJob(job, runner)", "queue contract"),
]:
    if needle not in text:
        fail(f"Required anchor missing after patch: {label}")

out = text if newline == "\n" else text.replace("\n", "\r\n")
path.write_bytes(out.encode("utf-8"))
print("Patched Discord thread archive storage.")