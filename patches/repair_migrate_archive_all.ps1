# SeekDeep / Seekotics force re-migrate all archives patch
#
# Fixes:
# - Existing local images were skipped because ".discord-thread-migrated" marker files already exist.
#
# Adds:
# - @SEEKOTICS migrate archive all
# - @SEEKOTICS remigrate archive
# - @SEEKOTICS remigrate archive all
# - @SEEKOTICS archive remigrate
#
# Behavior:
# - Normal command still skips already-migrated files:
#     @SEEKOTICS migrate archive
# - Force command ignores old marker files and re-posts everything:
#     @SEEKOTICS migrate archive all
#     @SEEKOTICS remigrate archive all
#
# Target:
# - Posts into the server archive channel's "Shared" thread.
#
# Validation:
# - node --check .\index.js
# - python -m py_compile .\local_ai_server.py

$ErrorActionPreference = "Stop"

try {
  [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
} catch {}

function Write-Info { param([string]$Message) Write-Host "[SeekDeep remigrate-all] $Message" -ForegroundColor Cyan }
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

  $backup = Join-Path $backupDir "index.js.before-remigrate-all-$stamp.bak"
  Copy-Item -LiteralPath $indexPath -Destination $backup -Force
  Write-Pass "Backed up index.js to $backup"

  $patchPy = @'
from pathlib import Path
import re
import sys

if len(sys.argv) != 2:
    raise SystemExit("Usage: patch_remigrate_all.py <index.js>")

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

    sig = source[start:start + 1200]
    m = re.search(r"\)\s*\{", sig)
    if not m:
        fail(f"Could not find opening brace for {name}")
    open_brace = start + m.end() - 1
    close = find_matching_brace(source, open_brace)
    return source[start:close + 1], start, close + 1


def replace_function(source, name, new_fn):
    _fn, start, end = get_function(source, name)
    if start < 0:
        fail(f"Missing function: {name}")
    return source[:start] + new_fn.rstrip() + source[end:]


required = [
    "seekdeepIsArchiveMigrationPrompt",
    "seekdeepHandleArchiveMigrationMessage",
    "seekdeepMigrateLocalArchiveToSharedThread",
    "seekdeepLocalArchiveFilesForMigration",
]
for name in required:
    if (f"function {name}(" not in text) and (f"async function {name}(" not in text):
        fail(f"Missing required migration function: {name}. Apply repair_migrate_archive_message_route.ps1 first.")


clean_prompt_fn = r"""function seekdeepCleanMessageCommandPrompt(value) {
  return String(value || '')
    .replace(/<@!?\d+>/g, ' ')
    .replace(/\bseekotics\b/gi, ' ')
    .replace(/\bseekdeep\b/gi, ' ')
    .replace(/^[@/\s]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}"""

is_prompt_fn = r"""function seekdeepIsArchiveMigrationPrompt(value) {
  const prompt = seekdeepCleanMessageCommandPrompt(value).toLowerCase();
  return /^(?:migrate\s+archive(?:\s+all)?|migratearchive(?:\s+all)?|archive\s+migrate(?:\s+all)?|archive\s+migration(?:\s+all)?|migrate\s+archives(?:\s+all)?|remigrate\s+archive(?:\s+all)?|remigrate\s+archives(?:\s+all)?|archive\s+remigrate(?:\s+all)?)$/i.test(prompt);
}"""

is_force_fn = r"""function seekdeepIsArchiveForceRemigrationPrompt(value) {
  const prompt = seekdeepCleanMessageCommandPrompt(value).toLowerCase();
  return /\b(?:all|force|again|re[-\s]?migrate|remigrate)\b/i.test(prompt);
}"""

local_files_fn = r"""function seekdeepLocalArchiveFilesForMigration(target, options) {
  target = target || {};
  options = options || {};

  const guildId = target?.guild?.id || target?.guildId || target?.message?.guild?.id || target?.message?.guildId || '';
  const baseDir = typeof __dirname !== 'undefined' ? __dirname : process.cwd();
  const dirs = [];

  if (guildId) {
    dirs.push(path.join(baseDir, 'saved_generations', 'archives', `guild-${guildId}`));
  }

  dirs.push(path.join(baseDir, 'saved_generations', 'archives'));
  dirs.push(path.join(baseDir, 'saved_generations'));

  const seen = new Set();
  const files = [];

  for (const dir of dirs) {
    try {
      if (!fs.existsSync(dir)) continue;

      const names = fs.readdirSync(dir);
      for (const name of names) {
        const fullPath = path.join(dir, name);
        if (seen.has(fullPath)) continue;
        seen.add(fullPath);

        let stat = null;
        try {
          stat = fs.statSync(fullPath);
        } catch {}

        if (!stat || !stat.isFile()) continue;
        if (!/\.(?:png|jpe?g|webp|gif)$/i.test(name)) continue;

        const marker = `${fullPath}.discord-thread-migrated`;
        if (!options.includeMigrated && fs.existsSync(marker)) continue;

        files.push({ name, fullPath, marker, stat });
      }
    } catch (err) {
      console.warn('SeekDeep archive migration scan failed:', err?.message || err);
    }
  }

  return files.sort((a, b) => Number(a.stat?.mtimeMs || 0) - Number(b.stat?.mtimeMs || 0));
}"""

migrate_fn = r"""async function seekdeepMigrateLocalArchiveToSharedThread(target, options) {
  target = target || null;
  options = options || {};

  const { thread, threadName } = await seekdeepGetOrCreateSharedArchiveThread(target);
  const files = seekdeepLocalArchiveFilesForMigration(target, options);
  const limit = Math.max(1, Math.min(Number(options.limit || 25), 500));
  const selected = files.slice(0, limit);

  let migrated = 0;
  let failed = 0;

  for (const file of selected) {
    try {
      await thread.send({
        content: [
          options.includeMigrated ? '**SeekDeep Legacy Archive Re-Import**' : '**SeekDeep Legacy Archive Import**',
          `File: ${file.name}`,
          `Imported: ${new Date().toISOString()}`,
          options.includeMigrated ? 'Mode: forced re-migration; previous migrated markers ignored' : '',
        ].filter(Boolean).join('\n'),
        files: [file.fullPath],
      });

      try {
        fs.writeFileSync(file.marker, new Date().toISOString(), 'utf8');
      } catch {}

      migrated += 1;
    } catch (err) {
      failed += 1;
      console.warn('SeekDeep archive migration file failed:', file.fullPath, err?.message || err);
    }
  }

  return {
    backend: 'discord-thread',
    threadName,
    totalLocalFiles: files.length,
    attempted: selected.length,
    migrated,
    failed,
    remaining: Math.max(files.length - selected.length, 0),
    includeMigrated: Boolean(options.includeMigrated),
  };
}"""

handler_fn = r"""async function seekdeepHandleArchiveMigrationMessage(message, prompt) {
  if (!message || !seekdeepIsArchiveMigrationPrompt(prompt || message.content || '')) return false;

  if (!message.guild) {
    await message.reply({
      content: 'Archive migration only works inside a server.',
      allowedMentions: { repliedUser: false },
    });
    return true;
  }

  const memberPermissions = message.member?.permissions;
  const allowed =
    memberPermissions?.has?.('Administrator') ||
    memberPermissions?.has?.('ManageGuild') ||
    memberPermissions?.has?.('ManageChannels');

  if (!allowed) {
    await message.reply({
      content: 'Archive migration is restricted to server managers.',
      allowedMentions: { repliedUser: false },
    });
    return true;
  }

  if (typeof seekdeepLogRoute === 'function') {
    seekdeepLogRoute('archive-migrate-message', prompt || message.content || '');
  }

  const forceRemigrate = seekdeepIsArchiveForceRemigrationPrompt(prompt || message.content || '');
  const result = await seekdeepMigrateLocalArchiveToSharedThread(message, {
    limit: forceRemigrate ? 100 : 25,
    includeMigrated: forceRemigrate,
  });

  await message.reply({
    content: [
      forceRemigrate ? 'Archive re-migration pass complete.' : 'Archive migration pass complete.',
      `Target thread: ${result.threadName}`,
      `Mode: ${forceRemigrate ? 'ALL local images; migrated markers ignored' : 'unmigrated local images only'}`,
      `Attempted: ${result.attempted}`,
      `Migrated: ${result.migrated}`,
      `Failed: ${result.failed}`,
      `Remaining local files in this mode: ${result.remaining}`,
      '',
      result.remaining > 0
        ? (forceRemigrate ? 'Run migrate archive all again to continue the next batch.' : 'Run migrate archive again to continue the next batch.')
        : 'No remaining local images found for this pass.',
    ].join('\n'),
    allowedMentions: { repliedUser: false },
  });

  return true;
}"""

# Replace known functions.
if "function seekdeepCleanMessageCommandPrompt(" in text:
    text = replace_function(text, "seekdeepCleanMessageCommandPrompt", clean_prompt_fn)
else:
    # Insert before detector if missing.
    _, s, _ = get_function(text, "seekdeepIsArchiveMigrationPrompt")
    text = text[:s] + clean_prompt_fn + "\n\n" + text[s:]

text = replace_function(text, "seekdeepIsArchiveMigrationPrompt", is_prompt_fn)

if "function seekdeepIsArchiveForceRemigrationPrompt(" in text:
    text = replace_function(text, "seekdeepIsArchiveForceRemigrationPrompt", is_force_fn)
else:
    _, s, _ = get_function(text, "seekdeepLocalArchiveFilesForMigration")
    text = text[:s] + is_force_fn + "\n\n" + text[s:]

text = replace_function(text, "seekdeepLocalArchiveFilesForMigration", local_files_fn)
text = replace_function(text, "seekdeepMigrateLocalArchiveToSharedThread", migrate_fn)
text = replace_function(text, "seekdeepHandleArchiveMigrationMessage", handler_fn)


for needle, label in [
    ("function seekdeepIsArchiveForceRemigrationPrompt", "force remigration detector"),
    ("includeMigrated: forceRemigrate", "force option in handler"),
    ("limit: forceRemigrate ? 100 : 25", "force batch size"),
    ("migrate archive all", "user-facing rerun text"),
    ("Mode: forced re-migration", "thread import metadata"),
]:
    if needle not in text:
        fail(f"Missing required patch element: {label}")

out = text if newline == "\n" else text.replace("\n", "\r\n")
path.write_bytes(out.encode("utf-8"))
print("Patched force re-migrate all behavior.")
'@

  $patchPyPath = Join-Path $patchesDir "patch_remigrate_all.py"
  [System.IO.File]::WriteAllText($patchPyPath, $patchPy, [System.Text.UTF8Encoding]::new($false))

  Push-Location $projectRoot
  try {
    Write-Info "Applying force re-migrate all patch"
    & ".\.venv\Scripts\python.exe" $patchPyPath $indexPath
    if ($LASTEXITCODE -ne 0) { throw "Patch helper failed with exit code $LASTEXITCODE." }
    Write-Pass "Applied force re-migrate all patch"

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
  Write-Pass "Force re-migrate all patch completed."
  Write-Host "Backup created: $backup" -ForegroundColor Yellow
  Write-Host "Restart the bot before testing." -ForegroundColor Yellow
  Write-Host ""
  Write-Host "Retest command:" -ForegroundColor Cyan
  Write-Host "@SEEKOTICS migrate archive all" -ForegroundColor White
  Write-Host ""
  Write-Host "Expected:" -ForegroundColor Cyan
  Write-Host "Archive re-migration pass complete." -ForegroundColor White
  Write-Host "Mode: ALL local images; migrated markers ignored" -ForegroundColor White
  exit 0
} catch {
  Write-Host ""
  Write-Fail $_.Exception.Message
  Write-Host "Backup available:" -ForegroundColor Yellow
  if ($backup) { Write-Host $backup -ForegroundColor Yellow }
  exit 1
}
