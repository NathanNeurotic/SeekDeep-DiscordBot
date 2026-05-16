from pathlib import Path
import re
import sys

if len(sys.argv) != 2:
    raise SystemExit('Usage: patch_image_choice_button.py <index.js>')

path = Path(sys.argv[1])
raw = path.read_bytes()
newline = '\r\n' if b'\r\n' in raw else '\n'
text = raw.decode('utf-8-sig').replace('\r\n', '\n').replace('\r', '\n')

m = re.search(r'async function seekdeepHandleImageButton\s*\(([^)]*)\)\s*\{', text)
if not m:
    raise SystemExit('Could not locate async function seekdeepHandleImageButton(...).')

start = m.start()
body_start = m.end()

# Find matching closing brace for the function block.
depth = 1
in_single = False
in_double = False
in_template = False
in_line_comment = False
in_block_comment = False
escaped = False
pos = body_start
while pos < len(text):
    ch = text[pos]
    nxt = text[pos + 1] if pos + 1 < len(text) else ''

    if in_line_comment:
        if ch == '\n':
            in_line_comment = False
        pos += 1
        continue

    if in_block_comment:
        if ch == '*' and nxt == '/':
            in_block_comment = False
            pos += 2
            continue
        pos += 1
        continue

    if in_single:
        if not escaped and ch == "'":
            in_single = False
        escaped = (ch == '\\' and not escaped)
        if ch != '\\':
            escaped = False
        pos += 1
        continue

    if in_double:
        if not escaped and ch == '"':
            in_double = False
        escaped = (ch == '\\' and not escaped)
        if ch != '\\':
            escaped = False
        pos += 1
        continue

    if in_template:
        if not escaped and ch == '`':
            in_template = False
        escaped = (ch == '\\' and not escaped)
        if ch != '\\':
            escaped = False
        pos += 1
        continue

    if ch == '/' and nxt == '/':
        in_line_comment = True
        pos += 2
        continue
    if ch == '/' and nxt == '*':
        in_block_comment = True
        pos += 2
        continue
    if ch == "'":
        in_single = True
        pos += 1
        continue
    if ch == '"':
        in_double = True
        pos += 1
        continue
    if ch == '`':
        in_template = True
        pos += 1
        continue

    if ch == '{':
        depth += 1
    elif ch == '}':
        depth -= 1
        if depth == 0:
            body_end = pos
            break
    pos += 1
else:
    raise SystemExit('Could not find end of seekdeepHandleImageButton function.')

fn_header = text[start:body_start]
fn_body = text[body_start:body_end]
fn_footer = text[body_end:body_end+1]

# Remove previous broken/duplicate top declarations if present.
fn_body = re.sub(r'^\s*(const|let|var)\s+customId\s*=.*?;\s*', '', fn_body, count=1, flags=re.S)
fn_body = re.sub(r'^\s*(const|let|var)\s+match\s*=.*?;\s*', '', fn_body, count=1, flags=re.S)
fn_body = re.sub(r'^\s*await\s+interaction\.deferUpdate\(\);\s*', '', fn_body, count=1, flags=re.S)

prelude = """
  const customId = interaction?.customId || '';
  const match =
    customId.match(/^seekdeep:(?:image-choice|regen):(original|refined|both):(.+)$/) ||
    customId.match(/^seekdeep:(original|refined|both):(.+)$/) ||
    customId.match(/^seekdeep:(regenerate|download|archive):(.+)$/) ||
    null;

  if (interaction && !interaction.deferred && !interaction.replied) {
    try {
      await interaction.deferUpdate();
    } catch {}
  }

"""

new_fn = fn_header + '\n' + prelude + fn_body.lstrip('\n') + fn_footer
new_text = text[:start] + new_fn + text[body_end+1:]

# Small sanity checks.
if "Cannot access 'customId' before initialization" in new_text:
    raise SystemExit('Unexpected literal error text found in source.')
if new_text.count('async function seekdeepHandleImageButton') != 1:
    raise SystemExit('Unexpected duplicate seekdeepHandleImageButton definitions.')
if 'await interaction.deferUpdate();' not in new_text:
    raise SystemExit('deferUpdate() prelude was not inserted.')

out = new_text if newline == '\n' else new_text.replace('\n', '\r\n')
path.write_bytes(out.encode('utf-8'))
print('Patched seekdeepHandleImageButton prelude.')