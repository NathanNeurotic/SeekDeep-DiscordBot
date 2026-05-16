from pathlib import Path
import re
from datetime import datetime

path = Path("index.js")
text = path.read_text(encoding="utf-8")

stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
backup = Path(f"index.js.bak.download-archive-buttons-{stamp}")
backup.write_text(text, encoding="utf-8")
print(f"[SeekDeep] Backup written: {backup}")

# ------------------------------------------------------------
# Ensure Discord button imports exist.
# ------------------------------------------------------------
import_match = re.search(r"import\s+\{([\s\S]*?)\}\s+from\s+'discord\.js';", text)
if not import_match:
    raise SystemExit("Could not find discord.js import block.")

imports = import_match.group(1)
needed = ["ActionRowBuilder", "ButtonBuilder", "ButtonStyle"]

for name in needed:
    if name not in imports:
        imports = "  " + name + ",\n" + imports.lstrip()

text = text[:import_match.start(1)] + imports + text[import_match.end(1):]

# ------------------------------------------------------------
# JS function replacement helper.
# ------------------------------------------------------------
def replace_js_function(src, name, replacement):
    markers = [f"async function {name}", f"function {name}"]
    start = -1

    for marker in markers:
        pos = src.find(marker)
        if pos != -1 and (start == -1 or pos < start):
            start = pos

    if start == -1:
        raise SystemExit(f"Could not find function {name}")

    brace = src.find("{", start)
    if brace == -1:
        raise SystemExit(f"Could not find opening brace for {name}")

    depth = 0
    end = None
    i = brace
    in_string = None
    escape = False
    in_line_comment = False
    in_block_comment = False

    while i < len(src):
        ch = src[i]
        nxt = src[i + 1] if i + 1 < len(src) else ""

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
            in_line_comment = True
            i += 2
            continue

        if ch == "/" and nxt == "*":
            in_block_comment = True
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
                end = i + 1
                break

        i += 1

    if end is None:
        raise SystemExit(f"Could not find end of function {name}")

    return src[:start].rstrip() + "\n\n" + replacement.rstrip() + "\n\n" + src[end:].lstrip()

