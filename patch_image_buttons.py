from pathlib import Path
import re
from datetime import datetime

path = Path("index.js")
text = path.read_text(encoding="utf-8")

stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
backup = Path(f"index.js.bak.image-buttons-{stamp}")
backup.write_text(text, encoding="utf-8")
print(f"[SeekDeep] Backup written: {backup}")

# ------------------------------------------------------------
# 1. Add Discord button imports.
# ------------------------------------------------------------
if "ActionRowBuilder" not in text:
    text = text.replace(
        "  AttachmentBuilder,\n",
        "  ActionRowBuilder,\n  AttachmentBuilder,\n  ButtonBuilder,\n  ButtonStyle,\n",
        1,
    )
    print("[SeekDeep] Added button imports.")

# ------------------------------------------------------------
# 2. Replace makeImage() with metadata-capable version + button state.
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

function seekdeepImageActionRow(id) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`seekdeep:image:regen:${id}`)
      .setLabel('Regenerate')
      .setStyle(ButtonStyle.Secondary),

    new ButtonBuilder()
      .setCustomId(`seekdeep:image:save:${id}`)
      .setLabel('Save as')
      .setStyle(ButtonStyle.Success),
  );
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

function seekdeepSaveImageStateToDisk(state) {
  if (!state?.buffer) {
    throw new Error('No image buffer is available to save. The image action may have expired.');
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

  try {
    return await message.reply(payload);
  } catch (err) {
    if (message.channel && typeof message.channel.send === 'function') {
      return await message.channel.send(payload);
    }

    throw err;
  }
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

  return await safeEditOrReply(interaction, {
    content: `Generated locally: ${prompt}`,
    files: [result.file],
    components: [seekdeepImageActionRow(actionId)],
    allowedMentions: { repliedUser: false },
  });
}

async function seekdeepHandleImageButton(interaction) {
  const customId = String(interaction.customId || '');
  const match = customId.match(/^seekdeep:image:(regen|save):(.+)$/);

  if (!match) {
    return false;
  }

  const action = match[1];
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

  if (action === 'save') {
    const savedPath = seekdeepSaveImageStateToDisk(state);

    await interaction.reply({
      content: `Saved as:\n\`${savedPath}\``,
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

    return true;
  }

  return false;
}
// SEEKDEEP_IMAGE_BUTTONS_END
'''

text = re.sub(
    r"(?s)// SEEKDEEP_IMAGE_BUTTONS_START.*?// SEEKDEEP_IMAGE_BUTTONS_END\s*",
    "",
    text,
)

text = replace_js_function(text, "makeImage", image_helpers)

# ------------------------------------------------------------
# 3. Patch image slash command output to include buttons.
# ------------------------------------------------------------
slash_old = """      const file = await makeImage(prompt, width, height, seed ?? null);
      remember(key, 'user', `/image ${prompt}`);
      remember(key, 'assistant', `Generated image locally for: ${prompt}`);
      await safeEditOrReply(interaction, { content: `Generated locally: ${prompt}`, files: [file] });
      return;"""

slash_new = """      remember(key, 'user', `/image ${prompt}`);
      remember(key, 'assistant', `Generated image locally for: ${prompt}`);
      await seekdeepSendImageWithButtonsInteraction(interaction, prompt, width, height, seed ?? null);
      return;"""

if slash_old in text:
    text = text.replace(slash_old, slash_new, 1)
    print("[SeekDeep] Patched /image command with buttons.")
else:
    print("[SeekDeep] /image command was not in the expected old form; leaving it unchanged.")

# ------------------------------------------------------------
# 4. Add button interaction routing.
# ------------------------------------------------------------
old_interaction_gate = """  if (!interaction.isChatInputCommand()) return;

  try {"""

new_interaction_gate = """  if (interaction.isButton && interaction.isButton()) {
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

if old_interaction_gate in text:
    text = text.replace(old_interaction_gate, new_interaction_gate, 1)
    print("[SeekDeep] Added image button interaction handler.")
elif "seekdeepHandleImageButton(interaction)" in text:
    print("[SeekDeep] Image button interaction handler already present.")
else:
    raise SystemExit("Could not find interaction gate to patch.")

# ------------------------------------------------------------
# 5. Replace/insert natural media helpers and messageCreate route.
# ------------------------------------------------------------
natural_helper = r'''
// SEEKDEEP_NATURAL_ROUTING_START
function seekdeepAttachmentLooksVisual(attachment) {
  if (!attachment) return false;

  const contentType = String(attachment.contentType || '').toLowerCase();
  const name = String(attachment.name || '').toLowerCase();
  const url = String(attachment.url || '').toLowerCase();

  return (
    contentType.startsWith('image/') ||
    contentType.startsWith('video/') ||
    /\.(png|jpe?g|webp|gif|bmp|svg|mp4|mov|webm|mkv)$/i.test(name) ||
    /\.(png|jpe?g|webp|gif|bmp|svg|mp4|mov|webm|mkv)(\?|$)/i.test(url)
  );
}

function seekdeepFirstVisualAttachment(message) {
  if (!message?.attachments?.size) return null;

  for (const attachment of message.attachments.values()) {
    if (seekdeepAttachmentLooksVisual(attachment)) return attachment;
  }

  return null;
}

async function seekdeepGetReplyVisualAttachment(message) {
  try {
    const refId = message?.reference?.messageId;
    if (!refId || !message?.channel) return null;

    const replied = await message.channel.messages.fetch(refId);
    return seekdeepFirstVisualAttachment(replied);
  } catch (err) {
    console.error('Could not inspect replied-to message for visual media:', err?.message || err);
    return null;
  }
}

function seekdeepLooksLikeVisionPrompt(text = '') {
  const t = normalizeUserText(text).toLowerCase().trim();
  if (!t) return true;

  return (
    /\bwhat(?:'s| is)\s+(?:this|that)\b/.test(t) ||
    /\bwhat the fuck is this\b/.test(t) ||
    /\bwtf is this\b/.test(t) ||
    /\bdescribe\b(?:\s+(?:this|that|image|picture|photo|media))?/.test(t) ||
    /\bidentify\b(?:\s+(?:this|that|image|picture|photo|media))?/.test(t) ||
    /\bcaption\b(?:\s+(?:this|that|image|picture|photo|media))?/.test(t) ||
    /\banaly[sz]e\b(?:\s+(?:this|that|image|picture|photo|media))?/.test(t) ||
    /\bwhat do you see\b/.test(t) ||
    /\bwhat is in (?:this|that|the image|the picture|the photo)\b/.test(t) ||
    /\bvision\b/.test(t)
  );
}

function seekdeepLooksLikeImagePrompt(text = '') {
  const t = normalizeUserText(text).toLowerCase().trim();
  if (!t) return false;

  if (/^(?:show me|make me|generate|create|draw|render|paint|illustrate|design)\b/.test(t)) return true;

  if (/\b(?:image|picture|photo|pic|art|artwork|drawing|wallpaper|banner|logo|icon)\b/.test(t)) return true;

  if (
    /^(?:i need|need|i want|want)\b/.test(t) &&
    !/[?]$/.test(t) &&
    !/\b(help|advice|info|information|know|understand|learn|tell me|explain|why|how|when|where|who|status)\b/.test(t)
  ) return true;

  return false;
}

function seekdeepExtractImagePrompt(text = '') {
  let t = normalizeUserText(text);

  t = t.replace(/<@!?\d+>/g, ' ').trim();
  t = t.replace(/^(?:hey|yo|hi|hello)\s+/i, '');
  t = t.replace(/^(?:seekdeep|seekotics|neurabot|plugtalk)[,:]?\s+/i, '');
  t = t.replace(/^(?:please\s+)?(?:can you|could you|would you)\s+/i, '');
  t = t.replace(/^(?:please\s+)?(?:show me|make me|generate|create|draw|render|paint|illustrate|design)\s+(?:me\s+)?/i, '');
  t = t.replace(/^(?:an?\s+)?(?:image|picture|photo|pic|art|artwork|drawing|wallpaper|banner|logo|icon)\s+(?:of|for)\s+/i, '');
  t = t.replace(/^(?:i need|need|i want|want)\s+(?:an?\s+|some\s+)?(?:image|picture|photo|pic|art|artwork|drawing|wallpaper|banner|logo|icon)?\s*(?:of|for)?\s*/i, '');
  t = t.replace(/\s+/g, ' ').trim();

  return t;
}

async function seekdeepInferNaturalRoute(message, prompt) {
  const cleanPrompt = normalizeUserText(prompt || '');
  const directVisual = seekdeepFirstVisualAttachment(message);
  const replyVisual = await seekdeepGetReplyVisualAttachment(message);
  const visualAttachment = directVisual || replyVisual || null;

  if (visualAttachment && seekdeepLooksLikeVisionPrompt(cleanPrompt)) {
    return {
      route: 'vision',
      prompt: cleanPrompt || 'Describe this media clearly.',
      attachment: visualAttachment,
    };
  }

  if (seekdeepLooksLikeImagePrompt(cleanPrompt)) {
    return {
      route: 'image',
      prompt: seekdeepExtractImagePrompt(cleanPrompt) || cleanPrompt,
      attachment: null,
    };
  }

  return {
    route: 'chat',
    prompt: cleanPrompt,
    attachment: null,
  };
}
// SEEKDEEP_NATURAL_ROUTING_END
'''

text = re.sub(
    r"(?s)// SEEKDEEP_NATURAL_ROUTING_START.*?// SEEKDEEP_NATURAL_ROUTING_END\s*",
    "",
    text,
)

anchor = "client.on('interactionCreate', async (interaction) => {"
if anchor not in text:
    raise SystemExit("Could not find interactionCreate anchor for natural-routing helper insertion.")

text = text.replace(anchor, natural_helper + "\n\n" + anchor, 1)

new_message_handler = r'''client.on('messageCreate', async (message) => {
  // SEEKDEEP_MESSAGE_EVENT_DEDUPE
  if (message?.id && !seekdeepClaimEventOnce(`message:${message.id}`)) {
    console.warn(`Duplicate Discord message event suppressed: ${message.id}`);
    return;
  }

  if (message.author.bot || !client.user) return;
  if (!message.mentions.has(client.user)) return;

  const prompt = normalizeUserText(stripBotMentions(message.content));

  // SEEKDEEP_MESSAGE_EARLY_FINAL_CLAIM
  if (!seekdeepClaimFinalReply('message-start', message?.id)) {
    console.warn(`Duplicate message handler path suppressed before generation: ${message?.id}`);
    stopSeekDeepTypingLoopForMessage(message);
    return;
  }

  // SEEKDEEP_MESSAGE_PROMPT_DEDUPE_AND_TYPING
  if (!seekdeepClaimPromptOnce('message', message.author?.id || 'unknown', message.channel?.id || 'unknown', prompt || '[attachment-only]')) {
    console.warn(`Duplicate prompt suppressed from ${message.author?.id || 'unknown'} in ${message.channel?.id || 'unknown'}`);
    stopSeekDeepTypingLoopForMessage(message);
    return;
  }

  const _seekdeepTypingLoop = startSeekDeepTypingLoop(message.channel, `message:${message.id}`);
  try {
    message.__seekdeepTypingLoop = _seekdeepTypingLoop;
  } catch {}

  if (typeof isExactPongTest === 'function' && isExactPongTest(prompt)) {
    const key = memoryKeyFrom(message);
    remember(key, 'user', prompt);
    remember(key, 'assistant', 'pong');
    await sendLongMessageReply(message, 'pong');
    return;
  }

  if (typeof isExplicitStatusRequest === 'function' && isExplicitStatusRequest(prompt)) {
    const key = memoryKeyFrom(message);
    const answer = asTextBlock(await statusText());
    remember(key, 'user', prompt);
    remember(key, 'assistant', answer);
    await sendLongMessageReply(message, answer);
    return;
  }

  // SEEKDEEP_DIRECT_IDENTITY_REPLY_V2
  if (isBotIdentityQuestion(prompt)) {
    const answer = botIdentityAnswer(message.client?.user?.username || client.user?.username || 'PlugTalk');

    try {
      const key = typeof memoryKeyFrom === 'function' ? memoryKeyFrom(message) : null;
      if (key && typeof remember === 'function') {
        remember(key, 'user', prompt);
        remember(key, 'assistant', answer);
      }
    } catch {}

    if (typeof sendLongMessageReply === 'function') {
      await sendLongMessageReply(message, answer);
    } else {
      await message.reply({ content: answer, allowedMentions: { repliedUser: false } });
    }

    return;
  }

  const replyVisual = await seekdeepGetReplyVisualAttachment(message);
  if (!prompt && message.attachments.size === 0 && !replyVisual) return;

  try {
    await message.channel.sendTyping();

    const key = memoryKeyFrom(message);
    const naturalRoute = await seekdeepInferNaturalRoute(message, prompt);

    if (naturalRoute.route === 'vision' && naturalRoute.attachment) {
      const rawPrompt = naturalRoute.prompt || 'Describe this media clearly.';
      const answer = await askVision(naturalRoute.attachment, buildPromptWithMemory(rawPrompt, key));
      remember(key, 'user', `/vision ${rawPrompt}`);
      remember(key, 'assistant', answer);
      await sendLongMessageReply(message, answer);
      return;
    }

    if (naturalRoute.route === 'image') {
      const imagePrompt = naturalRoute.prompt || prompt;
      remember(key, 'user', `/image ${imagePrompt}`);
      remember(key, 'assistant', `Generated image locally for: ${imagePrompt}`);

      stopSeekDeepTypingLoopForMessage(message);
      await seekdeepSendImageWithButtonsMessage(message, imagePrompt, 1024, 1024, null);
      return;
    }

    const answer = await askChat(naturalRoute.prompt || prompt, { web: 'auto', memoryKey: key });
    remember(key, 'user', naturalRoute.prompt || prompt);
    remember(key, 'assistant', answer);
    await sendLongMessageReply(message, answer);
  } catch (err) {
    console.error(err);
    stopSeekDeepTypingLoopForMessage(message);
    await sendLongMessageReply(message, `SeekDeep request failed.\n\nError:\n${err.message}`);
  }
});

client.login(TOKEN);
'''

text = re.sub(
    r"client\.on\('messageCreate', async \(message\) => \{[\s\S]*?\n\}\);\s*\nclient\.login\(TOKEN\);\s*",
    new_message_handler,
    text,
)

required = [
    "ActionRowBuilder",
    "ButtonBuilder",
    "ButtonStyle",
    "SEEKDEEP_IMAGE_ACTIONS",
    "seekdeepHandleImageButton",
    "seekdeepSendImageWithButtonsMessage",
    "seekdeepSendImageWithButtonsInteraction",
    "seekdeepInferNaturalRoute",
    "components: [seekdeepImageActionRow",
]

missing = [item for item in required if item not in text]
if missing:
    raise SystemExit("Patch failed. Missing: " + ", ".join(missing))

path.write_text(text, encoding="utf-8")
print("[SeekDeep] Wrote patched index.js.")
