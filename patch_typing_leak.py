from pathlib import Path
import re

p = Path("index.js")
text = p.read_text(encoding="utf-8")

# Clean known old corruption if present.
text = re.sub(r"(?m)^\s*async\s*$\r?\n?", "", text)
text = text.replace(
    "async function askVisionasync function askVision",
    "async function askVision"
)

# 1) Reduce hard-stop max from 10 minutes to 2 minutes unless explicitly overridden.
text = text.replace(
    "const SEEKDEEP_TYPING_MAX_MS = Number(process.env.SEEKDEEP_TYPING_MAX_MS || 600000);",
    "const SEEKDEEP_TYPING_MAX_MS = Number(process.env.SEEKDEEP_TYPING_MAX_MS || 120000);"
)

# 2) Add stop helper if missing.
helper = r'''
function stopSeekDeepTypingLoopForMessage(message) {
  try {
    if (message && message.__seekdeepTypingLoop) {
      message.__seekdeepTypingLoop.stop();
      message.__seekdeepTypingLoop = null;
    }
  } catch (err) {
    console.error('Failed to stop typing loop:', err?.message || err);
  }
}

'''

if "function stopSeekDeepTypingLoopForMessage(message)" not in text:
    marker = "async function sendLongMessageReply"
    pos = text.find(marker)
    if pos == -1:
        raise SystemExit("Could not find sendLongMessageReply insertion point.")
    text = text[:pos].rstrip() + "\n\n" + helper + text[pos:].lstrip()

# 3) Ensure sendLongMessageReply stops typing BEFORE final reply dedupe can return.
sig = "async function sendLongMessageReply(message, content) {"
pos = text.find(sig)
if pos == -1:
    raise SystemExit("Could not find async function sendLongMessageReply(message, content).")

next_func = text.find("\nasync function ", pos + len(sig))
if next_func == -1:
    next_func = text.find("\nfunction ", pos + len(sig))
if next_func == -1:
    next_func = len(text)

body = text[pos:next_func]

# Remove older stop hook fragments so placement is deterministic.
body = re.sub(
    r"(?ms)\s*// SEEKDEEP_STOP_TYPING_ON_MESSAGE_REPLY\s*if \(message && message\.__seekdeepTypingLoop\) \{.*?\}\s*",
    "\n",
    body,
)

# Add deterministic stop hook immediately after the opening brace.
if "SEEKDEEP_STOP_TYPING_BEFORE_REPLY_OR_DEDUPE" not in body:
    brace = body.find("{")
    inject = r'''
  // SEEKDEEP_STOP_TYPING_BEFORE_REPLY_OR_DEDUPE
  stopSeekDeepTypingLoopForMessage(message);
'''
    body = body[:brace + 1] + inject + body[brace + 1:]

text = text[:pos] + body + text[next_func:]

# 4) If duplicate prompt suppression returns after starting typing, stop before return.
text = text.replace(
    "console.warn(`Duplicate prompt suppressed from ${message.author?.id || 'unknown'} in ${message.channel?.id || 'unknown'}`);\n    return;",
    "console.warn(`Duplicate prompt suppressed from ${message.author?.id || 'unknown'} in ${message.channel?.id || 'unknown'}`);\n    stopSeekDeepTypingLoopForMessage(message);\n    return;"
)

text = text.replace(
    "console.warn(`Duplicate message handler path suppressed before generation: ${message?.id}`);\n    return;",
    "console.warn(`Duplicate message handler path suppressed before generation: ${message?.id}`);\n    stopSeekDeepTypingLoopForMessage(message);\n    return;"
)

# 5) Add a finally-style safety stop near common message handler error returns if present.
text = text.replace(
    "await sendLongMessageReply(message, `SeekDeep request failed.\\n\\nError:\\n${err.message}`);",
    "stopSeekDeepTypingLoopForMessage(message);\n      await sendLongMessageReply(message, `SeekDeep request failed.\\n\\nError:\\n${err.message}`);"
)

required = [
    "function stopSeekDeepTypingLoopForMessage",
    "SEEKDEEP_STOP_TYPING_BEFORE_REPLY_OR_DEDUPE",
    "SEEKDEEP_TYPING_MAX_MS = Number(process.env.SEEKDEEP_TYPING_MAX_MS || 120000)",
]

missing = [x for x in required if x not in text]
if missing:
    raise SystemExit("Patch failed; missing markers: " + ", ".join(missing))

if re.search(r"(?m)^\s*async\s*$", text):
    raise SystemExit("Standalone async line exists after patch.")

if "askVisionasync" in text:
    raise SystemExit("askVisionasync corruption exists after patch.")

bad_join = re.search(r"\.join\(['\"]\s*\r?\n\s*['\"]\)", text)
if bad_join:
    raise SystemExit("Malformed multiline .join string exists after patch.")

p.write_text(text, encoding="utf-8")
print("Typing-loop leak repair applied.")
