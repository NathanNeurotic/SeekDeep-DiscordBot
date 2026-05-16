from pathlib import Path
from datetime import datetime

path = Path("index.js")
text = path.read_text(encoding="utf-8")

stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
backup = Path(f"index.js.bak-response-footer-v2-{stamp}")
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

def replace_function(src: str, name: str, replacement: str, required=True):
    rng = find_function_range(src, name)
    if rng is None:
        if required:
            raise SystemExit(f"Could not find function {name}")
        print(f"[SeekDeep] Skipped missing function: {name}")
        return src, False

    start, end = rng
    return src[:start] + replacement.strip() + "\n\n" + src[end:].lstrip(), True

# Remove known orphaned askChat fragment if present.
start_marker = "\n = {}) {\n"
end_marker = "\nasync function askVision"
start = text.find(start_marker)
if start != -1:
    end = text.find(end_marker, start)
    if end == -1:
        raise SystemExit("Found orphan askChat fragment start, but no following askVision marker.")

    removed = text[start:end]
    if "const cleanPrompt = normalizeUserText(prompt);" in removed and "formatSources(sources)" in removed:
        text = text[:start] + "\n" + text[end:].lstrip()
        print("[SeekDeep] Removed orphaned askChat fragment.")
    else:
        raise SystemExit("Orphan marker found, but safety checks failed.")

footer_helpers = r'''
// SEEKDEEP_RESPONSE_FOOTER_START
const SEEKDEEP_NO_MODEL_USED_LABEL = 'local command (no AI model)';

function seekdeepNowMs() {
  return Date.now();
}

function seekdeepMarkRequestStart(target) {
  try {
    if (target && !target.__seekdeepRequestStartedAt) {
      target.__seekdeepRequestStartedAt = seekdeepNowMs();
    }
  } catch {}
}

function seekdeepSetResponseModel(target, modelUsed) {
  try {
    if (target) target.__seekdeepResponseModel = modelUsed || SEEKDEEP_NO_MODEL_USED_LABEL;
  } catch {}
}

function seekdeepChatModelLabel() {
  return process.env.LOCAL_CHAT_MODEL_ID || 'Qwen/Qwen3-8B';
}

function seekdeepVisionModelLabel() {
  return process.env.LOCAL_VISION_MODEL_ID || 'Qwen/Qwen2.5-VL-3B-Instruct';
}

function seekdeepImageModelLabel() {
  return process.env.LOCAL_IMAGE_MODEL_ID || 'Efficient-Large-Model/Sana_Sprint_1.6B_1024px_diffusers';
}

function seekdeepNoModelLabel() {
  return SEEKDEEP_NO_MODEL_USED_LABEL;
}

function seekdeepElapsedSeconds(startedAt) {
  const start = Number(startedAt || seekdeepNowMs());
  const elapsedMs = Math.max(0, seekdeepNowMs() - start);
  return (elapsedMs / 1000).toFixed(2);
}

function seekdeepResponseFooter({ startedAt = null, modelUsed = null } = {}) {
  const model = modelUsed || SEEKDEEP_NO_MODEL_USED_LABEL;

  return [
    `Time to Generate: ${seekdeepElapsedSeconds(startedAt)} seconds`,
    `Model Used: ${model}`,
  ].join('\n');
}

function seekdeepAppendResponseFooter(content, meta = {}) {
  const body = String(content ?? '').trim();

  if (/Time to Generate:\s*\d+(?:\.\d+)?\s*seconds\s*\nModel Used:/i.test(body)) {
    return body;
  }

  const footer = seekdeepResponseFooter(meta);
  return body ? `${body}\n\n${footer}` : footer;
}

function seekdeepModelUsedForInteraction(interaction) {
  if (interaction?.__seekdeepResponseModel) return interaction.__seekdeepResponseModel;

  switch (interaction?.commandName) {
    case 'ask':
    case 'refine':
      return seekdeepChatModelLabel();
    case 'vision':
      return seekdeepVisionModelLabel();
    case 'image':
      return seekdeepImageModelLabel();
    case 'status':
    case 'postarchive':
      return seekdeepNoModelLabel();
    default:
      return seekdeepNoModelLabel();
  }
}

function seekdeepModelUsedForMessage(message, content = '') {
  if (message?.__seekdeepResponseModel) return message.__seekdeepResponseModel;

  const body = String(content || '').trim();

  if (/^pong$/i.test(body)) return seekdeepNoModelLabel();
  if (/^Local AI server status/i.test(body)) return seekdeepNoModelLabel();
  if (/^Archive /i.test(body) || /^Posting archive:/i.test(body)) return seekdeepNoModelLabel();
  if (/^SeekDeep request failed/i.test(body)) return seekdeepNoModelLabel();

  return seekdeepChatModelLabel();
}
// SEEKDEEP_RESPONSE_FOOTER_END
'''

