# SeekDeep / Seekotics repair duplicate image-button action declaration
#
# Fixes:
#   SyntaxError: Identifier 'action' has already been declared
#   at:
#     const action = match[1] === 'save' ? 'archive' : match[1];
#
# Cause:
# - apply_public_use_and_regenerate_modes_v2 injected a new parser into
#   seekdeepHandleImageButton(...)
# - the old parser's `const action = ...` line remained
#
# This repair:
# - Removes stale old `match` parser lines inside seekdeepHandleImageButton(...)
# - Keeps the new parser:
#     seekdeep:regen:original:<id>
#     seekdeep:regen:refined:<id>
#     seekdeep:regen:both:<id>
#     seekdeep:regenerate:<id>
#     seekdeep:download:<id>
#     seekdeep:archive:<id>
# - Ensures one action variable only:
#     const action = buttonAction;
#
# Files patched:
# - index.js only

$ErrorActionPreference = "Stop"

try {
  [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
} catch {}

function Write-Info {
  param([string]$Message)
  Write-Host "[SeekDeep duplicate-action-repair] $Message" -ForegroundColor Cyan
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

  $backup = Join-Path $backupDir "index.js.duplicate-action-repair-$stamp.bak"
  Copy-Item -LiteralPath $indexPath -Destination $backup -Force
  Write-Pass "Backed up index.js to $backup"

  $utf8NoBom = [System.Text.UTF8Encoding]::new($false)

  $patchPy = @'
from pathlib import Path
import re
import sys

if len(sys.argv) != 2:
    raise SystemExit("Usage: repair_duplicate_action_parser.py <index.js>")

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
    start = source.find(f"async function {name}(")
    if start < 0:
        start = source.find(f"function {name}(")
    if start < 0:
        fail(f"Could not locate {name}.")

    open_brace = source.find("{", start)
    if open_brace < 0:
        fail(f"Could not locate opening brace for {name}.")

    close_brace = find_matching_brace(source, open_brace)
    return source[start:close_brace + 1], start, close_brace + 1

fn, start, end = get_function(text, "seekdeepHandleImageButton")

if "const seekdeepImageButtonParsed =" not in fn:
    fail("New image button parser not found; v2 patch may not have applied far enough.")

# Remove stale old parser declaration blocks. These are now replaced by seekdeepImageButtonParsed.
fn = re.sub(
    r"\n\s*const\s+match\s*=\s*customId\.match\([\s\S]*?\);\s*",
    "\n",
    fn,
    count=1,
)

fn = re.sub(
    r"\n\s*if\s*\(\s*!\s*match\s*\)\s*return\s+false;\s*",
    "\n",
    fn,
)

# Remove stale old action/actionId declarations that collide with injected parser.
fn = re.sub(
    r"\n\s*const\s+action\s*=\s*match\[[^\]]+\]\s*===\s*['\"]save['\"]\s*\?\s*['\"]archive['\"]\s*:\s*match\[[^\]]+\]\s*;\s*",
    "\n",
    fn,
)

fn = re.sub(
    r"\n\s*const\s+action\s*=\s*match\[[^\]]+\]\s*;\s*",
    "\n",
    fn,
)

fn = re.sub(
    r"\n\s*const\s+actionId\s*=\s*match\[[^\]]+\]\s*;\s*",
    "\n",
    fn,
)

# If old code still references save-normalization, normalize the injected buttonAction instead.
fn = fn.replace("buttonAction = 'save';", "buttonAction = 'archive';")
fn = fn.replace("buttonAction === 'save'", "buttonAction === 'archive'")

# Remove any remaining exact duplicate action declarations.
# Keep only the first `const action = buttonAction;`.
matches = list(re.finditer(r"\n\s*const\s+action\s*=\s*buttonAction\s*;\s*", fn))
if not matches:
    marker = "  } else {\n    actionId = seekdeepImageButtonParsed[2] || '';\n  }\n"
    if marker not in fn:
        fail("Could not locate parser ending to insert action alias.")
    fn = fn.replace(marker, marker + "\n  const action = buttonAction;\n", 1)
elif len(matches) > 1:
    keep = matches[0]
    rebuilt = []
    last = 0
    for i, m in enumerate(matches):
        rebuilt.append(fn[last:m.start()])
        if i == 0:
            rebuilt.append(m.group(0))
        last = m.end()
    rebuilt.append(fn[last:])
    fn = "".join(rebuilt)

# Replace leftover match[] uses if any remain in the handler.
fn = fn.replace("match[1]", "buttonAction")
fn = fn.replace("match[2]", "actionId")
fn = fn.replace("match[3]", "actionId")

# Validation inside handler.
if re.search(r"\bconst\s+action\s*=", fn) and len(re.findall(r"\bconst\s+action\s*=", fn)) > 1:
    fail("More than one const action declaration remains in seekdeepHandleImageButton.")

if re.search(r"\bconst\s+actionId\s*=", fn):
    fail("A stale const actionId declaration remains in seekdeepHandleImageButton.")

if re.search(r"\bmatch\s*\[", fn):
    fail("A stale match[...] reference remains in seekdeepHandleImageButton.")

if "const action = buttonAction;" not in fn:
    fail("Missing const action = buttonAction after repair.")

text = text[:start] + fn + text[end:]

# Global validation.
for needle, label in [
    ("function seekdeepRegenerateModeOptions", "regenerate mode helper"),
    ("setLabel('Original')", "Original button"),
    ("setLabel('Refined')", "Refined button"),
    ("setLabel('Both')", "Both button"),
    ("seekdeepEnqueueImageJob(job, runner)", "queue contract"),
]:
    if needle not in text:
        fail(f"Required anchor not found after repair: {label}")

out = text if newline == "\n" else text.replace("\n", "\r\n")
path.write_bytes(out.encode("utf-8"))
print("Repaired duplicate action parser declarations.")
'@

  $patchPyPath = Join-Path $patchesDir "repair_duplicate_action_parser.py"
  [System.IO.File]::WriteAllText($patchPyPath, $patchPy, $utf8NoBom)

  Push-Location $projectRoot
  try {
    Write-Info "Repairing duplicate action parser declarations"
    & ".\.venv\Scripts\python.exe" $patchPyPath $indexPath
    if ($LASTEXITCODE -ne 0) {
      throw "Patch helper failed with exit code $LASTEXITCODE."
    }
    Write-Pass "Applied duplicate action repair"

    Write-Info "Running node --check .\index.js"
    & node --check ".\index.js"
    if ($LASTEXITCODE -ne 0) {
      throw "node --check failed with exit code $LASTEXITCODE."
    }
    Write-Pass "node --check passed"

    Write-Info "Running Python compile check"
    & ".\.venv\Scripts\python.exe" -m py_compile ".\local_ai_server.py"
    if ($LASTEXITCODE -ne 0) {
      throw "Python compile check failed with exit code $LASTEXITCODE."
    }
    Write-Pass "Python compile check passed"
  } finally {
    Pop-Location
  }

  Write-Host ""
  Write-Pass "Duplicate action parser repair completed."
  Write-Host "Backup created: $backup" -ForegroundColor Yellow
  Write-Host "Restart the bot, then retest generated image buttons." -ForegroundColor Yellow
  exit 0
} catch {
  Write-Host ""
  Write-Fail $_.Exception.Message
  Write-Host "Backup available:" -ForegroundColor Yellow
  if ($backup) { Write-Host $backup -ForegroundColor Yellow }
  exit 1
}