# ------------------------------------------------------------
# Replace old image button block, or install it over makeImage().
# ------------------------------------------------------------
image_helpers = r'''
// SEEKDEEP_IMAGE_BUTTONS_START
const SEEKDEEP_IMAGE_ACTIONS = new Map();
const SEEKDEEP_IMAGE_ACTION_TTL_MS = Number(process.env.SEEKDEEP_IMAGE_ACTION_TTL_MS || 86400000);
const SEEKDEEP_SAVED_IMAGE_DIR = process.env.SEEKDEEP_SAVED_IMAGE_DIR || path.join(__dirname, 'saved_generations');

function seekdeepSweepImageActions() {
  const now = Date.now();

  for (const [id, state] of SEEKDEEP_IMAGE_ACTIONS.entries()) {
    if (!state || state.expiresAt <= now) {
      SEEKDEEP_IMAGE_ACTIONS.delete(id);
    }
  }
}

function seekdeepNewImageActionId() {
  seekdeepSweepImageActions();
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function seekdeepRememberImageAction(state) {
  const id = seekdeepNewImageActionId();

  SEEKDEEP_IMAGE_ACTIONS.set(id, {
    ...state,
    createdAt: Date.now(),
    expiresAt: Date.now() + SEEKDEEP_IMAGE_ACTION_TTL_MS,
  });

  return id;
}

function seekdeepImageActionRow(id, downloadUrl = null) {
  const buttons = [
    new ButtonBuilder()
      .setCustomId(`seekdeep:image:regen:${id}`)
      .setLabel('Regenerate')
      .setStyle(ButtonStyle.Secondary),
  ];

  if (downloadUrl) {
    buttons.push(
      new ButtonBuilder()
        .setLabel('Download')
        .setStyle(ButtonStyle.Link)
        .setURL(downloadUrl)
    );
  }

  buttons.push(
    new ButtonBuilder()
      .setCustomId(`seekdeep:image:archive:${id}`)
      .setLabel('Archive')
      .setStyle(ButtonStyle.Success)
  );

  return new ActionRowBuilder().addComponents(...buttons);
}

function seekdeepAttachmentDownloadUrl(sentMessage) {
  try {
    const first = sentMessage?.attachments?.first?.();
    return first?.url || first?.proxyURL || null;
  } catch {
    return null;
  }
}

async function seekdeepAttachDownloadButton(sentMessage, actionId) {
  const url = seekdeepAttachmentDownloadUrl(sentMessage);

  if (!url || !sentMessage || typeof sentMessage.edit !== 'function') {
    return sentMessage;
  }

  try {
    return await sentMessage.edit({
      components: [seekdeepImageActionRow(actionId, url)],
    });
  } catch (err) {
    console.warn('Could not attach Download button:', err?.message || err);
    return sentMessage;
  }
}

function seekdeepSafeFilenamePiece(value, fallback = 'seekdeep-image') {
  const clean = String(value || fallback)
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, ' ')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 80);

  return clean || fallback;
}

async function makeImageResult(prompt, width = 1024, height = 1024, seed = null) {
  const response = await postLocal('/image', {
    prompt,
    width,
    height,
    steps: 2,
    guidance_scale: Number(process.env.IMAGE_GUIDANCE_SCALE || 0.0),
    seed,
  });

  const buffer = Buffer.from(response.image_b64, 'base64');
  const filename = response.filename || 'seekdeep_image.png';

  return {
    file: new AttachmentBuilder(buffer, { name: filename }),
    buffer,
    filename,
    prompt,
    width,
    height,
    seed,
  };
}

async function makeImage(prompt, width = 1024, height = 1024, seed = null) {
  const result = await makeImageResult(prompt, width, height, seed);
  return result.file;
}

function seekdeepArchiveImageStateToDisk(state) {
  if (!state?.buffer) {
    throw new Error('No image buffer is available to archive. The image action may have expired.');
  }

  fs.mkdirSync(SEEKDEEP_SAVED_IMAGE_DIR, { recursive: true });

  const ext = path.extname(state.filename || '').replace('.', '') || 'png';
  const base = seekdeepSafeFilenamePiece(state.prompt || 'seekdeep-image');
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const filename = `${stamp}-${base}.${ext}`;
  const outPath = path.join(SEEKDEEP_SAVED_IMAGE_DIR, filename);

  fs.writeFileSync(outPath, state.buffer);

  return outPath;
}

async function seekdeepSendImageWithButtonsMessage(message, prompt, width = 1024, height = 1024, seed = null) {
  const result = await makeImageResult(prompt, width, height, seed);

  const actionId = seekdeepRememberImageAction({
    prompt,
    width,
    height,
    seed,
    buffer: result.buffer,
    filename: result.filename,
    userId: message.author?.id || null,
    channelId: message.channel?.id || null,
  });

  const payload = {
    content: `Generated locally: ${prompt}`,
    files: [result.file],
    components: [seekdeepImageActionRow(actionId)],
    allowedMentions: { repliedUser: false },
  };

  let sent;

  try {
    sent = await message.reply(payload);
  } catch (err) {
    if (message.channel && typeof message.channel.send === 'function') {
      sent = await message.channel.send(payload);
    } else {
      throw err;
    }
  }

  return await seekdeepAttachDownloadButton(sent, actionId);
}

async function seekdeepSendImageWithButtonsInteraction(interaction, prompt, width = 1024, height = 1024, seed = null) {
  const result = await makeImageResult(prompt, width, height, seed);

  const actionId = seekdeepRememberImageAction({
    prompt,
    width,
    height,
    seed,
    buffer: result.buffer,
    filename: result.filename,
    userId: interaction.user?.id || null,
    channelId: interaction.channelId || interaction.channel?.id || null,
  });

  let sent = await safeEditOrReply(interaction, {
    content: `Generated locally: ${prompt}`,
    files: [result.file],
    components: [seekdeepImageActionRow(actionId)],
    allowedMentions: { repliedUser: false },
  });

  if (!sent && typeof interaction.fetchReply === 'function') {
    sent = await interaction.fetchReply().catch(() => null);
  }

  return await seekdeepAttachDownloadButton(sent, actionId);
}

async function seekdeepHandleImageButton(interaction) {
  const customId = String(interaction.customId || '');
  const match = customId.match(/^seekdeep:image:(regen|archive|save):(.+)$/);

  if (!match) {
    return false;
  }

  const action = match[1] === 'save' ? 'archive' : match[1];
  const id = match[2];

  seekdeepSweepImageActions();

  const state = SEEKDEEP_IMAGE_ACTIONS.get(id);
  if (!state) {
    await interaction.reply({
      content: 'That image action expired. Generate it again and I’ll give you fresh buttons.',
      ephemeral: true,
    });
    return true;
  }

  if (action === 'archive') {
    const savedPath = seekdeepArchiveImageStateToDisk(state);

    await interaction.reply({
      content: `Archived on the bot host:\n\`${savedPath}\``,
      ephemeral: true,
    });

    return true;
  }

  if (action === 'regen') {
    await interaction.deferReply();

    const regenSeed =
      String(process.env.SEEKDEEP_REGEN_REUSE_SEED || 'false').toLowerCase() === 'true'
        ? state.seed
        : null;

    const result = await makeImageResult(state.prompt, state.width || 1024, state.height || 1024, regenSeed);

    const newActionId = seekdeepRememberImageAction({
      prompt: state.prompt,
      width: state.width || 1024,
      height: state.height || 1024,
      seed: regenSeed,
      buffer: result.buffer,
      filename: result.filename,
      userId: interaction.user?.id || null,
      channelId: interaction.channelId || interaction.channel?.id || null,
    });

    await interaction.editReply({
      content: `Regenerated locally: ${state.prompt}`,
      files: [result.file],
      components: [seekdeepImageActionRow(newActionId)],
      allowedMentions: { repliedUser: false },
    });

    let sent = null;
    if (typeof interaction.fetchReply === 'function') {
      sent = await interaction.fetchReply().catch(() => null);
    }

    await seekdeepAttachDownloadButton(sent, newActionId);

    return true;
  }

  return false;
}
// SEEKDEEP_IMAGE_BUTTONS_END
'''

