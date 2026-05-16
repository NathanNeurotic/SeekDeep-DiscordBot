from pathlib import Path
import re
import sys

if len(sys.argv) != 2:
    raise SystemExit("Usage: patch_archive_mention_route.py <index.js>")

path = Path(sys.argv[1])
raw = path.read_bytes()
newline = "\r\n" if b"\r\n" in raw else "\n"
text = raw.decode("utf-8-sig").replace("\r\n", "\n").replace("\r", "\n")


def fail(msg):
    raise SystemExit(msg)


def find_matching_brace(source, open_brace_index):
    depth = 0
    i = open_brace_index
    in_single = False
    in_double = False
    in_template = False
    in_line_comment = False
    in_block_comment = False
    escaped = False

    while i < len(source):
        ch = source[i]
        nxt = source[i + 1] if i + 1 < len(source) else ""

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
        if in_single:
            if not escaped and ch == "\\":
                escaped = True
            elif not escaped and ch == "'":
                in_single = False
            else:
                escaped = False
            i += 1
            continue
        if in_double:
            if not escaped and ch == "\\":
                escaped = True
            elif not escaped and ch == '"':
                in_double = False
            else:
                escaped = False
            i += 1
            continue
        if in_template:
            if not escaped and ch == "\\":
                escaped = True
            elif not escaped and ch == "`":
                in_template = False
            else:
                escaped = False
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
        if ch == "'":
            in_single = True
            i += 1
            continue
        if ch == '"':
            in_double = True
            i += 1
            continue
        if ch == "`":
            in_template = True
            i += 1
            continue

        if ch == "{":
            depth += 1
        elif ch == "}":
            depth -= 1
            if depth == 0:
                return i
        i += 1

    fail("Could not find matching closing brace.")


def get_function(source, name):
    for prefix in ("async function ", "function "):
        start = source.find(prefix + name + "(")
        if start >= 0:
            break
    else:
        return None, -1, -1

    sig = source[start:start + 1500]
    m = re.search(r"\)\s*\{", sig)
    if not m:
        fail(f"Could not find opening brace for {name}")
    open_brace = start + m.end() - 1
    close = find_matching_brace(source, open_brace)
    return source[start:close + 1], start, close + 1


def replace_function(source, name, new_fn):
    _fn, start, end = get_function(source, name)
    if start < 0:
        fail(f"Missing function: {name}")
    return source[:start] + new_fn.rstrip() + source[end:]


required = ["seekdeepIsArchiveOpenPrompt", "seekdeepHandleArchiveOpenMessage", "seekdeepGetOrCreateUserArchiveThread"]
for name in required:
    if (f"function {name}(" not in text) and (f"async function {name}(" not in text):
        fail(f"Missing required function: {name}. Apply archive status v2 command pack first.")


is_open_fn = r"""function seekdeepIsArchiveOpenPrompt(value = '') {
  const raw = String(value || '').trim();
  const withoutBotMention = raw
    .replace(/<@!?\d+>/g, (mention, offset) => {
      // Preserve non-leading mentions so "archive @user" still routes.
      const before = raw.slice(0, offset).trim();
      return before ? mention : ' ';
    })
    .replace(/\bseekotics\b/gi, ' ')
    .replace(/\bseekdeep\b/gi, ' ')
    .replace(/^[@/\s]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();

  const cleaned = typeof seekdeepCleanMessageCommandPrompt === 'function'
    ? seekdeepCleanMessageCommandPrompt(value).toLowerCase()
    : withoutBotMention;

  return Boolean(
    /^(?:archive\s+(?:shared|me)|open\s+archive(?:\s+(?:shared|me))?)$/i.test(cleaned) ||
    /^(?:archive|open\s+archive)\s+<@!?\d+>$/i.test(withoutBotMention) ||
    /^archive\s+@/i.test(withoutBotMention)
  );
}"""

handle_open_fn = r"""async function seekdeepHandleArchiveOpenMessage(message, prompt = '') {
  if (!message || !seekdeepIsArchiveOpenPrompt(prompt || message.content || '')) return false;

  if (!message.guild) {
    await message.reply({
      content: 'Archive threads only work inside a server.',
      allowedMentions: { repliedUser: false },
    });
    return true;
  }

  const raw = String(prompt || message.content || '');
  const clean = typeof seekdeepCleanMessageCommandPrompt === 'function'
    ? seekdeepCleanMessageCommandPrompt(raw).toLowerCase()
    : raw.toLowerCase().trim();

  if (typeof seekdeepLogRoute === 'function') {
    seekdeepLogRoute('archive-open-message', raw);
  }

  if (/\bshared\b/i.test(clean)) {
    const { thread } = await seekdeepGetOrCreateSharedArchiveThread(message);
    await message.reply({
      content: `Shared archive: <#${thread.id}>`,
      allowedMentions: { repliedUser: false },
    });
    return true;
  }

  let targetUser = message.author;
  const mentioned = message.mentions?.users?.first?.();

  if (mentioned) {
    targetUser = mentioned;
  } else if (!/\bme\b/i.test(clean)) {
    await message.reply({
      content: 'Use `archive me`, `archive shared`, or `archive @user`.',
      allowedMentions: { repliedUser: false },
    });
    return true;
  }

  const { thread, threadName } = await seekdeepGetOrCreateUserArchiveThread(message, targetUser);

  await message.reply({
    content: [
      mentioned ? `Archive for <@${targetUser.id}>: <#${thread.id}>` : `Your archive: <#${thread.id}>`,
      `Thread: ${threadName}`,
    ].join('\n'),
    allowedMentions: { repliedUser: false },
  });

  return true;
}"""

text = replace_function(text, "seekdeepIsArchiveOpenPrompt", is_open_fn)
text = replace_function(text, "seekdeepHandleArchiveOpenMessage", handle_open_fn)

for needle, label in [
    ("Preserve non-leading mentions", "mention-preserving detector"),
    ("archive @user", "help text"),
    ("archive-open-message", "route log"),
    ("message.mentions?.users?.first?.()", "mention lookup"),
]:
    if needle not in text:
        fail(f"Missing required patch element: {label}")

for bad in ["}, target = null) {", "state = {) {", "state = {,"]:
    if bad in text:
        fail(f"Malformed code detected after patch: {bad}")

out = text if newline == "\n" else text.replace("\n", "\r\n")
path.write_bytes(out.encode("utf-8"))
print("Patched archive @user mention route.")