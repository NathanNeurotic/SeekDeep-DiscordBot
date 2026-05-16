from pathlib import Path
from datetime import datetime

path = Path("index.js")
text = path.read_text(encoding="utf-8")

stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
backup = Path(f"index.js.bak-archive-duplicate-fix-{stamp}")
backup.write_text(text, encoding="utf-8")
print(f"[SeekDeep] Backup written: {backup}")

def find_function_range(src: str, name: str):
    starts = []
    for prefix in [f"async function {name}", f"function {name}"]:
        pos = src.find(prefix)
        if pos != -1:
            starts.append(pos)

    if not starts:
        return None

    start = min(starts)
    brace = src.find("{", start)
    if brace == -1:
        raise SystemExit(f"Found {name}, but no opening brace.")

    depth = 0
    in_string = None
    escape = False
    line_comment = False
    block_comment = False

    i = brace
    while i < len(src):
        ch = src[i]
        nxt = src[i + 1] if i + 1 < len(src) else ""

        if line_comment:
            if ch == "\n":
                line_comment = False
            i += 1
            continue

        if block_comment:
            if ch == "*" and nxt == "/":
                block_comment = False
                i += 2
                continue
            i += 1
            continue

        if in_string:
            if escape:
                escape = False
            elif ch == "\\":
                escape = True
            elif ch == in_string:
                in_string = None
            i += 1
            continue

        if ch == "/" and nxt == "/":
            line_comment = True
            i += 2
            continue

        if ch == "/" and nxt == "*":
            block_comment = True
            i += 2
            continue

        if ch in ("'", '"', "`"):
            in_string = ch
            i += 1
            continue

        if ch == "{":
            depth += 1
        elif ch == "}":
            depth -= 1
            if depth == 0:
                return start, i + 1

        i += 1

    raise SystemExit(f"Could not find closing brace for {name}.")

def replace_function(src: str, name: str, replacement: str):
    rng = find_function_range(src, name)
    if rng is None:
        raise SystemExit(f"Could not find function: {name}")

    start, end = rng
    return src[:start] + replacement.strip() + "\n\n" + src[end:].lstrip()

post_archive_to_channel = r'''
async function seekdeepPostArchiveToChannel(channel) {
  const startedAt = seekdeepNowMs();
  const modelUsed = seekdeepNoModelLabel();

  globalThis.__seekdeepArchivePostLocks = globalThis.__seekdeepArchivePostLocks || new Set();

  const lockKey = String(channel?.id || 'global');

  if (globalThis.__seekdeepArchivePostLocks.has(lockKey)) {
    return {
      summary: 'Archive post is already running in this channel. Ignored duplicate request.',
      startedAt,
      modelUsed,
      posted: 0,
      failed: 0,
      duplicate: true,
    };
  }

  globalThis.__seekdeepArchivePostLocks.add(lockKey);

  try {
    const files = seekdeepListArchiveImageFiles();
    const dir = seekdeepArchiveDir();

    if (!files.length) {
      return {
        summary: `Archive is empty.\nPath checked:\n\`${dir}\``,
        startedAt,
        modelUsed,
        posted: 0,
        failed: 0,
      };
    }

    const batches = seekdeepArchiveBatches(files, 10);
    let posted = 0;
    let failed = 0;

    await channel.send(seekdeepAppendResponseFooter(`Posting archive: ${files.length} image(s) from \`${dir}\`.`, {
      startedAt,
      modelUsed,
    }));

    for (let i = 0; i < batches.length; i++) {
      const batchStartedAt = seekdeepNowMs();
      const batch = batches[i];

      try {
        await channel.send({
          content: seekdeepAppendResponseFooter(`Archive batch ${i + 1}/${batches.length}`, {
            startedAt: batchStartedAt,
            modelUsed,
          }),
          files: batch.map((entry) => new AttachmentBuilder(entry.fullPath, { name: entry.name })),
        });

        posted += batch.length;
      } catch (err) {
        console.error(`Archive batch ${i + 1} failed; trying individually:`, err?.message || err);

        for (const entry of batch) {
          const singleStartedAt = seekdeepNowMs();

          try {
            await channel.send({
              content: seekdeepAppendResponseFooter(`Archive image: ${entry.name}`, {
                startedAt: singleStartedAt,
                modelUsed,
              }),
              files: [new AttachmentBuilder(entry.fullPath, { name: entry.name })],
            });

            posted += 1;
          } catch (singleErr) {
            failed += 1;
            console.error(`Archive image failed: ${entry.fullPath}`, singleErr?.message || singleErr);
          }
        }
      }
    }

    return {
      summary: `Archive post complete.\nPosted: ${posted}\nFailed: ${failed}\nSource: \`${dir}\``,
      startedAt,
      modelUsed,
      posted,
      failed,
    };
  } finally {
    globalThis.__seekdeepArchivePostLocks.delete(lockKey);
  }
}
'''

post_archive_from_message = r'''
async function seekdeepPostArchiveFromMessage(message) {
  seekdeepMarkRequestStart(message);
  seekdeepSetResponseModel(message, seekdeepNoModelLabel());
  stopSeekDeepTypingLoopForMessage(message);

  const result = await seekdeepPostArchiveToChannel(message.channel);

  const finalContent = seekdeepAppendResponseFooter(result.summary, {
    startedAt: result.startedAt || message?.__seekdeepRequestStartedAt,
    modelUsed: result.modelUsed || seekdeepNoModelLabel(),
  });

  await message.reply({
    content: finalContent,
    allowedMentions: { repliedUser: false },
  });

  return finalContent;
}
'''

post_archive_from_interaction = r'''
async function seekdeepPostArchiveFromInteraction(interaction) {
  seekdeepMarkRequestStart(interaction);
  seekdeepSetResponseModel(interaction, seekdeepNoModelLabel());

  const result = await seekdeepPostArchiveToChannel(interaction.channel);

  const finalContent = seekdeepAppendResponseFooter(result.summary, {
    startedAt: result.startedAt || interaction?.__seekdeepRequestStartedAt,
    modelUsed: result.modelUsed || seekdeepNoModelLabel(),
  });

  await safeEditOrReply(interaction, {
    content: finalContent,
    allowedMentions: { repliedUser: false },
  });

  return finalContent;
}
'''

for name, replacement in [
    ("seekdeepPostArchiveToChannel", post_archive_to_channel),
    ("seekdeepPostArchiveFromMessage", post_archive_from_message),
    ("seekdeepPostArchiveFromInteraction", post_archive_from_interaction),
]:
    text = replace_function(text, name, replacement)
    print(f"[SeekDeep] Replaced {name}.")

required = [
    "globalThis.__seekdeepArchivePostLocks",
    "Archive post is already running in this channel",
    "async function seekdeepPostArchiveToChannel(",
    "async function seekdeepPostArchiveFromMessage(",
    "async function seekdeepPostArchiveFromInteraction(",
]

missing = [item for item in required if item not in text]
if missing:
    raise SystemExit("Patch failed. Missing: " + ", ".join(missing))

path.write_text(text, encoding="utf-8")
print("[SeekDeep] Archive duplicate fix written.")
