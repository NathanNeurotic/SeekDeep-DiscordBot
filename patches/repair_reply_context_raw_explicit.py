from pathlib import Path
import re
import sys

if len(sys.argv) != 2:
    raise SystemExit("Usage: repair_reply_context_raw_explicit.py <index.js>")

path = Path(sys.argv[1])
raw = path.read_bytes()
newline = "\r\n" if b"\r\n" in raw else "\n"
text = raw.decode("utf-8-sig").replace("\r\n", "\n").replace("\r", "\n")

def require_contains(haystack: str, needle: str, label: str):
    if needle not in haystack:
        raise SystemExit(f"Required anchor not found: {label}")

def replace_function_by_name(src: str, name: str, replacement: str) -> str:
    marker = f"function {name}("
    async_marker = f"async function {name}("
    start = src.find(marker)
    if start < 0:
        start = src.find(async_marker)
    if start < 0:
        raise SystemExit(f"Could not locate function {name}.")

    brace = src.find("{", start)
    if brace < 0:
        raise SystemExit(f"Could not locate opening brace for function {name}.")

    depth = 0
    i = brace
    in_str = None
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

        if in_str:
            if escape:
                escape = False
            elif ch == "\\":
                escape = True
            elif ch == in_str:
                in_str = None
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
            in_str = ch
            i += 1
            continue

        if ch == "{":
            depth += 1
        elif ch == "}":
            depth -= 1
            if depth == 0:
                return src[:start] + replacement.rstrip() + src[i + 1:]

        i += 1

    raise SystemExit(f"Could not locate closing brace for function {name}.")

for needle, label in [
    ("client.on('messageCreate'", "messageCreate handler"),
    ("async function seekdeepApplyReplyContextToPrompt", "reply-context function"),
    ("async function makeImageResult", "makeImageResult"),
    ("async function seekdeepSendImageWithButtonsMessage", "message image sender"),
    ("async function safeEditOrReply", "safeEditOrReply"),
    ("seekdeepEnqueueImageJob(job, runner)", "correct image queue contract"),
]:
    require_contains(text, needle, label)

if "seekdeepMakeImageQueueJobId" in text:
    raise SystemExit("Unsafe old queue helper found: seekdeepMakeImageQueueJobId")
if "job.run" in text:
    raise SystemExit("Unsafe job.run-style queue logic found")

# -------------------------------------------------------------------------
# 1. Reply-context logic: visual-only for generate; translate route metadata.
# -------------------------------------------------------------------------

reply_helpers = r"""
function seekdeepReplyTranslateRequested(prompt = '') {
  const p = normalizeUserText(prompt).toLowerCase().trim();
  return /^(?:translate|trans)\s+(?:this|that|it|the\s+reply|the\s+message)?\s*(?:to|into)?\s*(?:english|en)?\s*[.!?]*$/i.test(p) ||
    /^(?:what\s+does|what\s+did)\s+(?:this|that|it|the\s+reply|the\s+message)\s+(?:mean|say)(?:\s+in\s+english)?\s*[.!?]*$/i.test(p);
}

function seekdeepReplyContextLooksVisualPrompt(value = '') {
  let p = normalizeUserText(value)
    .replace(/<a?:[^>]+:\d+>/g, ' ')
    .replace(/https?:\/\/\S+/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  if (!p) return false;
  if (p.length > 220) return false;

  const lower = p.toLowerCase();

  if (/^(what|who|why|how|when|where|is|are|do|does|did|can|could|would|should)\b/.test(lower)) return false;
  if (/\b(translate|explain|tell me|summarize|summary|define|definition|search|look up|internet|web|code|script|powershell|table|spreadsheet|audit)\b/.test(lower)) return false;

  // Avoid turning pure profanity/reaction chatter into image prompts.
  const visualCue = /\b(spyro|ripto|predator|toad|mario|sonic|pepe|sailor\s*moon|homer|simpson|animal\s*crossing|nintendo|pokemon|zelda|batman|joker|cat|dog|dragon|monster|castle|tower|forest|album|poster|cover|logo|bag|bells|sword|armor|robot|alien|matrix|cyberpunk|gothic|character|creature|creatures?)\b/i.test(p);
  if (!visualCue) return false;

  try {
    if (typeof seekdeepLooksLikeShortNamedVisualSubject === 'function' && seekdeepLooksLikeShortNamedVisualSubject(p)) return true;
  } catch {}

  try {
    if (typeof seekdeepLooksLikeGroundableVisualSubject === 'function' && seekdeepLooksLikeGroundableVisualSubject(p)) return true;
  } catch {}

  try {
    if (typeof isNaturalImagePrompt === 'function' && isNaturalImagePrompt(p)) return true;
  } catch {}

  return visualCue && p.split(/\s+/).length <= 14;
}

"""

