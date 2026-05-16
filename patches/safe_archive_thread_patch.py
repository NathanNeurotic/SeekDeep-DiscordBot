from pathlib import Path
import re
import sys

if len(sys.argv) != 2:
    raise SystemExit("Usage: safe_archive_thread_patch.py <index.js>")

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
            if ch == "\n": in_line_comment = False
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
            if not escaped and ch == "\\": escaped = True
            elif not escaped and ch == "'": in_single = False
            else: escaped = False
            i += 1
            continue
        if in_double:
            if not escaped and ch == "\\": escaped = True
            elif not escaped and ch == '"': in_double = False
            else: escaped = False
            i += 1
            continue
        if in_template:
            if not escaped and ch == "\\": escaped = True
            elif not escaped and ch == "`": in_template = False
            else: escaped = False
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


def find_function_start(source, name):
    for prefix in ("async function ", "function "):
        idx = source.find(prefix + name + "(")
        if idx >= 0:
            return idx
    return -1


def get_function(source, name):
    start = find_function_start(source, name)
    if start < 0:
        return None, -1, -1
    sig = source[start:start + 1000]
    m = re.search(r"\)\s*\{", sig)
    if not m:
        fail(f"Could not find signature opening for {name}")
    open_brace = start + m.end() - 1
    close_brace = find_matching_brace(source, open_brace)
    return source[start:close_brace + 1], start, close_brace + 1


def replace_or_insert_function(source, name, new_fn, before_name=None):
    fn, start, end = get_function(source, name)
    if start >= 0:
        return source[:start] + new_fn.rstrip() + source[end:]

    if before_name:
        before = find_function_start(source, before_name)
        if before >= 0:
            return source[:before] + new_fn.rstrip() + "\n\n" + source[before:]

    pos = source.find("client.on('interactionCreate'")
    if pos < 0:
        pos = source.find('client.on("interactionCreate"')
    if pos < 0:
        fail(f"Could not insert missing function {name}")
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


if "seekdeepEnqueueImageJob(job, runner)" not in text:
    fail("queue contract anchor missing; refusing to patch wrong file")

# Do not continue if restored file is already malformed.
bad_needles = [
    "}, target = null) {",
    "state = {) {",
    "state = {,",
]
for bad in bad_needles:
    if bad in text:
        fail(f"Restored backup is still malformed: {bad}")

helpers = r"""function seekdeepArchiveChannelName() {
  return String(process.env.SEEKDEEP_ARCHIVE_CHANNEL_NAME || 'seekdeep-archive')
    .trim()
    .replace(/^#+/, '')
    .replace(/\s+/g, '-')
    .toLowerCase() || 'seekdeep-archive';
}

function seekdeepArchiveUserThreadName(user) {
  user = user || {};
  const username = String(user.username || user.globalName || user.displayName || user.id || 'unknown-user')
    .replace(/[^a-zA-Z0-9_. -]+/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .slice(0, 48) || 'unknown-user';
  const idSuffix = user.id ? `-${String(user.id).slice(-6)}` : '';
  return `archive-${username}${idSuffix}`.slice(0, 90);
}

function seekdeepArchiveMetadataLines(state, target) {
  state = state || {};
  target = target || null;

  const prompt = state.originalPrompt || state.rawPrompt || state.prompt || 'unknown prompt';
  const refinedPrompt = state.refinedPrompt || state.finalPrompt || '';
  const requester = target?.user || target?.author || target?.member?.user || target?.message?.author || null;

  const lines = [
    '**SeekDeep Image Archive Entry**',
    requester?.id ? `Requester: <@${requester.id}>` : '',
    `Prompt: ${String(prompt).slice(0, 1500)}`,
  ];

  if (refinedPrompt && refinedPrompt !== prompt) {
    lines.push(`Refined: ${String(refinedPrompt).slice(0, 1500)}`);
  }

  if (state.jobId) lines.push(`Job ID: ${state.jobId}`);
  if (state.modelUsed || state.model) lines.push(`Model: ${state.modelUsed || state.model}`);
  if (state.seed !== undefined && state.seed !== null) lines.push(`Seed: ${state.seed}`);
  if (state.width && state.height) lines.push(`Size: ${state.width}x${state.height}`);
  lines.push(`Archived: ${new Date().toISOString()}`);

  return lines.filter(Boolean);
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

  return null;
}

async function seekdeepGetOrCreateUserArchiveThread(target, userOverride) {
  target = target || null;
  const channel = await seekdeepGetOrCreateGuildArchiveChannel(target);
  const user = userOverride || target?.user || target?.author || target?.member?.user || target?.message?.author || null;
  const threadName = seekdeepArchiveUserThreadName(user);
  let thread = await seekdeepFindArchiveThread(channel, threadName);

  if (!thread) {
    thread = await channel.threads.create({
      name: threadName,
      autoArchiveDuration: 10080,
      reason: `SeekDeep archive thread for ${user?.id || 'unknown user'}`,
    });
    await thread.send([
      `Archive thread for ${user?.id ? `<@${user.id}>` : 'unknown user'}.`,
      'New archived generations for this user will be posted here.',
    ].join('\n')).catch(() => null);
  }

  return { channel, thread, threadName };
}"""

if "function seekdeepGetOrCreateUserArchiveThread" not in text:
    pos = find_function_start(text, "seekdeepHandleImageButton")
    if pos < 0:
        pos = text.find("client.on('interactionCreate'")
    if pos < 0:
        pos = text.find('client.on("interactionCreate"')
    if pos < 0:
        fail("Could not insert archive thread helpers")
    text = text[:pos] + helpers + "\n\n" + text[pos:]