if "SEEKDEEP_IMAGE_BUTTONS_START" in text:
    text = re.sub(
        r"(?s)// SEEKDEEP_IMAGE_BUTTONS_START.*?// SEEKDEEP_IMAGE_BUTTONS_END\s*",
        image_helpers + "\n\n",
        text,
    )
    print("[SeekDeep] Replaced existing image button block.")
else:
    text = replace_js_function(text, "makeImage", image_helpers)
    print("[SeekDeep] Installed image button block.")

# ------------------------------------------------------------
# Patch /image command to use button helper.
# ------------------------------------------------------------
slash_pattern = re.compile(
    r"""(?s)      const file = await makeImage\(prompt, width, height, seed \?\? null\);\s*
      remember\(key, 'user', `/image \$\{prompt\}`\);\s*
      remember\(key, 'assistant', `Generated image locally for: \$\{prompt\}`\);\s*
      await safeEditOrReply\(interaction, \{ content: `Generated locally: \$\{prompt\}`, files: \[file\] \}\);\s*
      return;"""
)

slash_replacement = """      remember(key, 'user', `/image ${prompt}`);
      remember(key, 'assistant', `Generated image locally for: ${prompt}`);
      await seekdeepSendImageWithButtonsInteraction(interaction, prompt, width, height, seed ?? null);
      return;"""

text, slash_count = slash_pattern.subn(slash_replacement, text, count=1)

if slash_count:
    print("[SeekDeep] Patched /image command.")
else:
    print("[SeekDeep] /image command already patched or not in old form.")

