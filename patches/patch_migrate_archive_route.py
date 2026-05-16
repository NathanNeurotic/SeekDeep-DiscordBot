from pathlib import Path
import re
import sys

if len(sys.argv) != 2:
    raise SystemExit("Usage: patch_migrate_archive_route.py <index.js>")

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
        start = source.find(prefix + name + "(")
        if start >= 0:
            break
    else:
        return None, -1, -1

    sig = source[start:start + 1000]
    m = re.search(r"\)\s*\{", sig)
    if not m:
        fail(f"Could not find opening brace for {name}")
    open_brace = start + m.end() - 1
    close = find_matching_brace(source, open_brace)
    return source[start:close + 1], start, close + 1


def replace_or_insert_function(source, name, new_fn, anchor=None):
    _fn, start, end = get_function(source, name)
    if start >= 0:
        return source[:start] + new_fn.rstrip() + source[end:]

    pos = -1
    if anchor:
        for prefix in ("async function ", "function "):
            pos = source.find(prefix + anchor + "(")
            if pos >= 0:
                break

    if pos < 0:
        pos = source.find("client.on('messageCreate'")
    if pos < 0:
        pos = source.find('client.on("messageCreate"')
    if pos < 0:
        pos = source.find("client.on('interactionCreate'")
    if pos < 0:
        pos = source.find('client.on("interactionCreate"')
    if pos < 0:
        fail(f"Could not insert function {name}")

    return source[:pos] + new_fn.rstrip() + "\n\n" + source[pos:]


def get_client_handler(source, event_name):
    for quote in ("'", '"'):
        start = source.find(f"client.on({quote}{event_name}{quote}")
        if start >= 0:
            break
    else:
        return None, -1, -1

    arrow = source.find("=>", start)
    if arrow < 0:
        return None, -1, -1

    open_brace = source.find("{", arrow)
    if open_brace < 0:
        return None, -1, -1

    close = find_matching_brace(source, open_brace)
    end = close + 1
    while end < len(source) and source[end].isspace():
        end += 1
    if source.startswith(");", end):
        end += 2
    elif end < len(source) and source[end] == ")":
        end += 1
        if end < len(source) and source[end] == ";":
            end += 1
    return source[start:end], start, end


if "client.on('messageCreate'" not in text and 'client.on("messageCreate"' not in text:
    fail("messageCreate handler not found")

# Fallback archive channel helper only if missing.
fallback_channel_helper = r"""function seekdeepArchiveChannelName() {
  return String(process.env.SEEKDEEP_ARCHIVE_CHANNEL_NAME || 'seekdeep-archive')
    .trim()
    .replace(/^#+/, '')
    .replace(/\s+/g, '-')
    .toLowerCase() || 'seekdeep-archive';
}

async function seekdeepGetOrCreateGuildArchiveChannel(target) {
  target = target || null;
  const guild = target?.guild || target?.message?.guild || target?.channel?.guild || null;
  if (!guild) throw new Error('Archive threads require a Discord server.');

  const configuredId = String(process.env.SEEKDEEP_ARCHIVE_CHANNEL_ID || '').trim();
  if (configuredId) {
    const byId = guild.channels.cache.get(configuredId) || await guild.channels.fetch(configuredId).catch(() => null);
    if (byId) return byId;
  }

  const wantedName = seekdeepArchiveChannelName();
  let channel = guild.channels.cache.find((candidate) =>
    candidate && candidate.name === wantedName && typeof candidate.send === 'function' && candidate.threads
  );

  if (!channel) {
    const fetched = await guild.channels.fetch().catch(() => null);
    if (fetched) {
      channel = fetched.find((candidate) =>
        candidate && candidate.name === wantedName && typeof candidate.send === 'function' && candidate.threads
      );
    }
  }

  if (channel) return channel;

  channel = await guild.channels.create({
    name: wantedName,
    type: 0,
    reason: 'SeekDeep server archive channel',
  });

  await channel.send('SeekDeep archive channel initialized. User archive threads will be created here.').catch(() => null);
  return channel;
}"""

