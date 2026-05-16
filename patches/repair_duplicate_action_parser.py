from pathlib import Path
import re
import sys

if len(sys.argv) != 2:
    raise SystemExit("Usage: repair_duplicate_action_parser.py <index.js>")

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
    start = source.find(f"async function {name}(")
    if start < 0:
        start = source.find(f"function {name}(")
    if start < 0:
        fail(f"Could not locate {name}.")

    open_brace = source.find("{", start)
    if open_brace < 0:
        fail(f"Could not locate opening brace for {name}.")

    close_brace = find_matching_brace(source, open_brace)
    return source[start:close_brace + 1], start, close_brace + 1

fn, start, end = get_function(text, "seekdeepHandleImageButton")

if "const seekdeepImageButtonParsed =" not in fn:
    fail("New image button parser not found; v2 patch may not have applied far enough.")

# Remove stale old parser declaration blocks. These are now replaced by seekdeepImageButtonParsed.
fn = re.sub(
    r"\n\s*const\s+match\s*=\s*customId\.match\([\s\S]*?\);\s*",
    "\n",
    fn,
    count=1,
)

fn = re.sub(
    r"\n\s*if\s*\(\s*!\s*match\s*\)\s*return\s+false;\s*",
    "\n",
    fn,
)

# Remove stale old action/actionId declarations that collide with injected parser.
fn = re.sub(
    r"\n\s*const\s+action\s*=\s*match\[[^\]]+\]\s*===\s*['\"]save['\"]\s*\?\s*['\"]archive['\"]\s*:\s*match\[[^\]]+\]\s*;\s*",
    "\n",
    fn,
)

fn = re.sub(
    r"\n\s*const\s+action\s*=\s*match\[[^\]]+\]\s*;\s*",
    "\n",
    fn,
)

fn = re.sub(
    r"\n\s*const\s+actionId\s*=\s*match\[[^\]]+\]\s*;\s*",
    "\n",
    fn,
)

# If old code still references save-normalization, normalize the injected buttonAction instead.
fn = fn.replace("buttonAction = 'save';", "buttonAction = 'archive';")
fn = fn.replace("buttonAction === 'save'", "buttonAction === 'archive'")

# Remove any remaining exact duplicate action declarations.
# Keep only the first `const action = buttonAction;`.
matches = list(re.finditer(r"\n\s*const\s+action\s*=\s*buttonAction\s*;\s*", fn))
if not matches:
    marker = "  } else {\n    actionId = seekdeepImageButtonParsed[2] || '';\n  }\n"
    if marker not in fn:
        fail("Could not locate parser ending to insert action alias.")
    fn = fn.replace(marker, marker + "\n  const action = buttonAction;\n", 1)
elif len(matches) > 1:
    keep = matches[0]
    rebuilt = []
    last = 0
    for i, m in enumerate(matches):
        rebuilt.append(fn[last:m.start()])
        if i == 0:
            rebuilt.append(m.group(0))
        last = m.end()
    rebuilt.append(fn[last:])
    fn = "".join(rebuilt)

# Replace leftover match[] uses if any remain in the handler.
fn = fn.replace("match[1]", "buttonAction")
fn = fn.replace("match[2]", "actionId")
fn = fn.replace("match[3]", "actionId")

# Validation inside handler.
if re.search(r"\bconst\s+action\s*=", fn) and len(re.findall(r"\bconst\s+action\s*=", fn)) > 1:
    fail("More than one const action declaration remains in seekdeepHandleImageButton.")

if re.search(r"\bconst\s+actionId\s*=", fn):
    fail("A stale const actionId declaration remains in seekdeepHandleImageButton.")

if re.search(r"\bmatch\s*\[", fn):
    fail("A stale match[...] reference remains in seekdeepHandleImageButton.")

if "const action = buttonAction;" not in fn:
    fail("Missing const action = buttonAction after repair.")

text = text[:start] + fn + text[end:]

# Global validation.
for needle, label in [
    ("function seekdeepRegenerateModeOptions", "regenerate mode helper"),
    ("setLabel('Original')", "Original button"),
    ("setLabel('Refined')", "Refined button"),
    ("setLabel('Both')", "Both button"),
    ("seekdeepEnqueueImageJob(job, runner)", "queue contract"),
]:
    if needle not in text:
        fail(f"Required anchor not found after repair: {label}")

out = text if newline == "\n" else text.replace("\n", "\r\n")
path.write_bytes(out.encode("utf-8"))
print("Repaired duplicate action parser declarations.")