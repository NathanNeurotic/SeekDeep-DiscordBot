from pathlib import Path
import re
import sys

if len(sys.argv) != 2:
    raise SystemExit("Usage: patch_button_router_fix.py <index.js>")

path = Path(sys.argv[1])
raw = path.read_bytes()
newline = "\r\n" if b"\r\n" in raw else "\n"
text = raw.decode("utf-8-sig").replace("\r\n", "\n").replace("\r", "\n")


def fail(msg):
    raise SystemExit(msg)


def find_function_block(src, func_pattern):
    m = re.search(func_pattern, src)
    if not m:
        return None
    start = m.start()
    body_start = m.end()
    depth = 1
    i = body_start
    in_single = in_double = in_template = False
    in_line_comment = in_block_comment = False
    escaped = False

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
                return {
                    "match": m,
                    "start": start,
                    "body_start": body_start,
                    "body_end": i,
                    "end": i + 1,
                    "header": src[start:body_start],
                    "body": src[body_start:i],
                    "full": src[start:i+1],
                }
        i += 1

    return None


def remove_decl(body_text, var_name):
    pattern = re.compile(r"^[ \t]*(?:const|let|var)\s+" + re.escape(var_name) + r"\s*=", re.M)
    while True:
        m = pattern.search(body_text)
        if not m:
            return body_text
        j = m.end()
        in_single = in_double = in_template = False
        in_line_comment = in_block_comment = False
        escaped = False
        while j < len(body_text):
            ch = body_text[j]
            nxt = body_text[j + 1] if j + 1 < len(body_text) else ""

            if in_line_comment:
                if ch == "\n":
                    in_line_comment = False
                j += 1
                continue

            if in_block_comment:
                if ch == "*" and nxt == "/":
                    in_block_comment = False
                    j += 2
                    continue
                j += 1
                continue

            if in_single:
                if not escaped and ch == "\\":
                    escaped = True
                elif not escaped and ch == "'":
                    in_single = False
                else:
                    escaped = False
                j += 1
                continue

            if in_double:
                if not escaped and ch == "\\":
                    escaped = True
                elif not escaped and ch == '"':
                    in_double = False
                else:
                    escaped = False
                j += 1
                continue

            if in_template:
                if not escaped and ch == "\\":
                    escaped = True
                elif not escaped and ch == "`":
                    in_template = False
                else:
                    escaped = False
                j += 1
                continue

            if ch == "/" and nxt == "/":
                in_line_comment = True
                j += 2
                continue

            if ch == "/" and nxt == "*":
                in_block_comment = True
                j += 2
                continue

            if ch == "'":
                in_single = True
                j += 1
                continue

            if ch == '"':
                in_double = True
                j += 1
                continue

            if ch == "`":
                in_template = True
                j += 1
                continue

            if ch == ";":
                j += 1
                if j < len(body_text) and body_text[j] == "\n":
                    j += 1
                body_text = body_text[:m.start()] + body_text[j:]
                break

            j += 1
        else:
            fail(f"Could not find semicolon for declaration: {var_name}")


def strip_duplicate_defer_blocks(body_text):
    # Remove direct deferUpdate statements
    body_text = re.sub(r"^[ \t]*await\s+interaction\.deferUpdate\(\);\s*\n?", "", body_text, flags=re.M)
    # Remove tiny wrapped defer blocks if present
    body_text = re.sub(
        r"^[ \t]*if\s*\(\s*interaction\s*&&\s*!interaction\.deferred\s*&&\s*!interaction\.replied\s*\)\s*\{\s*\n"
        r"[ \t]*try\s*\{\s*\n"
        r"[ \t]*await\s+interaction\.deferUpdate\(\);\s*\n"
        r"[ \t]*\}\s*catch\s*\{\s*\}\s*\n"
        r"[ \t]*\}\s*\n?",
        "",
        body_text,
        flags=re.M,
    )
    return body_text


# -------------------------------------------------------------------------
# 1) Repair seekdeepHandleImageButton
# -------------------------------------------------------------------------
fn = find_function_block(text, r"async function seekdeepHandleImageButton\s*\(([^)]*)\)\s*\{")
if not fn:
    fail("Could not locate seekdeepHandleImageButton.")

