from pathlib import Path
import re
import sys

if len(sys.argv) != 2:
    raise SystemExit("Usage: patch_quiet_report_v2.py <index.js>")

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


def replace_named_function_or_const(source, name, replacement):
    # function name(...) { ... }
    start = source.find(f"function {name}(")
    if start >= 0:
        open_brace = source.find("{", start)
        if open_brace < 0:
            fail(f"Opening brace not found for function {name}")
        close_brace = find_matching_brace(source, open_brace)
        return source[:start] + replacement.rstrip() + source[close_brace + 1:]

    # const name = (...) => { ... };
    m = re.search(rf"\bconst\s+{re.escape(name)}\s*=", source)
    if m:
        start = m.start()
        open_brace = source.find("{", m.end())
        if open_brace < 0:
            fail(f"Opening brace not found for const {name}")
        close_brace = find_matching_brace(source, open_brace)
        end = close_brace + 1
        while end < len(source) and source[end].isspace():
            end += 1
        if end < len(source) and source[end] == ";":
            end += 1
        return source[:start] + replacement.rstrip() + source[end:]

    fail(f"Could not find {name}")


def insert_before_append(source, helper_code):
    if "function seekdeepIsNoModelReportLabel" in source:
        return source

    pos = source.find("function seekdeepAppendResponseFooter")
    if pos < 0:
        m = re.search(r"\bconst\s+seekdeepAppendResponseFooter\s*=", source)
        if m:
            pos = m.start()

    if pos < 0:
        pos = source.find("client.on('interactionCreate'")

    if pos < 0:
        fail("Could not find insertion point for quiet report helpers")

    return source[:pos] + helper_code.rstrip() + "\n\n" + source[pos:]


if "client.on('interactionCreate'" not in text:
    fail("interaction handler anchor not found")

helpers = r"""function seekdeepIsNoModelReportLabel(modelUsed = '') {
  const model = String(modelUsed || '').trim().toLowerCase();
  return !model || model === 'local command (no ai model)' || model === 'local command' || model === 'none' || model === 'n/a';
}

function seekdeepCleanPublicReportText(value = '') {
  return String(value || '')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/^Generated locally:/gim, 'Generated:')
    .replace(/^Archived on the bot host:\s*\n?\[local archive path hidden\]\s*$/gim, 'Archived to this server.')
    .replace(/^Archived on the bot host:\s*$/gim, 'Archived to this server.')
    .replace(/^Archived locally for this server\.\s*$/gim, 'Archived to this server.')
    .trim();
}

function seekdeepCompactQueueSummary(body = '') {
  const text = String(body || '').trim();

  if (/^Queued both prompt versions\./i.test(text) || /^Queued both regenerate versions\./i.test(text) || /^Queued both:/i.test(text)) {
    return 'Queued both:\nâ€¢ Original\nâ€¢ Refined';
  }

  if (/^Queued original prompt\./i.test(text) || /^Queued original regenerate\./i.test(text) || /^Queued original\./i.test(text)) {
    return 'Queued original.';
  }

  if (/^Queued refined prompt\./i.test(text) || /^Queued refined regenerate\./i.test(text) || /^Queued refined\./i.test(text)) {
    return 'Queued refined.';
  }

  return text;
}

function seekdeepShouldHideCommandFooter(body = '', meta = {}) {
  const modelUsed = meta?.modelUsed || meta?.model || '';
  const text = String(body || '').trim();

  if (!seekdeepIsNoModelReportLabel(modelUsed)) return false;

  return Boolean(
    /^Queued (?:both|original|refined)/i.test(text) ||
    /^Prompt choice expired/i.test(text) ||
    /^Only the requester can use/i.test(text) ||
    /^Image generation cooldown is active/i.test(text) ||
    /^Archived (?:to|locally|on)/i.test(text) ||
    /^Archive is empty/i.test(text) ||
    /^Image archive status/i.test(text) ||
    /^Download URL:/i.test(text)
  );
}"""

text = insert_before_append(text, helpers)

new_append = r"""function seekdeepAppendResponseFooter(body = '', meta = {}) {
  const cleanedBody = seekdeepCleanPublicReportText(seekdeepCompactQueueSummary(body));

  if (seekdeepShouldHideCommandFooter(cleanedBody, meta)) {
    return cleanedBody;
  }

  const startedAt = Number(meta?.startedAt || 0);
  const elapsedSeconds = startedAt > 0
    ? ((Date.now() - startedAt) / 1000).toFixed(2)
    : null;

  const modelUsed = meta?.modelUsed || meta?.model || '';
  const footer = [];

  if (elapsedSeconds !== null) {
    footer.push(`Time to Generate: ${elapsedSeconds} seconds`);
  }

  if (modelUsed && !seekdeepIsNoModelReportLabel(modelUsed)) {
    footer.push(`Model Used: ${modelUsed}`);
  }

  if (!footer.length) return cleanedBody;
  return `${cleanedBody}\n\n${footer.join('\n')}`;
}"""

text = replace_named_function_or_const(text, "seekdeepAppendResponseFooter", new_append)

# Simple public-facing string cleanup only. Do not edit JS object keys or large blocks.
text = text.replace("Generated locally:", "Generated:")
text = text.replace("Archived on the bot host:\\n[local archive path hidden]", "Archived to this server.")
text = text.replace("Archived on the bot host:", "Archived to this server.")
text = text.replace("Archived locally for this server.", "Archived to this server.")

# Keep these strings; the compact helper will shorten displayed output centrally.
# Directly cleaning them is safe for plain string literals.
text = text.replace("Queued both prompt versions.", "Queued both:")
text = text.replace("Queued both regenerate versions.", "Queued both:")
text = text.replace("Queued original prompt.", "Queued original.")
text = text.replace("Queued refined prompt.", "Queued refined.")

for required in [
    "function seekdeepIsNoModelReportLabel",
    "function seekdeepCleanPublicReportText",
    "function seekdeepCompactQueueSummary",
    "function seekdeepAppendResponseFooter",
]:
    if required not in text:
        fail(f"Missing required helper after patch: {required}")

out = text if newline == "\n" else text.replace("\n", "\r\n")
path.write_bytes(out.encode("utf-8"))
print("Applied quiet generation report v2 safely.")