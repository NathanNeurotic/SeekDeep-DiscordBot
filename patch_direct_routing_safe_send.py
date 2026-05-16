from pathlib import Path
import re

p = Path("index.js")
text = p.read_text(encoding="utf-8")

# Clean known accidental corruption if present.
text = re.sub(r"(?m)^\s*async\s*$\r?\n?", "", text)
text = text.replace("async function askVisionasync function askVision", "async function askVision")

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

routing_helpers = r'''
// SEEKDEEP_DIRECT_ROUTING_START
function isExplicitStatusRequest(prompt) {
  const p = normalizeUserText(prompt).toLowerCase().trim();

  return (
    /^status\??$/.test(p) ||
    /^bot status\??$/.test(p) ||
    /^server status\??$/.test(p) ||
    /^local ai status\??$/.test(p) ||
    /^local ai server status\??$/.test(p) ||
    /^backend status\??$/.test(p) ||
    /^health\??$/.test(p)
  );
}

function isExactPongTest(prompt) {
  const p = normalizeUserText(prompt).toLowerCase().trim();

  return (
    /^pong\??$/.test(p) ||
    /^ping\??$/.test(p) ||
    /^say pong\.?$/.test(p) ||
    /^say only pong\.?$/.test(p) ||
    /^reply pong\.?$/.test(p) ||
    /^reply only pong\.?$/.test(p)
  );
}
// SEEKDEEP_DIRECT_ROUTING_END

'''

# Add direct routing helpers once.
if "SEEKDEEP_DIRECT_ROUTING_START" not in text:
    insert_pos = text.find("function isBotIdentityQuestion")
    if insert_pos == -1:
        insert_pos = text.find("function shouldAutoSearch")
    if insert_pos == -1:
        insert_pos = text.find("async function statusText")
    if insert_pos == -1:
        raise SystemExit("Could not find insertion point for direct routing helpers.")

    text = text[:insert_pos].rstrip() + "\n\n" + routing_helpers + text[insert_pos:].lstrip()

# Replace sendLongMessageReply with safe fallback version.
safe_send = r'''async function sendLongMessageReply(message, content) {
  stopSeekDeepTypingLoopForMessage(message);

  if (!seekdeepClaimFinalReply('message', message?.id)) {
    return null;
  }

  if (typeof stripQwenThinkingBlocks === 'function') {
    content = stripQwenThinkingBlocks(content);
  }

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

  async function sendViaChannel(payload) {
    if (!message.channel || typeof message.channel.send !== 'function') {
      throw new Error('No channel.send available for fallback message delivery.');
    }

    return await message.channel.send({
      content: payload.content,
      allowedMentions: payload.allowedMentions || { repliedUser: false },
    });
  }

  async function sendFirstChunk(payload) {
    try {
      return await message.reply(payload);
    } catch (err) {
      const code = err?.code;
      const raw = String(err?.rawError?.message || '');
      const msg = String(err?.message || '');

      const referenceFailed =
        code === 10008 ||
        code === 50035 ||
        raw.includes('Invalid Form Body') ||
        raw.includes('Unknown message') ||
        msg.includes('Unknown message') ||
        msg.includes('MESSAGE_REFERENCE_UNKNOWN_MESSAGE');

      if (referenceFailed) {
        console.warn(`Source message reference failed; falling back to channel.send for message ${message?.id}`);
      } else {
        console.error('message.reply failed; falling back to channel.send:', err);
      }

      return await sendViaChannel(payload);
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

    return await sendViaChannel(payload);
  }

  for (let i = 0; i < chunks.length; i++) {
    const payload = {
      content: chunks[i],
      allowedMentions: { repliedUser: false },
    };

    if (!payload.content || !payload.content.trim()) continue;

    if (i === 0) {
      previous = await sendFirstChunk(payload);
    } else {
      previous = await sendFollowupChunk(previous, payload);
    }
  }

  return previous;
}'''

text = replace_js_function(text, "sendLongMessageReply", safe_send)

# Insert direct status/pong routing in messageCreate try block after memoryKeyFrom(message).
direct_block = r'''
    // SEEKDEEP_DIRECT_STATUS_PONG_ROUTING
    if (isExactPongTest(prompt)) {
      remember(key, 'user', prompt);
      remember(key, 'assistant', 'pong');
      await sendLongMessageReply(message, 'pong');
      return;
    }

    if (isExplicitStatusRequest(prompt)) {
      const answer = asTextBlock(await statusText());
      remember(key, 'user', prompt);
      remember(key, 'assistant', answer);
      await sendLongMessageReply(message, answer);
      return;
    }

'''

if "SEEKDEEP_DIRECT_STATUS_PONG_ROUTING" not in text:
    marker = "    const key = memoryKeyFrom(message);\n"
    if marker not in text:
        raise SystemExit("Could not find const key = memoryKeyFrom(message); marker in messageCreate handler.")

    text = text.replace(marker, marker + direct_block, 1)

required = [
    "SEEKDEEP_DIRECT_ROUTING_START",
    "function isExplicitStatusRequest",
    "function isExactPongTest",
    "async function sendLongMessageReply(message, content)",
    "sendViaChannel",
    "SEEKDEEP_DIRECT_STATUS_PONG_ROUTING",
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
print("Direct status/pong routing and safe message send patched.")
