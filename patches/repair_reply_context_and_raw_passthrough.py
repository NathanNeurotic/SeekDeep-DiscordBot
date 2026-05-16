from pathlib import Path
import re
import sys

if len(sys.argv) != 2:
    raise SystemExit("Usage: repair_reply_context_and_raw_passthrough.py <index.js>")

path = Path(sys.argv[1])
raw = path.read_bytes()
newline = "\r\n" if b"\r\n" in raw else "\n"
text = raw.decode("utf-8-sig").replace("\r\n", "\n").replace("\r", "\n")


def require_contains(haystack: str, needle: str, label: str):
    if needle not in haystack:
        raise SystemExit(f"Required anchor not found: {label}")

for needle, label in [
    ("async function seekdeepApplyReplyContextToPrompt", "reply context function"),
    ("async function seekdeepSendImageWithButtonsMessage", "image send function"),
    ("async function makeImageResult", "makeImageResult"),
    ("seekdeepEnqueueImageJob(job, runner)", "correct image queue contract"),
]:
    require_contains(text, needle, label)

if "seekdeepMakeImageQueueJobId" in text:
    raise SystemExit("Unsafe old queue helper found: seekdeepMakeImageQueueJobId")
if "job.run" in text:
    raise SystemExit("Unsafe job.run-style queue logic found")

# 1) Fix raw/unrefined pass-through for normal message image generation.
old_call = "const result = await makeImageResult(prompt, width, height, seed);"
new_call = "const result = await makeImageResult(prompt, width, height, seed, seekdeepImageModeOptions);"
if old_call in text:
    text = text.replace(old_call, new_call, 1)
elif new_call not in text:
    raise SystemExit("Could not locate or verify makeImageResult options pass-through call.")

# 2) Replace seekdeepApplyReplyContextToPrompt with safer version and helper functions.
start = text.find("async function seekdeepApplyReplyContextToPrompt")
if start < 0:
    raise SystemExit("Could not locate seekdeepApplyReplyContextToPrompt.")
end_marker = "\n// SEEKDEEP_REPLY_CONTEXT_IMAGE_PROMPT_END"
end = text.find(end_marker, start)
if end < 0:
    raise SystemExit("Could not locate end of reply context block.")

replacement = r'''function seekdeepLooksLikeReplyVisualPrompt(replyText = '') {
  const p = normalizeUserText(replyText).trim();
  if (!p) return false;

  // Do not treat obvious text/research/translation content as an image prompt.
  if (typeof seekdeepShouldKeepPromptAsChatBeforeImage === 'function' && seekdeepShouldKeepPromptAsChatBeforeImage(p)) return false;
  if (/\b(translate|translation|what does this mean|explain|why|how|when|where|who|what|search|internet|web|table|code|script|powershell)\b/i.test(p)) return false;

  // Use current image route detectors when available.
  if (typeof seekdeepLooksLikeShortNamedVisualSubject === 'function' && seekdeepLooksLikeShortNamedVisualSubject(p)) return true;
  if (typeof seekdeepLooksLikeGroundableVisualSubject === 'function' && seekdeepLooksLikeGroundableVisualSubject(p)) return true;
  if (typeof seekdeepLooksLikeVisualRequest === 'function' && seekdeepLooksLikeVisualRequest(p)) return true;
  if (typeof isNaturalImagePrompt === 'function' && isNaturalImagePrompt(p)) return true;

  return false;
}

function seekdeepIsReplyTranslationRequest(prompt = '') {
  const p = normalizeUserText(prompt).toLowerCase().trim();
  return /^(translate|translation)\b/.test(p) || /\btranslate\s+(this|that|it|message|reply)\s+(to|into)\s+english\b/.test(p) || /^what\s+does\s+this\s+say\s+in\s+english\b/.test(p);
}

async function seekdeepApplyReplyContextToPrompt(message, prompt = '') {
  const original = normalizeUserText(prompt || '');
  const replyText = await seekdeepResolveReplyContextText(message);
  if (!replyText) {
    return {
      prompt: original,
      usedReplyContext: false,
      replyContext: ''
    };
  }

  const cleaned = seekdeepCleanReplyContextPrompt(original);
  const isGenerateOnly = seekdeepLooksLikeGenerateOnlyPrompt(original);
  const replyLooksVisual = seekdeepLooksLikeReplyVisualPrompt(replyText);

  // Only replace the prompt with replied text for image-style trigger messages
  // when the replied message itself looks like a visual prompt.
  if ((isGenerateOnly || !cleaned) && replyLooksVisual) {
    return {
      prompt: replyText,
      usedReplyContext: true,
      replyContext: replyText,
      replyContextMode: 'image'
    };
  }

  // Keep the user's actual command. Other reply-aware workflows, like translation,
  // can consume replyContext explicitly without hijacking prompt routing.
  return {
    prompt: original,
    usedReplyContext: false,
    replyContext: replyText,
    replyContextMode: 'available'
  };
}
'''

