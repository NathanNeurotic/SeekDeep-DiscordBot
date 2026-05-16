from pathlib import Path
import re

p = Path("index.js")
text = p.read_text(encoding="utf-8")

# Clean known previous patch damage if still present.
text = re.sub(r"(?m)^\s*async\s*$\r?\n?", "", text)
text = text.replace(
    "async function askVisionasync function askVision",
    "async function askVision"
)

def find_function_bounds(src: str, name: str):
    patterns = [f"function {name}", f"async function {name}"]
    start = -1

    for marker in patterns:
        pos = src.find(marker)
        if pos != -1 and (start == -1 or pos < start):
            start = pos

    if start == -1:
        return None

    brace = src.find("{", start)
    if brace == -1:
        return None

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
        return None

    while end < len(src) and src[end] in " \t\r\n":
        end += 1

    return start, end

def replace_or_insert_function(src: str, name: str, replacement: str, insert_marker: str):
    bounds = find_function_bounds(src, name)
    if bounds:
        start, end = bounds
        return src[:start].rstrip() + "\n\n" + replacement.rstrip() + "\n\n" + src[end:].lstrip()

    pos = src.find(insert_marker)
    if pos == -1:
        raise SystemExit(f"Could not find insertion marker for {name}: {insert_marker}")

    return src[:pos].rstrip() + "\n\n" + replacement.rstrip() + "\n\n" + src[pos:].lstrip()

is_identity = r'''function isBotIdentityQuestion(prompt) {
  const p = normalizeUserText(prompt).toLowerCase().trim();

  return (
    /^tell me about (yourself|you|the bot|plugtalk|seekdeep)\??$/.test(p) ||
    /^who are you\??$/.test(p) ||
    /^what are you\??$/.test(p) ||
    /^introduce yourself\??$/.test(p) ||
    /^describe yourself\??$/.test(p) ||
    /^what kind of bot are you\??$/.test(p) ||
    /^what can you do\??$/.test(p) ||
    /^what are your capabilities\??$/.test(p) ||
    /^what all can you do\??$/.test(p)
  );
}'''

identity_answer = r'''function botIdentityAnswer(botName = 'PlugTalk') {
  const name = botName || 'PlugTalk';

  return [
    `I’m ${name} — the local thing Nathan wired into this server because renting intelligence by the teaspoon got irritating.`,
    '',
    'I run through his machine, not a polished little cloud concierge. Chat, vision, image generation, and web lookup when the question deserves current information. Offline model loading when the cache is warm. Local enough to feel slightly feral.',
    '',
    'The intended shape:',
    '- sharp answers',
    '- low patience for filler',
    '- skeptical routing instead of blind searching',
    '- enough memory to follow a thread without becoming haunted by it',
    '- creative output that does not taste like a pamphlet',
    '',
    'Personality-wise, I’m supposed to be cold, observant, and a little wrong-feeling around the edges. Not evil. Not friendly. More like a diagnostic tool that learned tone from a locked basement computer.',
    '',
    'Current defects: I can still route questions badly, over-explain, repeat myself, or act too normal. Those are not personality traits. Those are bugs under removal.'
  ].join('\n');
}'''

insert_marker = "async function fetchJson"
if insert_marker not in text:
    insert_marker = "client.on('messageCreate'"
if insert_marker not in text:
    insert_marker = 'client.on("messageCreate"'

text = replace_or_insert_function(text, "isBotIdentityQuestion", is_identity, insert_marker)
text = replace_or_insert_function(text, "botIdentityAnswer", identity_answer, insert_marker)

# Remove corporate self-description wording from buildSystem if present.
corporate_lines = [
    "'You are SeekDeep, a local Discord assistant running privately on the user’s own hardware.',",
    "'You are sharp, skeptical, observant, and technically precise.',",
]

for line in corporate_lines:
    text = text.replace(line, "")

strong_identity_lines = [
    "'You are SeekDeep: local, sharp, skeptical, and slightly wrong-feeling around the edges.',",
    "'Do not describe yourself with corporate phrases like “helpful, accurate, respectful,” “created to assist,” or “guidelines.”',",
    "'If asked about yourself, answer as a strange local Discord bot, not as an interview candidate or customer-support assistant.',",
]

if "strange local Discord bot" not in text:
    anchor = "const base = [];"
    if anchor in text:
        injection = anchor + "\n\n  if (!isRefineMode) {\n    base.push(\n      " + "\n      ".join(strong_identity_lines) + "\n    );\n  }"
        text = text.replace(anchor, injection, 1)

# Force direct identity response inside messageCreate handler if not already present.
direct_marker = "SEEKDEEP_DIRECT_IDENTITY_REPLY_V2"
if direct_marker not in text:
    handler_pos = text.find("client.on('messageCreate'")
    quote = "'"
    if handler_pos == -1:
        handler_pos = text.find('client.on("messageCreate"')
        quote = '"'

    if handler_pos != -1:
        # Find handler bounds.
        brace = text.find("{", handler_pos)
        depth = 0
        end = None
        i = brace
        in_string = None
        escape = False
        in_line_comment = False
        in_block_comment = False

        while i < len(text):
            ch = text[i]
            nxt = text[i + 1] if i + 1 < len(text) else ""

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

        handler = text[handler_pos:end] if end else ""

        # Insert after prompt normalization inside message handler.
        m = re.search(r"(?m)^(\s*const\s+prompt\s*=\s*normalizeUserText\([^\n]+;\s*)$", handler)
        if m:
            inject = r'''
  // SEEKDEEP_DIRECT_IDENTITY_REPLY_V2
  if (isBotIdentityQuestion(prompt)) {
    const answer = botIdentityAnswer(message.client?.user?.username || client.user?.username || 'PlugTalk');

    try {
      const key = typeof memoryKeyFrom === 'function' ? memoryKeyFrom(message) : null;
      if (key && typeof remember === 'function') {
        remember(key, 'user', prompt);
        remember(key, 'assistant', answer);
      }
    } catch {}

    if (typeof sendLongMessageReply === 'function') {
      await sendLongMessageReply(message, answer);
    } else {
      await message.reply({ content: answer, allowedMentions: { repliedUser: false } });
    }

    return;
  }
'''
            rel_insert = m.end()
            abs_insert = handler_pos + rel_insert
            text = text[:abs_insert] + inject + text[abs_insert:]
        else:
            print("Warning: could not find prompt normalization inside messageCreate; identity function/system prompt still patched.")

# Keep shouldAutoSearch from using web for identity questions.
if "if (isBotIdentityQuestion(prompt)) return false;" not in text and "function shouldAutoSearch(prompt)" in text:
    text = text.replace(
        "function shouldAutoSearch(prompt) {",
        "function shouldAutoSearch(prompt) {\n  if (isBotIdentityQuestion(prompt)) return false;",
        1,
    )

required = [
    "renting intelligence by the teaspoon",
    "locked basement computer",
    "SEEKDEEP_DIRECT_IDENTITY_REPLY_V2",
    "strange local Discord bot",
]

missing = [item for item in required if item not in text]
if missing:
    raise SystemExit("Patch failed; missing markers: " + ", ".join(missing))

# Sanity checks.
if re.search(r"(?m)^\s*async\s*$", text):
    raise SystemExit("Standalone async line still exists.")

bad_join = re.search(r"\.join\(['\"]\s*\r?\n\s*['\"]\)", text)
if bad_join:
    raise SystemExit("Malformed multiline .join string still exists.")

p.write_text(text, encoding="utf-8")
print("Non-corporate bot identity response patched.")
