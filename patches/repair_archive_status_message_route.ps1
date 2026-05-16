# SeekDeep / Seekotics archive status message-route repair
#
# Fixes the exact failure shown in the log:
# - @SEEKOTICS archivestatus can fall through into the chat model.
# - Qwen then hallucinates a giant fake "Archive status: inactive..." report.
# - Message-mode archive status can resolve to dm-unknown and expose local host paths.
#
# Behavior after patch:
# - Text messages like:
#     @SEEKOTICS archivestatus
#     @SEEKOTICS archive status
#     @SEEKOTICS status archive
#   are intercepted before chat/image/research routing.
# - The bot sends one small local archive status report.
# - It returns immediately, so the chat model cannot answer too.
# - The displayed archive scope is "this server" or "this DM", not C:\... or dm-unknown.
#
# Files patched:
# - index.js only

$ErrorActionPreference = "Stop"

try {
  [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
} catch {}

function Write-Info {
  param([string]$Message)
  Write-Host "[SeekDeep archive-status-message-route] $Message" -ForegroundColor Cyan
}

function Write-Pass {
  param([string]$Message)
  Write-Host "[PASS] $Message" -ForegroundColor Green
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

  $backup = Join-Path $backupDir "index.js.archive-status-message-route-$stamp.bak"
  Copy-Item -LiteralPath $indexPath -Destination $backup -Force
  Write-Pass "Backed up index.js to $backup"

  $patchPy = @'
from pathlib import Path
import re
import sys

if len(sys.argv) != 2:
    raise SystemExit("Usage: patch_archive_status_message_route.py <index.js>")

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


def replace_or_insert_function(source, name, new_fn, anchor):
    _, start, end = get_function(source, name)
    if start >= 0:
        return source[:start] + new_fn.rstrip() + source[end:]

    pos = source.find(anchor)
    if pos < 0:
        pos = source.find("client.on('messageCreate'")
    if pos < 0:
        pos = source.find("client.on('interactionCreate'")
    if pos < 0:
        fail(f"Could not find insertion point for {name}.")
    return source[:pos] + new_fn.rstrip() + "\n\n" + source[pos:]


def get_client_handler(source, event_name):
    needle1 = f"client.on('{event_name}'"
    needle2 = f'client.on("{event_name}"'
    start = source.find(needle1)
    if start < 0:
        start = source.find(needle2)
    if start < 0:
        return None, -1, -1

    arrow = source.find("=>", start)
    if arrow < 0:
        fail(f"Could not find arrow function for client.on('{event_name}').")

    open_brace = source.find("{", arrow)
    if open_brace < 0:
        fail(f"Could not find opening brace for client.on('{event_name}').")

    close_brace = find_matching_brace(source, open_brace)
    # include closing ); if present
    end = close_brace + 1
    while end < len(source) and source[end].isspace():
        end += 1
    if source.startswith(");", end):
        end += 2
    elif end < len(source) and source[end] == ")":
        end += 1
        if end < len(source) and source[end] == ";":
            end += 1

    return source[start:end], start, end


if "client.on('messageCreate'" not in text and 'client.on("messageCreate"' not in text:
    fail("messageCreate handler not found.")
if "client.on('interactionCreate'" not in text and 'client.on("interactionCreate"' not in text:
    fail("interactionCreate handler not found.")

helpers = r"""function seekdeepArchiveStatusCleanPrompt(value = '') {
  return String(value || '')
    .replace(/<@!?\d+>/g, ' ')
    .replace(/\bseekotics\b/gi, ' ')
    .replace(/\bseekdeep\b/gi, ' ')
    .replace(/^[@/\s]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function seekdeepIsArchiveStatusPrompt(value = '') {
  const prompt = seekdeepArchiveStatusCleanPrompt(value);
  return /^(?:archive\s*status|archivestatus|status\s+archive|archive\s+stats|archivestats)$/.test(prompt);
}

function seekdeepArchiveStatusTargetFallback(target = null) {
  if (target) return target;
  if (typeof interaction !== 'undefined' && interaction) return interaction;
  if (typeof message !== 'undefined' && message) return message;
  return {};
}

function seekdeepArchiveScopeLabelForTarget(target = null) {
  const safeTarget = seekdeepArchiveStatusTargetFallback(target);
  if (safeTarget?.guild?.id || safeTarget?.guildId || safeTarget?.message?.guild?.id || safeTarget?.message?.guildId) {
    return 'this server';
  }
  return 'this DM';
}

function seekdeepArchiveDirForStatusTarget(target = null) {
  const safeTarget = seekdeepArchiveStatusTargetFallback(target);

  if (typeof seekdeepArchiveDirForTarget === 'function') {
    return seekdeepArchiveDirForTarget(safeTarget);
  }

  const guildId = safeTarget?.guild?.id || safeTarget?.guildId || safeTarget?.message?.guild?.id || safeTarget?.message?.guildId || '';
  const userId = safeTarget?.author?.id || safeTarget?.user?.id || safeTarget?.member?.user?.id || 'unknown';
  const scope = guildId ? `guild-${guildId}` : `dm-${userId}`;
  const baseDir = typeof __dirname !== 'undefined' ? __dirname : process.cwd();
  const dir = path.join(baseDir, 'saved_generations', 'archives', scope);
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch {}
  return dir;
}

function seekdeepFormatBytesCompact(bytes = 0) {
  const n = Number(bytes || 0);
  if (!Number.isFinite(n) || n <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = n;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(unit === 0 ? 0 : 1)} ${units[unit]}`;
}

function seekdeepBuildArchiveStatusReport(target = null) {
  const safeTarget = seekdeepArchiveStatusTargetFallback(target);
  const dir = seekdeepArchiveDirForStatusTarget(safeTarget);
  let files = [];

  try {
    if (fs.existsSync(dir)) {
      files = fs.readdirSync(dir, { withFileTypes: true })
        .filter((entry) => entry.isFile())
        .map((entry) => {
          const fullPath = path.join(dir, entry.name);
          let stat = null;
          try {
            stat = fs.statSync(fullPath);
          } catch {}
          return { name: entry.name, stat };
        });
    }
  } catch (err) {
    console.warn('Archive status scan failed:', err?.message || err);
  }

  const imageFiles = files.filter((file) => /\.(?:png|jpe?g|webp|gif)$/i.test(file.name));
  const metaFiles = files.filter((file) => /\.json$/i.test(file.name));
  const totalBytes = files.reduce((sum, file) => sum + Number(file?.stat?.size || 0), 0);
  const newest = files
    .filter((file) => file.stat && file.stat.mtimeMs)
    .sort((a, b) => b.stat.mtimeMs - a.stat.mtimeMs)[0];

  return [
    'Image archive status',
    `Scope: ${seekdeepArchiveScopeLabelForTarget(safeTarget)}`,
    `Images: ${imageFiles.length}`,
    `Metadata files: ${metaFiles.length}`,
    `Total files: ${files.length}`,
    `Size: ${seekdeepFormatBytesCompact(totalBytes)}`,
    `Newest file: ${newest ? newest.name : 'none'}`,
  ].join('\n');
}

async function seekdeepHandleArchiveStatusMessage(message, prompt = '') {
  if (!message || !seekdeepIsArchiveStatusPrompt(prompt || message.content || '')) {
    return false;
  }

  if (typeof seekdeepLogRoute === 'function') {
    seekdeepLogRoute('archive-status-message', prompt || message.content || '');
  }

  const startedAt = typeof seekdeepNowMs === 'function' ? seekdeepNowMs() : Date.now();
  const report = seekdeepBuildArchiveStatusReport(message);

  const content = typeof seekdeepAppendResponseFooter === 'function'
    ? seekdeepAppendResponseFooter(report, {
        startedAt,
        modelUsed: typeof seekdeepNoModelLabel === 'function' ? seekdeepNoModelLabel() : 'local command (no AI model)',
      })
    : report;

  await message.reply({
    content,
    allowedMentions: { repliedUser: false },
  });

  return true;
}"""

for name in [
    "seekdeepArchiveStatusCleanPrompt",
    "seekdeepIsArchiveStatusPrompt",
    "seekdeepArchiveStatusTargetFallback",
    "seekdeepArchiveScopeLabelForTarget",
    "seekdeepArchiveDirForStatusTarget",
    "seekdeepFormatBytesCompact",
    "seekdeepBuildArchiveStatusReport",
    "seekdeepHandleArchiveStatusMessage",
]:
    # split helper by function name
    pattern = rf"function {name}\("
    if re.search(pattern, text):
        continue

# Simpler insertion: if primary helper not present, insert the whole block.
if "function seekdeepHandleArchiveStatusMessage" not in text:
    insert_pos = text.find("client.on('messageCreate'")
    if insert_pos < 0:
        insert_pos = text.find('client.on("messageCreate"')
    text = text[:insert_pos] + helpers + "\n\n" + text[insert_pos:]

# Patch messageCreate handler to intercept early after bot/self filters.
handler, hs, he = get_client_handler(text, "messageCreate")

if "seekdeepHandleArchiveStatusMessage(message" not in handler:
    open_brace = handler.find("{")
    if open_brace < 0:
        fail("Could not patch messageCreate handler.")

    injection = r"""
  try {
    const seekdeepArchiveStatusRawContent = String(message?.content || '');
    if (await seekdeepHandleArchiveStatusMessage(message, seekdeepArchiveStatusRawContent)) {
      return;
    }
  } catch (err) {
    console.error('Archive status message handler failed:', err?.stack || err?.message || err);
    try {
      await message.reply({
        content: 'Archive status failed locally. Check the bot console for details.',
        allowedMentions: { repliedUser: false },
      });
    } catch {}
    return;
  }

"""
    # Insert after common early ignore lines if possible, otherwise at top.
    # Avoid responding to bot messages by placing after the first bot-author guard if found.
    bot_guard = re.search(r"\n\s*if\s*\([^\n]*(?:message\.author\.bot|author\?\.bot)[^\n]*\)\s*return\s*;?", handler)
    if bot_guard:
        insert_at = bot_guard.end()
        handler = handler[:insert_at] + injection + handler[insert_at:]
    else:
        handler = handler[:open_brace + 1] + injection + handler[open_brace + 1:]

    text = text[:hs] + handler + text[he:]

# Improve slash command status output if the existing command still displays paths.
text = text.replace("Archive scope: C:\\Users\\natha\\SeekDeep-DiscordBot\\saved_generations\\archives\\dm-unknown", "Scope: this server")
text = re.sub(r"Archive scope:\s*[A-Z]:\\[^\n\r`]+", "Scope: this server", text)
text = re.sub(r"Path:\s*[A-Z]:\\[^\n\r`]+", "Scope: this server", text)

# Validation.
for needle, label in [
    ("function seekdeepHandleArchiveStatusMessage", "archive status message handler"),
    ("function seekdeepBuildArchiveStatusReport", "archive status report builder"),
    ("archive-status-message", "archive status route log"),
]:
    if needle not in text:
        fail(f"Required anchor missing after patch: {label}")

handler, _, _ = get_client_handler(text, "messageCreate")
if "seekdeepHandleArchiveStatusMessage(message" not in handler:
    fail("messageCreate handler was not patched.")

out = text if newline == "\n" else text.replace("\n", "\r\n")
path.write_bytes(out.encode("utf-8"))
print("Patched archive status message routing.")
'@

  $patchPyPath = Join-Path $patchesDir "patch_archive_status_message_route.py"
  [System.IO.File]::WriteAllText($patchPyPath, $patchPy, [System.Text.UTF8Encoding]::new($false))

  Push-Location $projectRoot
  try {
    Write-Info "Applying archive status message-route patch"
    & ".\.venv\Scripts\python.exe" $patchPyPath $indexPath
    if ($LASTEXITCODE -ne 0) { throw "Patch helper failed with exit code $LASTEXITCODE." }
    Write-Pass "Applied archive status message-route patch"

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
  Write-Pass "Archive status message-route patch completed."
  Write-Host "Backup created: $backup" -ForegroundColor Yellow
  Write-Host "Restart the bot before testing." -ForegroundColor Yellow
  Write-Host ""
  Write-Host "Retest:" -ForegroundColor Cyan
  Write-Host "@SEEKOTICS archivestatus" -ForegroundColor White
  Write-Host "@SEEKOTICS archive status" -ForegroundColor White
  Write-Host ""
  Write-Host "Expected:" -ForegroundColor Cyan
  Write-Host "- one small archive status report" -ForegroundColor White
  Write-Host "- no Qwen/chat-model hallucinated archive report" -ForegroundColor White
  Write-Host "- no C:\ path" -ForegroundColor White
  Write-Host "- no dm-unknown in a server" -ForegroundColor White
  exit 0
} catch {
  Write-Host ""
  Write-Fail $_.Exception.Message
  Write-Host "Backup available:" -ForegroundColor Yellow
  if ($backup) { Write-Host $backup -ForegroundColor Yellow }
  exit 1
}
