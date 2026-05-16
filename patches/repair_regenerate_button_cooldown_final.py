from pathlib import Path
import re
import sys

if len(sys.argv) != 2:
    raise SystemExit("Usage: repair_regenerate_button_cooldown_final.py <index.js>")

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
        raise SystemExit(f"Could not locate function {function_name}.")

    open_brace = src.find('{', m.end())
    if open_brace < 0:
        raise SystemExit(f"Could not locate opening brace for {function_name}.")

    close_brace = find_matching_brace(src, open_brace)
    return m.start(), open_brace, close_brace, src[m.start():close_brace + 1]

require_contains(text, "function seekdeepHandleImageButton(interaction)", "image button handler")
require_contains(text, "if (action === 'regen')", "regen button action branch")
require_contains(text, "function seekdeepImageCooldownRemaining", "cooldown remaining helper")
require_contains(text, "function seekdeepRememberImageCooldown", "cooldown remember helper")
require_contains(text, "function seekdeepEnqueueImageJob(job, runner)", "correct queue contract")

if "seekdeepMakeImageQueueJobId" in text:
    raise SystemExit("Unsafe old queue helper found: seekdeepMakeImageQueueJobId")
if "job.run" in text:
    raise SystemExit("Unsafe job.run-style queue logic found")

start, open_brace, close_brace, fn = find_function_block(text, "seekdeepHandleImageButton")

if "SEEKDEEP_REGENERATE_BUTTON_FINAL_COOLDOWN_START" in fn:
    raise SystemExit("Final regenerate button cooldown patch already appears to be applied.")

regen_pos = fn.find("if (action === 'regen') {")
if regen_pos < 0:
    raise SystemExit("Could not locate action === 'regen' branch inside seekdeepHandleImageButton.")

regen_open = fn.find("{", regen_pos)
regen_close = find_matching_brace(fn, regen_open)
regen_block = fn[regen_pos:regen_close + 1]

old_user_line = "    const userId = interaction?.user?.id || 'unknown';\n"
if old_user_line not in regen_block:
    raise SystemExit("Could not locate regenerate button userId line.")

cooldown_check = """    const userId = interaction?.user?.id || 'unknown';
    // SEEKDEEP_REGENERATE_BUTTON_FINAL_COOLDOWN_START
    const seekdeepButtonRegenCooldownRemaining = seekdeepImageCooldownRemaining(userId);
    if (seekdeepButtonRegenCooldownRemaining > 0) {
      if (typeof seekdeepLogRoute === 'function') seekdeepLogRoute('regenerate-cooldown', 'button-regenerate');

      const modelUsed = typeof seekdeepNoModelLabel === 'function' ? seekdeepNoModelLabel() : 'local command (no AI model)';
      await interaction.editReply({
        content: seekdeepAppendResponseFooter(seekdeepImageCooldownText(seekdeepButtonRegenCooldownRemaining), {
          startedAt,
          modelUsed,
        }),
      });

      return true;
    }
    // SEEKDEEP_REGENERATE_BUTTON_FINAL_COOLDOWN_END
"""

regen_block = regen_block.replace(old_user_line, cooldown_check, 1)

old_enqueue = "    await seekdeepEnqueueImageJob(job, async (runningJob) => {"
if old_enqueue not in regen_block:
    raise SystemExit("Could not locate awaited regenerate button enqueue call.")

regen_block = regen_block.replace(old_enqueue, "    const seekdeepButtonRegenQueuePromise = seekdeepEnqueueImageJob(job, async (runningJob) => {", 1)

old_after_enqueue = "    });\n\n    return true;"
if old_after_enqueue not in regen_block:
    raise SystemExit("Could not locate regenerate button enqueue completion block.")

new_after_enqueue = """    });

    // Start cooldown after enqueue is accepted. Do not do this before enqueue,
    // because seekdeepEnqueueImageJob may also contain a cooldown gate.
    seekdeepRememberImageCooldown(userId);
    await seekdeepButtonRegenQueuePromise;

    return true;"""
regen_block = regen_block.replace(old_after_enqueue, new_after_enqueue, 1)

fn = fn[:regen_pos] + regen_block + fn[regen_close + 1:]
text = text[:start] + fn + text[close_brace + 1:]

for needle, label in [
    ("SEEKDEEP_REGENERATE_BUTTON_FINAL_COOLDOWN_START", "final regenerate button cooldown marker"),
    ("const seekdeepButtonRegenCooldownRemaining = seekdeepImageCooldownRemaining(userId);", "regen button cooldown check"),
    ("seekdeepRememberImageCooldown(userId);", "regen button cooldown remember"),
    ("const seekdeepButtonRegenQueuePromise = seekdeepEnqueueImageJob(job, async", "regen button enqueue promise"),
    ("await seekdeepButtonRegenQueuePromise;", "regen button await queued promise"),
    ("function seekdeepEnqueueImageJob(job, runner)", "queue contract preserved"),
]:
    require_contains(text, needle, label)

out = text if newline == "\n" else text.replace("\n", "\r\n")
path.write_bytes(out.encode("utf-8"))
print("Patched regenerate button branch to remember cooldown after enqueue.")