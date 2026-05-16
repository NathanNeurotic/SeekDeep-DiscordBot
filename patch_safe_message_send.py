from pathlib import Path
import re

p = Path("index.js")
text = p.read_text(encoding="utf-8")

def replace_js_function(src: str, name: str, replacement: str) -> str:
    patterns = [f"async function {name}", f"function {name}"]
    start = -1

    for marker in patterns:
        pos = src.find(marker)
        if pos != -1 and (start == -1 or pos < start):
            start = pos

    if start == -1:
        raise SystemExit(f"Could not find function {name}.")

    brace = src.find("{", start)
    if brace == -1:
        raise SystemExit(f"Could not find opening brace for {name}.")

    depth = 0
    end = None
    i = brace
    in_string = None
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

        if in_string:
            if escape:
                escape = False
            elif ch == "\\":
                escape = True
            elif ch == in_string:
                in_string = None
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
            in_string = ch
            i += 1
            continue

        if ch == "{":
            depth += 1
        elif ch == "}":
            depth -= 1
            if depth == 0:
                end = i + 1
                break

        i += 1

    if end is None:
        raise SystemExit(f"Could not find end of function {name}.")

    while end < len(src) and src[end] in " \t\r\n":
        end += 1

    return src[:start].rstrip() + "\n\n" + replacement.rstrip() + "\n\n" + src[end:].lstrip()

new_func = r'''async function sendLongMessageReply(message, content) {
  // Stop typing as soon as reply handling starts.
  stopSeekDeepTypingLoopForMessage(message);

  // Suppress duplicate final replies for the same source message.
  if (!seekdeepClaimFinalReply('message', message?.id)) {
    return null;
  }

  content = stripQwenThinkingBlocks(content);

  if (!String(content || '').trim()) {
    content = '[SeekDeep generated an empty response after cleanup. This usually means the model only produced hidden <think> output or the output was stripped as invalid.]';
  }

  const chunks = splitDiscordText(content)
    .map((chunk) => String(chunk || '').trim())
    .filter(Boolean);

  if (!chunks.length) {
    chunks.push('[SeekDeep generated no sendable text.]');
  }

  let previous = null;

  async function sendFirstChunk(payload) {
    // Prefer replying to the source message.
    try {
      return await message.reply(payload);
    } catch (err) {
      const msg = String(err?.message || '');
      const raw = String(err?.rawError?.message || '');
      const code = err?.code;

      const referenceFailed =
        code === 10008 ||
        code === 50035 ||
        msg.includes('Unknown message') ||
        msg.includes('MESSAGE_REFERENCE_UNKNOWN_MESSAGE') ||
        raw.includes('Invalid Form Body');

      if (!referenceFailed) {
        console.error('message.reply failed; falling back to channel.send:', err);
      } else {
        console.warn(`Source message reference failed; falling back to channel.send for message ${message?.id}`);
      }

      if (message.channel && typeof message.channel.send === 'function') {
        return await message.channel.send({
          content: payload.content,
          allowedMentions: payload.allowedMentions,
        });
      }

      throw err;
    }
  }

  async function sendFollowupChunk(parent, payload) {
    if (parent && typeof parent.reply === 'function') {
      try {
        return await parent.reply(payload);
      } catch (err) {
        console.warn('Follow-up reply failed; falling back to channel.send:', err?.message || err);
      }
    }

    if (message.channel && typeof message.channel.send === 'function') {
      return await message.channel.send({
        content: payload.content,
        allowedMentions: payload.allowedMentions,
      });
    }

    throw new Error('Could not send follow-up chunk; no previous message or channel is available.');
  }

  for (let i = 0; i < chunks.length; i++) {
    const payload = {
      content: chunks[i],
      allowedMentions: { repliedUser: false },
    };

    if (!payload.content || !payload.content.trim()) {
      continue;
    }

    if (i === 0) {
      previous = await sendFirstChunk(payload);
    } else {
      previous = await sendFollowupChunk(previous, payload);
    }
  }

  return previous;
}'''

text = replace_js_function(text, "sendLongMessageReply", new_func)

required = [
    "async function sendLongMessageReply(message, content)",
    "sendFirstChunk",
    "sendFollowupChunk",
    "MESSAGE_REFERENCE_UNKNOWN_MESSAGE",
    "generated an empty response after cleanup",
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
print("sendLongMessageReply safe fallback patched.")
