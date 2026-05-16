from pathlib import Path
import re

p = Path("index.js")
text = p.read_text(encoding="utf-8")

# Remove old copy if re-run.
text = re.sub(
    r"(?ms)\n*// SEEKDEEP_QWEN_THINK_STRIP_START.*?// SEEKDEEP_QWEN_THINK_STRIP_END\n*",
    "\n\n",
    text,
)

helper = r'''
// SEEKDEEP_QWEN_THINK_STRIP_START
function stripQwenThinkingBlocks(value) {
  let text = String(value ?? '');

  // Remove complete Qwen3 thinking blocks.
  text = text.replace(/<think>[\s\S]*?<\/think>/gi, '');

  // If the model was cut off while still thinking, discard that leaked section.
  text = text.replace(/<think>[\s\S]*$/i, '');

  // Remove loose closing tags.
  text = text.replace(/<\/think>/gi, '');

  return text.trim();
}
// SEEKDEEP_QWEN_THINK_STRIP_END

'''

insert_pos = text.find("async function sendLongMessageReply")
if insert_pos == -1:
    raise SystemExit("Could not find sendLongMessageReply.")

text = text[:insert_pos].rstrip() + "\n\n" + helper + text[insert_pos:].lstrip()

def insert_after_open(src, signature, marker, injection):
    pos = src.find(signature)
    if pos == -1:
        raise SystemExit(f"Could not find {signature}")

    next_func = src.find("\nasync function ", pos + len(signature))
    if next_func == -1:
        next_func = src.find("\nfunction ", pos + len(signature))
    if next_func == -1:
        next_func = len(src)

    if marker in src[pos:next_func]:
        return src

    brace = src.find("{", pos)
    if brace == -1:
        raise SystemExit(f"Could not find opening brace for {signature}")

    return src[:brace + 1] + injection + src[brace + 1:]

text = insert_after_open(
    text,
    "async function sendLongMessageReply(message, content)",
    "SEEKDEEP_STRIP_THINK_MESSAGE_REPLY",
    "\n  // SEEKDEEP_STRIP_THINK_MESSAGE_REPLY\n  content = stripQwenThinkingBlocks(content);\n"
)

text = insert_after_open(
    text,
    "async function sendLongInteractionReply(interaction, content)",
    "SEEKDEEP_STRIP_THINK_INTERACTION_REPLY",
    "\n  // SEEKDEEP_STRIP_THINK_INTERACTION_REPLY\n  content = stripQwenThinkingBlocks(content);\n"
)

required = [
    "stripQwenThinkingBlocks",
    "SEEKDEEP_STRIP_THINK_MESSAGE_REPLY",
    "SEEKDEEP_STRIP_THINK_INTERACTION_REPLY",
]

missing = [x for x in required if x not in text]
if missing:
    raise SystemExit("Patch failed; missing markers: " + ", ".join(missing))

if re.search(r"(?m)^\s*async\s*$", text):
    raise SystemExit("Standalone async line exists.")

if "askVisionasync" in text:
    raise SystemExit("askVisionasync corruption exists.")

bad_join = re.search(r"\.join\(['\"]\s*\r?\n\s*['\"]\)", text)
if bad_join:
    raise SystemExit("Malformed multiline .join string exists.")

p.write_text(text, encoding="utf-8")
print("Qwen <think> stripping added.")
