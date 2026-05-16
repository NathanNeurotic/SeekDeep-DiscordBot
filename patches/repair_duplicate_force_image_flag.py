from pathlib import Path
import re
import sys

if len(sys.argv) != 2:
    raise SystemExit("Usage: repair_duplicate_force_image_flag.py <index.js>")

path = Path(sys.argv[1])
raw = path.read_bytes()
newline = "\r\n" if b"\r\n" in raw else "\n"
text = raw.decode("utf-8-sig").replace("\r\n", "\n").replace("\r", "\n")

def fail(msg):
    raise SystemExit(msg)

def require(needle, label):
    if needle not in text:
        fail(f"Required anchor not found: {label}")

def find_function_bounds(src, function_start_marker):
    start = src.find(function_start_marker)
    if start < 0:
        fail(f"Could not locate function/handler marker: {function_start_marker}")

    brace = src.find("{", start)
    if brace < 0:
        fail("Could not locate opening brace")

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
                return start, i + 1

        i += 1

    fail("Could not locate closing brace")

for needle, label in [
    ("client.on('messageCreate'", "messageCreate handler"),
    ("seekdeepApplyReplyContextToPrompt(message, prompt)", "reply-context hook"),
    ("prompt = seekdeepReplyPromptInfo.prompt;", "reply-context prompt assignment"),
    ("seekdeepEnqueueImageJob(job, runner)", "queue contract"),
]:
    require(needle, label)

if "seekdeepMakeImageQueueJobId" in text:
    fail("Unsafe old queue helper found: seekdeepMakeImageQueueJobId")
if "job.run" in text:
    fail("Unsafe job.run-style queue logic found")

# Repair accidental async typo from earlier patch family, if present.
text = re.sub(r"\basync\s+async\s+function\b", "async function", text)

msg_start, msg_end = find_function_bounds(text, "client.on('messageCreate'")
handler = text[msg_start:msg_end]

# Ensure we have a stable "before reply context" variable. If multiple exist, collapse later by not touching unless absent.
if "const seekdeepPromptBeforeReplyContext = prompt;" not in handler:
    handler = handler.replace(
        "  let prompt = normalizeUserText(stripBotMentions(message.content));\n\n  const seekdeepReplyPromptInfo = await seekdeepApplyReplyContextToPrompt(message, prompt);\n",
        "  let prompt = normalizeUserText(stripBotMentions(message.content));\n  const seekdeepPromptBeforeReplyContext = prompt;\n\n  const seekdeepReplyPromptInfo = await seekdeepApplyReplyContextToPrompt(message, prompt);\n",
        1,
    )

if "const seekdeepPromptBeforeReplyContext = prompt;" not in handler:
    fail("Could not ensure seekdeepPromptBeforeReplyContext exists in messageCreate handler.")

# Remove all existing marked force-image blocks.
handler = re.sub(
    r"\n[ \t]*// SEEKDEEP_REPLY_FORCE_IMAGE_FLAG_START\n"
    r"[\s\S]*?"
    r"// SEEKDEEP_REPLY_FORCE_IMAGE_FLAG_END\n",
    "\n",
    handler,
    flags=re.MULTILINE,
)

# Remove any bare single-line declaration.
handler = re.sub(
    r"\n[ \t]*const\s+seekdeepForceImageFromReplyContext\s*=\s*Boolean\([^\n]*\);\n",
    "\n",
    handler,
    flags=re.MULTILINE,
)

# Remove any bare multi-line declaration block.
handler = re.sub(
    r"\n[ \t]*const\s+seekdeepForceImageFromReplyContext\s*=\s*Boolean\(\n"
    r"[\s\S]*?"
    r"\n[ \t]*\);\n",
    "\n",
    handler,
    flags=re.MULTILINE,
)

# Insert exactly one canonical declaration after prompt assignment.
assignment = "  prompt = seekdeepReplyPromptInfo.prompt;\n"
idx = handler.find(assignment)
if idx < 0:
    fail("Could not locate prompt assignment in messageCreate handler.")