if "function seekdeepReplyTranslateRequested" not in text:
    pos = text.find("async function seekdeepApplyReplyContextToPrompt")
    if pos < 0:
        raise SystemExit("Could not locate seekdeepApplyReplyContextToPrompt for helper insertion.")
    text = text[:pos] + reply_helpers + "\n" + text[pos:]

new_apply = r"""async function seekdeepApplyReplyContextToPrompt(message, prompt = '') {
  const original = normalizeUserText(prompt || '');
  const replyText = await seekdeepResolveReplyContextText(message);

  if (!replyText) {
    return {
      prompt: original,
      usedReplyContext: false,
      replyContext: '',
      replyTranslateRequested: false,
    };
  }

  if (seekdeepReplyTranslateRequested(original)) {
    return {
      prompt: original,
      usedReplyContext: false,
      replyContext: replyText,
      replyTranslateRequested: true,
    };
  }

  const cleaned = seekdeepCleanReplyContextPrompt(original);
  const isGenerateOnly = seekdeepLooksLikeGenerateOnlyPrompt(original);
  const replyLooksVisual = seekdeepReplyContextLooksVisualPrompt(replyText);

  // Only consume replied text for image generation when the replied text itself looks visual.
  // This prevents "generate" replies to normal chat/profanity from becoming weird chat prompts.
  if ((isGenerateOnly || !cleaned) && replyLooksVisual) {
    return {
      prompt: replyText,
      usedReplyContext: true,
      replyContext: replyText,
      replyTranslateRequested: false,
    };
  }

  return {
    prompt: original,
    usedReplyContext: false,
    replyContext: replyText,
    replyTranslateRequested: false,
  };
}"""

text = replace_function_by_name(text, "seekdeepApplyReplyContextToPrompt", new_apply)

# Insert reply-translate route after key is available inside messageCreate.
if "SEEKDEEP_REPLY_TRANSLATE_ROUTE_START" not in text:
    anchor = "    const key = memoryKeyFrom(message);\n"
    pos = text.find(anchor, text.find("client.on('messageCreate'"))
    if pos < 0:
        raise SystemExit("Could not locate messageCreate key anchor for reply-translate route.")
    insert_at = pos + len(anchor)
    route = r"""
    // SEEKDEEP_REPLY_TRANSLATE_ROUTE_START
    if (seekdeepReplyPromptInfo?.replyTranslateRequested && seekdeepReplyPromptInfo.replyContext) {
      seekdeepLogRoute('reply-translate', prompt);
      const translatePrompt = [
        'Translate the following message to English.',
        'Return only the translation. Preserve slang/profanity plainly. Do not add commentary.',
        '',
        seekdeepReplyPromptInfo.replyContext,
      ].join('\n');

      const answer = await askChat(translatePrompt, {
        web: 'off',
        memoryKey: key,
        system: 'You are a direct translation engine. Translate to English only. No extra commentary.',
        maxNewTokens: 400,
        temperature: 0.1,
      });

      remember(key, 'user', `[reply-translate] ${prompt}`);
      remember(key, 'assistant', answer);
      seekdeepSetResponseModel(message, seekdeepChatModelLabel());
      await sendLongMessageReply(message, answer);
      return;
    }
    // SEEKDEEP_REPLY_TRANSLATE_ROUTE_END

"""
    text = text[:insert_at] + route + text[insert_at:]

# -------------------------------------------------------------------------
# 2. Raw mode pass-through and makeImage helper repair.
# -------------------------------------------------------------------------

# Fix broken makeImage helper that referenced seekdeepImageModeOptions outside scope.
text = text.replace(
    "async function makeImage(prompt, width = 1024, height = 1024, seed = null) {\n  const result = await makeImageResult(prompt, width, height, seed, seekdeepImageModeOptions);\n  return result.file;\n}",
    "async function makeImage(prompt, width = 1024, height = 1024, seed = null) {\n  const result = await makeImageResult(prompt, width, height, seed, {});\n  return result.file;\n}",
    1
)

# Pass seekdeepImageModeOptions into normal message image generation.
msg_sender_start = text.find("async function seekdeepSendImageWithButtonsMessage")
if msg_sender_start < 0:
    raise SystemExit("Could not locate seekdeepSendImageWithButtonsMessage.")
