from pathlib import Path
import sys

if len(sys.argv) != 2:
    raise SystemExit("Usage: repair_image_cooldown_notification_v2.py <index.js>")

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

require_contains(text, "const SEEKDEEP_IMAGE_COOLDOWN_MS", "existing cooldown duration")
require_contains(text, "function seekdeepImageCooldownRemaining", "existing cooldown remaining helper")
require_contains(text, "function seekdeepRememberImageCooldown", "existing cooldown remember helper")
require_contains(text, "function seekdeepImageCooldownText", "existing cooldown text helper")
require_contains(text, "function seekdeepEnqueueImageJob(job, runner)", "correct queue contract")
require_contains(text, "if (isNaturalImagePrompt(prompt))", "message image route")
require_contains(text, "client.on('messageCreate'", "message dispatcher")

if "seekdeepMakeImageQueueJobId" in text:
    raise SystemExit("Unsafe old queue helper found: seekdeepMakeImageQueueJobId")
if "job.run" in text:
    raise SystemExit("Unsafe job.run-style queue logic found")

helper_block = r"""
// SEEKDEEP_IMAGE_COOLDOWN_ROUTE_NOTIFY_START
async function seekdeepReplyImageCooldownRemaining(source, remainingMs) {
  const remainingSeconds = Math.max(1, Math.ceil(Number(remainingMs || 0) / 1000));
  const baseText = typeof seekdeepImageCooldownText === 'function'
    ? seekdeepImageCooldownText(remainingMs)
    : `Image generation cooldown is active. Try again in ${remainingSeconds} second${remainingSeconds === 1 ? '' : 's'}.`;

  const content = seekdeepAppendResponseFooter(baseText, {
    startedAt: source?.__seekdeepRequestStartedAt,
    modelUsed: typeof seekdeepNoModelLabel === 'function' ? seekdeepNoModelLabel() : 'local command (no AI model)',
  });

  if (typeof source?.reply === 'function') {
    try {
      return await source.reply({
        content,
        allowedMentions: { repliedUser: false },
      });
    } catch (err) {
      console.warn('Cooldown reply failed:', err?.message || err);
    }
  }

  if (source?.channel && typeof source.channel.send === 'function') {
    try {
      return await source.channel.send({
        content,
        allowedMentions: { repliedUser: false },
      });
    } catch (err) {
      console.warn('Cooldown channel fallback failed:', err?.message || err);
    }
  }

  return null;
}
// SEEKDEEP_IMAGE_COOLDOWN_ROUTE_NOTIFY_END
"""

if "SEEKDEEP_IMAGE_COOLDOWN_ROUTE_NOTIFY_START" not in text and "async function seekdeepReplyImageCooldownRemaining" not in text:
    text = text.replace("function seekdeepEnqueueImageJob(job, runner)", helper_block + "\nfunction seekdeepEnqueueImageJob(job, runner)", 1)

# Patch every unpatched message image route block.
needle = "if (isNaturalImagePrompt(prompt)) {"
idx = 0
patched = 0

while True:
    pos = text.find(needle, idx)
    if pos < 0:
        break

    open_brace = text.find("{", pos)
    close_brace = find_matching_brace(text, open_brace)
    block = text[pos:close_brace + 1]

    if "seekdeepRouteCooldownRemaining" in block or "seekdeepReplyImageCooldownRemaining(message" in block:
        idx = close_brace + 1
        continue

    insertion_point = open_brace + 1
    snippet = r"""
      const seekdeepRouteCooldownRemaining = seekdeepImageCooldownRemaining(message.author?.id || message.author?.username || 'unknown');
      if (seekdeepRouteCooldownRemaining > 0) {
        seekdeepLogRoute('image-cooldown', prompt);
        await seekdeepReplyImageCooldownRemaining(message, seekdeepRouteCooldownRemaining);
        return;
      }
"""

    text = text[:insertion_point] + snippet + text[insertion_point:]
    patched += 1
    idx = insertion_point + len(snippet)

if patched < 1:
    raise SystemExit("Found image route marker, but no route block was patched.")

for needle, label in [
    ("SEEKDEEP_IMAGE_COOLDOWN_ROUTE_NOTIFY_START", "cooldown route notification helper marker"),
    ("async function seekdeepReplyImageCooldownRemaining", "cooldown reply helper"),
    ("seekdeepRouteCooldownRemaining", "image route cooldown remaining check"),
    ("seekdeepReplyImageCooldownRemaining(message, seekdeepRouteCooldownRemaining)", "image route cooldown reply"),
    ("seekdeepLogRoute('image-cooldown', prompt);", "image cooldown route log"),
    ("function seekdeepEnqueueImageJob(job, runner)", "correct queue contract"),
]:
    require_contains(text, needle, label)

out = text if newline == "\n" else text.replace("\n", "\r\n")
path.write_bytes(out.encode("utf-8"))
print(f"Patched {patched} image route block(s) so cooldown rejections notify the user.")