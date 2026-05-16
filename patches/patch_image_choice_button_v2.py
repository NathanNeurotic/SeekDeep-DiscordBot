from pathlib import Path
import re
import sys

if len(sys.argv) != 2:
    raise SystemExit("Usage: patch_image_choice_button_v2.py <index.js>")

path = Path(sys.argv[1])
raw = path.read_bytes()
newline = "\r\n" if b"\r\n" in raw else "\n"
text = raw.decode("utf-8-sig").replace("\r\n", "\n").replace("\r", "\n")


def fail(msg):
    raise SystemExit(msg)


m = re.search(r"async function seekdeepHandleImageButton\s*\(([^)]*)\)\s*\{", text)
if not m:
    fail("Could not locate async function seekdeepHandleImageButton(...).")

start = m.start()
body_start = m.end()

# JS-aware brace scan for function end.
depth = 1
i = body_start
in_single = False
in_double = False
in_template = False
in_line_comment = False
in_block_comment = False
escaped = False

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
            body_end = i
            break

    i += 1
else:
    fail("Could not find end of seekdeepHandleImageButton function.")

header = text[start:body_start]
body = text[body_start:body_end]
footer = text[body_end:body_end + 1]


def remove_decl(body_text, var_name):
    # Removes JS variable declaration statement:
    #   const varName = ...;
    # Handles multi-line declaration by scanning to the first semicolon outside strings/templates/comments.
    pattern = re.compile(r"^[ \t]*(?:const|let|var)\s+" + re.escape(var_name) + r"\s*=", re.M)
    while True:
        match = pattern.search(body_text)
        if not match:
            return body_text

        pos = match.end()
        j = pos
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
                # Include following newline indentation if present.
                if j < len(body_text) and body_text[j] == "\n":
                    j += 1
                body_text = body_text[:match.start()] + body_text[j:]
                break

            j += 1
        else:
            raise SystemExit(f"Could not find semicolon for declaration {var_name}")


body = remove_decl(body, "customId")
body = remove_decl(body, "match")

# Remove standalone duplicate deferUpdate statements inside this handler; prelude will add one.
body = re.sub(r"^[ \t]*await\s+interaction\.deferUpdate\(\);\s*\n?", "", body, flags=re.M)

prelude = """\n  const customId = String(interaction?.customId || '').trim();\n  const match =\n    customId.match(/^seekdeep:(?:image-choice|regen):(original|refined|both):(.+)$/) ||\n    customId.match(/^seekdeep:(original|refined|both):(.+)$/) ||\n    customId.match(/^seekdeep:(regenerate|download|archive):(.+)$/) ||\n    null;\n\n  if (interaction && !interaction.deferred && !interaction.replied) {\n    try {\n      await interaction.deferUpdate();\n    } catch {}\n  }\n\n"""

new_fn = header + prelude + body.lstrip("\n") + footer
new_text = text[:start] + new_fn + text[body_end + 1:]

# Validate only one function and no duplicate local declarations inside function.
m2 = re.search(r"async function seekdeepHandleImageButton\s*\(([^)]*)\)\s*\{", new_text)
if not m2:
    fail("Patched function disappeared.")

fn_count = len(re.findall(r"async function seekdeepHandleImageButton\s*\(", new_text))
if fn_count != 1:
    fail(f"Unexpected seekdeepHandleImageButton function count: {fn_count}")

patched_fn_start = m2.start()
patched_body_start = m2.end()

# Fast local scan until next top-level-ish function marker for validation.
next_fn = re.search(r"\n(?:async\s+)?function\s+\w+\s*\(", new_text[patched_body_start:])
patched_slice = new_text[patched_body_start: patched_body_start + (next_fn.start() if next_fn else 4000)]

if len(re.findall(r"\b(?:const|let|var)\s+customId\s*=", patched_slice)) != 1:
    fail("customId declaration count inside patched area is not 1.")
if len(re.findall(r"\b(?:const|let|var)\s+match\s*=", patched_slice)) != 1:
    fail("match declaration count inside patched area is not 1.")
if "await interaction.deferUpdate();" not in patched_slice:
    fail("deferUpdate was not inserted.")

for bad in ["}, target = null) {", "state = {) {", "state = {,"]:
    if bad in new_text:
        fail(f"Malformed code detected after patch: {bad}")

out = new_text if newline == "\n" else new_text.replace("\n", "\r\n")
path.write_bytes(out.encode("utf-8"))
print("Patched seekdeepHandleImageButton v2.")