if "SEEKDEEP_RESPONSE_FOOTER_START" in text:
    start = text.find("// SEEKDEEP_RESPONSE_FOOTER_START")
    end = text.find("// SEEKDEEP_RESPONSE_FOOTER_END", start)
    if end == -1:
        raise SystemExit("Footer helper start exists but end marker is missing.")
    end += len("// SEEKDEEP_RESPONSE_FOOTER_END")
    text = text[:start] + footer_helpers.strip() + "\n\n" + text[end:].lstrip()
    print("[SeekDeep] Replaced response footer helpers.")
else:
    anchor = "const MAX_DISCORD_CHARS = Number(process.env.MAX_DISCORD_CHARS || 1900);"
    if anchor not in text:
        raise SystemExit("Could not find MAX_DISCORD_CHARS anchor.")
    text = text.replace(anchor, anchor + "\n\n" + footer_helpers.strip(), 1)
    print("[SeekDeep] Inserted response footer helpers.")

send_interaction = r'''
async function sendLongInteractionReply(interaction, content, meta = {}) {
  seekdeepMarkRequestStart(interaction);

  if (typeof cleanLoopingReply === 'function') {
    content = cleanLoopingReply(content);
  } else if (typeof stripQwenThinkingBlocks === 'function') {
    content = stripQwenThinkingBlocks(content);
  }

  content = seekdeepAppendResponseFooter(content, {
    startedAt: meta.startedAt || interaction?.__seekdeepRequestStartedAt,
    modelUsed: meta.modelUsed || seekdeepModelUsedForInteraction(interaction),
  });

  if (!seekdeepClaimFinalReply('interaction', interaction?.id)) {
    return null;
  }

  const chunks = splitDiscordText(content);
  let previous = null;

  for (let i = 0; i < chunks.length; i++) {
    const payload = {
      content: chunks[i],
      allowedMentions: { repliedUser: false },
    };

    if (i === 0) {
      previous = await safeEditOrReply(interaction, payload);

      if (!previous && typeof interaction.fetchReply === 'function') {
        previous = await interaction.fetchReply().catch(() => null);
      }

      continue;
    }

    if (previous && typeof previous.reply === 'function') {
      previous = await previous.reply(payload);
    } else if (interaction.channel && typeof interaction.channel.send === 'function') {
      previous = await interaction.channel.send(payload);
    } else {
      console.error('Could not send follow-up chunk; no previous message or channel is available.');
      break;
    }
  }

  return previous;
}
'''

text, _ = replace_function(text, "sendLongInteractionReply", send_interaction)