msg_sender_end = text.find("async function seekdeepSendImageWithButtonsInteraction", msg_sender_start)
if msg_sender_end < 0:
    msg_sender_end = msg_sender_start + 12000
msg_sender = text[msg_sender_start:msg_sender_end]
old_call = "const result = await makeImageResult(prompt, width, height, seed);"
new_call = "const result = await makeImageResult(prompt, width, height, seed, seekdeepImageModeOptions);"
if old_call in msg_sender:
    msg_sender = msg_sender.replace(old_call, new_call, 1)
elif new_call not in msg_sender:
    raise SystemExit("Could not locate makeImageResult call in message image sender.")
text = text[:msg_sender_start] + msg_sender + text[msg_sender_end:]

# Add interaction-side default image options and status display, but keep it conservative.
if "SEEKDEEP_INTERACTION_IMAGE_MODE_OPTIONS_START" not in text:
    inter_start = text.find("async function seekdeepSendImageWithButtonsInteraction")
    inter_end = text.find("// SEEKDEEP_TEXT_REGENERATE_START", inter_start)
    if inter_start >= 0 and inter_end >= 0:
        inter = text[inter_start:inter_end]
        anchor = "  const requestStartedAt = interaction?.__seekdeepRequestStartedAt || seekdeepNowMs();\n"
        if anchor in inter:
            inter = inter.replace(anchor, anchor + "\n  // SEEKDEEP_INTERACTION_IMAGE_MODE_OPTIONS_START\n  const seekdeepImageModeOptions = seekdeepImageModeOptionsFromPrompt(prompt);\n  prompt = seekdeepImageModeOptions.cleanPrompt || prompt;\n  // SEEKDEEP_INTERACTION_IMAGE_MODE_OPTIONS_END\n", 1)
        inter = inter.replace(old_call, new_call, 1)
        if "seekdeepRefinementStatusLine(result?.refinementEnabled !== false)" not in inter:
            inter = inter.replace(
                "        `Queue Wait: ${seekdeepImageQueueWaitSeconds(runningJob)} seconds`,",
                "        seekdeepGroundingStatusLine(result?.grounding, result?.imageOptions),\n        seekdeepRefinementStatusLine(result?.refinementEnabled !== false),\n        `Queue Wait: ${seekdeepImageQueueWaitSeconds(runningJob)} seconds`,",
                1
            )
        text = text[:inter_start] + inter + text[inter_end:]

# -------------------------------------------------------------------------
# 3. Discord explicit-media block handling.
# -------------------------------------------------------------------------

explicit_helpers = r"""
function seekdeepIsDiscordExplicitContentBlock(err) {
  const code = Number(err?.code || err?.rawError?.code || 0);
  const message = String(err?.message || err?.rawError?.message || err || '').toLowerCase();
  return code === 20009 || message.includes('explicit content cannot be sent');
}

function seekdeepExplicitContentBlockedText() {
  return [
    'Discord blocked the generated image attachment for this recipient/channel.',
    'Generation completed locally, but I cannot send that image here because of Discord explicit-media filtering.',
  ].join('\n');
}

"""

if "function seekdeepIsDiscordExplicitContentBlock" not in text:
    pos = text.find("async function safeEditOrReply")
    if pos < 0:
        raise SystemExit("Could not locate safeEditOrReply for explicit helper insertion.")
    text = text[:pos] + explicit_helpers + "\n" + text[pos:]

# Patch safeEditOrReply catch to retry without files/components on explicit-media block.
if "SEEKDEEP_EXPLICIT_CONTENT_INTERACTION_FALLBACK_START" not in text:
    old = """  } catch (err) {
    if (seekdeepIsDiscordAbortError(err)) {
      seekdeepLogDiscordAbort('Could not send interaction response', err);
    } else {
      console.error('Could not send interaction response:', err);
    }
    return null;
  }
}"""
    new = """  } catch (err) {
    // SEEKDEEP_EXPLICIT_CONTENT_INTERACTION_FALLBACK_START
    if (seekdeepIsDiscordExplicitContentBlock(err)) {
      console.warn('Discord blocked generated image attachment for this interaction; sending text-only notice.');

      const fallbackPayload = {
        content: seekdeepExplicitContentBlockedText(),
        allowedMentions: { repliedUser: false },
        files: [],
        attachments: [],
        components: [],
      };

      try {
        if (interaction?.deferred || interaction?.replied) {
          return await interaction.editReply(fallbackPayload);
        }
        return await interaction.reply(fallbackPayload);
      } catch (fallbackErr) {
        console.error('Could not send explicit-content fallback interaction response:', fallbackErr);
        return null;
      }
    }
    // SEEKDEEP_EXPLICIT_CONTENT_INTERACTION_FALLBACK_END

    if (seekdeepIsDiscordAbortError(err)) {
      seekdeepLogDiscordAbort('Could not send interaction response', err);
    } else {
      console.error('Could not send interaction response:', err);
    }
    return null;
  }
}"""
    if old not in text:
        raise SystemExit("Could not patch safeEditOrReply catch block.")
    text = text.replace(old, new, 1)

