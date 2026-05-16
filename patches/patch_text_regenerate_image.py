from pathlib import Path
import sys

if len(sys.argv) != 2:
    raise SystemExit("Usage: patch_text_regenerate.py <index.js>")

path = Path(sys.argv[1])
raw = path.read_bytes()
newline = "\r\n" if b"\r\n" in raw else "\n"
text = raw.decode("utf-8-sig")
text = text.replace("\r\n", "\n").replace("\r", "\n")

def require_contains(haystack, needle, label):
    if needle not in haystack:
        raise SystemExit(f"Required anchor not found: {label}")

def replace_once(haystack, old, new, label):
    count = haystack.count(old)
    if count != 1:
        raise SystemExit(f"Expected exactly one anchor for {label}, found {count}.")
    return haystack.replace(old, new, 1)

require_contains(text, "SEEKDEEP_STABILIZED_DISPATCH_HELPERS_START", "stabilized dispatcher marker")
require_contains(text, "function seekdeepEnqueueImageJob(job, runner)", "correct image queue contract")
if "seekdeepMakeImageQueueJobId" in text:
    raise SystemExit("Unsafe old queue helper found: seekdeepMakeImageQueueJobId")
if "job.run" in text:
    raise SystemExit("Unsafe job.run-style queue logic found")

