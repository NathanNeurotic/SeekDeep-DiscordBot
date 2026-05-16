from pathlib import Path
import re
import sys

if len(sys.argv) != 2:
    raise SystemExit("Usage: repair_image_cooldown_hang_v3.py <index.js>")

path = Path(sys.argv[1])
raw = path.read_bytes()
newline = "\r\n" if b"\r\n" in raw else "\n"
text = raw.decode("utf-8-sig")
text = text.replace("\r\n", "\n").replace("\r", "\n")

def require_contains(haystack, needle, label):
    if needle not in haystack:
        raise SystemExit(f"Required anchor not found: {label}")

require_contains(text, "const SEEKDEEP_IMAGE_COOLDOWN_MS", "existing cooldown duration")
require_contains(text, "function seekdeepImageCooldownRemaining", "existing cooldown remaining helper")
require_contains(text, "function seekdeepImageCooldownText", "existing cooldown text helper")
require_contains(text, "seekdeepLogRoute('image-cooldown', prompt);", "image cooldown route log")
require_contains(text, "function seekdeepEnqueueImageJob(job, runner)", "correct queue contract")

if "seekdeepMakeImageQueueJobId" in text:
    raise SystemExit("Unsafe old queue helper found: seekdeepMakeImageQueueJobId")
if "job.run" in text:
    raise SystemExit("Unsafe job.run-style queue logic found")

helper_block = r"""
// SEEKDEEP_IMAGE_COOLDOWN_HANG_REPAIR_START
function seekdeepStopTypingSafelyForMessage(message) {
  try {
    if (typeof stopSeekDeepTypingLoopForMessage === 'function') {
      stopSeekDeepTypingLoopForMessage(message);
    }
  } catch (err) {
    console.warn('Could not stop typing loop for cooldown notice:', err?.message || err);
  }
}

async function seekdeepSendImageCooldownNotice(message, remainingMs) {
  const remainingSeconds = Math.max(1, Math.ceil(Number(remainingMs || 0) / 1000));
  const fallbackText = `Image generation cooldown is active. Try again in ${remainingSeconds} second${remainingSeconds === 1 ? '' : 's'}.`;
  const baseText = typeof seekdeepImageCooldownText === 'function'
    ? seekdeepImageCooldownText(remainingMs)
    : fallbackText;

  const modelUsed = typeof seekdeepNoModelLabel === 'function'
    ? seekdeepNoModelLabel()
    : 'local command (no AI model)';

  const content = typeof seekdeepAppendResponseFooter === 'function'
    ? seekdeepAppendResponseFooter(baseText || fallbackText, {
        startedAt: message?.__seekdeepRequestStartedAt,
        modelUsed,
      })
    : `${baseText || fallbackText}\n\nModel Used: ${modelUsed}`;

  seekdeepStopTypingSafelyForMessage(message);

  try {
    if (message && typeof message.reply === 'function') {
      const sent = await message.reply({
        content,
        allowedMentions: { repliedUser: false },
      });
      seekdeepStopTypingSafelyForMessage(message);
      return sent;
    }
  } catch (err) {
    console.warn('Cooldown message.reply failed; trying channel.send:', err?.message || err);
  }

  try {
    if (message?.channel && typeof message.channel.send === 'function') {
      const sent = await message.channel.send({
        content,
        allowedMentions: { repliedUser: false },
      });
      seekdeepStopTypingSafelyForMessage(message);
      return sent;
    }
  } catch (err) {
    console.warn('Cooldown channel.send fallback failed:', err?.message || err);
  }

  seekdeepStopTypingSafelyForMessage(message);
  return null;
}
// SEEKDEEP_IMAGE_COOLDOWN_HANG_REPAIR_END
"""

if "SEEKDEEP_IMAGE_COOLDOWN_HANG_REPAIR_START" not in text:
    text = text.replace("function seekdeepEnqueueImageJob(job, runner)", helper_block + "\nfunction seekdeepEnqueueImageJob(job, runner)", 1)

# Replace older fragile cooldown reply helpers only in the image route branch.
replacements = [
    (
        "await seekdeepReplyImageCooldownRemaining(message, seekdeepRouteCooldownRemaining);",
        "await seekdeepSendImageCooldownNotice(message, seekdeepRouteCooldownRemaining);"
    ),
    (
        "await seekdeepReplyImageCooldownRemaining(message, cooldownRemaining);",
        "await seekdeepSendImageCooldownNotice(message, cooldownRemaining);"
    ),
    (
        "await seekdeepReplyImageCooldownRemaining(message, remaining);",
        "await seekdeepSendImageCooldownNotice(message, remaining);"
    ),
]

changed = 0
for old, new in replacements:
    count = text.count(old)
    if count:
        text = text.replace(old, new)
        changed += count

# If the route exists but the earlier helper call was already absent, patch the image-cooldown block directly.
if changed == 0:
    pattern = re.compile(
        r"(seekdeepLogRoute\('image-cooldown', prompt\);\s*)"
        r"(?P<body>.*?)"
        r"(\s*return;\s*)",
        re.S
    )
    m = pattern.search(text)
    if not m:
        raise SystemExit("Could not locate image-cooldown branch body to repair.")

    body = m.group("body")
    if "seekdeepSendImageCooldownNotice" not in body:
      replacement = m.group(1) + "\n        await seekdeepSendImageCooldownNotice(message, seekdeepRouteCooldownRemaining);\n" + m.group(3)
      text = text[:m.start()] + replacement + text[m.end():]
      changed = 1

# Ensure every cooldown return stops typing even if the reply throws.
if "seekdeepStopTypingSafelyForMessage(message);\n        return;" not in text:
    text = text.replace(
        "await seekdeepSendImageCooldownNotice(message, seekdeepRouteCooldownRemaining);\n        return;",
        "await seekdeepSendImageCooldownNotice(message, seekdeepRouteCooldownRemaining);\n        seekdeepStopTypingSafelyForMessage(message);\n        return;"
    )
    text = text.replace(
        "await seekdeepSendImageCooldownNotice(message, cooldownRemaining);\n        return;",
        "await seekdeepSendImageCooldownNotice(message, cooldownRemaining);\n        seekdeepStopTypingSafelyForMessage(message);\n        return;"
    )
    text = text.replace(
        "await seekdeepSendImageCooldownNotice(message, remaining);\n        return;",
        "await seekdeepSendImageCooldownNotice(message, remaining);\n        seekdeepStopTypingSafelyForMessage(message);\n        return;"
    )

for needle, label in [
    ("SEEKDEEP_IMAGE_COOLDOWN_HANG_REPAIR_START", "cooldown hang repair helper marker"),
    ("async function seekdeepSendImageCooldownNotice", "safe cooldown notice sender"),
    ("seekdeepStopTypingSafelyForMessage(message)", "typing loop stop helper usage"),
    ("seekdeepSendImageCooldownNotice(message", "image cooldown branch uses safe sender"),
    ("seekdeepLogRoute('image-cooldown', prompt);", "image cooldown route log preserved"),
    ("function seekdeepEnqueueImageJob(job, runner)", "correct queue contract"),
]:
    require_contains(text, needle, label)

out = text if newline == "\n" else text.replace("\n", "\r\n")
path.write_bytes(out.encode("utf-8"))
print(f"Repaired image cooldown branch with safe reply + typing-loop stop. Replaced {changed} call site(s).")