from pathlib import Path
import re
import sys

if len(sys.argv) != 2:
    raise SystemExit("Usage: patch_archive_materializer_v2.py <index.js>")

path = Path(sys.argv[1])
raw = path.read_bytes()
newline = "\r\n" if b"\r\n" in raw else "\n"
text = raw.decode("utf-8-sig").replace("\r\n", "\n").replace("\r", "\n")

helper = r"""async function seekdeepMaterializeArchiveFileFromState(state = {}, target = null) {
  state = state || {};
  target = target || null;

  const directPathCandidates = [
    state.filePath,
    state.path,
    state.fullPath,
    state.savedPath,
    state.imagePath,
    state.outputPath,
    state.localPath,
    state.attachmentPath,
  ]
    .map((value) => String(value || '').trim())
    .filter(Boolean);

  for (const candidate of directPathCandidates) {
    try {
      if (fs.existsSync(candidate)) return candidate;
    } catch {}
  }

  const sourceAttachment =
    target?.message?.attachments?.first?.() ||
    target?.attachments?.first?.() ||
    null;

  const sourceUrl = String(
    state.attachmentUrl ||
    state.url ||
    state.downloadUrl ||
    state.proxyURL ||
    state.imageUrl ||
    sourceAttachment?.url ||
    sourceAttachment?.proxyURL ||
    ''
  ).trim();

  if (!sourceUrl) return '';

  const baseDir = typeof __dirname !== 'undefined' ? __dirname : process.cwd();
  const tempDir = path.join(baseDir, 'saved_generations', 'temp_archive_uploads');

  try {
    fs.mkdirSync(tempDir, { recursive: true });
  } catch {}

  const safeExtMatch = sourceUrl.match(/\.(png|jpe?g|webp|gif)(?:\?|$)/i);
  const ext = safeExtMatch ? safeExtMatch[1].toLowerCase() : 'png';
  const tempName = `archive-upload-${Date.now()}-${Math.random().toString(36).slice(2, 10)}.${ext}`;
  const tempPath = path.join(tempDir, tempName);

  const response = await fetch(sourceUrl);
  if (!response.ok) {
    throw new Error(`Failed to fetch source attachment: ${response.status} ${response.statusText}`);
  }

  const arrayBuffer = await response.arrayBuffer();
  fs.writeFileSync(tempPath, Buffer.from(arrayBuffer));
  return tempPath;
}
"""

def replace_function_if_exists(source, name, replacement):
    m = re.search(r"(?:async\s+)?function\s+" + re.escape(name) + r"\s*\([^)]*\)\s*\{", source)
    if not m:
        return source, False

    start = m.start()
    open_brace = m.end() - 1
    depth = 0
    i = open_brace
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
            if ch == "\n": in_line_comment = False
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
            if not escaped and ch == "\\": escaped = True
            elif not escaped and ch == "'": in_single = False
            else: escaped = False
            i += 1
            continue
        if in_double:
            if not escaped and ch == "\\": escaped = True
            elif not escaped and ch == '"': in_double = False
            else: escaped = False
            i += 1
            continue
        if in_template:
            if not escaped and ch == "\\": escaped = True
            elif not escaped and ch == "`": in_template = False
            else: escaped = False
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
                return source[:start] + replacement + source[i + 1:], True

        i += 1

    raise SystemExit(f"Could not find end of existing function {name}")

text, replaced = replace_function_if_exists(text, "seekdeepMaterializeArchiveFileFromState", helper)

if not replaced:
    insert_pos = text.find("async function seekdeepArchiveImageStateToDiscordThread")
    if insert_pos < 0:
        insert_pos = text.find("function seekdeepArchiveImageStateToDiscordThread")
    if insert_pos < 0:
        insert_pos = text.find("async function seekdeepHandleImageButton")
    if insert_pos < 0:
        raise SystemExit("Could not find insertion anchor for archive materializer.")

    text = text[:insert_pos] + helper + "\n\n" + text[insert_pos:]

# Mojibake/bullet cleanup. Prefer ASCII to avoid encoding issues.
text = text.replace("Ã¢â‚¬Â¢ Original", "- Original")
text = text.replace("Ã¢â‚¬Â¢ Refined", "- Refined")
text = text.replace("â€¢ Original", "- Original")
text = text.replace("â€¢ Refined", "- Refined")

# Also normalize future code strings if they still contain literal bullets.
text = text.replace("'â€¢ Original'", "'- Original'")
text = text.replace("'â€¢ Refined'", "'- Refined'")
text = text.replace('"â€¢ Original"', '"- Original"')
text = text.replace('"â€¢ Refined"', '"- Refined"')

for needle, label in [
    ("async function seekdeepMaterializeArchiveFileFromState", "archive materializer"),
    ("temp_archive_uploads", "temporary upload directory"),
    ("fetch(sourceUrl)", "URL fetch fallback"),
]:
    if needle not in text:
        raise SystemExit(f"Missing required patch element: {label}")

out = text if newline == "\n" else text.replace("\n", "\r\n")
path.write_bytes(out.encode("utf-8"))
print("Patched archive materializer and bullet cleanup v2.")