from pathlib import Path
import re
from datetime import datetime

p = Path("index.js")
text = p.read_text(encoding="utf-8")

stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
backup = Path(f"index.js.bak.force-download-archive-{stamp}")
backup.write_text(text, encoding="utf-8")
print(f"[SeekDeep] Backup written: {backup}")

# Hard remove misleading Save as label anywhere.
text = text.replace(".setLabel('Save as')", ".setLabel('Archive')")
text = text.replace('.setLabel("Save as")', '.setLabel("Archive")')
text = text.replace("seekdeep:image:save:", "seekdeep:image:archive:")

# Ensure the image action row has Regenerate + optional Download + Archive.
row_pattern = re.compile(
    r"(?s)function seekdeepImageActionRow\(.*?\)\s*\{.*?\n\}"
)

new_row = r'''function seekdeepImageActionRow(id, downloadUrl = null) {
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
}'''

if row_pattern.search(text):
    text = row_pattern.sub(new_row, text, count=1)
    print("[SeekDeep] Replaced seekdeepImageActionRow.")
else:
    raise SystemExit("Could not find seekdeepImageActionRow. The image button block may not be installed.")

# Ensure Download button gets attached after Discord gives us the attachment URL.
if "function seekdeepAttachmentDownloadUrl" not in text:
    insert_after = "function seekdeepImageActionRow"
    pos = text.find(insert_after)
    if pos == -1:
        raise SystemExit("Could not find image action row insertion point.")

    end = text.find("\n}\n", pos)
    if end == -1:
        raise SystemExit("Could not find end of image action row.")

    end += 3

    download_helpers = r'''

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
'''
    text = text[:end] + download_helpers + text[end:]
    print("[SeekDeep] Added download helper functions.")

# Rename save function if present.
text = text.replace("seekdeepSaveImageStateToDisk", "seekdeepArchiveImageStateToDisk")
text = text.replace("Saved as:", "Archived on the bot host:")
text = text.replace("Saved as:\\n", "Archived on the bot host:\\n")

# Ensure button handler recognizes archive and old save IDs as archive.
text = re.sub(
    r"customId\.match\(\s*/\^seekdeep:image:\(regen\|save\):\(\.\+\)\$/\s*\)",
    "customId.match(/^seekdeep:image:(regen|archive|save):(.+)$/)",
    text,
)

text = re.sub(
    r"const action = match\[1\];",
    "const action = match[1] === 'save' ? 'archive' : match[1];",
    text,
    count=1,
)

# Replace remaining save action branch if present.
text = text.replace("if (action === 'save') {", "if (action === 'archive') {")

# Ensure message image sender edits in Download link after send.
msg_func_pattern = re.compile(
    r"(?s)async function seekdeepSendImageWithButtonsMessage\(message, prompt, width = 1024, height = 1024, seed = null\)\s*\{.*?\n\}"
)

new_msg_func = r'''async function seekdeepSendImageWithButtonsMessage(message, prompt, width = 1024, height = 1024, seed = null) {
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
}'''

if msg_func_pattern.search(text):
    text = msg_func_pattern.sub(new_msg_func, text, count=1)
    print("[SeekDeep] Replaced message image sender.")
else:
    print("[SeekDeep] Message image sender not found; skipping.")

# Ensure interaction image sender edits in Download link after send.
int_func_pattern = re.compile(
    r"(?s)async function seekdeepSendImageWithButtonsInteraction\(interaction, prompt, width = 1024, height = 1024, seed = null\)\s*\{.*?\n\}"
)

new_int_func = r'''async function seekdeepSendImageWithButtonsInteraction(interaction, prompt, width = 1024, height = 1024, seed = null) {
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
}'''

if int_func_pattern.search(text):
    text = int_func_pattern.sub(new_int_func, text, count=1)
    print("[SeekDeep] Replaced interaction image sender.")
else:
    print("[SeekDeep] Interaction image sender not found; skipping.")

# Fix regenerate path to also attach Download after regeneration.
if "Regenerated locally:" in text and "await seekdeepAttachDownloadButton(sent, newActionId);" not in text:
    text = text.replace(
        """    await interaction.editReply({
      content: `Regenerated locally: ${state.prompt}`,
      files: [result.file],
      components: [seekdeepImageActionRow(newActionId)],
      allowedMentions: { repliedUser: false },
    });

    return true;""",
        """    await interaction.editReply({
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

    return true;"""
    )

# Validation.
bad = []
for s in ["Save as", "seekdeep:image:save:"]:
    if s in text:
        bad.append(s)

required = [
    "setLabel('Download')",
    "setLabel('Archive')",
    "setURL(downloadUrl)",
    "seekdeepAttachDownloadButton",
    "seekdeep:image:archive:",
]

for s in required:
    if s not in text:
        bad.append("missing " + s)

if bad:
    raise SystemExit("Still not fixed: " + ", ".join(bad))

p.write_text(text, encoding="utf-8")
print("[SeekDeep] Forced Download/Archive button fix written.")