if "async function seekdeepGetOrCreateGuildArchiveChannel" not in text:
    text = replace_or_insert_function(text, "seekdeepArchiveChannelName", fallback_channel_helper, None)

migration_helpers = r"""function seekdeepCleanMessageCommandPrompt(value) {
  return String(value || '')
    .replace(/<@!?\d+>/g, ' ')
    .replace(/\bseekotics\b/gi, ' ')
    .replace(/\bseekdeep\b/gi, ' ')
    .replace(/^[@/\s]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function seekdeepIsArchiveMigrationPrompt(value) {
  const prompt = seekdeepCleanMessageCommandPrompt(value).toLowerCase();
  return /^(?:migrate\s+archive|migratearchive|archive\s+migrate|archive\s+migration|migrate\s+archives)$/i.test(prompt);
}

async function seekdeepGetOrCreateSharedArchiveThread(target) {
  const channel = await seekdeepGetOrCreateGuildArchiveChannel(target);
  const threadName = 'Shared';

  const active = await channel.threads.fetchActive().catch(() => null);
  let thread = active?.threads?.find((candidate) => candidate?.name === threadName);

  if (!thread) {
    const archivedPublic = await channel.threads.fetchArchived({ type: 'public' }).catch(() => null);
    thread = archivedPublic?.threads?.find((candidate) => candidate?.name === threadName);
    if (thread) {
      try {
        if (thread.archived) await thread.setArchived(false, 'SeekDeep shared archive migration');
      } catch {}
    }
  }

  if (!thread) {
    thread = await channel.threads.create({
      name: threadName,
      autoArchiveDuration: 10080,
      reason: 'SeekDeep shared archive migration thread',
    });

    await thread.send('Shared archive thread initialized. Legacy/local archive imports will be posted here.').catch(() => null);
  }

  return { channel, thread, threadName };
}

function seekdeepLocalArchiveFilesForMigration(target, options) {
  target = target || {};
  options = options || {};

  const guildId = target?.guild?.id || target?.guildId || target?.message?.guild?.id || target?.message?.guildId || '';
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

        const marker = `${fullPath}.discord-thread-migrated`;
        if (!options.includeMigrated && fs.existsSync(marker)) continue;

        files.push({ name, fullPath, marker, stat });
      }
    } catch (err) {
      console.warn('SeekDeep archive migration scan failed:', err?.message || err);
    }
  }

  return files.sort((a, b) => Number(a.stat?.mtimeMs || 0) - Number(b.stat?.mtimeMs || 0));
}

async function seekdeepMigrateLocalArchiveToSharedThread(target, options) {
  target = target || null;
  options = options || {};

  const { thread, threadName } = await seekdeepGetOrCreateSharedArchiveThread(target);
  const files = seekdeepLocalArchiveFilesForMigration(target, options);
  const limit = Math.max(1, Math.min(Number(options.limit || 25), 100));
  const selected = files.slice(0, limit);

  let migrated = 0;
  let failed = 0;

  for (const file of selected) {
    try {
      await thread.send({
        content: [
          '**SeekDeep Legacy Archive Import**',
          `File: ${file.name}`,
          `Imported: ${new Date().toISOString()}`,
        ].join('\n'),
        files: [file.fullPath],
      });

      try {
        fs.writeFileSync(file.marker, new Date().toISOString(), 'utf8');
      } catch {}

      migrated += 1;
    } catch (err) {
      failed += 1;
      console.warn('SeekDeep archive migration file failed:', file.fullPath, err?.message || err);
    }
  }

  return {
    backend: 'discord-thread',
    threadName,
    totalLocalFiles: files.length,
    attempted: selected.length,
    migrated,
    failed,
    remaining: Math.max(files.length - selected.length, 0),
  };
}

async function seekdeepHandleArchiveMigrationMessage(message, prompt) {
  if (!message || !seekdeepIsArchiveMigrationPrompt(prompt || message.content || '')) return false;

  if (!message.guild) {
    await message.reply({
      content: 'Archive migration only works inside a server.',
      allowedMentions: { repliedUser: false },
    });
    return true;
  }

  const memberPermissions = message.member?.permissions;
  const allowed =
    memberPermissions?.has?.('Administrator') ||
    memberPermissions?.has?.('ManageGuild') ||
    memberPermissions?.has?.('ManageChannels');

  if (!allowed) {
    await message.reply({
      content: 'Archive migration is restricted to server managers.',
      allowedMentions: { repliedUser: false },
    });
    return true;
  }

  if (typeof seekdeepLogRoute === 'function') {
    seekdeepLogRoute('archive-migrate-message', prompt || message.content || '');
  }

  const result = await seekdeepMigrateLocalArchiveToSharedThread(message, { limit: 25 });

  await message.reply({
    content: [
      'Archive migration pass complete.',
      `Target thread: ${result.threadName}`,
      `Attempted: ${result.attempted}`,
      `Migrated: ${result.migrated}`,
      `Failed: ${result.failed}`,
      `Remaining local files: ${result.remaining}`,
      '',
      result.remaining > 0 ? 'Run migrate archive again to continue the next batch.' : 'No remaining local images found for this pass.',
    ].join('\n'),
    allowedMentions: { repliedUser: false },
  });

  return true;
}"""