text = text[:start] + replacement + text[end:]

# 3) Add explicit reply-translation route before image routing / chat fallback.
if "SEEKDEEP_REPLY_TRANSLATION_ROUTE_START" not in text:
    anchor = "    // SEEKDEEP_RAW_IMAGE_MESSAGE_ROUTE_START\n"
    pos = text.find(anchor)
    if pos < 0:
        raise SystemExit("Could not locate image route anchor for reply translation insertion.")
    block = r'''    // SEEKDEEP_REPLY_TRANSLATION_ROUTE_START
    if (seekdeepReplyPromptInfo?.replyContext && seekdeepIsReplyTranslationRequest(prompt)) {
      seekdeepLogRoute('reply-translate', prompt);
      const translationPrompt = [
        'Translate the following message to English.',
        'Return only the translation unless a note is necessary for slang or profanity.',
        '',
        seekdeepReplyPromptInfo.replyContext,
      ].join('\n');
      const answer = await askChat(translationPrompt, {
        web: 'off',
        memoryKey: key,
        temperature: 0.1,
        maxNewTokens: 500,
      });
      remember(key, 'user', `[reply-translate] ${prompt}\n${seekdeepReplyPromptInfo.replyContext}`);
      remember(key, 'assistant', answer);
      seekdeepSetResponseModel(message, seekdeepChatModelLabel());
      await sendLongMessageReply(message, answer);
      return;
    }
    // SEEKDEEP_REPLY_TRANSLATION_ROUTE_END

'''
    text = text[:pos] + block + text[pos:]

# 4) Make logging less misleading: only says image prompt when used for image.
old_log = "console.log(`[SeekDeep] reply-context image prompt:\\n  reply: ${seekdeepReplyPromptInfo.replyContext}\\n  final: ${prompt}`);"
new_log = "console.log(`[SeekDeep] reply-context prompt used (${seekdeepReplyPromptInfo.replyContextMode || 'context'}):\\n  reply: ${seekdeepReplyPromptInfo.replyContext}\\n  final: ${prompt}`);"
if old_log in text:
    text = text.replace(old_log, new_log, 1)

for needle, label in [
    ("makeImageResult(prompt, width, height, seed, seekdeepImageModeOptions)", "raw options pass-through"),
    ("function seekdeepLooksLikeReplyVisualPrompt", "reply visual guard"),
    ("function seekdeepIsReplyTranslationRequest", "reply translation detector"),
    ("replyLooksVisual", "reply context gated by visual detection"),
    ("SEEKDEEP_REPLY_TRANSLATION_ROUTE_START", "reply translation route"),
    ("seekdeepEnqueueImageJob(job, runner)", "queue contract preserved"),
]:
    require_contains(text, needle, label)

out = text if newline == "\n" else text.replace("\n", "\r\n")
path.write_bytes(out.encode("utf-8"))
print("Repaired reply-context routing and raw image option pass-through.")