helper_block = r"""
// SEEKDEEP_TEXT_REGENERATE_START
function seekdeepIsTextRegenerateImagePrompt(prompt = '') {
  const p = normalizeUserText(prompt).toLowerCase().trim();

  if (!p) return false;

  return /^(?:regenerate|regen|reroll|redo)$/i.test(p) ||
    /^(?:regenerate|regen|reroll|redo)\s+(?:the\s+)?(?:last\s+)?(?:image|picture|pic|generation|generated\s+image|one|that|this)\b/i.test(p);
}

function seekdeepLatestTempImageStateForRegenerate() {
  try {
    if (typeof seekdeepSweepExpiredImageCache === 'function') {
      seekdeepSweepExpiredImageCache();
    }
  } catch (err) {
    console.warn('Could not sweep image cache before text regenerate:', err?.message || err);
  }

  const now = Date.now();
  const candidates = [];
  const seen = new Set();

  try {
    if (typeof seekdeepTempImageStateIndex !== 'undefined' && seekdeepTempImageStateIndex?.entries) {
      for (const [id, state] of seekdeepTempImageStateIndex.entries()) {
        const key = String(id || state?.id || '').trim();
        if (!key || seen.has(key)) continue;
        if (Number(state?.expiresAt || 0) && Number(state.expiresAt || 0) <= now) continue;
        if (!String(state?.prompt || '').trim()) continue;
        seen.add(key);
        candidates.push({ id: key, createdAt: Number(state?.createdAt || 0) || 0 });
      }
    }
  } catch (err) {
    console.warn('Could not inspect live image cache before text regenerate:', err?.message || err);
  }

  try {
    if (typeof seekdeepReadTempImageCacheMetadata === 'function') {
      for (const meta of seekdeepReadTempImageCacheMetadata()) {
        const key = String(meta?.id || '').trim();
        if (!key || seen.has(key)) continue;
        if (Number(meta?.expiresAt || 0) && Number(meta.expiresAt || 0) <= now) continue;
        if (!String(meta?.prompt || '').trim()) continue;
        seen.add(key);
        candidates.push({ id: key, createdAt: Number(meta?.createdAt || meta?.__stat?.mtimeMs || 0) || 0 });
      }
    }
  } catch (err) {
    console.warn('Could not inspect disk image cache before text regenerate:', err?.message || err);
  }

  candidates.sort((a, b) => Number(b.createdAt || 0) - Number(a.createdAt || 0));

  for (const candidate of candidates) {
    try {
      const state = seekdeepLoadTempImageState(candidate.id);
      if (state && String(state.prompt || '').trim()) return state;
    } catch (err) {
      console.warn(`Could not load cached image state for text regenerate (${candidate.id}):`, err?.message || err);
    }
  }

  return null;
}

async function seekdeepRegenerateLatestImageFromMessage(message) {
  const requestStartedAt = message?.__seekdeepRequestStartedAt || seekdeepNowMs();
  const state = seekdeepLatestTempImageStateForRegenerate();

  if (!state) {
    seekdeepSetResponseModel(message, seekdeepNoModelLabel());
    stopSeekDeepTypingLoopForMessage(message);
    return await message.reply({
      content: seekdeepAppendResponseFooter('No recent cached image was found to regenerate. Generate a new image first, then use `regenerate`.', {
        startedAt: requestStartedAt,
        modelUsed: seekdeepNoModelLabel(),
      }),
      allowedMentions: { repliedUser: false },
    });
  }

  const prompt = String(state.prompt || '').trim();
  const width = Number(state.width || 1024) || 1024;
  const height = Number(state.height || 1024) || 1024;
  const seed = state.seed ?? null;
  const userId = message?.author?.id || 'unknown';
  const workingLoop = seekdeepStartWorkingLoop(message?.channel, `regen-message:${message?.id || state.id || prompt}`);
  const position = seekdeepImageQueueCurrentPosition();
  const job = seekdeepCreateImageQueueJob({
    source: 'message-regenerate',
    userId,
    channelId: message?.channel?.id || '',
    prompt,
    width,
    height,
    seed,
  });

  await message.reply({
    content: seekdeepAppendResponseFooter(seekdeepImageQueueAckText(job, position), {
      startedAt: job.enqueuedAt || requestStartedAt,
      modelUsed: seekdeepNoModelLabel(),
    }),
    allowedMentions: { repliedUser: false },
  });

  return await seekdeepEnqueueImageJob(job, async (runningJob) => {
    try {
      const result = await makeImageResult(prompt, width, height, seed);
      const normalized = seekdeepNormalizeGeneratedImageResult(result);
      const newActionId = seekdeepMakeImageActionId();

      const newState = seekdeepRememberTempImageState({
        id: newActionId,
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

      const content = seekdeepAppendResponseFooter([
        `Regenerated locally: ${prompt}`,
        `Queue Wait: ${seekdeepImageQueueWaitSeconds(runningJob)} seconds`,
        `Job ID: ${runningJob.id}`,
      ].join('\n'), {
        startedAt: runningJob.startedAt,
        modelUsed: seekdeepImageModelLabel(),
      });

      let sent = null;

      try {
        sent = await message.reply({
          content,
          files: [normalized.attachment],
          components: [seekdeepImageActionRow(newState.id)],
          allowedMentions: { repliedUser: false },
        });
      } catch (err) {
        console.warn('Text regenerate result reply failed; falling back to channel.send:', err?.message || err);

        if (message?.channel && typeof message.channel.send === 'function') {
          sent = await message.channel.send({
            content,
            files: [normalized.attachment],
            components: [seekdeepImageActionRow(newState.id)],
            allowedMentions: { repliedUser: false },
          });
        } else {
          throw err;
        }
      }

      try {
        sent = await seekdeepAttachDownloadButton(sent, newState.id);
      } catch (err) {
        console.warn('Could not attach Download button after text regenerate:', err?.message || err);
      }

      return sent;
    } finally {
      seekdeepStopWorkingLoop(workingLoop);
      stopSeekDeepTypingLoopForMessage(message);
    }
  });
}
// SEEKDEEP_TEXT_REGENERATE_END
"""

if "SEEKDEEP_TEXT_REGENERATE_START" not in text:
    anchor = "async function seekdeepHandleImageButton(interaction) {"
    require_contains(text, anchor, "image button handler insertion point")
    text = text.replace(anchor, helper_block + "\n" + anchor, 1)

if "return 'regenerate-image'" not in text:
    old = "  if (/^(recent prompts|recent prompt|prompt history|last prompts|last prompt)\\b/.test(p)) return 'recent-prompts';\n  if (/^(admin status|am i admin)\\b/.test(p)) return 'admin';"
    new = "  if (/^(recent prompts|recent prompt|prompt history|last prompts|last prompt)\\b/.test(p)) return 'recent-prompts';\n  if (typeof seekdeepIsTextRegenerateImagePrompt === 'function' && seekdeepIsTextRegenerateImagePrompt(p)) return 'regenerate-image';\n  if (/^(admin status|am i admin)\\b/.test(p)) return 'admin';"
    text = replace_once(text, old, new, "seekdeepUtilityPromptKind regenerate route")