insert_at = idx + len(assignment)
canonical = """  // SEEKDEEP_REPLY_FORCE_IMAGE_FLAG_START
  const seekdeepForceImageFromReplyContext = Boolean(
    seekdeepReplyPromptInfo?.usedReplyContext &&
    typeof seekdeepLooksLikeGenerateOnlyPrompt === 'function' &&
    seekdeepLooksLikeGenerateOnlyPrompt(seekdeepPromptBeforeReplyContext)
  );
  // SEEKDEEP_REPLY_FORCE_IMAGE_FLAG_END
"""

handler = handler[:insert_at] + canonical + handler[insert_at:]

# Ensure route condition uses force-image flag.
if "seekdeepForceImageFromReplyContext ||" not in handler:
    old_route = "if (!seekdeepShouldKeepPromptAsChatBeforeImage(prompt) && ((typeof seekdeepIsGenericImageFollowupPrompt === 'function' && seekdeepIsGenericImageFollowupPrompt(prompt)) || (typeof seekdeepLooksLikeShortNamedVisualSubject === 'function' && seekdeepLooksLikeShortNamedVisualSubject(prompt)) || isNaturalImagePrompt(prompt))) {"
    new_route = "if (seekdeepForceImageFromReplyContext || (!seekdeepShouldKeepPromptAsChatBeforeImage(prompt) && ((typeof seekdeepIsGenericImageFollowupPrompt === 'function' && seekdeepIsGenericImageFollowupPrompt(prompt)) || (typeof seekdeepLooksLikeShortNamedVisualSubject === 'function' && seekdeepLooksLikeShortNamedVisualSubject(prompt)) || isNaturalImagePrompt(prompt)))) {"
    if old_route in handler:
        handler = handler.replace(old_route, new_route, 1)
    else:
        # Regex fallback: first image route condition containing isNaturalImagePrompt(prompt)
        m = re.search(r"(?m)^(?P<indent>\s*)if \((?P<inner>[^\n]*isNaturalImagePrompt\(prompt\)[^\n]*)\) \{", handler)
        if not m:
            fail("Could not locate image route condition to force reply-context image routing.")
        start = m.start()
        end = m.end()
        indent = m.group("indent")
        inner = m.group("inner")
        handler = handler[:start] + f"{indent}if (seekdeepForceImageFromReplyContext || ({inner})) {{" + handler[end:]

# Validate exactly one declaration in the handler.
count = len(re.findall(r"\bconst\s+seekdeepForceImageFromReplyContext\b", handler))
if count != 1:
    hits = [i + 1 for i, line in enumerate(handler.splitlines()) if "seekdeepForceImageFromReplyContext" in line]
    fail(f"messageCreate still has {count} force-image declarations. Hits: {hits[:20]}")

if "seekdeepForceImageFromReplyContext ||" not in handler:
    fail("messageCreate route condition does not use seekdeepForceImageFromReplyContext.")

text = text[:msg_start] + handler + text[msg_end:]

# Validate image mode options are not duplicated anymore, because the previous hard repair claimed to fix them.
for name in ("seekdeepSendImageWithButtonsMessage", "seekdeepSendImageWithButtonsInteraction"):
    try:
        s, e = find_function_bounds(text, f"async function {name}(")
    except SystemExit:
        fail(f"Could not locate {name}")
    fn = text[s:e]
    count = len(re.findall(r"\bconst\s+seekdeepImageModeOptions\b", fn))
    if count != 1:
        hits = [i + 1 for i, line in enumerate(fn.splitlines()) if "seekdeepImageModeOptions" in line]
        fail(f"{name} has {count} seekdeepImageModeOptions declarations. Hits: {hits[:20]}")
    if "makeImageResult(prompt, width, height, seed, seekdeepImageModeOptions)" not in fn:
        fail(f"{name} does not pass seekdeepImageModeOptions to makeImageResult")

for needle, label in [
    ("const seekdeepForceImageFromReplyContext = Boolean(", "canonical force-image declaration"),
    ("seekdeepForceImageFromReplyContext ||", "force-image route condition"),
    ("seekdeepEnqueueImageJob(job, runner)", "queue contract preserved"),
]:
    if needle not in text:
        fail(f"Validation failed: missing {label}")

out = text if newline == "\n" else text.replace("\n", "\r\n")
path.write_bytes(out.encode("utf-8"))
print("Repaired duplicate seekdeepForceImageFromReplyContext declarations.")