body = fn["body"]

# Remove pre-existing routing prelude fragments so we can install one clean copy.
body = remove_decl(body, "customId")
body = remove_decl(body, "match")
body = remove_decl(body, "isSeekdeepImageButton")
body = remove_decl(body, "seekdeepButtonId")
body = strip_duplicate_defer_blocks(body)

prelude = """
  const customId = String(interaction?.customId || '').trim();
  const isSeekdeepImageButton =
    /^seekdeep:(?:image-choice|regen):(original|refined|both):/.test(customId) ||
    /^seekdeep:(?:original|refined|both):/.test(customId) ||
    /^seekdeep:(?:regenerate|download|archive):/.test(customId);

  if (!isSeekdeepImageButton) {
    return false;
  }

  const match =
    customId.match(/^seekdeep:(?:image-choice|regen):(original|refined|both):(.+)$/) ||
    customId.match(/^seekdeep:(original|refined|both):(.+)$/) ||
    customId.match(/^seekdeep:(regenerate|download|archive):(.+)$/) ||
    null;

  if (!interaction.deferred && !interaction.replied) {
    try {
      await interaction.deferUpdate();
    } catch {}
  }

""".lstrip("\n")

new_fn = fn["header"] + "\n" + prelude + body.lstrip("\n") + "}"
text = text[:fn["start"]] + new_fn + text[fn["end"]:]

# -------------------------------------------------------------------------
# 2) Ensure interactionCreate routes seekdeep image buttons early
# -------------------------------------------------------------------------
router_marker = "// SeekDeep image button router hard-fix"
if router_marker not in text:
    candidates = [
        r"client\.on\(\s*['\"]interactionCreate['\"]\s*,\s*async\s*\(\s*interaction\s*\)\s*=>\s*\{",
        r"client\.on\(\s*Events\.InteractionCreate\s*,\s*async\s*\(\s*interaction\s*\)\s*=>\s*\{",
    ]
    inserted = False
    for pat in candidates:
        m = re.search(pat, text)
        if not m:
            continue
        ins = m.end()
        block = """

  // SeekDeep image button router hard-fix
  if (interaction.isButton()) {
    const seekdeepButtonId = String(interaction.customId || '').trim();
    if (
      /^seekdeep:(?:image-choice|regen):(original|refined|both):/.test(seekdeepButtonId) ||
      /^seekdeep:(?:original|refined|both):/.test(seekdeepButtonId) ||
      /^seekdeep:(?:regenerate|download|archive):/.test(seekdeepButtonId)
    ) {
      await seekdeepHandleImageButton(interaction);
      return;
    }
  }
"""
        text = text[:ins] + block + text[ins:]
        inserted = True
        break
    if not inserted:
        fail("Could not locate interactionCreate handler to install router hard-fix.")

# -------------------------------------------------------------------------
# Validation
# -------------------------------------------------------------------------
if text.count("const customId = String(interaction?.customId || '').trim();") != 1:
    fail("Expected exactly one inserted customId prelude in seekdeepHandleImageButton.")

if router_marker not in text:
    fail("Router hard-fix marker not present after patch.")

# Make sure no malformed duplicate declarations remain right at function top.
fn2 = find_function_block(text, r"async function seekdeepHandleImageButton\s*\(([^)]*)\)\s*\{")
if not fn2:
    fail("Patched seekdeepHandleImageButton could not be re-located.")

slice2 = fn2["full"]
if len(re.findall(r"\b(?:const|let|var)\s+customId\s*=", slice2)) != 1:
    fail("customId declaration count inside seekdeepHandleImageButton is not 1.")
if len(re.findall(r"\b(?:const|let|var)\s+match\s*=", slice2)) != 1:
    fail("match declaration count inside seekdeepHandleImageButton is not 1.")

bad_fragments = [
    "Cannot access 'customId' before initialization",
    "Identifier 'customId' has already been declared",
]
# These are runtime history strings, not code errors. Don't fail on mere text presence elsewhere.

out = text if newline == "\n" else text.replace("\n", "\r\n")
path.write_bytes(out.encode("utf-8"))
print("Patched image button router + ack hard-fix.")