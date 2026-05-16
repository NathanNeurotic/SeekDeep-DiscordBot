from pathlib import Path

p = Path("index.js")
text = p.read_text(encoding="utf-8")

def remove_js_function(src: str, name: str) -> str:
    marker = f"async function {name}"
    while True:
        start = src.find(marker)
        if start == -1:
            return src

        brace = src.find("{", start)
        if brace == -1:
            return src

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
            return src

        # Also remove trailing blank lines.
        while end < len(src) and src[end] in " \t\r\n":
            end += 1

        src = src[:start].rstrip() + "\n\n" + src[end:].lstrip()

helpers = r'''
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

# Remove all broken duplicate helper definitions, then insert one clean copy.
text = remove_js_function(text, "safeDefer")
text = remove_js_function(text, "safeEditOrReply")

insert_markers = [
    "client.on('interactionCreate'",
    'client.on("interactionCreate"',
]

insert_at = -1
for marker in insert_markers:
    insert_at = text.find(marker)
    if insert_at != -1:
        break

if insert_at == -1:
    # Fallback: put helpers before login.
    for marker in ["client.login(", "await client.login("]:
        insert_at = text.find(marker)
        if insert_at != -1:
            break

if insert_at == -1:
    raise SystemExit("Could not find where to insert safe helper functions.")

text = text[:insert_at].rstrip() + "\n\n" + helpers + "\n" + text[insert_at:].lstrip()

# Guard against the exact recursion failure.
if "async function safeDefer(interaction)" not in text:
    raise SystemExit("safeDefer was not inserted.")

safe_start = text.find("async function safeDefer(interaction)")
safe_end = text.find("async function safeEditOrReply(interaction", safe_start)
safe_body = text[safe_start:safe_end]
if "await safeDefer(interaction)" in safe_body:
    raise SystemExit("Patch failed: safeDefer still calls itself.")

edit_start = text.find("async function safeEditOrReply(interaction")
edit_end = text.find("client.on('interactionCreate'", edit_start)
if edit_end == -1:
    edit_end = text.find('client.on("interactionCreate"', edit_start)
edit_body = text[edit_start:edit_end if edit_end != -1 else len(text)]
if "await safeEditOrReply(interaction" in edit_body:
    raise SystemExit("Patch failed: safeEditOrReply still calls itself.")

p.write_text(text, encoding="utf-8")
print("safeDefer/safeEditOrReply helper recursion fixed.")
