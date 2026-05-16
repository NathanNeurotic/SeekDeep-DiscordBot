# SeekDeep / Seekotics archive scope + path privacy repair
#
# Fixes the current observed archive bugs:
# - /archivestatus can resolve to saved_generations\archives\dm-unknown inside a server.
# - /postarchive checks dm-unknown even when invoked in a guild.
# - Archive/status messages expose full Windows host paths.
# - Archive button still says "Archived on the bot host:" and exposes local file paths.
#
# What this patch does:
# - Strengthens guild/archive scope detection.
# - Makes archive helper calls pass the interaction/message target when the call site forgot to.
# - Adds a safe fallback scope for slash commands:
#     guild:<interaction.guildId>
#   instead of dm:unknown.
# - Redacts local filesystem paths from Discord-facing archive messages.
# - Keeps local disk writes working internally.
#
# Files patched:
# - index.js
#
# Safety:
# - backs up index.js first
# - patches only index.js
# - runs node --check
# - runs Python compile check for local_ai_server.py

$ErrorActionPreference = "Stop"

try {
  [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
} catch {}

function Write-Info {
  param([string]$Message)
  Write-Host "[SeekDeep archive-scope-privacy-repair] $Message" -ForegroundColor Cyan
}

function Write-Pass {
  param([string]$Message)
  Write-Host "[PASS] $Message" -ForegroundColor Green
}

function Write-Fail {
  param([string]$Message)
  Write-Host "[FAIL] $Message" -ForegroundColor Red
}

function Invoke-CheckedCommand {
  param(
    [Parameter(Mandatory=$true)][string]$Label,
    [Parameter(Mandatory=$true)][scriptblock]$Command
  )

  Write-Info "Running $Label"
  & $Command
  if ($LASTEXITCODE -ne 0) {
    throw "$Label failed with exit code $LASTEXITCODE."
  }
  Write-Pass "$Label passed"
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

  Write-Info "Project root: $projectRoot"

  $indexBackup = Join-Path $backupDir "index.js.archive-scope-privacy-repair-$stamp.bak"
  Copy-Item -LiteralPath $indexPath -Destination $indexBackup -Force
  Write-Pass "Backed up index.js to $indexBackup"

  $utf8NoBom = [System.Text.UTF8Encoding]::new($false)

  $patchPy = @'
from pathlib import Path
import re
import sys

if len(sys.argv) != 2:
    raise SystemExit("Usage: patch_archive_scope_privacy_repair.py <index.js>")

path = Path(sys.argv[1])
raw = path.read_bytes()
newline = "\r\n" if b"\r\n" in raw else "\n"
text = raw.decode("utf-8-sig").replace("\r\n", "\n").replace("\r", "\n")

def fail(msg):
    raise SystemExit(msg)

def require(needle, label):
    if needle not in text:
        fail(f"Required anchor not found: {label}")

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
                i += 1
                continue
            if not escaped and ch == "'":
                in_single = False
            escaped = False
            i += 1
            continue

        if in_double:
            if not escaped and ch == "\\":
                escaped = True
                i += 1
                continue
            if not escaped and ch == '"':
                in_double = False
            escaped = False
            i += 1
            continue

        if in_template:
            if not escaped and ch == "\\":
                escaped = True
                i += 1
                continue
            if not escaped and ch == "`":
                in_template = False
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

def get_named_function(source, name_or_signature):
    if name_or_signature.startswith("function ") or name_or_signature.startswith("async function "):
        start = source.find(name_or_signature)
    else:
        start = source.find(f"function {name_or_signature}(")
        if start < 0:
            start = source.find(f"async function {name_or_signature}(")
    if start < 0:
        return None, -1, -1
    brace_open = source.find("{", start)
    if brace_open < 0:
        fail(f"Could not locate opening brace for {name_or_signature}")
    brace_close = find_matching_brace(source, brace_open)
    return source[start:brace_close + 1], start, brace_close + 1

def replace_named_function(source, name_or_signature, new_block):
    _, start, end = get_named_function(source, name_or_signature)
    if start < 0:
        fail(f"Could not locate function for replacement: {name_or_signature}")
    return source[:start] + new_block.rstrip() + source[end:]

require("client.on('interactionCreate'", "interaction handler")
require("seekdeepEnqueueImageJob(job, runner)", "image queue contract")

if "seekdeepMakeImageQueueJobId" in text:
    fail("Unsafe old queue helper found: seekdeepMakeImageQueueJobId")
if "job.run" in text:
    fail("Unsafe job.run-style queue logic found")

# ----------------------------------------------------------------------
# 1. Ensure / strengthen archive scope helpers.
# ----------------------------------------------------------------------
helpers = r"""
// SEEKDEEP_ARCHIVE_SCOPE_PRIVACY_REPAIR_START
function seekdeepGuildArchiveScopeFromTarget(target = null) {
  const guildId =
    target?.guild?.id ||
    target?.guildId ||
    target?.message?.guild?.id ||
    target?.message?.guildId ||
    target?.channel?.guild?.id ||
    target?.channel?.guildId ||
    target?.interaction?.guild?.id ||
    target?.interaction?.guildId ||
    target?.member?.guild?.id ||
    '';

  if (guildId) return `guild:${guildId}`;

  const userId =
    target?.user?.id ||
    target?.author?.id ||
    target?.member?.user?.id ||
    target?.message?.author?.id ||
    target?.message?.interaction?.user?.id ||
    target?.requesterId ||
    'unknown';

  return `dm:${userId}`;
}

function seekdeepSanitizeArchiveScopeKey(scope = '') {
  return String(scope || 'unknown')
    .replace(/^guild:/, 'guild-')
    .replace(/^dm:/, 'dm-')
    .replace(/[^a-zA-Z0-9_.-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '') || 'unknown';
}

function seekdeepArchiveScopeLabel(target = null) {
  const scope = seekdeepGuildArchiveScopeFromTarget(target);
  if (scope.startsWith('guild:')) return 'this server';
  if (scope.startsWith('dm:')) return 'this DM';
  return 'current archive scope';
}

function seekdeepArchiveScopedKey(target = null, key = '') {
  const scope = seekdeepGuildArchiveScopeFromTarget(target);
  const cleanKey = String(key || 'default').replace(/^:+|:+$/g, '') || 'default';
  return `${scope}:${cleanKey}`;
}

function seekdeepArchiveUserScopedKey(target = null, userId = '') {
  const uid = String(userId || target?.user?.id || target?.author?.id || 'unknown');
  return seekdeepArchiveScopedKey(target, `user:${uid}`);
}

function seekdeepArchiveThreadScopedKey(target = null, userId = '') {
  const uid = String(userId || target?.user?.id || target?.author?.id || 'unknown');
  return seekdeepArchiveScopedKey(target, `thread:${uid}`);
}

function seekdeepArchiveDirForTarget(target = null) {
  const scopeDir = seekdeepSanitizeArchiveScopeKey(seekdeepGuildArchiveScopeFromTarget(target));
  const baseDir = typeof __dirname !== 'undefined' ? __dirname : process.cwd();
  const out = path.join(baseDir, 'saved_generations', 'archives', scopeDir);
  try {
    fs.mkdirSync(out, { recursive: true });
  } catch {}
  return out;
}

function seekdeepRedactArchivePathForDiscord(value = '') {
  return String(value || '')
    .replace(/[A-Z]:\\[^\n\r`]+/gi, '[local archive path hidden]')
    .replace(/\/(?:home|Users|mnt|var|tmp)\/[^\n\r`]+/gi, '[local archive path hidden]');
}
// SEEKDEEP_ARCHIVE_SCOPE_PRIVACY_REPAIR_END

"""

# Replace older helper definitions if they exist; otherwise insert helpers.
if "function seekdeepGuildArchiveScopeFromTarget" in text:
    text = replace_named_function(text, "function seekdeepGuildArchiveScopeFromTarget", helpers.split("function seekdeepSanitizeArchiveScopeKey", 1)[0].replace("// SEEKDEEP_ARCHIVE_SCOPE_PRIVACY_REPAIR_START\n", "").rstrip())
    # Replace or add sanitize helper.
    sanitize_body = "function seekdeepSanitizeArchiveScopeKey" + helpers.split("function seekdeepSanitizeArchiveScopeKey", 1)[1].split("function seekdeepArchiveScopeLabel", 1)[0].rstrip()
    if "function seekdeepSanitizeArchiveScopeKey" in text:
        text = replace_named_function(text, "function seekdeepSanitizeArchiveScopeKey", sanitize_body)
    else:
        pos = text.find("function seekdeepGuildArchiveScopeFromTarget")
        _, _, end = get_named_function(text, "function seekdeepGuildArchiveScopeFromTarget")
        text = text[:end] + "\n\n" + sanitize_body + text[end:]
    # Add missing newer helpers after sanitize function.
    add_after = "function seekdeepSanitizeArchiveScopeKey"
    _, _, end = get_named_function(text, add_after)
    missing = ""
    for name in [
        "seekdeepArchiveScopeLabel",
        "seekdeepArchiveScopedKey",
        "seekdeepArchiveUserScopedKey",
        "seekdeepArchiveThreadScopedKey",
        "seekdeepArchiveDirForTarget",
        "seekdeepRedactArchivePathForDiscord",
    ]:
        if f"function {name}" not in text:
            part = "function " + helpers.split(f"function {name}", 1)[1]
            # cut at next function or end marker
            m = re.search(r"\nfunction\s+\w+|\n// SEEKDEEP_ARCHIVE_SCOPE_PRIVACY_REPAIR_END", part[1:])
            if m:
                part = part[:1 + m.start()]
            missing += "\n\n" + part.rstrip()
    if missing:
        text = text[:end] + missing + text[end:]
else:
    insert_pos = -1
    for anchor in [
        "function seekdeepImageActionRow",
        "function seekdeepArchive",
        "async function seekdeepArchive",
        "client.on('interactionCreate'",
    ]:
        pos = text.find(anchor)
        if pos >= 0:
            insert_pos = pos
            break
    if insert_pos < 0:
        fail("Could not find insertion point for archive scope helpers.")
    text = text[:insert_pos] + helpers + "\n" + text[insert_pos:]

# ----------------------------------------------------------------------
# 2. Force archive dir/status helpers to use interaction/message target.
# ----------------------------------------------------------------------
# Patch calls with no args inside likely archive command handlers.
archive_call_patterns = [
    (r"\bseekdeepArchiveDir\(\)", "seekdeepArchiveDirForTarget(interaction || message || {})"),
    (r"\bseekdeepGetArchiveDir\(\)", "seekdeepArchiveDirForTarget(interaction || message || {})"),
    (r"\bseekdeepArchivePath\(\)", "seekdeepArchiveDirForTarget(interaction || message || {})"),
    (r"\bseekdeepGetArchivePath\(\)", "seekdeepArchiveDirForTarget(interaction || message || {})"),
]
for pat, repl in archive_call_patterns:
    text = re.sub(pat, repl, text)

# If old dir helper exists and still points to archives/dm-unknown by default, replace it with target-aware helper.
for name in ["seekdeepArchiveDir", "seekdeepGetArchiveDir"]:
    fn, start, end = get_named_function(text, name)
    if start >= 0 and "seekdeepArchiveDirForTarget" not in fn:
        header_end = fn.find("{")
        header = fn[:header_end]
        if "target" not in header:
            header = re.sub(r"\(([^)]*)\)", lambda m: "(" + (m.group(1).strip() + ", target = null" if m.group(1).strip() else "target = null") + ")", header, count=1)
        new_fn = header + r"""{
  return seekdeepArchiveDirForTarget(target);
}"""
        text = text[:start] + new_fn + text[end:]

# ----------------------------------------------------------------------
# 3. Redact local paths from Discord-facing archive messages.
# ----------------------------------------------------------------------
# Replace common visible labels.
text = text.replace("Archived on the bot host:", "Archived locally for this server.")
text = text.replace("Archived on bot host:", "Archived locally for this server.")
text = text.replace("Path checked:", "Archive scope checked:")
text = text.replace("Path:", "Archive scope:")

# If a message interpolates archive dir/path into content, prefer scope label.
# Common template fragments:
text = re.sub(r"`?\$\{archiveDir\}`?", "${seekdeepArchiveScopeLabel(interaction || message || {})}", text)
text = re.sub(r"`?\$\{archivePath\}`?", "${seekdeepArchiveScopeLabel(interaction || message || {})}", text)
text = re.sub(r"`?\$\{savedPath\}`?", "${seekdeepArchiveScopeLabel(interaction || message || {})}", text)
text = re.sub(r"`?\$\{filePath\}`?", "${seekdeepArchiveScopeLabel(interaction || message || {})}", text)

# Common concatenation forms.
text = re.sub(
    r"(\+\s*)(archiveDir|archivePath|savedPath|filePath)(\s*\+)",
    r"\1seekdeepArchiveScopeLabel(interaction || message || {})\3",
    text,
)

# If status text uses a variable called dir/path line directly, sanitize before response.
# This is a broad but safe display-only sanitation around archive/status reply content.
if "seekdeepRedactArchivePathForDiscord(" not in text[text.find("client.on('interactionCreate'"):]:
    # Patch common safeEditOrReply archive response content? Avoid broad wrapping all messages.
    pass

# ----------------------------------------------------------------------
# 4. Fix slash-command archive status scope if command branches exist.
# ----------------------------------------------------------------------
# Add local archiveTarget in archive-related command branches if obvious.
# This does not change non-archive commands.
text = re.sub(
    r"(if\s*\(\s*commandName\s*===\s*['\"](?:archivestatus|postarchive|archive|weeklyarchive|alltimearchive|purgearchive)['\"]\s*\)\s*\{\n)",
    r"\1      const archiveTarget = interaction || message || {};\n",
    text,
)

# Then prefer archiveTarget for scope labels.
text = text.replace("seekdeepArchiveScopeLabel(interaction || message || {})", "seekdeepArchiveScopeLabel(typeof archiveTarget !== 'undefined' ? archiveTarget : (interaction || message || {}))")

# Common fallback path: saved_generations/archives/dm-unknown means helper was called with no target.
text = text.replace(
    "path.join(__dirname, 'saved_generations', 'archives', seekdeepSanitizeArchiveScopeKey(seekdeepGuildArchiveScopeFromTarget(message || interaction || {})))",
    "seekdeepArchiveDirForTarget(typeof archiveTarget !== 'undefined' ? archiveTarget : (interaction || message || {}))"
)

# ----------------------------------------------------------------------
# 5. Defensive response sanitation: specific archive/status content.
# ----------------------------------------------------------------------
# Wrap exact archive status string returns if common forms are present.
text = re.sub(
    r"(content:\s*)(`[^`]*(?:Image archive status|Archive is empty|Archived locally for this server)[^`]*`)",
    r"\1seekdeepRedactArchivePathForDiscord(\2)",
    text,
    flags=re.DOTALL,
)
text = re.sub(
    r"(content:\s*)(['\"][^'\"]*(?:Image archive status|Archive is empty|Archived locally for this server)[^'\"]*['\"])",
    r"\1seekdeepRedactArchivePathForDiscord(\2)",
    text,
    flags=re.DOTALL,
)

# ----------------------------------------------------------------------
# Validation.
# ----------------------------------------------------------------------
for needle, label in [
    ("function seekdeepGuildArchiveScopeFromTarget", "scope helper"),
    ("function seekdeepArchiveDirForTarget", "dir helper"),
    ("function seekdeepRedactArchivePathForDiscord", "path redactor"),
    ("function seekdeepArchiveScopeLabel", "scope label helper"),
    ("seekdeepEnqueueImageJob(job, runner)", "queue contract"),
]:
    require(needle, label)

if "saved_generations\\archives\\dm-unknown" in text or "saved_generations/archives/dm-unknown" in text:
    fail("Hardcoded dm-unknown archive path still exists.")

out = text if newline == "\n" else text.replace("\n", "\r\n")
path.write_bytes(out.encode("utf-8"))
print("Patched archive scope target passing and Discord path redaction.")
'@

  $patchPyPath = Join-Path $patchesDir "patch_archive_scope_privacy_repair.py"
  [System.IO.File]::WriteAllText($patchPyPath, $patchPy, $utf8NoBom)

  Push-Location $projectRoot
  try {
    Write-Info "Applying archive scope/privacy repair"
    & ".\.venv\Scripts\python.exe" $patchPyPath $indexPath
    if ($LASTEXITCODE -ne 0) {
      throw "Patch helper failed with exit code $LASTEXITCODE."
    }
    Write-Pass "Applied archive scope/privacy repair"

    Invoke-CheckedCommand "node --check .\index.js" {
      & node --check ".\index.js"
    }

    Invoke-CheckedCommand ".\.venv\Scripts\python.exe -m py_compile .\local_ai_server.py" {
      & ".\.venv\Scripts\python.exe" -m py_compile ".\local_ai_server.py"
    }
  } finally {
    Pop-Location
  }

  Write-Host ""
  Write-Pass "Archive scope/privacy repair completed."
  Write-Host "Backup created: $indexBackup" -ForegroundColor Yellow
  Write-Host "Restart the Discord bot before testing." -ForegroundColor Yellow
  Write-Host ""
  Write-Host "Retest:" -ForegroundColor Cyan
  Write-Host "1) Run /archivestatus in a server." -ForegroundColor White
  Write-Host "   Expected: no dm-unknown and no C:\ path shown." -ForegroundColor White
  Write-Host "2) Archive an image in that same server." -ForegroundColor White
  Write-Host "   Expected: no local file path exposed in Discord." -ForegroundColor White
  Write-Host "3) Run /postarchive in that same server." -ForegroundColor White
  Write-Host "   Expected: checks that server's archive scope, not dm-unknown." -ForegroundColor White
  exit 0
} catch {
  Write-Host ""
  Write-Fail $_.Exception.Message
  Write-Host "Backup available:" -ForegroundColor Yellow
  if ($indexBackup) { Write-Host $indexBackup -ForegroundColor Yellow }
  exit 1
}