dedupe_start = text.find("function seekdeepIsPromptDedupeExempt")
dedupe_end = text.find("// SEEKDEEP_HARD_COMMAND_DEDUPE_EXEMPT_END", dedupe_start)
if dedupe_start < 0 or dedupe_end < 0:
    raise SystemExit("Could not locate hard-command dedupe exemption block.")

dedupe_block = text[dedupe_start:dedupe_end]
if "reroll|redo" not in dedupe_block:
    old = "    /^recent\\s+(?:images|image|prompts|prompt)\\b/.test(p) ||\n    /^admin\\s+status\\b/.test(p) ||"
    new = "    /^recent\\s+(?:images|image|prompts|prompt)\\b/.test(p) ||\n    /^(?:regenerate|regen|reroll|redo)(?:\\s+(?:the\\s+)?(?:last\\s+)?(?:image|picture|pic|generation|one|that|this))?\\b/.test(p) ||\n    /^admin\\s+status\\b/.test(p) ||"
    text = replace_once(text, old, new, "hard-command dedupe regenerate exemption")

if "Text: @SEEKOTICS regenerate / regen" not in text:
    old = "    'Buttons: Regenerate / Download / Archive',\n"
    new = "    'Buttons: Regenerate / Download / Archive',\n    'Text: @SEEKOTICS regenerate / regen',\n"
    text = replace_once(text, old, new, "help text regenerate line")

if "utilityKind === 'regenerate-image'" not in text:
    old = """    if (utilityKind === 'post-archive') {
      seekdeepLogRoute('post-archive', prompt);
      remember(key, 'user', prompt);
      remember(key, 'assistant', 'Posting archive.');
      await seekdeepPostArchiveFromMessage(message);
      return;
    }

    if (utilityKind) {"""
    new = """    if (utilityKind === 'post-archive') {
      seekdeepLogRoute('post-archive', prompt);
      remember(key, 'user', prompt);
      remember(key, 'assistant', 'Posting archive.');
      await seekdeepPostArchiveFromMessage(message);
      return;
    }

    if (utilityKind === 'regenerate-image') {
      seekdeepLogRoute('regenerate-image', prompt);
      remember(key, 'user', prompt);
      remember(key, 'assistant', 'Regenerating latest cached image.');
      await seekdeepRegenerateLatestImageFromMessage(message);
      return;
    }

    if (utilityKind) {"""
    text = replace_once(text, old, new, "dispatcher regenerate branch")

for needle, label in [
    ("SEEKDEEP_TEXT_REGENERATE_START", "text regenerate helper block"),
    ("function seekdeepIsTextRegenerateImagePrompt", "text regenerate detector"),
    ("function seekdeepLatestTempImageStateForRegenerate", "latest temp image resolver"),
    ("async function seekdeepRegenerateLatestImageFromMessage", "message regenerate runner"),
    ("return 'regenerate-image'", "utility regenerate kind"),
    ("seekdeepLogRoute('regenerate-image', prompt);", "dispatcher regenerate route log"),
    ("await seekdeepRegenerateLatestImageFromMessage(message);", "dispatcher regenerate call"),
    ("function seekdeepEnqueueImageJob(job, runner)", "correct image queue contract"),
]:
    require_contains(text, needle, label)

post = text.find("utilityKind === 'post-archive'")
regen = text.find("utilityKind === 'regenerate-image'")
generic = text.find("if (utilityKind) {", regen)
chat = text.find("seekdeepLogRoute('chat', prompt);", regen)
if not (post >= 0 and regen > post and generic > regen and chat > generic):
    raise SystemExit("Dispatcher order is unsafe. Expected post-archive -> regenerate-image -> generic utility -> chat.")

if "seekdeepMakeImageQueueJobId" in text:
    raise SystemExit("Unsafe old queue helper found after patch: seekdeepMakeImageQueueJobId")
if "job.run" in text:
    raise SystemExit("Unsafe job.run-style queue logic found after patch")

out = text if newline == "\n" else text.replace("\n", "\r\n")
path.write_bytes(out.encode("utf-8"))
print("Patched index.js with text regenerate route.")