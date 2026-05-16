from pathlib import Path
import re

path = Path("index.js")
text = path.read_text(encoding="utf-8")

backup = Path(f"index.js.bak.media-route-python")
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

  if (/\b(?:image|picture|photo|pic|art|artwork|drawing|wallpaper|banner|logo|icon)\s+of\b/.test(t)) return true;

  if (
    /\b(?:i need|need|i want|want|show me|give me)\b/.test(t) &&
    /\b(?:image|picture|photo|pic|art|artwork|drawing|wallpaper|banner|logo|icon)\b/.test(t)
  ) return true;

  if (/\b(?:generate|create|make|draw|render|paint|illustrate|design)\b/.test(t)) {
    if (/\b(?:image|picture|photo|pic|art|artwork|drawing|wallpaper|banner|logo|icon)\b/.test(t)) return true;
    if (/\bof\b/.test(t) || /\bme\b/.test(t)) return true;
  }

  return false;
}

function seekdeepExtractImagePrompt(text = '') {
  let t = normalizeUserText(text);

  t = t.replace(/<@!?\d+>/g, ' ').trim();
  t = t.replace(/^(?:hey|yo|hi|hello)\s+/i, '');
  t = t.replace(/^(?:seekdeep|seekotics|neurabot|plugtalk)[,:]?\s+/i, '');
  t = t.replace(/^(?:please\s+)?(?:can you|could you|would you)\s+/i, '');
  t = t.replace(/^(?:please\s+)?(?:generate|create|make|draw|render|paint|illustrate|design)\s+(?:me\s+)?/i, '');
  t = t.replace(/^(?:an?\s+)?(?:image|picture|photo|pic|art|artwork|drawing|wallpaper|banner|logo|icon)\s+(?:of|for)\s+/i, '');
  t = t.replace(/^(?:i need|need|i want|want|show me|give me)\s+(?:an?\s+|some\s+)?(?:image|picture|photo|pic|art|artwork|drawing|wallpaper|banner|logo|icon)\s+(?:of|for)\s*/i, '');
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

# Replace or insert helper block.
if "// SEEKDEEP_NATURAL_ROUTING_START" in text:
    text = re.sub(
        r"(?s)// SEEKDEEP_NATURAL_ROUTING_START.*?// SEEKDEEP_NATURAL_ROUTING_END\s*",
        helper + "\n\n",
        text,
    )
    print("[SeekDeep] Replaced existing natural-routing helper block.")
else:
    anchor = "client.on('messageCreate', async (message) => {"
    if anchor not in text:
        raise SystemExit("Could not find messageCreate handler anchor.")
    text = text.replace(anchor, helper + "\n\n" + anchor, 1)
    print("[SeekDeep] Inserted natural-routing helper block.")

old_block = re.search(
    r"""(?s)    const key = memoryKeyFrom\(message\);\s*
    const firstAttachment = message\.attachments\.first\(\);\s*
    if \(firstAttachment && \(firstAttachment\.contentType\?\.startsWith\('image/'\) \|\| firstAttachment\.contentType\?\.startsWith\('video/'\)\)\) \{\s*
      const rawPrompt = prompt \|\| 'Describe this media clearly\.';\s*
      const answer = await askVision\(firstAttachment, buildPromptWithMemory\(rawPrompt, key\)\);\s*
      remember\(key, 'user', rawPrompt\);\s*
      remember\(key, 'assistant', answer\);\s*
      await sendLongMessageReply\(message, answer\);\s*
      return;\s*
    \}\s*

    const answer = await askChat\(prompt, \{ web: 'auto', memoryKey: key \}\);\s*
    remember\(key, 'user', prompt\);\s*
    remember\(key, 'assistant', answer\);\s*
    await sendLongMessageReply\(message, answer\);""",
    text,
)

new_block = r'''    const key = memoryKeyFrom(message);
    const naturalRoute = await seekdeepInferNaturalRoute(message, prompt);

    if (naturalRoute.route === 'vision' && naturalRoute.attachment) {
      const rawPrompt = naturalRoute.prompt || 'Describe this media clearly.';
      const answer = await askVision(naturalRoute.attachment, buildPromptWithMemory(rawPrompt, key));
      remember(key, 'user', rawPrompt);
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
    await sendLongMessageReply(message, answer);'''

if not old_block:
    raise SystemExit("Could not find old message routing block. Upload current index.js if this fails.")

text = text[:old_block.start()] + new_block + text[old_block.end():]
print("[SeekDeep] Replaced message routing block.")

path.write_text(text, encoding="utf-8")
print("[SeekDeep] Wrote index.js.")
