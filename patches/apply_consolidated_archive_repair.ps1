# SeekDeep consolidated archive-thread repair + audit-pack fix
#
# Purpose:
# - Stop the repeated broken patch loop.
# - Repair the current malformed archive-thread image function signature directly.
# - Replace archive-thread posting with a version that posts the actual image attachment.
# - Add/fix minimal thread-archive helper functions if missing.
# - Patch the image Archive button branch if needed.
# - Write a fixed audit-pack script for future use.
#
# Files changed:
# - index.js
# - patches\create_seekdeep_audit_pack_fixed.ps1
#
# Validation:
# - node --check .\index.js
# - python -m py_compile .\local_ai_server.py

$ErrorActionPreference = "Stop"

try {
  [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
} catch {}

function Write-Info {
  param([string]$Message)
  Write-Host "[SeekDeep consolidated-archive-repair] $Message" -ForegroundColor Cyan
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

  $backup = Join-Path $backupDir "index.js.before-consolidated-archive-repair-$stamp.bak"
  Copy-Item -LiteralPath $indexPath -Destination $backup -Force
  Write-Pass "Backed up index.js to $backup"

  $patchPy = @'
from pathlib import Path
import re
import sys

if len(sys.argv) != 2:
    raise SystemExit("Usage: consolidated_archive_repair.py <index.js>")

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


def find_function_start(source, name):
    pats = [
        rf"\nasync\s+function\s+{re.escape(name)}\s*\(",
        rf"\nfunction\s+{re.escape(name)}\s*\(",
        rf"^async\s+function\s+{re.escape(name)}\s*\(",
        rf"^function\s+{re.escape(name)}\s*\(",
    ]
    for pat in pats:
        m = re.search(pat, source)
        if m:
            return m.start() + (1 if source[m.start():m.start()+1] == "\n" else 0)
    return -1


def find_next_top_function(source, start):
    m = re.search(r"\n(?:async\s+)?function\s+[A-Za-z_$][\w$]*\s*\(", source[start:])
    if not m:
        return -1
    return start + m.start() + 1


def get_function_by_brace(source, name):
    start = find_function_start(source, name)
    if start < 0:
        return None, -1, -1

    # Prefer first "{\n" after the signature close. This avoids the "{ }" in malformed default params.
    sig_window = source[start:start + 1000]
    sig_match = re.search(r"\)\s*\{", sig_window)
    if sig_match:
        open_brace = start + sig_match.end() - 1
    else:
        open_brace = source.find("{", start)

    if open_brace < 0:
        return None, start, -1

    try:
        close = find_matching_brace(source, open_brace)
        return source[start:close + 1], start, close + 1
    except SystemExit:
        return None, start, -1


def replace_function_force(source, name, replacement, insert_before=None):
    _fn, start, end = get_function_by_brace(source, name)
    if start >= 0 and end > start:
        return source[:start] + replacement.rstrip() + source[end:]

    # If brace parsing failed, cut from this function start to next top-level function.
    if start >= 0:
        next_start = find_next_top_function(source, start + len(name) + 20)
        if next_start < 0:
            fail(f"Could not determine end of malformed function {name}")
        return source[:start] + replacement.rstrip() + "\n\n" + source[next_start:]

    if insert_before:
        pos = find_function_start(source, insert_before)
        if pos >= 0:
            return source[:pos] + replacement.rstrip() + "\n\n" + source[pos:]

    fail(f"Could not find or insert function {name}")


def get_client_handler(source, event_name):
    for quote in ("'", '"'):
        start = source.find(f"client.on({quote}{event_name}{quote}")
        if start >= 0:
            break
    else:
        return None, -1, -1

    arrow = source.find("=>", start)
    if arrow < 0:
        return None, start, -1
    open_brace = source.find("{", arrow)
    if open_brace < 0:
        return None, start, -1
    close = find_matching_brace(source, open_brace)
    end = close + 1
    while end < len(source) and source[end].isspace():
        end += 1
    if source.startswith(");", end):
        end += 2
    elif end < len(source) and source[end] == ")":
        end += 1
        if end < len(source) and source[end] == ";":
            end += 1
    return source[start:end], start, end


# ---------------------------------------------------------------------
# Hard cleanup of malformed signature fragments from previous patches.
# ---------------------------------------------------------------------
text = re.sub(
    r"async\s+function\s+seekdeepMaterializeArchiveFileFromState\s*\(\s*state\s*=\s*\{\s*\}\s*,?\s*\n\s*\}\s*,\s*target\s*=\s*null\s*\)\s*\{",
    "async function seekdeepMaterializeArchiveFileFromState(state, target) {",
    text,
)
text = re.sub(
    r"async\s+function\s+seekdeepArchiveImageStateToDiscordThread\s*\(\s*state\s*=\s*\{\s*\}\s*,?\s*\n\s*\}\s*,\s*target\s*=\s*null\s*\)\s*\{",
    "async function seekdeepArchiveImageStateToDiscordThread(state, target) {",
    text,
)
text = text.replace("}, target = null) {", ") { /* repaired malformed archive signature */")

# ---------------------------------------------------------------------
# Minimal thread archive helpers if the prior thread-storage patch is absent/incomplete.
# ---------------------------------------------------------------------
thread_helpers = r"""function seekdeepArchiveChannelName() {
  return String(process.env.SEEKDEEP_ARCHIVE_CHANNEL_NAME || 'seekdeep-archive')
    .trim()
    .replace(/^#+/, '')
    .replace(/\s+/g, '-')
    .toLowerCase() || 'seekdeep-archive';
}

function seekdeepArchiveUserThreadName(user) {
  user = user || {};
  const username = String(user.username || user.globalName || user.displayName || user.id || 'unknown-user')
    .replace(/[^a-zA-Z0-9_. -]+/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .slice(0, 48) || 'unknown-user';

  const idSuffix = user.id ? `-${String(user.id).slice(-6)}` : '';
  return `archive-${username}${idSuffix}`.slice(0, 90);
}

function seekdeepArchiveMetadataLines(state, target) {
  state = state || {};
  target = target || null;

  const prompt = state.originalPrompt || state.rawPrompt || state.prompt || 'unknown prompt';
  const refinedPrompt = state.refinedPrompt || state.finalPrompt || '';
  const requester = target?.user || target?.author || target?.member?.user || target?.message?.author || null;

  const lines = [
    '**SeekDeep Image Archive Entry**',
    requester?.id ? `Requester: <@${requester.id}>` : '',
    `Prompt: ${String(prompt).slice(0, 1500)}`,
  ];

  if (refinedPrompt && refinedPrompt !== prompt) {
    lines.push(`Refined: ${String(refinedPrompt).slice(0, 1500)}`);
  }

  if (state.jobId) lines.push(`Job ID: ${state.jobId}`);
  if (state.modelUsed || state.model) lines.push(`Model: ${state.modelUsed || state.model}`);
  if (state.seed !== undefined && state.seed !== null) lines.push(`Seed: ${state.seed}`);
  if (state.width && state.height) lines.push(`Size: ${state.width}x${state.height}`);
  lines.push(`Archived: ${new Date().toISOString()}`);

  return lines.filter(Boolean);
}

async function seekdeepGetOrCreateGuildArchiveChannel(target) {
  target = target || null;

  const guild = target?.guild || target?.message?.guild || target?.channel?.guild || null;
  if (!guild) {
    throw new Error('Archive threads require a Discord server.');
  }

  const configuredId = String(process.env.SEEKDEEP_ARCHIVE_CHANNEL_ID || '').trim();
  if (configuredId) {
    const byId = guild.channels.cache.get(configuredId) || await guild.channels.fetch(configuredId).catch(() => null);
    if (byId) return byId;
  }

  const wantedName = seekdeepArchiveChannelName();
  let channel = guild.channels.cache.find((candidate) =>
    candidate &&
    candidate.name === wantedName &&
    typeof candidate.send === 'function' &&
    candidate.threads
  );

  if (!channel) {
    const fetched = await guild.channels.fetch().catch(() => null);
    if (fetched) {
      channel = fetched.find((candidate) =>
        candidate &&
        candidate.name === wantedName &&
        typeof candidate.send === 'function' &&
        candidate.threads
      );
    }
  }

  if (channel) return channel;

  channel = await guild.channels.create({
    name: wantedName,
    type: 0,
    reason: 'SeekDeep server archive channel',
  });

  await channel.send('SeekDeep archive channel initialized. User archive threads will be created here.').catch(() => null);
  return channel;
}

async function seekdeepFindArchiveThread(channel, threadName) {
  const active = await channel.threads.fetchActive().catch(() => null);
  const activeThread = active?.threads?.find((thread) => thread?.name === threadName);
  if (activeThread) return activeThread;

  const archivedPublic = await channel.threads.fetchArchived({ type: 'public' }).catch(() => null);
  const archivedThread = archivedPublic?.threads?.find((thread) => thread?.name === threadName);
  if (archivedThread) {
    try {
      if (archivedThread.archived) await archivedThread.setArchived(false, 'SeekDeep archive write');
    } catch {}
    return archivedThread;
  }

  return null;
}

async function seekdeepGetOrCreateUserArchiveThread(target, userOverride) {
  target = target || null;

  const channel = await seekdeepGetOrCreateGuildArchiveChannel(target);
  const user = userOverride || target?.user || target?.author || target?.member?.user || target?.message?.author || null;
  const threadName = seekdeepArchiveUserThreadName(user);

  let thread = await seekdeepFindArchiveThread(channel, threadName);
  if (thread) return { channel, thread, threadName };

  thread = await channel.threads.create({
    name: threadName,
    autoArchiveDuration: 10080,
    reason: `SeekDeep archive thread for ${user?.id || 'unknown user'}`,
  });

  await thread.send([
    `Archive thread for ${user?.id ? `<@${user.id}>` : 'unknown user'}.`,
    'New archived generations for this user will be posted here.',
  ].join('\n')).catch(() => null);

  return { channel, thread, threadName };
}"""

if "function seekdeepGetOrCreateUserArchiveThread" not in text:
    pos = find_function_start(text, "seekdeepHandleImageButton")
    if pos < 0:
        pos = text.find("client.on('interactionCreate'")
    if pos < 0:
        pos = text.find('client.on("interactionCreate"')
    if pos < 0:
        fail("Could not insert thread archive helpers.")
    text = text[:pos] + thread_helpers + "\n\n" + text[pos:]


# ---------------------------------------------------------------------
# Replacement functions: actual image posting.
# ---------------------------------------------------------------------
materialize_fn = r"""async function seekdeepMaterializeArchiveFileFromState(state, target) {
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
}"""

archive_writer_fn = r"""async function seekdeepArchiveImageStateToDiscordThread(state, target) {
  state = state || {};
  target = target || null;

  const archiveInfo = await seekdeepGetOrCreateUserArchiveThread(target);
  const thread = archiveInfo.thread;
  const threadName = archiveInfo.threadName;

  const payload = {
    content: seekdeepArchiveMetadataLines(state, target).join('\n'),
  };

  let filePath = '';

  try {
    filePath = await seekdeepMaterializeArchiveFileFromState(state, target);
    if (filePath) {
      payload.files = [filePath];
    }
  } catch (err) {
    console.warn('SeekDeep archive attachment materialization failed:', err?.message || err);
  }

  if (!payload.files || !payload.files.length) {
    const fallbackAttachment =
      target?.message?.attachments?.first?.() ||
      target?.attachments?.first?.() ||
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

    payload.content += fallbackUrl ? `\nImage URL: ${fallbackUrl}` : '\nImage attachment unavailable.';
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

text = replace_function_force(text, "seekdeepMaterializeArchiveFileFromState", materialize_fn, "seekdeepArchiveImageStateToDiscordThread")
text = replace_function_force(text, "seekdeepArchiveImageStateToDiscordThread", archive_writer_fn, "seekdeepHandleImageButton")


# ---------------------------------------------------------------------
# Patch Archive button branch if still local-only.
# ---------------------------------------------------------------------
handler_fn, hs, he = get_function_by_brace(text, "seekdeepHandleImageButton")
if hs >= 0:
    if "seekdeepArchiveImageStateToDiscordThread(state, interaction)" not in handler_fn:
        idx = handler_fn.find("if (action === 'archive')")
        if idx >= 0:
            open_brace = handler_fn.find("{", idx)
            close_brace = find_matching_brace(handler_fn, open_brace)
            new_block = r"""if (action === 'archive') {
    try {
      const archiveResult = await seekdeepArchiveImageStateToDiscordThread(state, interaction);
      await interaction.editReply({
        content: seekdeepAppendResponseFooter([
          'Archived to this server.',
          archiveResult?.threadName ? `Thread: ${archiveResult.threadName}` : '',
        ].filter(Boolean).join('\n'), {
          startedAt,
          modelUsed: seekdeepNoModelLabel(),
        }),
      });
      return true;
    } catch (err) {
      console.warn('Discord thread archive failed; falling back to local archive:', err?.message || err);

      const savedPath = typeof seekdeepArchiveImageStateToDisk === 'function'
        ? seekdeepArchiveImageStateToDisk(state)
        : '';

      await interaction.editReply({
        content: seekdeepAppendResponseFooter([
          'Discord thread archive failed.',
          savedPath ? 'Saved locally as fallback.' : 'No fallback file was written.',
          err?.message ? `Reason: ${String(err.message).slice(0, 500)}` : '',
        ].filter(Boolean).join('\n'), {
          startedAt,
          modelUsed: seekdeepNoModelLabel(),
        }),
      });
      return true;
    }
  }"""
            handler_fn = handler_fn[:idx] + new_block + handler_fn[close_brace + 1:]
            text = text[:hs] + handler_fn + text[he:]


# ---------------------------------------------------------------------
# Light display cleanup from previous work.
# ---------------------------------------------------------------------
text = text.replace("Generated locally:", "Generated:")
text = text.replace("Archived on the bot host:", "Archived to this server.")


# ---------------------------------------------------------------------
# Validation.
# ---------------------------------------------------------------------
for needle, label in [
    ("async function seekdeepMaterializeArchiveFileFromState(state, target)", "materialize signature"),
    ("async function seekdeepArchiveImageStateToDiscordThread(state, target)", "archive writer signature"),
    ("payload.files = [filePath];", "attachment line"),
    ("await thread.send(payload);", "thread send"),
    ("function seekdeepGetOrCreateUserArchiveThread", "thread helper"),
]:
    if needle not in text:
        fail(f"Missing required patch element: {label}")

if "}, target = null) {" in text:
    fail("Malformed signature remains after replacement.")

out = text if newline == "\n" else text.replace("\n", "\r\n")
path.write_bytes(out.encode("utf-8"))
print("Consolidated archive repair applied.")
'@

  $patchPyPath = Join-Path $patchesDir "consolidated_archive_repair.py"
  [System.IO.File]::WriteAllText($patchPyPath, $patchPy, [System.Text.UTF8Encoding]::new($false))

  Push-Location $projectRoot
  try {
    Write-Info "Applying consolidated archive repair"
    & ".\.venv\Scripts\python.exe" $patchPyPath $indexPath
    if ($LASTEXITCODE -ne 0) { throw "Patch helper failed with exit code $LASTEXITCODE." }
    Write-Pass "Applied consolidated archive repair"

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

  # Write a fixed audit packer for next time.
  $auditFixed = Join-Path $patchesDir "create_seekdeep_audit_pack_fixed.ps1"
  $auditScript = @'
$ErrorActionPreference = "Stop"
$projectRoot = Join-Path $env:USERPROFILE "SeekDeep-DiscordBot"
if (-not (Test-Path -LiteralPath (Join-Path $projectRoot "index.js"))) { $projectRoot = (Get-Location).Path }
$stamp = Get-Date -Format "yyyyMMdd-HHmmss"
$outDir = Join-Path $env:USERPROFILE "Downloads"
$workDir = Join-Path $env:TEMP "seekdeep-audit-pack-$stamp"
$zipPath = Join-Path $outDir "seekdeep-audit-pack-$stamp.zip"
New-Item -ItemType Directory -Path "$workDir\project","$workDir\diagnostics","$workDir\recent-backups","$workDir\recent-patches" -Force | Out-Null

foreach ($file in @("index.js","local_ai_server.py","package.json","package-lock.json","README.md","AGENTS.md")) {
  $src = Join-Path $projectRoot $file
  if (Test-Path -LiteralPath $src) { Copy-Item -LiteralPath $src -Destination (Join-Path $workDir "project\$file") -Force }
}

$patchesDir = Join-Path $projectRoot "patches"
if (Test-Path -LiteralPath $patchesDir) {
  Get-ChildItem -LiteralPath $patchesDir -File -ErrorAction SilentlyContinue |
    Where-Object { $_.Extension -in ".ps1",".py" } |
    Sort-Object LastWriteTime -Descending |
    Select-Object -First 30 |
    ForEach-Object { Copy-Item -LiteralPath $_.FullName -Destination (Join-Path $workDir "recent-patches\$($_.Name)") -Force }

  $backupDir = Join-Path $patchesDir "backups"
  if (Test-Path -LiteralPath $backupDir) {
    Get-ChildItem -LiteralPath $backupDir -File -Filter "index.js*.bak" -ErrorAction SilentlyContinue |
      Sort-Object LastWriteTime -Descending |
      Select-Object -First 12 |
      ForEach-Object { Copy-Item -LiteralPath $_.FullName -Destination (Join-Path $workDir "recent-backups\$($_.Name)") -Force }
  }
}

Push-Location $projectRoot
try {
  & node --check ".\index.js" *> (Join-Path $workDir "diagnostics\node-check.txt")
  "EXITCODE=$LASTEXITCODE" | Add-Content -LiteralPath (Join-Path $workDir "diagnostics\node-check.txt")

  $lines = Get-Content -LiteralPath ".\index.js"
  $context = New-Object System.Collections.Generic.List[string]
  $start = [Math]::Max(1, 3520)
  $end = [Math]::Min($lines.Count, 3620)
  for ($i = $start; $i -le $end; $i++) {
    $context.Add(("{0,6}: {1}" -f $i, $lines[$i - 1]))
  }
  $context | Set-Content -LiteralPath (Join-Path $workDir "diagnostics\index-context-around-archive.txt") -Encoding UTF8

  Select-String -Path ".\index.js" -Pattern "seekdeepArchiveImageStateToDiscordThread|seekdeepMaterializeArchiveFileFromState|seekdeepGetOrCreateUserArchiveThread|}, target = null" -Context 4,8 |
    Out-String -Width 240 |
    Set-Content -LiteralPath (Join-Path $workDir "diagnostics\archive-function-search.txt") -Encoding UTF8

  try { & git status --short *> (Join-Path $workDir "diagnostics\git-status.txt") } catch {}
} finally {
  Pop-Location
}

@"
SeekDeep audit pack
Created: $(Get-Date -Format o)
Project root: $projectRoot
Excluded: .env, node_modules, .venv, models, saved_generations, .git
"@ | Set-Content -LiteralPath (Join-Path $workDir "MANIFEST.txt") -Encoding UTF8

if (Test-Path -LiteralPath $zipPath) { Remove-Item -LiteralPath $zipPath -Force }
Compress-Archive -Path (Join-Path $workDir "*") -DestinationPath $zipPath -Force
Remove-Item -LiteralPath $workDir -Recurse -Force
Write-Host "[PASS] Created audit zip: $zipPath" -ForegroundColor Green
'@
  [System.IO.File]::WriteAllText($auditFixed, $auditScript, [System.Text.UTF8Encoding]::new($false))
  Write-Pass "Wrote fixed audit packer: $auditFixed"

  Write-Host ""
  Write-Pass "Consolidated archive repair completed."
  Write-Host "Backup created: $backup" -ForegroundColor Yellow
  Write-Host "Restart the bot before testing." -ForegroundColor Yellow
  Write-Host ""
  Write-Host "Retest:" -ForegroundColor Cyan
  Write-Host "1) Generate image" -ForegroundColor White
  Write-Host "2) Click Archive" -ForegroundColor White
  Write-Host "3) Open user archive thread" -ForegroundColor White
  Write-Host "Expected: image attachment plus metadata is posted in the thread." -ForegroundColor White
  exit 0
} catch {
  Write-Host ""
  Write-Fail $_.Exception.Message
  Write-Host "Backup available:" -ForegroundColor Yellow
  if ($backup) { Write-Host $backup -ForegroundColor Yellow }
  exit 1
}
