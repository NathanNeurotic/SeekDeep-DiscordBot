from pathlib import Path
import re
from datetime import datetime

path = Path("index.js")
text = path.read_text(encoding="utf-8")

stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
backup = Path(f"index.js.bak-loop-archive-{stamp}")
backup.write_text(text, encoding="utf-8")
print(f"[SeekDeep] Backup written: {backup}")

# ------------------------------------------------------------
# 1. Add anti-loop cleanup helpers.
# ------------------------------------------------------------
anti_loop = r'''
// SEEKDEEP_ANTI_LOOP_CLEANUP_START
function seekdeepLoopKey(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/https?:\/\/\S+/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function seekdeepSplitTextUnits(text) {
  return String(text || '')
    .replace(/\r\n/g, '\n')
    .split(/(?<=[.!?])\s+|\n+/)
    .map((part) => part.trim())
    .filter(Boolean);
}

function seekdeepRemoveRepeatedUnits(text) {
  const raw = String(text || '').trim();
  if (!raw) return '';

  const units = seekdeepSplitTextUnits(raw);
  if (units.length <= 1) return raw;

  const seen = new Map();
  const kept = [];

  let previousKey = '';
  let previousRun = 0;

  for (const unit of units) {
    const key = seekdeepLoopKey(unit);

    if (!key) continue;

    if (key === previousKey) {
      previousRun += 1;
    } else {
      previousKey = key;
      previousRun = 1;
    }

    const seenCount = seen.get(key) || 0;
    seen.set(key, seenCount + 1);

    // Drop immediate repeated sentences after the first.
    if (previousRun > 1 && key.length > 20) {
      continue;
    }

    // Drop globally repeated substantial sentences after two appearances.
    if (seenCount >= 2 && key.length > 24) {
      continue;
    }

    kept.push(unit);
  }

  return kept.join('\n').trim();
}

function seekdeepTrimContiguousWordLoops(text) {
  const raw = String(text || '').trim();
  if (!raw) return '';

  const words = raw.split(/\s+/);
  if (words.length < 60) return raw;

  // Detect contiguous repeated word sequences in the tail and cut before the loop expands.
  for (let size = 4; size <= 24; size++) {
    for (let i = 0; i <= words.length - size * 3; i++) {
      const a = words.slice(i, i + size).join(' ').toLowerCase();
      const b = words.slice(i + size, i + size * 2).join(' ').toLowerCase();
      const c = words.slice(i + size * 2, i + size * 3).join(' ').toLowerCase();

      if (a === b && b === c) {
        return words.slice(0, i + size).join(' ').trim() + '\n\n[loop trimmed]';
      }
    }
  }

  return raw;
}

function seekdeepCleanModelOutput(value) {
  let text = stripQwenThinkingBlocks(value);
  text = seekdeepTrimContiguousWordLoops(text);
  text = seekdeepRemoveRepeatedUnits(text);

  // Collapse extreme repeated short phrases like "Hive, Maw, Hive, Maw..."
  text = text.replace(/\b(\w{3,})\b(?:[\s,;:.-]+\1\b){3,}/gi, '$1 [repetition trimmed]');

  return text.trim();
}
// SEEKDEEP_ANTI_LOOP_CLEANUP_END
'''

if "SEEKDEEP_ANTI_LOOP_CLEANUP_START" in text:
    text = re.sub(
        r"(?s)// SEEKDEEP_ANTI_LOOP_CLEANUP_START.*?// SEEKDEEP_ANTI_LOOP_CLEANUP_END\s*",
        anti_loop + "\n\n",
        text,
    )
    print("[SeekDeep] Replaced anti-loop helper block.")
else:
    marker = "// SEEKDEEP_TYPING_DEDUPE_START"
    if marker not in text:
        raise SystemExit("Could not find typing dedupe marker for anti-loop insertion.")
    text = text.replace(marker, anti_loop + "\n\n" + marker, 1)
    print("[SeekDeep] Inserted anti-loop helper block.")

# Use anti-loop cleanup wherever reply stripping happens.
text = text.replace(
    "content = stripQwenThinkingBlocks(content);",
    "content = seekdeepCleanModelOutput(content);"
)

# Clean askChat output before sources are appended.
old_return = "  return `${response.text || ''}${formatSources(sources)}`.trim();"
new_return = """  const cleanedText = seekdeepCleanModelOutput(response.text || '');
  return `${cleanedText}${formatSources(sources)}`.trim();"""