send_message = r'''
async function sendLongMessageReply(message, content, meta = {}) {
  seekdeepMarkRequestStart(message);
  stopSeekDeepTypingLoopForMessage(message);

  if (!seekdeepClaimFinalReply('message', message?.id)) {
    return null;
  }

  if (typeof cleanLoopingReply === 'function') {
    content = cleanLoopingReply(content);
  } else if (typeof stripQwenThinkingBlocks === 'function') {
    content = stripQwenThinkingBlocks(content);
  }

  if (!String(content || '').trim()) {
    content = '[SeekDeep generated an empty response after cleanup. This usually means the model only produced hidden <think> output or the output was stripped as invalid.]';
  }

  content = seekdeepAppendResponseFooter(content, {
    startedAt: meta.startedAt || message?.__seekdeepRequestStartedAt,
    modelUsed: meta.modelUsed || seekdeepModelUsedForMessage(message, content),
  });

  const chunks = splitDiscordText(content)
    .map((chunk) => String(chunk || '').trim())
    .filter(Boolean);

  if (!chunks.length) {
    chunks.push(seekdeepAppendResponseFooter('[SeekDeep generated no sendable text.]', {
      startedAt: meta.startedAt || message?.__seekdeepRequestStartedAt,
      modelUsed: meta.modelUsed || seekdeepModelUsedForMessage(message, content),
    }));
  }

  let previous = null;

  async function sendViaChannel(payload) {
    if (!message.channel || typeof message.channel.send !== 'function') {
      throw new Error('No channel.send available for fallback message delivery.');
    }

    return await message.channel.send({
      content: payload.content,
      allowedMentions: payload.allowedMentions || { repliedUser: false },
    });
  }

  async function sendFirstChunk(payload) {
    try {
      return await message.reply(payload);
    } catch (err) {
      const code = err?.code;
      const raw = String(err?.rawError?.message || '');
      const msg = String(err?.message || '');

      const referenceFailed =
        code === 10008 ||
        code === 50035 ||
        raw.includes('Invalid Form Body') ||
        raw.includes('Unknown message') ||
        msg.includes('Unknown message') ||
        msg.includes('MESSAGE_REFERENCE_UNKNOWN_MESSAGE');

      if (referenceFailed) {
        console.warn(`Source message reference failed; falling back to channel.send for message ${message?.id}`);
      } else {
        console.error('message.reply failed; falling back to channel.send:', err);
      }

      return await sendViaChannel(payload);
    }
  }

  async function sendFollowupChunk(parent, payload) {
    if (parent && typeof parent.reply === 'function') {
      try {
        return await parent.reply(payload);
      } catch (err) {
        console.warn('Follow-up reply failed; falling back to channel.send:', err?.message || err);
      }
    }

    return await sendViaChannel(payload);
  }

  for (let i = 0; i < chunks.length; i++) {
    const payload = {
      content: chunks[i],
      allowedMentions: { repliedUser: false },
    };

    if (i === 0) {
      previous = await sendFirstChunk(payload);
    } else {
      previous = await sendFollowupChunk(previous, payload);
    }
  }

  return previous;
}
'''

text, _ = replace_function(text, "sendLongMessageReply", send_message)

image_msg = r'''
async function seekdeepSendImageWithButtonsMessage(message, prompt, width = 1024, height = 1024, seed = null) {
  const startedAt = seekdeepNowMs();
  const result = await makeImageResult(prompt, width, height, seed);
  const normalized = seekdeepNormalizeGeneratedImageResult(result);
  const actionId = seekdeepMakeImageActionId();

  const state = seekdeepRememberTempImageState({
    id: actionId,
    prompt,
    width,
    height,
    seed,
    filename: normalized.filename,
    buffer: normalized.buffer,
    mimeType: 'image/png',
    createdAt: Date.now(),
    expiresAt: Date.now() + SEEKDEEP_IMAGE_CACHE_TTL_MS,
  });

  const content = seekdeepAppendResponseFooter(`Generated locally: ${prompt}`, {
    startedAt,
    modelUsed: seekdeepImageModelLabel(),
  });

  let sent = await message.reply({
    content,
    files: [normalized.attachment],
    components: [seekdeepImageActionRow(actionId)],
    allowedMentions: { repliedUser: false },
  });

  try {
    sent = await seekdeepAttachDownloadButton(sent, state.id);
  } catch (err) {
    console.warn('Could not attach Download button after image generation:', err?.message || err);
  }

  return sent;
}
'''

