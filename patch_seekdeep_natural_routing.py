from pathlib import Path
import re

path = Path("index.js")
text = path.read_text(encoding="utf-8")

backup = Path("index.js.bak.natural-routing")
backup.write_text(text, encoding="utf-8")
print(f"[SeekDeep] Backup written: {backup}")

helper = r'''
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

  if (/^(?:show me|make me|generate|create|draw|render|paint|illustrate|design)\b/.test(t)) {
    return true;
  }

  if (/\b(?:image|picture|photo|pic|art|artwork|drawing|wallpaper|banner|logo|icon)\b/.test(t)) {
    return true;
  }

  if (
    /^(?:i need|need|i want|want)\b/.test(t) &&
    !/[?]$/.test(t) &&
    !/\b(help|advice|info|information|know|understand|learn|tell me|explain|why|how|when|where|who|status)\b/.test(t)
  ) {
    return true;
  }

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

if "// SEEKDEEP_NATURAL_ROUTING_START" in text:
    text = re.sub(
        r"(?s)// SEEKDEEP_NATURAL_ROUTING_START.*?// SEEKDEEP_NATURAL_ROUTING_END\s*",
        helper + "\n\n",
        text,
    )
    print("[SeekDeep] Replaced existing natural-routing helper block.")
else:
    anchor = "client.on('interactionCreate', async (interaction) => {"
    if anchor not in text:
        raise SystemExit("Could not find interactionCreate anchor.")
    text = text.replace(anchor, helper + "\n\n" + anchor, 1)
    print("[SeekDeep] Inserted natural-routing helper block.")

new_handler = r'''client.on('messageCreate', async (message) => {
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
      const file = await makeImage(imagePrompt, 1024, 1024, null);

      remember(key, 'user', `/image ${imagePrompt}`);
      remember(key, 'assistant', `Generated image locally for: ${imagePrompt}`);

      stopSeekDeepTypingLoopForMessage(message);

      if (!seekdeepClaimFinalReply('message', message?.id)) {
        return;
      }

      try {
        await message.reply({
          content: `Generated locally: ${imagePrompt}`,
          files: [file],
          allowedMentions: { repliedUser: false },
        });
      } catch (err) {
        if (message.channel && typeof message.channel.send === 'function') {
          await message.channel.send({
            content: `Generated locally: ${imagePrompt}`,
            files: [file],
            allowedMentions: { repliedUser: false },
          });
        } else {
          throw err;
        }
      }

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
    r"client\.on\('messageCreate', async \(message\) => \{[\s\S]*?\n\}\);\n\nclient\.login\(TOKEN\);\n*",
    new_handler,
    text,
)

path.write_text(text, encoding="utf-8")
print("[SeekDeep] Wrote patched index.js")
