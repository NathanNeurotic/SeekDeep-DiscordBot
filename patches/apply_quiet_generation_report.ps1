# SeekDeep / Seekotics quiet generation report patch
#
# Goal:
# - Make Discord-facing generation reports less noisy.
# - Hide "Time to Generate: 0.00 seconds" and "Model Used: local command (no AI model)" for command-only acknowledgements.
# - Shorten prompt-choice queue confirmations.
# - Change archive confirmation wording away from "bot host".
# - Keep real final image metadata useful.
#
# This patch is intentionally presentation-focused:
# - It does not alter image generation, queue order, model loading, or archive storage.
# - It only changes Discord-facing message text helpers and known confirmation strings.
#
# Files patched:
# - index.js only

$ErrorActionPreference = "Stop"

try {
  [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
} catch {}

function Write-Info {
  param([string]$Message)
  Write-Host "[SeekDeep quiet-report] $Message" -ForegroundColor Cyan
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

  $backup = Join-Path $backupDir "index.js.quiet-generation-report-$stamp.bak"
  Copy-Item -LiteralPath $indexPath -Destination $backup -Force
  Write-Pass "Backed up index.js to $backup"

  $patchPy = @'
from pathlib import Path
import re
import sys

if len(sys.argv) != 2:
    raise SystemExit("Usage: patch_quiet_generation_report.py <index.js>")

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
    _, start, end = get_function(source, name)
    if start < 0:
        fail(f"Could not replace missing function: {name}")
    return source[:start] + new_fn.rstrip() + source[end:]

if "client.on('interactionCreate'" not in text:
    fail("interaction handler anchor not found")

# ----------------------------------------------------------------------
# 1. Add quiet report helpers.
# ----------------------------------------------------------------------
quiet_helpers = r"""function seekdeepIsNoModelReportLabel(modelUsed = '') {
  const model = String(modelUsed || '').trim().toLowerCase();
  return !model || model === 'local command (no ai model)' || model === 'local command' || model === 'none' || model === 'n/a';
}

function seekdeepShouldHideCommandFooter(body = '', meta = {}) {
  const modelUsed = meta?.modelUsed || meta?.model || '';
  const text = String(body || '');

  if (!seekdeepIsNoModelReportLabel(modelUsed)) return false;

  // Hide footer for button acknowledgements and command/router-only responses.
  if (/^Queued (?:both|original|refined)/i.test(text)) return true;
  if (/^Prompt choice expired/i.test(text)) return true;
  if (/^Only the requester can use/i.test(text)) return true;
  if (/^Image generation cooldown is active/i.test(text)) return true;
  if (/^Archived (?:to|locally|on)/i.test(text)) return true;
  if (/^Archive is empty/i.test(text)) return true;
  if (/^Image archive status/i.test(text)) return true;
  if (/^Download URL:/i.test(text)) return true;

  return false;
}

function seekdeepCleanPublicReportText(value = '') {
  return String(value || '')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/^Archived on the bot host:\s*\n?\[local archive path hidden\]\s*$/gim, 'Archived to this server.')
    .replace(/^Archived on the bot host:\s*$/gim, 'Archived to this server.')
    .replace(/^Archived locally for this server\.\s*$/gim, 'Archived to this server.')
    .replace(/^Generated locally:/gim, 'Generated:')
    .trim();
}

function seekdeepCompactQueueSummary(body = '') {
  const text = String(body || '').trim();

  if (/^Queued both prompt versions\./i.test(text) || /^Queued both regenerate versions\./i.test(text)) {
    return 'Queued both:\n• Original\n• Refined';
  }

  if (/^Queued original prompt\./i.test(text) || /^Queued original regenerate\./i.test(text)) {
    return 'Queued original.';
  }

  if (/^Queued refined prompt\./i.test(text) || /^Queued refined regenerate\./i.test(text)) {
    return 'Queued refined.';
  }

  return text;
}"""

if "function seekdeepIsNoModelReportLabel" not in text:
    insert_pos = text.find("function seekdeepAppendResponseFooter")
    if insert_pos < 0:
        insert_pos = text.find("client.on('interactionCreate'")
    text = text[:insert_pos] + quiet_helpers + "\n\n" + text[insert_pos:]

# ----------------------------------------------------------------------
# 2. Replace footer helper so command-only acknowledgements do not show fake timing/model.
# ----------------------------------------------------------------------
append_fn, _, _ = get_function(text, "seekdeepAppendResponseFooter")
if append_fn:
    # Use a full replacement because this helper is the cleanest central choke point.
    new_append_fn = r"""function seekdeepAppendResponseFooter(body = '', meta = {}) {
  const cleanedBody = seekdeepCleanPublicReportText(seekdeepCompactQueueSummary(body));

  if (seekdeepShouldHideCommandFooter(cleanedBody, meta)) {
    return cleanedBody;
  }

  const startedAt = Number(meta?.startedAt || 0);
  const elapsedSeconds = startedAt > 0
    ? ((Date.now() - startedAt) / 1000).toFixed(2)
    : null;

  const modelUsed = meta?.modelUsed || meta?.model || '';
  const footer = [];

  if (elapsedSeconds !== null) {
    footer.push(`Time to Generate: ${elapsedSeconds} seconds`);
  }

  if (modelUsed && !seekdeepIsNoModelReportLabel(modelUsed)) {
    footer.push(`Model Used: ${modelUsed}`);
  } else if (modelUsed && !seekdeepShouldHideCommandFooter(cleanedBody, meta)) {
    // Preserve old behavior for non-ack text only if a caller explicitly supplied a model label.
    // Most command-only acks are filtered above.
  }

  if (!footer.length) return cleanedBody;
  return `${cleanedBody}\n\n${footer.join('\n')}`;
}"""
    text = replace_function(text, "seekdeepAppendResponseFooter", new_append_fn)

# ----------------------------------------------------------------------
# 3. Tighten prompt-choice handler summaries if present.
# ----------------------------------------------------------------------
handler_fn, hs, he = get_function(text, "seekdeepHandlePromptChoiceButton")
if handler_fn:
    handler_fn = handler_fn.replace("Queued both prompt versions.", "Queued both:")
    handler_fn = handler_fn.replace("Queued original prompt.", "Queued original.")
    handler_fn = handler_fn.replace("Queued refined prompt.", "Queued refined.")

    # Remove noisy lines from selection summary arrays.
    noisy_lines = [
        "'Queued Jobs: 1',",
        "`Queued Jobs: ${queuedLines.length}`,",
        "'Versions queued now:',",
        "'Both versions have now been queued.',",
        "'You can still choose the remaining version from this prompt.',",
        "'Jobs queued:',",
        "'1. Original prompt',",
        "'2. Refined prompt',",
    ]
    for line in noisy_lines:
        handler_fn = handler_fn.replace(line, "")

    # Make "both" summary include bullet list if not already generated by central compactor.
    handler_fn = handler_fn.replace(
        "needsOriginal && needsRefined ? 'Queued both:' : needsOriginal ? 'Queued original.' : 'Queued refined.'",
        "needsOriginal && needsRefined ? 'Queued both:\\n• Original\\n• Refined' : needsOriginal ? 'Queued original.' : 'Queued refined.'"
    )

    text = text[:hs] + handler_fn + text[he:]

# ----------------------------------------------------------------------
# 4. Tighten image button / regenerate summaries if present.
# ----------------------------------------------------------------------
image_button_fn, ibs, ibe = get_function(text, "seekdeepHandleImageButton")
if image_button_fn:
    image_button_fn = image_button_fn.replace("Queued both regenerate versions.", "Queued both:")
    image_button_fn = image_button_fn.replace("Queued original regenerate.", "Queued original.")
    image_button_fn = image_button_fn.replace("Queued refined regenerate.", "Queued refined.")

    # Remove noisy summary fragments from arrays.
    for frag in [
        "'Jobs queued:',",
        "'1. Original prompt',",
        "'2. Refined prompt',",
        "'Queued Jobs: 1',",
    ]:
        image_button_fn = image_button_fn.replace(frag, "")

    # Archive wording.
    image_button_fn = image_button_fn.replace(
        "`Archived on the bot host:\\n\\`${shownPath}\\``",
        "`Archived to this server.`"
    )
    image_button_fn = image_button_fn.replace(
        "`Archived on the bot host:\\n\\`${savedPath}\\``",
        "`Archived to this server.`"
    )

    text = text[:ibs] + image_button_fn + text[ibe:]

# ----------------------------------------------------------------------
# 5. Direct string cleanup across the file.
# ----------------------------------------------------------------------
direct_replacements = {
    "Archived on the bot host:\\n[local archive path hidden]": "Archived to this server.",
    "Archived on the bot host:": "Archived to this server.",
    "Archived locally for this server.": "Archived to this server.",
    "Generated locally:": "Generated:",
}
for old, new in direct_replacements.items():
    text = text.replace(old, new)

# Compact old queue summary literals if they exist in unusual handlers.
text = text.replace("Queued both prompt versions.", "Queued both:")
text = text.replace("Queued both regenerate versions.", "Queued both:")
text = text.replace("Queued original prompt.", "Queued original.")
text = text.replace("Queued refined prompt.", "Queued refined.")

# ----------------------------------------------------------------------
# 6. Prefer clearer generated labels when final image metadata has refinement.
#    This is conservative: keep prompt line format, only remove "locally".
# ----------------------------------------------------------------------
text = text.replace("Generated locally:", "Generated:")

# ----------------------------------------------------------------------
# Validation.
# ----------------------------------------------------------------------
for needle, label in [
    ("function seekdeepAppendResponseFooter", "footer helper"),
    ("function seekdeepCleanPublicReportText", "public text cleaner"),
    ("function seekdeepCompactQueueSummary", "compact queue summary helper"),
]:
    if needle not in text:
        fail(f"Required anchor missing after patch: {label}")

out = text if newline == "\n" else text.replace("\n", "\r\n")
path.write_bytes(out.encode("utf-8"))
print("Patched quiet public generation reports.")
'@

  $patchPyPath = Join-Path $patchesDir "patch_quiet_generation_report.py"
  [System.IO.File]::WriteAllText($patchPyPath, $patchPy, [System.Text.UTF8Encoding]::new($false))

  Push-Location $projectRoot
  try {
    Write-Info "Applying quiet generation report patch"
    & ".\.venv\Scripts\python.exe" $patchPyPath $indexPath
    if ($LASTEXITCODE -ne 0) { throw "Patch helper failed with exit code $LASTEXITCODE." }
    Write-Pass "Applied quiet generation report patch"

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
  Write-Pass "Quiet generation report patch completed."
  Write-Host "Backup created: $backup" -ForegroundColor Yellow
  Write-Host "Restart the bot before testing." -ForegroundColor Yellow
  Write-Host ""
  Write-Host "Retest:" -ForegroundColor Cyan
  Write-Host "@SEEKOTICS show me a sugary lookin' bud" -ForegroundColor White
  Write-Host ""
  Write-Host "Expected queue ack:" -ForegroundColor Cyan
  Write-Host "Queued both:" -ForegroundColor White
  Write-Host "• Original" -ForegroundColor White
  Write-Host "• Refined" -ForegroundColor White
  Write-Host ""
  Write-Host "Expected archive ack:" -ForegroundColor Cyan
  Write-Host "Archived to this server." -ForegroundColor White
  exit 0
} catch {
  Write-Host ""
  Write-Fail $_.Exception.Message
  Write-Host "Backup available:" -ForegroundColor Yellow
  if ($backup) { Write-Host $backup -ForegroundColor Yellow }
  exit 1
}