if old_return in text:
    text = text.replace(old_return, new_return, 1)
    print("[SeekDeep] Patched askChat cleanup.")
elif "const cleanedText = seekdeepCleanModelOutput(response.text || '');" in text:
    print("[SeekDeep] askChat cleanup already present.")
else:
    print("[SeekDeep] Could not patch askChat cleanup automatically; continuing.")

# ------------------------------------------------------------
# 2. Add archive posting helpers.
# ------------------------------------------------------------
archive_helpers = r'''
// SEEKDEEP_POST_ARCHIVE_START
const SEEKDEEP_ARCHIVE_IMAGE_EXTENSIONS = new Set([
  '.png',
  '.jpg',
  '.jpeg',
  '.webp',
  '.gif',
  '.bmp',
  '.avif',
]);

function seekdeepArchiveDir() {
  if (typeof SEEKDEEP_SAVED_IMAGE_DIR !== 'undefined' && SEEKDEEP_SAVED_IMAGE_DIR) {
    return SEEKDEEP_SAVED_IMAGE_DIR;
  }

  return path.join(__dirname, 'saved_generations');
}

function isPostArchivePrompt(prompt = '') {
  const p = normalizeUserText(prompt).toLowerCase().trim();

  return (
    /^post\s+(the\s+)?archive\b/.test(p) ||
    /^show\s+(the\s+)?archive\b/.test(p) ||
    /^dump\s+(the\s+)?archive\b/.test(p) ||
    /^upload\s+(the\s+)?archive\b/.test(p) ||
    /^send\s+(the\s+)?archive\b/.test(p) ||
    /^post\s+saved\s+images\b/.test(p) ||
    /^show\s+saved\s+images\b/.test(p) ||
    /^post\s+saved_generations\b/.test(p)
  );
}

function seekdeepListArchiveImageFiles() {
  const dir = seekdeepArchiveDir();

  if (!fs.existsSync(dir)) {
    return [];
  }

  return fs.readdirSync(dir)
    .map((name) => {
      const fullPath = path.join(dir, name);
      const stat = fs.statSync(fullPath);
      return { name, fullPath, stat };
    })
    .filter((entry) => entry.stat.isFile())
    .filter((entry) => SEEKDEEP_ARCHIVE_IMAGE_EXTENSIONS.has(path.extname(entry.name).toLowerCase()))
    .sort((a, b) => a.name.localeCompare(b.name));
}

function seekdeepArchiveBatches(files, size = 10) {
  const batches = [];

  for (let i = 0; i < files.length; i += size) {
    batches.push(files.slice(i, i + size));
  }

  return batches;
}

async function seekdeepPostArchiveToChannel(channel, requesterLabel = 'archive') {
  const files = seekdeepListArchiveImageFiles();
  const dir = seekdeepArchiveDir();

  if (!files.length) {
    return `Archive is empty.\nPath checked:\n\`${dir}\``;
  }

  const batches = seekdeepArchiveBatches(files, 10);
  let posted = 0;
  let failed = 0;

  await channel.send(`Posting archive: ${files.length} image(s) from \`${dir}\`.`);

  for (let i = 0; i < batches.length; i++) {
    const batch = batches[i];

    const attachments = batch.map((entry) =>
      new AttachmentBuilder(entry.fullPath, { name: entry.name })
    );

    try {
      await channel.send({
        content: `Archive batch ${i + 1}/${batches.length}`,
        files: attachments,
      });

      posted += batch.length;
    } catch (err) {
      console.error(`Archive batch ${i + 1} failed:`, err);

      // Fallback: try one file at a time so one oversized/bad file does not kill the entire archive post.
      for (const entry of batch) {
        try {
          await channel.send({
            content: `Archive image: ${entry.name}`,
            files: [new AttachmentBuilder(entry.fullPath, { name: entry.name })],
          });

          posted += 1;
        } catch (singleErr) {
          failed += 1;
          console.error(`Archive image failed: ${entry.fullPath}`, singleErr);
        }
      }
    }
  }

  return `Archive post complete.\nPosted: ${posted}\nFailed: ${failed}\nSource: \`${dir}\``;
}

async function seekdeepPostArchiveFromMessage(message) {
  stopSeekDeepTypingLoopForMessage(message);

  const summary = await seekdeepPostArchiveToChannel(message.channel, message.author?.tag || 'message');
  await message.reply({
    content: summary,
    allowedMentions: { repliedUser: false },
  });

  return summary;
}

async function seekdeepPostArchiveFromInteraction(interaction) {
  const summary = await seekdeepPostArchiveToChannel(interaction.channel, interaction.user?.tag || 'interaction');
  await safeEditOrReply(interaction, {
    content: summary,
    allowedMentions: { repliedUser: false },
  });

  return summary;
}
// SEEKDEEP_POST_ARCHIVE_END
'''