text, _ = replace_function(text, "seekdeepSendImageWithButtonsMessage", image_msg, required=False)

image_int = r'''
async function seekdeepSendImageWithButtonsInteraction(interaction, prompt, width = 1024, height = 1024, seed = null) {
  const startedAt = seekdeepNowMs();
  const result = await makeImageResult(prompt, width, height, seed);
  const normalized = seekdeepNormalizeGeneratedImageResult(result);
  const actionId = seekdeepMakeImageActionId();

  const state = seekdeepRememberTempImageState({
    id: actionId,
    prompt,
    width,
    height,
    seed,
    filename: normalized.filename,
    buffer: normalized.buffer,
    mimeType: 'image/png',
    createdAt: Date.now(),
    expiresAt: Date.now() + SEEKDEEP_IMAGE_CACHE_TTL_MS,
  });

  const content = seekdeepAppendResponseFooter(`Generated locally: ${prompt}`, {
    startedAt,
    modelUsed: seekdeepImageModelLabel(),
  });

  let sent = await safeEditOrReply(interaction, {
    content,
    files: [normalized.attachment],
    components: [seekdeepImageActionRow(state.id)],
    allowedMentions: { repliedUser: false },
  });

  if (!sent && typeof interaction.fetchReply === 'function') {
    sent = await interaction.fetchReply().catch(() => null);
  }

  return await seekdeepAttachDownloadButton(sent, state.id);
}
'''

text, _ = replace_function(text, "seekdeepSendImageWithButtonsInteraction", image_int, required=False)

button_handler = r'''
async function seekdeepHandleImageButton(interaction) {
  const startedAt = seekdeepNowMs();
  const customId = String(interaction.customId || '');
  const match = customId.match(/^seekdeep:image:(regen|archive|save):(.+)$/);

  if (!match) {
    return false;
  }

  const action = match[1] === 'save' ? 'archive' : match[1];
  const id = match[2];

  await interaction.deferReply({ ephemeral: true });

  let state = seekdeepTempImageStateIndex.get(id) || null;
  if (!state) {
    state = seekdeepLoadTempImageState(id);
  }

  if (!state) {
    await interaction.editReply({
      content: seekdeepAppendResponseFooter('That image action expired from the 24-hour cache. Generate it again if you still want to use its buttons.', {
        startedAt,
        modelUsed: seekdeepNoModelLabel(),
      }),
    });
    return true;
  }

  if (action === 'archive') {
    const savedPath = seekdeepArchiveImageStateToDisk(state);

    await interaction.editReply({
      content: seekdeepAppendResponseFooter(`Archived on the bot host:\n\`${savedPath}\``, {
        startedAt,
        modelUsed: seekdeepNoModelLabel(),
      }),
    });

    return true;
  }

  if (action === 'regen') {
    const result = await makeImageResult(state.prompt, state.width || 1024, state.height || 1024, state.seed ?? null);
    const normalized = seekdeepNormalizeGeneratedImageResult(result);
    const newActionId = seekdeepMakeImageActionId();

    const newState = seekdeepRememberTempImageState({
      id: newActionId,
      prompt: state.prompt,
      width: state.width || 1024,
      height: state.height || 1024,
      seed: state.seed ?? null,
      filename: normalized.filename,
      buffer: normalized.buffer,
      mimeType: 'image/png',
      createdAt: Date.now(),
      expiresAt: Date.now() + SEEKDEEP_IMAGE_CACHE_TTL_MS,
    });

    let sent = null;

    if (interaction.channel && typeof interaction.channel.send === 'function') {
      sent = await interaction.channel.send({
        content: seekdeepAppendResponseFooter(`Regenerated locally: ${state.prompt}`, {
          startedAt,
          modelUsed: seekdeepImageModelLabel(),
        }),
        files: [normalized.attachment],
        components: [seekdeepImageActionRow(newState.id)],
      });

      try {
        await seekdeepAttachDownloadButton(sent, newState.id);
      } catch (err) {
        console.warn('Could not attach Download button after regeneration:', err?.message || err);
      }
    }

    await interaction.editReply({
      content: seekdeepAppendResponseFooter(sent ? 'Regenerated and posted.' : 'Regenerated, but I could not post the new image back to the channel.', {
        startedAt,
        modelUsed: seekdeepImageModelLabel(),
      }),
    });

    return true;
  }

  await interaction.editReply({
    content: seekdeepAppendResponseFooter('Unknown image action.', {
      startedAt,
      modelUsed: seekdeepNoModelLabel(),
    }),
  });

  return true;
}
'''