# Patch message image send catch so 20009 does not retry the same blocked attachment forever.
if "SEEKDEEP_EXPLICIT_CONTENT_MESSAGE_FALLBACK_START" not in text:
    msg_sender_start = text.find("async function seekdeepSendImageWithButtonsMessage")
    msg_sender_end = text.find("async function seekdeepSendImageWithButtonsInteraction", msg_sender_start)
    msg_sender = text[msg_sender_start:msg_sender_end]

    old = """      } catch (err) {
        console.warn('Image result reply failed; falling back to channel.send:', err?.message || err);

        if (message?.channel && typeof message.channel.send === 'function') {
          sent = await message.channel.send({
            content,
            files: [normalized.attachment],
            components: [seekdeepImageActionRow(actionId)],
            allowedMentions: { repliedUser: false },
          });
        } else {
          throw err;
        }
      }"""
    new = """      } catch (err) {
        // SEEKDEEP_EXPLICIT_CONTENT_MESSAGE_FALLBACK_START
        if (seekdeepIsDiscordExplicitContentBlock(err)) {
          console.warn('Discord blocked generated image attachment for this message; sending text-only notice.');

          try {
            sent = await message.reply({
              content: seekdeepAppendResponseFooter(seekdeepExplicitContentBlockedText(), {
                startedAt: runningJob.startedAt,
                modelUsed: seekdeepImageModelLabel(),
              }),
              allowedMentions: { repliedUser: false },
            });
          } catch (fallbackErr) {
            console.warn('Could not send explicit-content fallback reply:', fallbackErr?.message || fallbackErr);
          }

          return sent;
        }
        // SEEKDEEP_EXPLICIT_CONTENT_MESSAGE_FALLBACK_END

        console.warn('Image result reply failed; falling back to channel.send:', err?.message || err);

        if (message?.channel && typeof message.channel.send === 'function') {
          sent = await message.channel.send({
            content,
            files: [normalized.attachment],
            components: [seekdeepImageActionRow(actionId)],
            allowedMentions: { repliedUser: false },
          });
        } else {
          throw err;
        }
      }"""
    if old not in msg_sender:
        raise SystemExit("Could not patch message image explicit-content catch block.")
    msg_sender = msg_sender.replace(old, new, 1)
    text = text[:msg_sender_start] + msg_sender + text[msg_sender_end:]

# Validate.
for needle, label in [
    ("function seekdeepReplyTranslateRequested", "reply translate detector"),
    ("function seekdeepReplyContextLooksVisualPrompt", "reply visual detector"),
    ("replyTranslateRequested: true", "reply translate metadata"),
    ("SEEKDEEP_REPLY_TRANSLATE_ROUTE_START", "reply translate route"),
    ("makeImageResult(prompt, width, height, seed, seekdeepImageModeOptions)", "raw mode options pass-through"),
    ("async function makeImage(prompt, width = 1024, height = 1024, seed = null) {\n  const result = await makeImageResult(prompt, width, height, seed, {});", "makeImage helper repair"),
    ("function seekdeepIsDiscordExplicitContentBlock", "explicit block detector"),
    ("SEEKDEEP_EXPLICIT_CONTENT_INTERACTION_FALLBACK_START", "interaction explicit fallback"),
    ("SEEKDEEP_EXPLICIT_CONTENT_MESSAGE_FALLBACK_START", "message explicit fallback"),
    ("seekdeepEnqueueImageJob(job, runner)", "queue contract preserved"),
]:
    require_contains(text, needle, label)

out = text if newline == "\n" else text.replace("\n", "\r\n")
path.write_bytes(out.encode("utf-8"))
print("Patched reply-context, raw pass-through, reply translation, and explicit-media block handling.")