# ------------------------------------------------------------
# Add button interaction routing if missing.
# ------------------------------------------------------------
if "seekdeepHandleImageButton(interaction)" not in text:
    gate = "  if (!interaction.isChatInputCommand()) return;\n\n  try {"
    replacement = """  if (interaction.isButton && interaction.isButton()) {
    try {
      if (await seekdeepHandleImageButton(interaction)) return;
    } catch (err) {
      console.error(err);

      try {
        if (interaction.deferred || interaction.replied) {
          await interaction.editReply(`Image button failed.\\n\\nError:\\n${err.message}`);
        } else {
          await interaction.reply({
            content: `Image button failed.\\n\\nError:\\n${err.message}`,
            ephemeral: true,
          });
        }
      } catch {}
    }

    return;
  }

  if (!interaction.isChatInputCommand()) return;

  try {"""

    if gate not in text:
      raise SystemExit("Could not find interaction gate to patch.")

    text = text.replace(gate, replacement, 1)
    print("[SeekDeep] Added button interaction route.")
else:
    print("[SeekDeep] Button interaction route already present.")

# ------------------------------------------------------------
# Patch natural image route if it still uses raw makeImage().
# ------------------------------------------------------------
raw_message_image_pattern = re.compile(
    r"""(?s)      const imagePrompt = naturalRoute\.prompt \|\| prompt;\s*
      const file = await makeImage\(imagePrompt, 1024, 1024, null\);\s*
      remember\(key, 'user', `/image \$\{imagePrompt\}`\);\s*
      remember\(key, 'assistant', `Generated image locally for: \$\{imagePrompt\}`\);\s*
      stopSeekDeepTypingLoopForMessage\(message\);\s*
\s*      if \(!seekdeepClaimFinalReply\('message', message\?\.id\)\) \{\s*
        return;\s*
      \}\s*
\s*      try \{\s*
        await message\.reply\(\{\s*
          content: `Generated locally: \$\{imagePrompt\}`,\s*
          files: \[file\],\s*
          allowedMentions: \{ repliedUser: false \},\s*
        \}\);\s*
      \} catch \(err\) \{\s*
        if \(message\.channel && typeof message\.channel\.send === 'function'\) \{\s*
          await message\.channel\.send\(\{\s*
            content: `Generated locally: \$\{imagePrompt\}`,\s*
            files: \[file\],\s*
            allowedMentions: \{ repliedUser: false \},\s*
          \}\);\s*
        \} else \{\s*
          throw err;\s*
        \}\s*
      \}\s*
\s*      return;"""
)

raw_message_image_replacement = """      const imagePrompt = naturalRoute.prompt || prompt;
      remember(key, 'user', `/image ${imagePrompt}`);
      remember(key, 'assistant', `Generated image locally for: ${imagePrompt}`);
      stopSeekDeepTypingLoopForMessage(message);
      await seekdeepSendImageWithButtonsMessage(message, imagePrompt, 1024, 1024, null);
      return;"""

text, msg_count = raw_message_image_pattern.subn(raw_message_image_replacement, text, count=1)

if msg_count:
    print("[SeekDeep] Patched natural image message route.")
elif "seekdeepSendImageWithButtonsMessage(message, imagePrompt" in text:
    print("[SeekDeep] Natural image message route already uses buttons.")
else:
    print("[SeekDeep] Natural image message route not found in expected form. Leaving unchanged.")

# ------------------------------------------------------------
# Validate.
# ------------------------------------------------------------
required = [
    "ActionRowBuilder",
    "ButtonBuilder",
    "ButtonStyle",
    "Download",
    "Archive",
    "seekdeepAttachDownloadButton",
    "seekdeepHandleImageButton",
    "seekdeepSendImageWithButtonsMessage",
    "seekdeepSendImageWithButtonsInteraction",
]

missing = [item for item in required if item not in text]
if missing:
    raise SystemExit("Patch failed. Missing: " + ", ".join(missing))

if "setLabel('Save as')" in text or '.setLabel("Save as")' in text:
    raise SystemExit("Old Save as label still exists.")

path.write_text(text, encoding="utf-8")
print("[SeekDeep] Wrote patched index.js.")
