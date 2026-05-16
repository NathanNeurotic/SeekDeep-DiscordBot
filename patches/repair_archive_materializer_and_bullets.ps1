# SeekDeep / Seekotics archive attachment materializer + mojibake cleanup
#
# Fixes:
# - Console warning:
#     SeekDeep archive attachment materialization failed: seekdeepMaterializeArchiveFileFromState is not defined
#
# Result:
# - Archive thread posts can attach the actual image again when the state has a local path
#   or an attachment/download URL.
#
# Also cleans:
# - Queued both:
#   â€¢ Original
#   â€¢ Refined
# into plain ASCII:
#   - Original
#   - Refined
#
# Validation:
# - node --check .\index.js
# - python -m py_compile .\local_ai_server.py

$ErrorActionPreference = "Stop"

try {
  [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
} catch {}

function Write-Info { param([string]$Message) Write-Host "[SeekDeep archive-materializer] $Message" -ForegroundColor Cyan }
function Write-Pass { param([string]$Message) Write-Host "[PASS] $Message" -ForegroundColor Green }
function Write-Fail { param([string]$Message) Write-Host "[FAIL] $Message" -ForegroundColor Red }

try {
  $projectRoot = Join-Path $env:USERPROFILE "SeekDeep-DiscordBot"
  if (-not (Test-Path -LiteralPath (Join-Path $projectRoot "index.js"))) {
    $projectRoot = (Get-Location).Path
  }

  $indexPath = Join-Path $projectRoot "index.js"
  $serverPath = Join-Path $projectRoot "local_ai_server.py"
  $patchesDir = Join-Path $projectRoot "patches"
  $backupDir = Join-Path $patchesDir "backups"
  $stamp = Get-Date -Format "yyyyMMdd-HHmmss"

  if (-not (Test-Path -LiteralPath $indexPath)) { throw "index.js not found." }
  if (-not (Test-Path -LiteralPath $serverPath)) { throw "local_ai_server.py not found." }

  New-Item -ItemType Directory -Path $patchesDir -Force | Out-Null
  New-Item -ItemType Directory -Path $backupDir -Force | Out-Null

  $backup = Join-Path $backupDir "index.js.before-archive-materializer-$stamp.bak"
  Copy-Item -LiteralPath $indexPath -Destination $backup -Force
  Write-Pass "Backed up index.js to $backup"

  $patchPy = @'
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
text = text.replace("â€¢ Original", "- Original")
text = text.replace("â€¢ Refined", "- Refined")
text = text.replace("• Original", "- Original")
text = text.replace("• Refined", "- Refined")

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
'@

  $patchPyPath = Join-Path $patchesDir "patch_archive_materializer.py"
  [System.IO.File]::WriteAllText($patchPyPath, $patchPy, [System.Text.UTF8Encoding]::new($false))

  Push-Location $projectRoot
  try {
    Write-Info "Applying archive materializer patch"
    & ".\.venv\Scripts\python.exe" $patchPyPath $indexPath
    if ($LASTEXITCODE -ne 0) { throw "Patch helper failed with exit code $LASTEXITCODE." }
    Write-Pass "Applied archive materializer patch"

    Write-Info "Running node --check .\index.js"
    & node --check ".\index.js"
    if ($LASTEXITCODE -ne 0) { throw "node --check failed with exit code $LASTEXITCODE." }
    Write-Pass "node --check passed"

    Write-Info "Running Python compile check"
    & ".\.venv\Scripts\python.exe" -m py_compile ".\local_ai_server.py"
    if ($LASTEXITCODE -ne 0) { throw "Python compile check failed with exit code $LASTEXITCODE." }
    Write-Pass "Python compile check passed"
  } finally {
    Pop-Location
  }

  Write-Host ""
  Write-Pass "Archive materializer patch completed."
  Write-Host "Backup created: $backup" -ForegroundColor Yellow
  Write-Host "Restart the bot before testing." -ForegroundColor Yellow
  Write-Host ""
  Write-Host "Retest:" -ForegroundColor Cyan
  Write-Host "1. Generate an image." -ForegroundColor White
  Write-Host "2. Click Archive." -ForegroundColor White
  Write-Host "3. Confirm the archive thread receives the image attachment, not just metadata." -ForegroundColor White
  exit 0
} catch {
  Write-Host ""
  Write-Fail $_.Exception.Message
  Write-Host "Backup available:" -ForegroundColor Yellow
  if ($backup) { Write-Host $backup -ForegroundColor Yellow }
  exit 1
}
