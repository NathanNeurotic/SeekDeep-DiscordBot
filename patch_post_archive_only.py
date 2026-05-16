from pathlib import Path
import re
from datetime import datetime

path = Path("index.js")
text = path.read_text(encoding="utf-8")

stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
backup = Path(f"index.js.bak-postarchive-only-{stamp}")
backup.write_text(text, encoding="utf-8")
print(f"[SeekDeep] Backup written: {backup}")

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

  if (!fs.existsSync(dir)) return [];

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

async function seekdeepPostArchiveToChannel(channel) {
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

    try {
      await channel.send({
        content: `Archive batch ${i + 1}/${batches.length}`,
        files: batch.map((entry) => new AttachmentBuilder(entry.fullPath, { name: entry.name })),
      });

      posted += batch.length;
    } catch (err) {
      console.error(`Archive batch ${i + 1} failed; trying individually:`, err?.message || err);

      for (const entry of batch) {
        try {
          await channel.send({
            content: `Archive image: ${entry.name}`,
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

  return `Archive post complete.\nPosted: ${posted}\nFailed: ${failed}\nSource: \`${dir}\``;
}

async function seekdeepPostArchiveFromMessage(message) {
  stopSeekDeepTypingLoopForMessage(message);

  const summary = await seekdeepPostArchiveToChannel(message.channel);

  await message.reply({
    content: summary,
    allowedMentions: { repliedUser: false },
  });

  return summary;
}

async function seekdeepPostArchiveFromInteraction(interaction) {
  const summary = await seekdeepPostArchiveToChannel(interaction.channel);

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
    print("[SeekDeep] Replaced existing archive helper block.")
else:
    marker = "client.on('interactionCreate', async (interaction) => {"
    if marker not in text:
        raise SystemExit("Could not find interactionCreate marker.")
    text = text.replace(marker, archive_helpers + "\n\n" + marker, 1)
    print("[SeekDeep] Inserted archive helper block.")

# Add slash command.
if ".setName('postarchive')" not in text:
    marker = "  new SlashCommandBuilder()\n    .setName('status')"
    if marker not in text:
        raise SystemExit("Could not find status command marker.")
    text = text.replace(
        marker,
        "  new SlashCommandBuilder()\n    .setName('postarchive')\n    .setDescription('Post all archived SeekDeep images from saved_generations.'),\n" + marker,
        1,
    )
    print("[SeekDeep] Added /postarchive command.")
else:
    print("[SeekDeep] /postarchive command already exists.")

# Add interaction handler.
if "interaction.commandName === 'postarchive'" not in text:
    marker = "    if (interaction.commandName === 'status') {"
    if marker not in text:
        raise SystemExit("Could not find status handler marker.")
    text = text.replace(
        marker,
        "    if (interaction.commandName === 'postarchive') {\n      if (!(await safeDefer(interaction))) return;\n      await seekdeepPostArchiveFromInteraction(interaction);\n      return;\n    }\n\n" + marker,
        1,
    )
    print("[SeekDeep] Added /postarchive handler.")
else:
    print("[SeekDeep] /postarchive handler already exists.")

# Add mention route immediately after message key creation.
if "SEEKDEEP_POST_ARCHIVE_MESSAGE_ROUTE" not in text:
    marker = "    const key = memoryKeyFrom(message);\n"
    if marker not in text:
        raise SystemExit("Could not find messageCreate key marker.")

    route = """    // SEEKDEEP_POST_ARCHIVE_MESSAGE_ROUTE
    if (isPostArchivePrompt(prompt)) {
      const summary = await seekdeepPostArchiveFromMessage(message);
      remember(key, 'user', prompt);
      remember(key, 'assistant', summary);
      return;
    }

"""

    text = text.replace(marker, marker + route, 1)
    print("[SeekDeep] Added @mention post archive route.")
else:
    print("[SeekDeep] @mention post archive route already exists.")

required = [
    "seekdeepPostArchiveToChannel",
    "isPostArchivePrompt",
    ".setName('postarchive')",
    "interaction.commandName === 'postarchive'",
    "SEEKDEEP_POST_ARCHIVE_MESSAGE_ROUTE",
]

missing = [x for x in required if x not in text]
if missing:
    raise SystemExit("Patch failed. Missing: " + ", ".join(missing))

path.write_text(text, encoding="utf-8")
print("[SeekDeep] Archive-only patch written.")
