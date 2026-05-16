# SeekDeep / Seekotics archive-thread image posting repair v2 + recovery
#
# Fixes the failed v1 archive-thread image patch:
#   SyntaxError: Unexpected token ','
#   around:
#     }, target = null) {
#
# This script:
# 1. Backs up the currently broken index.js.
# 2. Restores the newest pre-v1 archive-thread-image-fix backup automatically.
# 3. Applies a corrected image-attachment archive patch.
# 4. Avoids default object parameters in the replacement functions to prevent the syntax failure.
# 5. Runs:
#      node --check .\index.js
#      .\.venv\Scripts\python.exe -m py_compile .\local_ai_server.py
#
# Result:
# - Archive thread receives the actual image attachment whenever possible.
# - Falls back to image URL text only if no file/attachment can be materialized.
# - Keeps confirmation reply as "Archived to this server."

$ErrorActionPreference = "Stop"

try {
  [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
} catch {}

function Write-Info {
  param([string]$Message)
  Write-Host "[SeekDeep archive-thread-image-fix-v2] $Message" -ForegroundColor Cyan
}

function Write-Pass {
  param([string]$Message)
  Write-Host "[PASS] $Message" -ForegroundColor Green
}

function Write-Warn {
  param([string]$Message)
  Write-Host "[WARN] $Message" -ForegroundColor Yellow
}

function Write-Fail {
  param([string]$Message)
  Write-Host "[FAIL] $Message" -ForegroundColor Red
}

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

  $brokenBackup = Join-Path $backupDir "index.js.broken-before-archive-thread-image-fix-v2-$stamp.bak"
  Copy-Item -LiteralPath $indexPath -Destination $brokenBackup -Force
  Write-Pass "Backed up current index.js to $brokenBackup"

  # Restore the newest backup created immediately before the failed v1 patch.
  $restoreCandidate = Get-ChildItem -LiteralPath $backupDir -Filter "index.js.archive-thread-image-fix-*.bak" -File |
    Sort-Object LastWriteTime -Descending |
    Select-Object -First 1

  if ($restoreCandidate) {
    Copy-Item -LiteralPath $restoreCandidate.FullName -Destination $indexPath -Force
    Write-Pass "Restored pre-v1 archive-thread image backup: $($restoreCandidate.FullName)"
  } else {
    Write-Warn "No archive-thread-image-fix backup found. Applying v2 to current index.js."
  }

  $patchPy = @'
from pathlib import Path
import sys

if len(sys.argv) != 2:
    raise SystemExit("Usage: patch_archive_thread_image_fix_v2.py <index.js>")

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
    for prefix in ("async function ", "function "):
        start = source.find(f"{prefix}{name}(")
        if start >= 0:
            break
    else:
        return None, -1, -1

    open_brace = source.find("{", start)
    if open_brace < 0:
        fail(f"Could not locate opening brace for {name}.")
    close_brace = find_matching_brace(source, open_brace)
    return source[start:close_brace + 1], start, close_brace + 1


def replace_function(source, name, new_fn):
    _existing, start, end = get_function(source, name)
    if start < 0:
        fail(f"Missing function: {name}")
    return source[:start] + new_fn.rstrip() + source[end:]


if "async function seekdeepArchiveImageStateToDiscordThread" not in text:
    fail("Required function not found: seekdeepArchiveImageStateToDiscordThread")

helpers = r"""async function seekdeepMaterializeArchiveFileFromState(state, target) {
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
    sourceAttachment?.url ||
    sourceAttachment?.proxyURL ||
    ''
  ).trim();

  if (!sourceUrl) {
    return '';
  }

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
}"""

if "async function seekdeepMaterializeArchiveFileFromState" not in text:
    pos = text.find("async function seekdeepArchiveImageStateToDiscordThread")
    if pos < 0:
        fail("Could not find insertion point for materialize helper.")
    text = text[:pos] + helpers + "\n\n" + text[pos:]

replacement = r"""async function seekdeepArchiveImageStateToDiscordThread(state, target) {
  state = state || {};
  target = target || null;

  const archiveTarget = target;
  const archiveInfo = await seekdeepGetOrCreateUserArchiveThread(archiveTarget);
  const thread = archiveInfo.thread;
  const threadName = archiveInfo.threadName;

  const metadata = seekdeepArchiveMetadataLines(state, archiveTarget).join('\n');

  const payload = {
    content: metadata,
  };

  let filePath = '';

  try {
    filePath = await seekdeepMaterializeArchiveFileFromState(state, archiveTarget);
    if (filePath) {
      payload.files = [filePath];
    }
  } catch (err) {
    console.warn('SeekDeep archive attachment materialization failed:', err?.message || err);
  }

  if (!payload.files || !payload.files.length) {
    const fallbackAttachment =
      archiveTarget?.message?.attachments?.first?.() ||
      archiveTarget?.attachments?.first?.() ||
      null;

    const fallbackUrl = String(
      state.attachmentUrl ||
      state.url ||
      state.downloadUrl ||
      state.proxyURL ||
      fallbackAttachment?.url ||
      fallbackAttachment?.proxyURL ||
      ''
    ).trim();

    if (fallbackUrl) {
      payload.content += `\nImage URL: ${fallbackUrl}`;
    } else {
      payload.content += '\nImage attachment unavailable.';
    }
  }

  await thread.send(payload);

  if (filePath && /[\\/]saved_generations[\\/]temp_archive_uploads[\\/]/i.test(filePath)) {
    try {
      fs.unlinkSync(filePath);
    } catch {}
  }

  return {
    ok: true,
    backend: 'discord-thread',
    threadId: thread.id,
    threadName,
    channelId: thread.parentId || thread.parent?.id || '',
    postedImage: Boolean(payload.files && payload.files.length),
  };
}"""

text = replace_function(text, "seekdeepArchiveImageStateToDiscordThread", replacement)

for needle, label in [
    ("async function seekdeepMaterializeArchiveFileFromState", "materialize helper"),
    ("async function seekdeepArchiveImageStateToDiscordThread", "thread archive writer"),
    ("payload.files = [filePath];", "file attachment line"),
    ("await thread.send(payload);", "thread send line"),
    ("postedImage:", "posted image result flag"),
]:
    if needle not in text:
        fail(f"Patch validation failed for {label}")

out = text if newline == "\n" else text.replace("\n", "\r\n")
path.write_bytes(out.encode("utf-8"))
print("Patched archive-thread image posting v2.")
'@

  $patchPyPath = Join-Path $patchesDir "patch_archive_thread_image_fix_v2.py"
  [System.IO.File]::WriteAllText($patchPyPath, $patchPy, [System.Text.UTF8Encoding]::new($false))

  Push-Location $projectRoot
  try {
    Write-Info "Applying archive-thread image posting repair v2"
    & ".\.venv\Scripts\python.exe" $patchPyPath $indexPath
    if ($LASTEXITCODE -ne 0) { throw "Patch helper failed with exit code $LASTEXITCODE." }
    Write-Pass "Applied archive-thread image posting repair v2"

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
  Write-Pass "Archive-thread image posting repair v2 completed."
  Write-Host "Broken file backup: $brokenBackup" -ForegroundColor Yellow
  if ($restoreCandidate) { Write-Host "Restored-from backup: $($restoreCandidate.FullName)" -ForegroundColor Yellow }
  Write-Host "Restart the bot before testing." -ForegroundColor Yellow
  Write-Host ""
  Write-Host "Retest:" -ForegroundColor Cyan
  Write-Host "1) Generate an image" -ForegroundColor White
  Write-Host "2) Click Archive" -ForegroundColor White
  Write-Host "3) Open the user's archive thread" -ForegroundColor White
  Write-Host "Expected: the thread contains the actual image attachment plus metadata text." -ForegroundColor White
  exit 0
} catch {
  Write-Host ""
  Write-Fail $_.Exception.Message
  Write-Host "Backups available:" -ForegroundColor Yellow
  if ($brokenBackup) { Write-Host $brokenBackup -ForegroundColor Yellow }
  if ($restoreCandidate) { Write-Host $restoreCandidate.FullName -ForegroundColor Yellow }
  exit 1
}