if "SEEKDEEP_POST_ARCHIVE_START" in text:
    text = re.sub(
        r"(?s)// SEEKDEEP_POST_ARCHIVE_START.*?// SEEKDEEP_POST_ARCHIVE_END\s*",
        archive_helpers + "\n\n",
        text,
    )
    print("[SeekDeep] Replaced archive posting helper block.")
else:
    marker = "client.on('interactionCreate', async (interaction) => {"
    if marker not in text:
        raise SystemExit("Could not find interactionCreate marker for archive helper insertion.")
    text = text.replace(marker, archive_helpers + "\n\n" + marker, 1)
    print("[SeekDeep] Inserted archive posting helpers.")

# ------------------------------------------------------------
# 3. Add /postarchive slash command.
# ------------------------------------------------------------
if ".setName('postarchive')" not in text:
    status_cmd_marker = "  new SlashCommandBuilder()\n    .setName('status')"
    if status_cmd_marker not in text:
        raise SystemExit("Could not find status command marker.")

    postarchive_cmd = """  new SlashCommandBuilder()
    .setName('postarchive')
    .setDescription('Post all archived SeekDeep images from saved_generations.'),\n"""

    text = text.replace(status_cmd_marker, postarchive_cmd + status_cmd_marker, 1)
    print("[SeekDeep] Added /postarchive command.")
else:
    print("[SeekDeep] /postarchive command already present.")

# ------------------------------------------------------------
# 4. Add interaction route for /postarchive.
# ------------------------------------------------------------
if "interaction.commandName === 'postarchive'" not in text:
    status_handler_marker = "    if (interaction.commandName === 'status') {"
    if status_handler_marker not in text:
        raise SystemExit("Could not find status handler marker.")

    postarchive_handler = """    if (interaction.commandName === 'postarchive') {
      if (!(await safeDefer(interaction))) return;
      await seekdeepPostArchiveFromInteraction(interaction);
      return;
    }

"""

    text = text.replace(status_handler_marker, postarchive_handler + status_handler_marker, 1)
    print("[SeekDeep] Added /postarchive handler.")
else:
    print("[SeekDeep] /postarchive handler already present.")

# ------------------------------------------------------------
# 5. Add mention route: @Seekotics post archive.
# ------------------------------------------------------------
if "isPostArchivePrompt(prompt)" not in text:
    raise SystemExit("Archive prompt helper missing unexpectedly.")

if "SEEKDEEP_POST_ARCHIVE_MESSAGE_ROUTE" not in text:
    identity_marker = "    if (isBotIdentityQuestion(prompt)) {"
    if identity_marker not in text:
        raise SystemExit("Could not find identity route marker in messageCreate handler.")

    postarchive_message_route = """    // SEEKDEEP_POST_ARCHIVE_MESSAGE_ROUTE
    if (isPostArchivePrompt(prompt)) {
      const summary = await seekdeepPostArchiveFromMessage(message);
      remember(key, 'user', prompt);
      remember(key, 'assistant', summary);
      return;
    }

"""

    text = text.replace(identity_marker, postarchive_message_route + identity_marker, 1)
    print("[SeekDeep] Added post archive mention route.")
else:
    print("[SeekDeep] Post archive mention route already present.")

# ------------------------------------------------------------
# Validate.
# ------------------------------------------------------------
required = [
    "seekdeepCleanModelOutput",
    "seekdeepTrimContiguousWordLoops",
    "seekdeepRemoveRepeatedUnits",
    "seekdeepPostArchiveToChannel",
    "isPostArchivePrompt",
    ".setName('postarchive')",
    "interaction.commandName === 'postarchive'",
    "SEEKDEEP_POST_ARCHIVE_MESSAGE_ROUTE",
]

missing = [item for item in required if item not in text]
if missing:
    raise SystemExit("Patch failed. Missing: " + ", ".join(missing))

path.write_text(text, encoding="utf-8")
print("[SeekDeep] Wrote patched index.js.")
