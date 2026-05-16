from pathlib import Path
import re
import sys

if len(sys.argv) != 2:
    raise SystemExit("Usage: patch_reply_context_force_image.py <index.js>")

path = Path(sys.argv[1])
raw = path.read_bytes()
newline = "\r\n" if b"\r\n" in raw else "\n"
text = raw.decode("utf-8-sig").replace("\r\n", "\n").replace("\r", "\n")

def require_contains(haystack: str, needle: str, label: str):
    if needle not in haystack:
        raise SystemExit(f"Required anchor not found: {label}")

for needle, label in [
    ("client.on('messageCreate'", "messageCreate handler"),
    ("seekdeepApplyReplyContextToPrompt(message, prompt)", "reply-context hook"),
    ("seekdeepEnqueueImageJob(job, runner)", "queue contract"),
]:
    require_contains(text, needle, label)

if "seekdeepMakeImageQueueJobId" in text:
    raise SystemExit("Unsafe old queue helper found: seekdeepMakeImageQueueJobId")
if "job.run" in text:
    raise SystemExit("Unsafe job.run-style queue logic found")

# Make reply-context visual detection less brittle for critique/correction text that includes
# known visual names/modifiers but isn't formatted as a clean prompt.
if "function seekdeepReplyContextLooksVisualPrompt" in text:
    fn_start = text.find("function seekdeepReplyContextLooksVisualPrompt")
    brace = text.find("{", fn_start)
    depth = 0
    i = brace
    end = -1
    while i < len(text):
        if text[i] == "{":
            depth += 1
        elif text[i] == "}":
            depth -= 1
            if depth == 0:
                end = i + 1
                break
        i += 1
    if end < 0:
        raise SystemExit("Could not find end of seekdeepReplyContextLooksVisualPrompt.")

    fn = text[fn_start:end]
    if "SEEKDEEP_REPLY_VISUAL_CRITIQUE_CUE_START" not in fn:
        insert = r"""
  // SEEKDEEP_REPLY_VISUAL_CRITIQUE_CUE_START
  if (/\b(ripto|spyro|matrix|predator|toad|mario|pepe|sailor\s*moon|homer|simpson|animal\s*crossing|nintendo)\b/i.test(p) &&
      /\b(matrix|green|greenish|predator|style|version|make|more|less|looks|image|picture|art|render|generate)\b/i.test(p)) {
    return true;
  }
  // SEEKDEEP_REPLY_VISUAL_CRITIQUE_CUE_END

"""
        # Insert after lower = p.toLowerCase(); if available, else after visualCue definition.
        anchor = "  const lower = p.toLowerCase();\n"
        if anchor in fn:
            fn = fn.replace(anchor, anchor + insert, 1)
        else:
            anchor = "  const visualCue = "
            pos = fn.find(anchor)
            if pos < 0:
                raise SystemExit("Could not insert critique visual cue in reply visual function.")
            line_end = fn.find("\n", pos)
            fn = fn[:line_end + 1] + insert + fn[line_end + 1:]
        text = text[:fn_start] + fn + text[end:]

# Add force-image flag after reply-context prompt assignment.
if "SEEKDEEP_REPLY_FORCE_IMAGE_FLAG_START" not in text:
    anchor = "prompt = seekdeepReplyPromptInfo.prompt;\n"
    pos = text.find(anchor, text.find("client.on('messageCreate'"))
    if pos < 0:
        raise SystemExit("Could not locate prompt assignment after reply-context hook.")
    insert_at = pos + len(anchor)
    block = """const seekdeepForceImageFromReplyContext = Boolean(seekdeepReplyPromptInfo?.usedReplyContext);\n"""
    # Preserve indentation from assignment line.
    line_start = text.rfind("\n", 0, pos) + 1
    indent = re.match(r"\s*", text[line_start:pos]).group(0)
    block = indent + "// SEEKDEEP_REPLY_FORCE_IMAGE_FLAG_START\n" + indent + block + indent + "// SEEKDEEP_REPLY_FORCE_IMAGE_FLAG_END\n"
    text = text[:insert_at] + block + text[insert_at:]

# Patch route condition to include force-image flag.
if "seekdeepForceImageFromReplyContext ||" not in text:
    msg_start = text.find("client.on('messageCreate'")
    # Prefer existing complex image route containing isNaturalImagePrompt(prompt)
    m = re.search(r"(?m)^(?P<indent>\s*)if \((?P<inner>[^\n]*isNaturalImagePrompt\(prompt\)[^\n]*)\) \{", text[msg_start:])
    if not m:
        raise SystemExit("Could not locate image route condition containing isNaturalImagePrompt(prompt).")
    start = msg_start + m.start()
    end = msg_start + m.end()
    indent = m.group("indent")
    inner = m.group("inner")
    new_line = f"{indent}if (seekdeepForceImageFromReplyContext || ({inner})) {{"
    text = text[:start] + new_line + text[end:]

# Ensure reply-context object returns usedReplyContext=true when it consumed reply text.
# Existing function should already do this; this validation catches failed prior patch.
require_contains(text, "usedReplyContext: true", "reply-context used flag")
require_contains(text, "const seekdeepForceImageFromReplyContext", "force image flag")
require_contains(text, "seekdeepForceImageFromReplyContext ||", "force image route condition")
require_contains(text, "SEEKDEEP_REPLY_VISUAL_CRITIQUE_CUE_START", "critique visual cue")
require_contains(text, "seekdeepEnqueueImageJob(job, runner)", "queue contract preserved")

out = text if newline == "\n" else text.replace("\n", "\r\n")
path.write_bytes(out.encode("utf-8"))
print("Patched reply-context force-image routing.")