text, _ = replace_function(text, "seekdeepHandleImageButton", button_handler, required=False)

archive_to_channel = r'''
async function seekdeepPostArchiveToChannel(channel) {
  const startedAt = seekdeepNowMs();
  const files = seekdeepListArchiveImageFiles();
  const dir = seekdeepArchiveDir();

  if (!files.length) {
    return seekdeepAppendResponseFooter(`Archive is empty.\nPath checked:\n\`${dir}\``, {
      startedAt,
      modelUsed: seekdeepNoModelLabel(),
    });
  }

  const batches = seekdeepArchiveBatches(files, 10);
  let posted = 0;
  let failed = 0;

  await channel.send(seekdeepAppendResponseFooter(`Posting archive: ${files.length} image(s) from \`${dir}\`.`, {
    startedAt,
    modelUsed: seekdeepNoModelLabel(),
  }));

  for (let i = 0; i < batches.length; i++) {
    const batchStartedAt = seekdeepNowMs();
    const batch = batches[i];

    try {
      await channel.send({
        content: seekdeepAppendResponseFooter(`Archive batch ${i + 1}/${batches.length}`, {
          startedAt: batchStartedAt,
          modelUsed: seekdeepNoModelLabel(),
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
              modelUsed: seekdeepNoModelLabel(),
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

  return seekdeepAppendResponseFooter(`Archive post complete.\nPosted: ${posted}\nFailed: ${failed}\nSource: \`${dir}\``, {
    startedAt,
    modelUsed: seekdeepNoModelLabel(),
  });
}
'''

text, _ = replace_function(text, "seekdeepPostArchiveToChannel", archive_to_channel, required=False)

archive_msg = r'''
async function seekdeepPostArchiveFromMessage(message) {
  seekdeepMarkRequestStart(message);
  seekdeepSetResponseModel(message, seekdeepNoModelLabel());
  stopSeekDeepTypingLoopForMessage(message);

  const summary = await seekdeepPostArchiveToChannel(message.channel);

  await message.reply({
    content: summary,
    allowedMentions: { repliedUser: false },
  });

  return summary;
}
'''

text, _ = replace_function(text, "seekdeepPostArchiveFromMessage", archive_msg, required=False)

archive_int = r'''
async function seekdeepPostArchiveFromInteraction(interaction) {
  seekdeepMarkRequestStart(interaction);
  seekdeepSetResponseModel(interaction, seekdeepNoModelLabel());

  const summary = await seekdeepPostArchiveToChannel(interaction.channel);

  await safeEditOrReply(interaction, {
    content: summary,
    allowedMentions: { repliedUser: false },
  });

  return summary;
}
'''

text, _ = replace_function(text, "seekdeepPostArchiveFromInteraction", archive_int, required=False)

needle = "client.on('interactionCreate', async (interaction) => {"
if needle in text and "SEEKDEEP_INTERACTION_REQUEST_START" not in text:
    text = text.replace(needle, needle + "\n  // SEEKDEEP_INTERACTION_REQUEST_START\n  seekdeepMarkRequestStart(interaction);", 1)
    print("[SeekDeep] Added interaction request timer start.")

