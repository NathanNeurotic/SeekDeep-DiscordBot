# SeekDeep / Seekotics archive/status/quiet/report command pack
#
# Applies the next stable batch from the checkpoint:
# 1) Archive status v2:
#    - Reports Discord archive channel/thread health as primary.
#    - Reports local fallback files and migrated markers separately.
#
# 2) Archive thread commands:
#    - @SEEKOTICS archive shared
#    - @SEEKOTICS archive me
#    - @SEEKOTICS archive @user
#
# 3) Quiet report cleanup:
#    - Hides "Time to Generate: 0.00 seconds" + "Model Used: local command (no AI model)"
#      for local command acknowledgements.
#    - Keeps real model/render info for actual image/chat outputs.
#
# 4) Botanical slang grounding cleanup:
#    - Replaces the existing cannabis/bud slang grounding helper with a clean version.
#
# Validation:
# - node --check .\index.js
# - python -m py_compile .\local_ai_server.py

$ErrorActionPreference = "Stop"

try {
  [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
} catch {}

function Write-Info { param([string]$Message) Write-Host "[SeekDeep archive-v2-pack] $Message" -ForegroundColor Cyan }
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

  $backup = Join-Path $backupDir "index.js.before-archive-v2-pack-$stamp.bak"
  Copy-Item -LiteralPath $indexPath -Destination $backup -Force
  Write-Pass "Backed up index.js to $backup"

  $patchPy = @'
from pathlib import Path
import re
import sys

if len(sys.argv) != 2:
    raise SystemExit("Usage: archive_v2_pack.py <index.js>")

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
        start = source.find(prefix + name + "(")
        if start >= 0:
            break
    else:
        return None, -1, -1

    sig = source[start:start + 1500]
    m = re.search(r"\)\s*\{", sig)
    if not m:
        fail(f"Could not find opening brace for {name}")
    open_brace = start + m.end() - 1
    close = find_matching_brace(source, open_brace)
    return source[start:close + 1], start, close + 1


def replace_or_insert_function(source, name, new_fn, anchor=None):
    _fn, start, end = get_function(source, name)
    if start >= 0:
        return source[:start] + new_fn.rstrip() + source[end:]

    pos = -1
    if anchor:
        for prefix in ("async function ", "function "):
            pos = source.find(prefix + anchor + "(")
            if pos >= 0:
                break

    if pos < 0:
        pos = source.find("client.on('messageCreate'")
    if pos < 0:
        pos = source.find('client.on("messageCreate"')
    if pos < 0:
        fail(f"Could not insert function {name}")

    return source[:pos] + new_fn.rstrip() + "\n\n" + source[pos:]


def get_client_handler(source, event_name):
    for quote in ("'", '"'):
        start = source.find(f"client.on({quote}{event_name}{quote}")
        if start >= 0:
            break
    else:
        return None, -1, -1

    arrow = source.find("=>", start)
    if arrow < 0:
        return None, -1, -1
    open_brace = source.find("{", arrow)
    if open_brace < 0:
        return None, -1, -1
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


# Basic sanity.
if "seekdeepEnqueueImageJob(job, runner)" not in text:
    fail("queue contract anchor missing; refusing to patch wrong file")
if "client.on('messageCreate'" not in text and 'client.on("messageCreate"' not in text:
    fail("messageCreate handler missing")


quiet_helpers = r"""function seekdeepIsNoModelReportLabel(modelUsed = '') {
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
    return 'Queued both:\n• Original\n• Refined';
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
    /^Archive/i.test(text) ||
    /^Image archive status/i.test(text) ||
    /^Download URL:/i.test(text)
  );
}"""

if "function seekdeepIsNoModelReportLabel" not in text:
    pos = text.find("function seekdeepAppendResponseFooter")
    if pos < 0:
        pos = text.find("client.on('messageCreate'")
    if pos < 0:
        pos = text.find('client.on("messageCreate"')
    text = text[:pos] + quiet_helpers + "\n\n" + text[pos:]


append_fn = r"""function seekdeepAppendResponseFooter(content, meta = {}) {
  const rawBody = String(content ?? '').trim();
  const body = seekdeepCleanPublicReportText(seekdeepCompactQueueSummary(rawBody));

  const modelUsed = meta.modelUsed || SEEKDEEP_NO_MODEL_USED_LABEL;

  if (typeof seekdeepTrackBotResponse === 'function') {
    seekdeepTrackBotResponse(modelUsed);
  }

  if (seekdeepShouldHideCommandFooter(body, { ...meta, modelUsed })) {
    return body;
  }

  const footer = seekdeepResponseFooter({
    ...meta,
    modelUsed,
  });

  return body ? `${body}\n\n${footer}` : footer;
}"""
text = replace_or_insert_function(text, "seekdeepAppendResponseFooter", append_fn)


botanical_fn = r"""function seekdeepGroundBotanicalSlangPrompt(prompt = '') {
  const raw = String(prompt || '').trim();
  const lower = raw.toLowerCase();

  const hasBud =
    /\b(bud|buds|flower|nug|nugs|nugget|weed|cannabis|marijuana|ganja|kush|herb|tree|trees)\b/i.test(lower);

  const hasSugaryVisual =
    /\b(sugary|sugar|frosty|frosted|crystal|crystals|crystalline|sticky|resin|resiny|trichome|trichomes|loud|dank|sparkly|snowy)\b/i.test(lower);

  if (!(hasBud && hasSugaryVisual)) {
    return raw;
  }

  const cleaned = raw
    .replace(/\blookin['’]?/gi, 'looking')
    .replace(/\bshow me\b/gi, '')
    .replace(/\bgenerate\b/gi, '')
    .replace(/\bpicture of\b/gi, '')
    .replace(/\bimage of\b/gi, '')
    .replace(/\s+/g, ' ')
    .trim();

  return [
    'frosty cannabis flower close-up',
    'dense white trichomes like sugar crystals',
    'sticky resin',
    'green and purple bud structure',
    'realistic botanical texture',
    'macro product-photo composition',
    'sharp leaf and flower structure',
    'natural plant detail',
    cleaned ? `user wording: ${cleaned}` : '',
    'no eyes',
    'no face',
    'no candy',
    'no gum',
    'no cartoon mascot',
    'no humanoid features',
    'no extra characters',
    'no monster anatomy',
    'no surreal eyeballs',
  ].filter(Boolean).join(', ');
}"""
text = replace_or_insert_function(text, "seekdeepGroundBotanicalSlangPrompt", botanical_fn, "seekdeepGroundImagePrompt")


archive_v2_helpers = r"""function seekdeepLocalArchiveStatsForTarget(target = null) {
  const safeTarget = target || {};
  const guildId = safeTarget?.guild?.id || safeTarget?.guildId || safeTarget?.message?.guild?.id || safeTarget?.message?.guildId || '';
  const baseDir = typeof __dirname !== 'undefined' ? __dirname : process.cwd();
  const dirs = [];

  if (guildId) {
    dirs.push(path.join(baseDir, 'saved_generations', 'archives', `guild-${guildId}`));
  }

  dirs.push(path.join(baseDir, 'saved_generations', 'archives'));
  dirs.push(path.join(baseDir, 'saved_generations'));

  const seen = new Set();
  const stats = {
    files: 0,
    images: 0,
    metadata: 0,
    migratedMarkers: 0,
    bytes: 0,
    newest: null,
  };

  for (const dir of dirs) {
    try {
      if (!fs.existsSync(dir)) continue;
      for (const name of fs.readdirSync(dir)) {
        const fullPath = path.join(dir, name);
        if (seen.has(fullPath)) continue;
        seen.add(fullPath);

        let stat = null;
        try {
          stat = fs.statSync(fullPath);
        } catch {}

        if (!stat || !stat.isFile()) continue;

        stats.files += 1;
        stats.bytes += Number(stat.size || 0);

        if (/\.(?:png|jpe?g|webp|gif)$/i.test(name)) stats.images += 1;
        if (/\.json$/i.test(name)) stats.metadata += 1;
        if (/\.discord-thread-migrated$/i.test(name)) stats.migratedMarkers += 1;

        if (!stats.newest || Number(stat.mtimeMs || 0) > Number(stats.newest.mtimeMs || 0)) {
          stats.newest = { name, mtimeMs: stat.mtimeMs };
        }
      }
    } catch (err) {
      console.warn('SeekDeep local archive stats scan failed:', err?.message || err);
    }
  }

  return stats;
}

async function seekdeepFindArchiveThreadByName(channel, threadName) {
  if (!channel?.threads) return null;

  const active = await channel.threads.fetchActive().catch(() => null);
  const activeThread = active?.threads?.find((thread) => thread?.name === threadName);
  if (activeThread) return activeThread;

  const archivedPublic = await channel.threads.fetchArchived({ type: 'public' }).catch(() => null);
  const archivedThread = archivedPublic?.threads?.find((thread) => thread?.name === threadName);
  if (archivedThread) return archivedThread;

  return null;
}

async function seekdeepArchiveThreadHealthForTarget(target = null) {
  const safeTarget = target || {};
  const guild = safeTarget?.guild || safeTarget?.message?.guild || safeTarget?.channel?.guild || null;

  if (!guild) {
    return {
      scope: 'this DM',
      hasGuild: false,
      channel: null,
      sharedThread: null,
      userThread: null,
      userThreadName: '',
      error: 'Discord archive threads require a server.',
    };
  }

  let channel = null;
  let error = '';

  try {
    channel = await seekdeepGetOrCreateGuildArchiveChannel(safeTarget);
  } catch (err) {
    error = err?.message || String(err);
  }

  const user = safeTarget?.user || safeTarget?.author || safeTarget?.member?.user || safeTarget?.message?.author || null;
  const userThreadName = typeof seekdeepArchiveUserThreadName === 'function'
    ? seekdeepArchiveUserThreadName(user)
    : '';

  const sharedThread = channel ? await seekdeepFindArchiveThreadByName(channel, 'Shared') : null;
  const userThread = channel && userThreadName ? await seekdeepFindArchiveThreadByName(channel, userThreadName) : null;

  return {
    scope: 'this server',
    hasGuild: true,
    channel,
    sharedThread,
    userThread,
    userThreadName,
    error,
  };
}

async function seekdeepBuildArchiveStatusReportV2(target = null) {
  const local = seekdeepLocalArchiveStatsForTarget(target);
  const health = await seekdeepArchiveThreadHealthForTarget(target);

  const lines = [
    'Image archive status',
    `Scope: ${health.scope}`,
    `Archive channel: ${health.channel ? `<#${health.channel.id}>` : 'missing'}`,
    `Shared thread: ${health.sharedThread ? `<#${health.sharedThread.id}>` : 'missing'}`,
    `User thread: ${health.userThread ? `<#${health.userThread.id}>` : `missing${health.userThreadName ? ` (${health.userThreadName})` : ''}`}`,
    '',
    'Local fallback storage:',
    `Images: ${local.images}`,
    `Metadata files: ${local.metadata}`,
    `Migrated markers: ${local.migratedMarkers}`,
    `Total local files: ${local.files}`,
    `Size: ${typeof seekdeepFormatBytesCompact === 'function' ? seekdeepFormatBytesCompact(local.bytes) : `${local.bytes} B`}`,
    `Newest local file: ${local.newest ? local.newest.name : 'none'}`,
  ];

  if (health.error) {
    lines.push('', `Archive thread warning: ${health.error}`);
  }

  return lines.join('\n');
}

function seekdeepIsArchiveOpenPrompt(value = '') {
  const prompt = seekdeepCleanMessageCommandPrompt
    ? seekdeepCleanMessageCommandPrompt(value).toLowerCase()
    : String(value || '').toLowerCase().trim();

  return /^(?:archive\s+(?:shared|me)|archive\s+<@!?\d+>|open\s+archive(?:\s+(?:shared|me|<@!?\d+>))?)$/i.test(prompt);
}

async function seekdeepHandleArchiveOpenMessage(message, prompt = '') {
  if (!message || !seekdeepIsArchiveOpenPrompt(prompt || message.content || '')) return false;

  if (!message.guild) {
    await message.reply({
      content: 'Archive threads only work inside a server.',
      allowedMentions: { repliedUser: false },
    });
    return true;
  }

  const clean = seekdeepCleanMessageCommandPrompt
    ? seekdeepCleanMessageCommandPrompt(prompt || message.content || '').toLowerCase()
    : String(prompt || message.content || '').toLowerCase().trim();

  let targetUser = message.author;

  if (/\bshared\b/i.test(clean)) {
    const { thread } = await seekdeepGetOrCreateSharedArchiveThread(message);
    await message.reply({
      content: `Shared archive: <#${thread.id}>`,
      allowedMentions: { repliedUser: false },
    });
    return true;
  }

  const mentioned = message.mentions?.users?.first?.();
  if (mentioned) targetUser = mentioned;

  const { thread, threadName } = await seekdeepGetOrCreateUserArchiveThread(message, targetUser);

  await message.reply({
    content: [
      mentioned ? `Archive for <@${targetUser.id}>: <#${thread.id}>` : `Your archive: <#${thread.id}>`,
      `Thread: ${threadName}`,
    ].join('\n'),
    allowedMentions: { repliedUser: false },
  });

  return true;
}"""

# Insert helpers if missing; replace v2 report if present.
for name in [
    "seekdeepLocalArchiveStatsForTarget",
    "seekdeepFindArchiveThreadByName",
    "seekdeepArchiveThreadHealthForTarget",
    "seekdeepBuildArchiveStatusReportV2",
    "seekdeepIsArchiveOpenPrompt",
    "seekdeepHandleArchiveOpenMessage",
]:
    # Individual replace not needed except if function already exists. Use replace/insert one by one from block hard is complicated.
    pass

if "async function seekdeepBuildArchiveStatusReportV2" not in text:
    pos = -1
    for anchor in ("seekdeepBuildArchiveStatusReport", "seekdeepHandleArchiveStatusMessage"):
        for prefix in ("async function ", "function "):
            pos = text.find(prefix + anchor + "(")
            if pos >= 0:
                break
        if pos >= 0:
            break
    if pos < 0:
        fail("Could not insert archive v2 helpers")
    text = text[:pos] + archive_v2_helpers + "\n\n" + text[pos:]


status_msg_fn = r"""async function seekdeepHandleArchiveStatusMessage(message, prompt = '') {
  if (!message || !seekdeepIsArchiveStatusPrompt(prompt || message.content || '')) {
    return false;
  }

  if (typeof seekdeepLogRoute === 'function') {
    seekdeepLogRoute('archive-status-message', prompt || message.content || '');
  }

  const startedAt = typeof seekdeepNowMs === 'function' ? seekdeepNowMs() : Date.now();
  const report = await seekdeepBuildArchiveStatusReportV2(message);

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
text = replace_or_insert_function(text, "seekdeepHandleArchiveStatusMessage", status_msg_fn)


# Insert archive-open route before archive-status route in messageCreate.
handler, hs, he = get_client_handler(text, "messageCreate")
if hs < 0:
    fail("messageCreate handler not found")

if "seekdeepHandleArchiveOpenMessage(message" not in handler:
    injection = r"""
  try {
    const seekdeepArchiveOpenRawContent = String(message?.content || '');
    if (await seekdeepHandleArchiveOpenMessage(message, seekdeepArchiveOpenRawContent)) {
      return;
    }
  } catch (err) {
    console.error('Archive open message handler failed:', err?.stack || err?.message || err);
    try {
      await message.reply({
        content: 'Archive lookup failed locally. Check the bot console for details.',
        allowedMentions: { repliedUser: false },
      });
    } catch {}
    return;
  }

"""

    # Place after bot guard and before migration/status if possible.
    marker = "try {\n    const seekdeepArchiveMigrationRawContent"
    idx = handler.find(marker)
    if idx >= 0:
        handler = handler[:idx] + injection + handler[idx:]
    else:
        bot_guard = re.search(r"\n\s*if\s*\([^\n]*(?:message\.author\.bot|author\?\.bot)[^\n]*\)\s*return\s*;?", handler)
        if bot_guard:
            insert_at = bot_guard.end()
            handler = handler[:insert_at] + injection + handler[insert_at:]
        else:
            ob = handler.find("{")
            handler = handler[:ob+1] + injection + handler[ob+1:]

    text = text[:hs] + handler + text[he:]


# Validate.
for needle, label in [
    ("function seekdeepIsNoModelReportLabel", "quiet helper"),
    ("function seekdeepAppendResponseFooter", "quiet footer"),
    ("async function seekdeepBuildArchiveStatusReportV2", "archive status v2"),
    ("async function seekdeepHandleArchiveOpenMessage", "archive open command"),
    ("seekdeepHandleArchiveOpenMessage(message", "archive open route"),
    ("function seekdeepGroundBotanicalSlangPrompt", "botanical helper"),
    ("frosty cannabis flower close-up", "botanical phrase"),
]:
    if needle not in text:
        fail(f"Missing required patch element: {label}")

for bad in ["}, target = null) {", "state = {) {", "state = {,"]:
    if bad in text:
        fail(f"Malformed code detected after patch: {bad}")

out = text if newline == "\n" else text.replace("\n", "\r\n")
path.write_bytes(out.encode("utf-8"))
print("Archive/status/quiet/report command pack applied.")
'@

  $patchPyPath = Join-Path $patchesDir "archive_v2_status_quiet_pack.py"
  [System.IO.File]::WriteAllText($patchPyPath, $patchPy, [System.Text.UTF8Encoding]::new($false))

  Push-Location $projectRoot
  try {
    Write-Info "Applying archive/status/quiet/report command pack"
    & ".\.venv\Scripts\python.exe" $patchPyPath $indexPath
    if ($LASTEXITCODE -ne 0) { throw "Patch helper failed with exit code $LASTEXITCODE." }
    Write-Pass "Applied archive/status/quiet/report command pack"

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
  Write-Pass "Archive/status/quiet/report command pack completed."
  Write-Host "Backup created: $backup" -ForegroundColor Yellow
  Write-Host "Restart the bot before testing." -ForegroundColor Yellow
  Write-Host ""
  Write-Host "Retest commands:" -ForegroundColor Cyan
  Write-Host "@SEEKOTICS archivestatus" -ForegroundColor White
  Write-Host "@SEEKOTICS archive shared" -ForegroundColor White
  Write-Host "@SEEKOTICS archive me" -ForegroundColor White
  Write-Host "@SEEKOTICS archive @user" -ForegroundColor White
  Write-Host "@SEEKOTICS show me a sugary lookin' bud" -ForegroundColor White
  exit 0
} catch {
  Write-Host ""
  Write-Fail $_.Exception.Message
  Write-Host "Backup available:" -ForegroundColor Yellow
  if ($backup) { Write-Host $backup -ForegroundColor Yellow }
  exit 1
}
