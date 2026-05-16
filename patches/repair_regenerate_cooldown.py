from pathlib import Path
import re
import sys

if len(sys.argv) != 2:
    raise SystemExit("Usage: repair_regenerate_cooldown.py <index.js>")

path = Path(sys.argv[1])
raw = path.read_bytes()
newline = "\r\n" if b"\r\n" in raw else "\n"
text = raw.decode("utf-8-sig")
text = text.replace("\r\n", "\n").replace("\r", "\n")

def require_contains(haystack, needle, label):
    if needle not in haystack:
        raise SystemExit(f"Required anchor not found: {label}")

def find_matching_brace(src, open_index):
    depth = 0
    i = open_index
    in_single = in_double = in_template = False
    in_line_comment = in_block_comment = False
    escape = False

    while i < len(src):
        c = src[i]
        n = src[i + 1] if i + 1 < len(src) else ''

        if in_line_comment:
            if c in '\r\n':
                in_line_comment = False
            i += 1
            continue

        if in_block_comment:
            if c == '*' and n == '/':
                in_block_comment = False
                i += 2
                continue
            i += 1
            continue

        if in_single:
            if escape:
                escape = False
            elif c == '\\':
                escape = True
            elif c == "'":
                in_single = False
            i += 1
            continue

        if in_double:
            if escape:
                escape = False
            elif c == '\\':
                escape = True
            elif c == '"':
                in_double = False
            i += 1
            continue

        if in_template:
            if escape:
                escape = False
            elif c == '\\':
                escape = True
            elif c == '`':
                in_template = False
            i += 1
            continue

        if c == '/' and n == '/':
            in_line_comment = True
            i += 2
            continue

        if c == '/' and n == '*':
            in_block_comment = True
            i += 2
            continue

        if c == "'":
            in_single = True
            i += 1
            continue

        if c == '"':
            in_double = True
            i += 1
            continue

        if c == '`':
            in_template = True
            i += 1
            continue

        if c == '{':
            depth += 1
        elif c == '}':
            depth -= 1
            if depth == 0:
                return i

        i += 1

    raise SystemExit("Could not find matching closing brace.")

def find_function_block(src, function_name):
    m = re.search(r'(?:async\s+)?function\s+' + re.escape(function_name) + r'\s*\(', src)
    if not m:
        return None

    open_brace = src.find('{', m.end())
    if open_brace < 0:
        return None

    close_brace = find_matching_brace(src, open_brace)
    return m.start(), open_brace, close_brace, src[m.start():close_brace + 1]

require_contains(text, "const SEEKDEEP_IMAGE_COOLDOWN_MS", "existing cooldown duration")
require_contains(text, "function seekdeepImageCooldownRemaining", "existing cooldown remaining helper")
require_contains(text, "function seekdeepEnqueueImageJob(job, runner)", "correct queue contract")

if "seekdeepMakeImageQueueJobId" in text:
    raise SystemExit("Unsafe old queue helper found: seekdeepMakeImageQueueJobId")
if "job.run" in text:
    raise SystemExit("Unsafe job.run-style queue logic found")

# Ensure we have a safe cooldown notice sender available.
notice_helper = r"""
// SEEKDEEP_REGENERATE_COOLDOWN_NOTICE_START
async function seekdeepSendRegenerateCooldownNotice(source, remainingMs) {
  const remainingSeconds = Math.max(1, Math.ceil(Number(remainingMs || 0) / 1000));
  const baseText = typeof seekdeepImageCooldownText === 'function'
    ? seekdeepImageCooldownText(remainingMs)
    : `Image generation cooldown is active. Try again in ${remainingSeconds} second${remainingSeconds === 1 ? '' : 's'}.`;

  const modelUsed = typeof seekdeepNoModelLabel === 'function'
    ? seekdeepNoModelLabel()
    : 'local command (no AI model)';

  const content = typeof seekdeepAppendResponseFooter === 'function'
    ? seekdeepAppendResponseFooter(baseText, {
        startedAt: source?.__seekdeepRequestStartedAt,
        modelUsed,
      })
    : `${baseText}\n\nModel Used: ${modelUsed}`;

  try {
    if (typeof stopSeekDeepTypingLoopForMessage === 'function' && source?.author) {
      stopSeekDeepTypingLoopForMessage(source);
    }
  } catch {}

  if (typeof source?.reply === 'function') {
    try {
      return await source.reply({
        content,
        allowedMentions: { repliedUser: false },
      });
    } catch (err) {
      console.warn('Regenerate cooldown reply failed:', err?.message || err);
    }
  }

  if (typeof source?.followUp === 'function') {
    try {
      return await source.followUp({
        content,
        ephemeral: true,
      });
    } catch (err) {
      console.warn('Regenerate cooldown interaction followUp failed:', err?.message || err);
    }
  }

  if (typeof source?.editReply === 'function') {
    try {
      return await source.editReply({
        content,
      });
    } catch (err) {
      console.warn('Regenerate cooldown interaction editReply failed:', err?.message || err);
    }
  }

  if (source?.channel && typeof source.channel.send === 'function') {
    try {
      return await source.channel.send({
        content,
        allowedMentions: { repliedUser: false },
      });
    } catch (err) {
      console.warn('Regenerate cooldown channel fallback failed:', err?.message || err);
    }
  }

  return null;
}

function seekdeepRegenerateCooldownUserId(source) {
  return String(source?.author?.id || source?.user?.id || source?.member?.user?.id || 'unknown').trim() || 'unknown';
}
// SEEKDEEP_REGENERATE_COOLDOWN_NOTICE_END
"""