needle = "client.on('messageCreate', async (message) => {"
if needle in text and "SEEKDEEP_MESSAGE_REQUEST_START" not in text:
    text = text.replace(needle, needle + "\n  // SEEKDEEP_MESSAGE_REQUEST_START\n  seekdeepMarkRequestStart(message);", 1)
    print("[SeekDeep] Added message request timer start.")

message_replacements = [
    (
        "remember(key, 'assistant', 'pong');\n      await sendLongMessageReply(message, 'pong');",
        "remember(key, 'assistant', 'pong');\n      seekdeepSetResponseModel(message, seekdeepNoModelLabel());\n      await sendLongMessageReply(message, 'pong');"
    ),
    (
        "remember(key, 'assistant', status);\n      await sendLongMessageReply(message, asTextBlock(status));",
        "remember(key, 'assistant', status);\n      seekdeepSetResponseModel(message, seekdeepNoModelLabel());\n      await sendLongMessageReply(message, asTextBlock(status));"
    ),
    (
        "remember(key, 'assistant', answer);\n      await sendLongMessageReply(message, answer);\n      return;\n    }\n\n    await message.channel.sendTyping();",
        "remember(key, 'assistant', answer);\n      seekdeepSetResponseModel(message, seekdeepNoModelLabel());\n      await sendLongMessageReply(message, answer);\n      return;\n    }\n\n    await message.channel.sendTyping();"
    ),
    (
        "remember(key, 'assistant', answer);\n      await sendLongMessageReply(message, answer);\n      return;\n    }\n\n    // Natural language image generation routing",
        "remember(key, 'assistant', answer);\n      seekdeepSetResponseModel(message, seekdeepVisionModelLabel());\n      await sendLongMessageReply(message, answer);\n      return;\n    }\n\n    // Natural language image generation routing"
    ),
    (
        "remember(key, 'assistant', answer);\n    await sendLongMessageReply(message, answer);",
        "remember(key, 'assistant', answer);\n    seekdeepSetResponseModel(message, seekdeepChatModelLabel());\n    await sendLongMessageReply(message, answer);"
    ),
]

for old, new in message_replacements:
    if old in text and new not in text:
        text = text.replace(old, new, 1)

interaction_replacements = [
    (
        "const answer = await askChat(prompt, { web, memoryKey: key });\n      remember(key, 'user', prompt);",
        "const answer = await askChat(prompt, { web, memoryKey: key });\n      seekdeepSetResponseModel(interaction, seekdeepChatModelLabel());\n      remember(key, 'user', prompt);"
    ),
    (
        "answer = cleanupRefinedPrompt(answer);\n\n      remember(key, 'user', prompt);",
        "answer = cleanupRefinedPrompt(answer);\n\n      seekdeepSetResponseModel(interaction, seekdeepChatModelLabel());\n      remember(key, 'user', prompt);"
    ),
    (
        "const answer = await askVision(attachment, buildPromptWithMemory(prompt, key));\n      remember(key, 'user', `/vision ${prompt}`);",
        "const answer = await askVision(attachment, buildPromptWithMemory(prompt, key));\n      seekdeepSetResponseModel(interaction, seekdeepVisionModelLabel());\n      remember(key, 'user', `/vision ${prompt}`);"
    ),
]

for old, new in interaction_replacements:
    if old in text and new not in text:
        text = text.replace(old, new, 1)

required = [
    "function seekdeepAppendResponseFooter(",
    "function seekdeepResponseFooter(",
    "function seekdeepChatModelLabel(",
    "function seekdeepImageModelLabel(",
    "async function sendLongMessageReply(",
    "async function sendLongInteractionReply(",
]

missing = [item for item in required if item not in text]
if missing:
    raise SystemExit("Missing after patch: " + ", ".join(missing))

path.write_text(text, encoding="utf-8")
print("[SeekDeep] Response footer patch v2 written.")
