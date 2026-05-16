# SeekDeep / Seekotics quiet local-command report cleanup
#
# Goal:
# - Remove noisy local-command footers from Discord-visible command acknowledgements:
#     Time to Generate: 0.00 seconds
#     Model Used: local command (no AI model)
#
# Keeps:
# - Real image/chat model footers.
# - Real render timing for actual image generation.
#
# Cleans:
# - Queued prompt choice messages
# - Archive/status/migration/thread lookup messages
# - Download/archive/cooldown/prompt-expired local responses
#
# Files changed:
# - index.js only
#
# Validation:
# - node --check .\index.js
# - python -m py_compile .\local_ai_server.py

$ErrorActionPreference = "Stop"

try {
  [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
} catch {}

function Write-Info { param([string]$Message) Write-Host "[SeekDeep quiet-local-report] $Message" -ForegroundColor Cyan }
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

  $backup = Join-Path $backupDir "index.js.before-quiet-local-report-$stamp.bak"
  Copy-Item -LiteralPath $indexPath -Destination $backup -Force
  Write-Pass "Backed up index.js to $backup"

  $patchPy = @'
from pathlib import Path
import re
import sys

if len(sys.argv) != 2:
    raise SystemExit("Usage: patch_quiet_local_report.py <index.js>")

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


if "seekdeepEnqueueImageJob(job, runner)" not in text:
    fail("queue contract anchor missing; refusing to patch wrong file")

helpers = {
"seekdeepIsNoModelReportLabel": r"""function seekdeepIsNoModelReportLabel(modelUsed = '') {
  const model = String(modelUsed || '').trim().toLowerCase();
  return !model ||
    model === 'local command (no ai model)' ||
    model === 'local command' ||
    model === 'none' ||
    model === 'n/a';
}""",

"seekdeepCleanPublicReportText": r"""function seekdeepCleanPublicReportText(value = '') {
  return String(value || '')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/^Generated locally:/gim, 'Generated:')
    .replace(/^Archived on the bot host:\s*\n?\[local archive path hidden\]\s*$/gim, 'Archived to this server.')
    .replace(/^Archived on the bot host:\s*$/gim, 'Archived to this server.')
    .replace(/^Archived locally for this server\.\s*$/gim, 'Archived to this server.')
    .trim();
}""",

"seekdeepCompactQueueSummary": r"""function seekdeepCompactQueueSummary(body = '') {
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
}""",

"seekdeepShouldHideCommandFooter": r"""function seekdeepShouldHideCommandFooter(body = '', meta = {}) {
  const modelUsed = meta?.modelUsed || meta?.model || '';
  const text = String(body || '').trim();

  if (!seekdeepIsNoModelReportLabel(modelUsed)) return false;

  return Boolean(
    /^Queued (?:both|original|refined)/i.test(text) ||
    /^Prompt choice expired/i.test(text) ||
    /^Only the requester can use/i.test(text) ||
    /^Image generation cooldown is active/i.test(text) ||
    /^Archived (?:to|locally|on)/i.test(text) ||
    /^Archive(?:\s|$)/i.test(text) ||
    /^Image archive status/i.test(text) ||
    /^Shared archive:/i.test(text) ||
    /^Your archive:/i.test(text) ||
    /^Archive for <@/i.test(text) ||
    /^Download URL:/i.test(text)
  );
}"""
}

# Insert/replace helpers. Insert before footer when missing.
for name, fn in helpers.items():
    text = replace_or_insert_function(text, name, fn, "seekdeepAppendResponseFooter")

append_fn = r"""function seekdeepAppendResponseFooter(content, meta = {}) {
  const rawBody = String(content ?? '').trim();
  const body = seekdeepCleanPublicReportText(seekdeepCompactQueueSummary(rawBody));

  const fallbackNoModel = typeof SEEKDEEP_NO_MODEL_USED_LABEL !== 'undefined'
    ? SEEKDEEP_NO_MODEL_USED_LABEL
    : 'local command (no AI model)';

  const modelUsed = meta.modelUsed || meta.model || fallbackNoModel;

  if (typeof seekdeepTrackBotResponse === 'function') {
    seekdeepTrackBotResponse(modelUsed);
  }

  if (seekdeepShouldHideCommandFooter(body, { ...meta, modelUsed })) {
    return body;
  }

  if (typeof seekdeepResponseFooter === 'function') {
    const footer = seekdeepResponseFooter({
      ...meta,
      modelUsed,
    });

    return body ? `${body}\n\n${footer}` : footer;
  }

  const footer = [];
  const startedAt = Number(meta.startedAt || 0);

  if (startedAt > 0) {
    footer.push(`Time to Generate: ${((Date.now() - startedAt) / 1000).toFixed(2)} seconds`);
  }

  if (modelUsed && !seekdeepIsNoModelReportLabel(modelUsed)) {
    footer.push(`Model Used: ${modelUsed}`);
  }

  return footer.length ? `${body}\n\n${footer.join('\n')}` : body;
}"""

text = replace_or_insert_function(text, "seekdeepAppendResponseFooter", append_fn)

# Safe literal text cleanup.
text = text.replace("Generated locally:", "Generated:")
text = text.replace("Archived on the bot host:", "Archived to this server.")
text = text.replace("Queued both prompt versions.", "Queued both:")
text = text.replace("Queued both regenerate versions.", "Queued both:")
text = text.replace("Queued original prompt.", "Queued original.")
text = text.replace("Queued refined prompt.", "Queued refined.")

for needle, label in [
    ("function seekdeepIsNoModelReportLabel", "no-model helper"),
    ("function seekdeepCleanPublicReportText", "public text cleaner"),
    ("function seekdeepCompactQueueSummary", "queue summary helper"),
    ("function seekdeepShouldHideCommandFooter", "hide footer helper"),
    ("function seekdeepAppendResponseFooter", "footer replacement"),
    ("Shared archive:", "shared archive hide rule"),
    ("Your archive:", "your archive hide rule"),
]:
    if needle not in text:
        fail(f"Missing required patch element: {label}")

for bad in ["}, target = null) {", "state = {) {", "state = {,"]:
    if bad in text:
        fail(f"Malformed code detected after patch: {bad}")

out = text if newline == "\n" else text.replace("\n", "\r\n")
path.write_bytes(out.encode("utf-8"))
print("Quiet local-command report cleanup applied.")
'@

  $patchPyPath = Join-Path $patchesDir "patch_quiet_local_report.py"
  [System.IO.File]::WriteAllText($patchPyPath, $patchPy, [System.Text.UTF8Encoding]::new($false))

  Push-Location $projectRoot
  try {
    Write-Info "Applying quiet local-command report cleanup"
    & ".\.venv\Scripts\python.exe" $patchPyPath $indexPath
    if ($LASTEXITCODE -ne 0) { throw "Patch helper failed with exit code $LASTEXITCODE." }
    Write-Pass "Applied quiet local-command report cleanup"

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
  Write-Pass "Quiet local-command report cleanup completed."
  Write-Host "Backup created: $backup" -ForegroundColor Yellow
  Write-Host "Restart the bot before testing." -ForegroundColor Yellow
  Write-Host ""
  Write-Host "Retest:" -ForegroundColor Cyan
  Write-Host "@SEEKOTICS archive shared" -ForegroundColor White
  Write-Host "@SEEKOTICS archive me" -ForegroundColor White
  Write-Host "@SEEKOTICS archivestatus" -ForegroundColor White
  Write-Host ""
  Write-Host "Expected: no Time to Generate / Model Used footer on these local command responses." -ForegroundColor White
  exit 0
} catch {
  Write-Host ""
  Write-Fail $_.Exception.Message
  Write-Host "Backup available:" -ForegroundColor Yellow
  if ($backup) { Write-Host $backup -ForegroundColor Yellow }
  exit 1
}
