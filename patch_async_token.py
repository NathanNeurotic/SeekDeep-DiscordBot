from pathlib import Path
import re

p = Path("index.js")
text = p.read_text(encoding="utf-8")

# Fix split async function headers:
#   async
#   function name(...)
# -> async function name(...)
text = re.sub(r"(?m)^\s*async\s*\r?\n\s*function\s+", "async function ", text)

# Fix duplicated function header from older broken package.
text = text.replace(
    "async function askVisionasync function askVision",
    "async function askVision"
)

def remove_js_function(src: str, name: str) -> str:
    patterns = [f"async function {name}", f"function {name}"]
    changed = True

    while changed:
        changed = False
        for marker in patterns:
            start = src.find(marker)
            if start == -1:
                continue

            brace = src.find("{", start)
            if brace == -1:
                continue

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
                continue

            while end < len(src) and src[end] in " \t\r\n":
                end += 1

            src = src[:start].rstrip() + "\n\n" + src[end:].lstrip()
            changed = True
            break

    return src

# Remove broken/duplicate safe helpers and insert clean versions.
text = remove_js_function(text, "safeDefer")
text = remove_js_function(text, "safeEditOrReply")

safe_helpers = r'''
async function safeDefer(interaction) {
  try {
    if (!interaction) return false;

    if (typeof interaction.isRepliable === 'function' && !interaction.isRepliable()) {
      return false;
    }

    if (interaction.deferred || interaction.replied) {
      return true;
    }

    await interaction.deferReply();
    return true;
  } catch (err) {
    console.error('Could not defer interaction. It may have expired before acknowledgement:', err);
    return false;
  }
}

async function safeEditOrReply(interaction, payload) {
  try {
    if (!interaction) return null;

    if (interaction.deferred || interaction.replied) {
      return await interaction.editReply(payload);
    }

    return await interaction.reply(payload);
  } catch (err) {
    console.error('Could not send interaction response:', err);
    return null;
  }
}

'''

insert_at = text.find("client.on('interactionCreate'")
if insert_at == -1:
    insert_at = text.find('client.on("interactionCreate"')
if insert_at == -1:
    insert_at = text.find("client.login(")
if insert_at == -1:
    raise SystemExit("Could not find interaction handler or login insertion point.")

text = text[:insert_at].rstrip() + "\n\n" + safe_helpers + "\n" + text[insert_at:].lstrip()

# Ensure interaction defer/edit calls use the helpers, but do NOT alter the helper bodies.
helper_start = text.find("async function safeDefer(interaction)")
helper_end = text.find("client.on('interactionCreate'", helper_start)
if helper_end == -1:
    helper_end = text.find('client.on("interactionCreate"', helper_start)
if helper_end == -1:
    helper_end = len(text)

before_helpers = text[:helper_start]
helpers = text[helper_start:helper_end]
after_helpers = text[helper_end:]

after_helpers = after_helpers.replace("await interaction.deferReply();", "if (!(await safeDefer(interaction))) return;")
after_helpers = after_helpers.replace("await interaction.editReply(", "await safeEditOrReply(interaction, ")

text = before_helpers + helpers + after_helpers

# Sanity checks.
safe_start = text.find("async function safeDefer(interaction)")
safe_end = text.find("async function safeEditOrReply(interaction", safe_start)
if safe_start == -1 or safe_end == -1:
    raise SystemExit("safe helper insertion failed.")

if "await safeDefer(interaction)" in text[safe_start:safe_end]:
    raise SystemExit("Patch failed: safeDefer still calls itself.")

edit_start = safe_end
edit_end = text.find("client.on('interactionCreate'", edit_start)
if edit_end == -1:
    edit_end = text.find('client.on("interactionCreate"', edit_start)
if edit_end == -1:
    edit_end = len(text)

if "await safeEditOrReply(interaction" in text[edit_start:edit_end]:
    raise SystemExit("Patch failed: safeEditOrReply still calls itself.")

if re.search(r"(?m)^\s*async\s*$", text):
    raise SystemExit("Patch failed: standalone async token still exists.")

p.write_text(text, encoding="utf-8")
print("index.js async-token and safe-helper repair applied.")