for name in [
    "seekdeepCleanMessageCommandPrompt",
    "seekdeepIsArchiveMigrationPrompt",
    "seekdeepGetOrCreateSharedArchiveThread",
    "seekdeepLocalArchiveFilesForMigration",
    "seekdeepMigrateLocalArchiveToSharedThread",
    "seekdeepHandleArchiveMigrationMessage",
]:
    # Replace stale versions if present to normalize behavior.
    if ("function " + name + "(" in text) or ("async function " + name + "(" in text):
        # individual replacement is not worth the risk here; whole block is only inserted if primary handler is missing
        pass

if "function seekdeepIsArchiveMigrationPrompt" not in text:
    insert_pos = -1
    for anchor in ("seekdeepHandleArchiveStatusMessage", "seekdeepHandleImageButton"):
        for prefix in ("async function ", "function "):
            insert_pos = text.find(prefix + anchor + "(")
            if insert_pos >= 0:
                break
        if insert_pos >= 0:
            break

    if insert_pos < 0:
        insert_pos = text.find("client.on('messageCreate'")
    if insert_pos < 0:
        insert_pos = text.find('client.on("messageCreate"')
    if insert_pos < 0:
        fail("Could not insert migration helpers")

    text = text[:insert_pos] + migration_helpers + "\n\n" + text[insert_pos:]


handler, hs, he = get_client_handler(text, "messageCreate")
if hs < 0:
    fail("Could not locate messageCreate handler")

if "seekdeepHandleArchiveMigrationMessage(message" not in handler:
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

    bot_guard = re.search(r"\n\s*if\s*\([^\n]*(?:message\.author\.bot|author\?\.bot)[^\n]*\)\s*return\s*;?", handler)
    if bot_guard:
        insert_at = bot_guard.end()
        handler = handler[:insert_at] + injection + handler[insert_at:]
    else:
        open_brace = handler.find("{")
        handler = handler[:open_brace + 1] + injection + handler[open_brace + 1:]

    text = text[:hs] + handler + text[he:]


for needle, label in [
    ("function seekdeepIsArchiveMigrationPrompt", "migration prompt detector"),
    ("async function seekdeepGetOrCreateSharedArchiveThread", "shared thread helper"),
    ("async function seekdeepHandleArchiveMigrationMessage", "migration message handler"),
    ("seekdeepHandleArchiveMigrationMessage(message", "messageCreate interception"),
    ("Shared", "shared thread name"),
]:
    if needle not in text:
        fail(f"Missing required patch element: {label}")

out = text if newline == "\n" else text.replace("\n", "\r\n")
path.write_bytes(out.encode("utf-8"))
print("Patched migrate archive message route.")