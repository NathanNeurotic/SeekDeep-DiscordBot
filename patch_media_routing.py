from pathlib import Path

p = Path("index.js")
text = p.read_text(encoding="utf-8")

helper = r'''
// SEEKDEEP_MEDIA_ROUTING_HELPERS
function isNaturalImageRequest(prompt) {
  const p = normalizeUserText(prompt).toLowerCase().trim();

  return (
    /^generate\s+(me\s+)?(an?\s+)?(image|picture|pic|photo|art|artwork|illustration|drawing|render)\b/.test(p) ||
    /^make\s+(me\s+)?(an?\s+)?(image|picture|pic|photo|art|artwork|illustration|drawing|render)\b/.test(p) ||
    /^create\s+(me\s+)?(an?\s+)?(image|picture|pic|photo|art|artwork|illustration|drawing|render)\b/.test(p) ||
    /^draw\s+/.test(p) ||
    /^render\s+/.test(p)
  );
}

function stripNaturalImageRequestPrefix(prompt) {
  let p = normalizeUserText(prompt);

  p = p.replace(/^generate\s+(me\s+)?(an?\s+)?(image|picture|pic|photo|art|artwork|illustration|drawing|render)\s+(of\s+)?/i, '');
  p = p.replace(/^make\s+(me\s+)?(an?\s+)?(image|picture|pic|photo|art|artwork|illustration|drawing|render)\s+(of\s+)?/i, '');
  p = p.replace(/^create\s+(me\s+)?(an?\s+)?(image|picture|pic|photo|art|artwork|illustration|drawing|render)\s+(of\s+)?/i, '');
  p = p.replace(/^draw\s+(me\s+)?/i, '');
  p = p.replace(/^render\s+(me\s+)?/i, '');

  return p.trim() || normalizeUserText(prompt);
}

function isNaturalVisionRequest(prompt) {
  const p = normalizeUserText(prompt).toLowerCase().trim();

  return (
    /^vision\b/.test(p) ||
    /^describe\s+(this|the)\b/.test(p) ||
    /^analy[sz]e\s+(this|the)\b/.test(p) ||
    /^look\s+at\s+(this|the)\b/.test(p) ||
    /^what\s+is\s+(this|that)\b/.test(p) ||
    /^what'?s\s+(this|that)\b/.test(p) ||
    /^what\s+am\s+i\s+looking\s+at\b/.test(p) ||
    /^what\s+is\s+in\s+(this|the)\b/.test(p) ||
    /^what'?s\s+in\s+(this|the)\b/.test(p) ||
    /^identify\s+(this|the)\b/.test(p) ||
    /^read\s+(this|the)\b/.test(p) ||
    /^ocr\b/.test(p)
  );
}

function isMediaAttachment(attachment) {
  if (!attachment) return false;

  const type = String(attachment.contentType || '').toLowerCase();
  const name = String(attachment.name || '').toLowerCase();
  const url = String(attachment.url || '').toLowerCase();

  if (type.startsWith('image/') || type.startsWith('video/')) return true;

  return /\.(png|jpe?g|webp|gif|bmp|avif|mp4|mov|webm|mkv)(\?|$)/i.test(name) ||
         /\.(png|jpe?g|webp|gif|bmp|avif|mp4|mov|webm|mkv)(\?|$)/i.test(url);
}

function firstMediaAttachment(msg) {
  if (!msg || !msg.attachments) return null;

  for (const attachment of msg.attachments.values()) {
    if (isMediaAttachment(attachment)) return attachment;
  }

  return null;
}

async function findVisionAttachment(message) {
  const direct = firstMediaAttachment(message);
  if (direct) return direct;

  if (message?.reference?.messageId && typeof message.fetchReference === 'function') {
    try {
      const referenced = await message.fetchReference();
      return firstMediaAttachment(referenced);
    } catch (err) {
      console.warn('Could not fetch referenced message:', err?.message || err);
    }
  }

  return null;
}
'''

if "SEEKDEEP_MEDIA_ROUTING_HELPERS" not in text:
    anchor = "client.on('messageCreate', async (message) => {"
    if anchor not in text:
        raise SystemExit("Could not find messageCreate handler.")
    text = text.replace(anchor, helper + "\n\n" + anchor, 1)

route = r'''
    // SEEKDEEP_MEDIA_ROUTING_ROUTE
    if (prompt && isNaturalImageRequest(prompt)) {
      const imagePrompt = stripNaturalImageRequestPrefix(prompt);
      const file = await makeImage(imagePrompt, 1024, 1024, null);

      remember(key, 'user', prompt);
      remember(key, 'assistant', `Generated image locally for: ${imagePrompt}`);

      stopSeekDeepTypingLoopForMessage(message);

      try {
        await message.reply({
          content: `Generated locally: ${imagePrompt}`,
          files: [file],
          allowedMentions: { repliedUser: false },
        });
      } catch (err) {
        await message.channel.send({
          content: `Generated locally: ${imagePrompt}`,
          files: [file],
          allowedMentions: { repliedUser: false },
        });
      }

      return;
    }

    const visionAttachment = await findVisionAttachment(message);

    if (visionAttachment && (isNaturalVisionRequest(prompt) || message.attachments.size > 0)) {
      const visionPrompt = prompt || 'Describe this media clearly.';
      const answer = await askVision(visionAttachment, buildPromptWithMemory(visionPrompt, key));

      remember(key, 'user', visionPrompt);
      remember(key, 'assistant', answer);

      await sendLongMessageReply(message, answer);
      return;
    }

    if (isNaturalVisionRequest(prompt) && !visionAttachment) {
      await sendLongMessageReply(
        message,
        'I need an image/video attachment, or reply to an image/video message and ping me with the question.'
      );
      return;
    }

'''

if "SEEKDEEP_MEDIA_ROUTING_ROUTE" not in text:
    marker = "    const answer = await askChat(prompt, { web: 'auto', memoryKey: key });"
    if marker not in text:
        raise SystemExit("Could not find askChat fallback marker.")
    text = text.replace(marker, route + marker, 1)

p.write_text(text, encoding="utf-8")
print("Natural image + vision routing patch applied.")