materialize_fn = r"""async function seekdeepMaterializeArchiveFileFromState(state, target) {
  state = state || {};
  target = target || null;

  const directPathCandidates = [
    state.filePath,
    state.path,
    state.fullPath,
    state.savedPath,
    state.imagePath,
    state.outputPath,
    state.localPath,
    state.attachmentPath,
  ].map((value) => String(value || '').trim()).filter(Boolean);

  for (const candidate of directPathCandidates) {
    try {
      if (fs.existsSync(candidate)) return candidate;
    } catch {}
  }

  const sourceAttachment =
    target?.message?.attachments?.first?.() ||
    target?.attachments?.first?.() ||
    null;

  const sourceUrl = String(
    state.attachmentUrl ||
    state.url ||
    state.downloadUrl ||
    state.proxyURL ||
    sourceAttachment?.url ||
    sourceAttachment?.proxyURL ||
    ''
  ).trim();

  if (!sourceUrl) return '';

  const baseDir = typeof __dirname !== 'undefined' ? __dirname : process.cwd();
  const tempDir = path.join(baseDir, 'saved_generations', 'temp_archive_uploads');
  try { fs.mkdirSync(tempDir, { recursive: true }); } catch {}

  const safeExtMatch = sourceUrl.match(/\.(png|jpe?g|webp|gif)(?:\?|$)/i);
  const ext = safeExtMatch ? safeExtMatch[1].toLowerCase() : 'png';
  const tempPath = path.join(tempDir, `archive-upload-${Date.now()}-${Math.random().toString(36).slice(2, 10)}.${ext}`);

  const response = await fetch(sourceUrl);
  if (!response.ok) throw new Error(`Failed to fetch source attachment: ${response.status} ${response.statusText}`);

  fs.writeFileSync(tempPath, Buffer.from(await response.arrayBuffer()));
  return tempPath;
}"""

archive_writer_fn = r"""async function seekdeepArchiveImageStateToDiscordThread(state, target) {
  state = state || {};
  target = target || null;

  const archiveInfo = await seekdeepGetOrCreateUserArchiveThread(target);
  const thread = archiveInfo.thread;
  const threadName = archiveInfo.threadName;

  const payload = {
    content: seekdeepArchiveMetadataLines(state, target).join('\n'),
  };

  let filePath = '';

  try {
    filePath = await seekdeepMaterializeArchiveFileFromState(state, target);
    if (filePath) payload.files = [filePath];
  } catch (err) {
    console.warn('SeekDeep archive attachment materialization failed:', err?.message || err);
  }

  if (!payload.files || !payload.files.length) {
    const fallbackAttachment =
      target?.message?.attachments?.first?.() ||
      target?.attachments?.first?.() ||
      null;

    const fallbackUrl = String(
      state.attachmentUrl ||
      state.url ||
      state.downloadUrl ||
      state.proxyURL ||
      fallbackAttachment?.url ||
      fallbackAttachment?.proxyURL ||
      ''
    ).trim();

    payload.content += fallbackUrl ? `\nImage URL: ${fallbackUrl}` : '\nImage attachment unavailable.';
  }

  await thread.send(payload);

  if (filePath && /[\\/]saved_generations[\\/]temp_archive_uploads[\\/]/i.test(filePath)) {
    try { fs.unlinkSync(filePath); } catch {}
  }

  return {
    ok: true,
    backend: 'discord-thread',
    threadId: thread.id,
    threadName,
    channelId: thread.parentId || thread.parent?.id || '',
    postedImage: Boolean(payload.files && payload.files.length),
  };
}"""

text = replace_or_insert_function(text, "seekdeepMaterializeArchiveFileFromState", materialize_fn, "seekdeepArchiveImageStateToDiscordThread")
text = replace_or_insert_function(text, "seekdeepArchiveImageStateToDiscordThread", archive_writer_fn, "seekdeepHandleImageButton")


handler, hs, he = get_function(text, "seekdeepHandleImageButton")
if hs >= 0 and "seekdeepArchiveImageStateToDiscordThread(state, interaction)" not in handler:
    idx = handler.find("if (action === 'archive')")
    if idx >= 0:
        open_brace = handler.find("{", idx)
        close_brace = find_matching_brace(handler, open_brace)
        archive_block = r"""if (action === 'archive') {
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
        handler = handler[:idx] + archive_block + handler[close_brace + 1:]
        text = text[:hs] + handler + text[he:]


text = text.replace("Generated locally:", "Generated:")
text = text.replace("Archived on the bot host:", "Archived to this server.")

for needle, label in [
    ("async function seekdeepMaterializeArchiveFileFromState(state, target)", "materialize helper"),
    ("async function seekdeepArchiveImageStateToDiscordThread(state, target)", "thread writer"),
    ("function seekdeepGetOrCreateUserArchiveThread", "thread helper"),
    ("payload.files = [filePath];", "file attachment"),
]:
    if needle not in text:
        fail(f"Missing required patch element: {label}")

for bad in ["}, target = null) {", "state = {) {", "state = {,"]:
    if bad in text:
        fail(f"Malformed code remains: {bad}")

out = text if newline == "\n" else text.replace("\n", "\r\n")
path.write_bytes(out.encode("utf-8"))
print("Safe archive thread patch applied.")