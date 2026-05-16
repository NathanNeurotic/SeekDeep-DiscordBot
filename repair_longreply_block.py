from pathlib import Path
import re
import subprocess
import sys

p = Path("index.js")
text = p.read_text(encoding="utf-8")

# Clean known old corruption if present.
text = re.sub(r"(?m)^\s*async\s*$\r?\n?", "", text)
text = text.replace(
    "async function askVisionasync function askVision",
    "async function askVision"
)

start_marker = "// SEEKDEEP_LONG_REPLY_HELPERS_START"
end_marker = "// SEEKDEEP_LONG_REPLY_HELPERS_END"

start = text.find(start_marker)
end = text.find(end_marker)

if start == -1 or end == -1:
    raise SystemExit("Could not find SEEKDEEP_LONG_REPLY_HELPERS_START/END markers.")

end += len(end_marker)

clean_block = r'''// SEEKDEEP_LONG_REPLY_HELPERS_START

function asTextBlock(value, lang = 'text') {
  return `\`\`\`${lang}\n${String(value ?? '').trim()}\n\`\`\``;
}

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

async function sendLongMessageReply(message, content) {
  // Stop typing as soon as a reply begins or a duplicate path is suppressed.
  stopSeekDeepTypingLoopForMessage(message);

  // Suppress duplicate final replies for the same source message.
  if (!seekdeepClaimFinalReply('message', message?.id)) {
    return null;
  }

  const chunks = splitDiscordText(content);
  let previous = null;

  for (let i = 0; i < chunks.length; i++) {
    const payload = {
      content: chunks[i],
      allowedMentions: { repliedUser: false },
    };

    if (i === 0) {
      previous = await message.reply(payload);
      continue;
    }

    if (previous && typeof previous.reply === 'function') {
      previous = await previous.reply(payload);
    } else if (message.channel && typeof message.channel.send === 'function') {
      previous = await message.channel.send(payload);
    } else {
      console.error('Could not send follow-up chunk; no previous message or channel is available.');
      break;
    }
  }

  return previous;
}
// SEEKDEEP_LONG_REPLY_HELPERS_END'''

text = text[:start] + clean_block + text[end:]

required = [
    "function asTextBlock",
    "function stopSeekDeepTypingLoopForMessage",
    "async function sendLongMessageReply",
    "stopSeekDeepTypingLoopForMessage(message);",
    "seekdeepClaimFinalReply('message', message?.id)",
    "return previous;",
]

missing = [item for item in required if item not in text]
if missing:
    raise SystemExit("Repair failed; missing markers: " + ", ".join(missing))

if re.search(r"(?m)^\s*async\s*$", text):
    raise SystemExit("Standalone async line exists after repair.")

if "askVisionasync" in text:
    raise SystemExit("askVisionasync corruption exists after repair.")

bad_join = re.search(r"\.join\(['\"]\s*\r?\n\s*['\"]\)", text)
if bad_join:
    raise SystemExit("Malformed multiline .join string exists after repair.")

p.write_text(text, encoding="utf-8")

proc = subprocess.run(
    ["node", "--check", "index.js"],
    text=True,
    capture_output=True,
)

if proc.returncode != 0:
    print(proc.stdout)
    print(proc.stderr)
    raise SystemExit("node --check still fails after long-reply repair.")

print("Long-reply helper block repaired and node --check passed.")