if "SEEKDEEP_REGENERATE_COOLDOWN_NOTICE_START" not in text:
    text = text.replace("function seekdeepEnqueueImageJob(job, runner)", notice_helper + "\nfunction seekdeepEnqueueImageJob(job, runner)", 1)

patched = 0

# 1) Patch text regenerate function if present.
fn_info = find_function_block(text, "seekdeepRegenerateLatestImageFromMessage")
if fn_info:
    start, open_brace, close_brace, fn = fn_info
    if "SEEKDEEP_REGENERATE_TEXT_COOLDOWN_START" not in fn:
        insertion = r"""
  // SEEKDEEP_REGENERATE_TEXT_COOLDOWN_START
  const seekdeepRegenUserId = seekdeepRegenerateCooldownUserId(message);
  const seekdeepRegenCooldownRemaining = seekdeepImageCooldownRemaining(seekdeepRegenUserId);
  if (seekdeepRegenCooldownRemaining > 0) {
    if (typeof seekdeepLogRoute === 'function') seekdeepLogRoute('regenerate-cooldown', 'regenerate');
    await seekdeepSendRegenerateCooldownNotice(message, seekdeepRegenCooldownRemaining);
    return null;
  }
  // SEEKDEEP_REGENERATE_TEXT_COOLDOWN_END

"""
        text = text[:open_brace + 1] + insertion + text[open_brace + 1:]
        patched += 1

# 2) Patch button handler if present.
fn_info = find_function_block(text, "seekdeepHandleImageButton")
if fn_info:
    start, open_brace, close_brace, fn = fn_info
    if "SEEKDEEP_REGENERATE_BUTTON_COOLDOWN_START" not in fn:
        # Insert after opening brace. It only applies if the custom/button id includes regenerate/regen.
        insertion = r"""
  // SEEKDEEP_REGENERATE_BUTTON_COOLDOWN_START
  try {
    const seekdeepButtonId = String(interaction?.customId || '');
    if (/\b(?:regenerate|regen)\b/i.test(seekdeepButtonId)) {
      const seekdeepRegenUserId = seekdeepRegenerateCooldownUserId(interaction);
      const seekdeepRegenCooldownRemaining = seekdeepImageCooldownRemaining(seekdeepRegenUserId);
      if (seekdeepRegenCooldownRemaining > 0) {
        if (typeof seekdeepLogRoute === 'function') seekdeepLogRoute('regenerate-cooldown', 'button-regenerate');
        await seekdeepSendRegenerateCooldownNotice(interaction, seekdeepRegenCooldownRemaining);
        return null;
      }
    }
  } catch (err) {
    console.warn('Regenerate button cooldown check failed:', err?.message || err);
  }
  // SEEKDEEP_REGENERATE_BUTTON_COOLDOWN_END

"""
        text = text[:open_brace + 1] + insertion + text[open_brace + 1:]
        patched += 1

# 3) Patch generic interactionCreate button branch if seekdeepHandleImageButton does not exist or another path exists.
if "SEEKDEEP_REGENERATE_BUTTON_COOLDOWN_START" not in text:
    marker_candidates = [
        "if (interaction.isButton()) {",
        "if (interaction?.isButton?.()) {",
    ]
    for marker in marker_candidates:
        pos = text.find(marker)
        if pos >= 0:
            open_brace = text.find("{", pos)
            insertion = r"""
    // SEEKDEEP_REGENERATE_BUTTON_COOLDOWN_START
    try {
      const seekdeepButtonId = String(interaction?.customId || '');
      if (/\b(?:regenerate|regen)\b/i.test(seekdeepButtonId)) {
        const seekdeepRegenUserId = seekdeepRegenerateCooldownUserId(interaction);
        const seekdeepRegenCooldownRemaining = seekdeepImageCooldownRemaining(seekdeepRegenUserId);
        if (seekdeepRegenCooldownRemaining > 0) {
          if (typeof seekdeepLogRoute === 'function') seekdeepLogRoute('regenerate-cooldown', 'button-regenerate');
          await seekdeepSendRegenerateCooldownNotice(interaction, seekdeepRegenCooldownRemaining);
          return;
        }
      }
    } catch (err) {
      console.warn('Regenerate interaction cooldown check failed:', err?.message || err);
    }
    // SEEKDEEP_REGENERATE_BUTTON_COOLDOWN_END

"""
            text = text[:open_brace + 1] + insertion + text[open_brace + 1:]
            patched += 1
            break

if patched < 1:
    raise SystemExit("Could not locate text regenerate or button regenerate handler to patch.")

for needle, label in [
    ("SEEKDEEP_REGENERATE_COOLDOWN_NOTICE_START", "regenerate cooldown notice helper"),
    ("function seekdeepRegenerateCooldownUserId", "regenerate cooldown user id helper"),
    ("seekdeepImageCooldownRemaining(seekdeepRegenUserId)", "regenerate cooldown check"),
    ("seekdeepSendRegenerateCooldownNotice", "regenerate cooldown notice sender"),
    ("function seekdeepEnqueueImageJob(job, runner)", "correct queue contract"),
]:
    require_contains(text, needle, label)

out = text if newline == "\n" else text.replace("\n", "\r\n")
path.write_bytes(out.encode("utf-8"))
print(f"Patched regenerate cooldown enforcement at {patched} entry point(s).")