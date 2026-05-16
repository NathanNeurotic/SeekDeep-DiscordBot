from pathlib import Path
import sys

if len(sys.argv) != 2:
    raise SystemExit("Usage: patch_archive_materializer.py <index.js>")

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

if "async function seekdeepMaterializeArchiveFileFromState" not in text:
    insert_pos = text.find("async function seekdeepArchiveImageStateToDiscordThread")
    if insert_pos < 0:
        insert_pos = text.find("function seekdeepArchiveImageStateToDiscordThread")
    if insert_pos < 0:
        insert_pos = text.find("async function seekdeepHandleImageButton")
    if insert_pos < 0:
        raise SystemExit("Could not find insertion anchor for archive materializer.")

    text = text[:insert_pos] + helper + "\n\n" + text[insert_pos:]

# Mojibake/bullet cleanup. Use ASCII to avoid PowerShell/Discord encoding weirdness.
text = text.replace("Ã¢â‚¬Â¢ Original", "- Original")
text = text.replace("Ã¢â‚¬Â¢ Refined", "- Refined")
text = text.replace("â€¢ Original", "- Original")
text = text.replace("â€¢ Refined", "- Refined")

for needle, label in [
    ("async function seekdeepMaterializeArchiveFileFromState", "archive materializer"),
    ("temp_archive_uploads", "temporary upload directory"),
    ("fetch(sourceUrl)", "URL fetch fallback"),
]:
    if needle not in text:
        raise SystemExit(f"Missing required patch element: {label}")

for bad in ["}, target = null) {", "state = {) {", "state = {,"]:
    if bad in text:
        raise SystemExit(f"Malformed code detected after patch: {bad}")

out = text if newline == "\n" else text.replace("\n", "\r\n")
path.write_bytes(out.encode("utf-8"))
print("Patched archive materializer and bullet mojibake.")