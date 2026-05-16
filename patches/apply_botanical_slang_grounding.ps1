# SeekDeep / Seekotics botanical slang grounding patch
#
# Goal:
# - Stop prompts like "sugary lookin' bud" from drifting into candy/gum/eyeball nonsense.
# - Ground cannabis/botanical slang before refinement.
#
# Examples:
#   "show me a sugary lookin' bud"
# becomes:
#   "frosty cannabis flower close-up, dense white trichomes like sugar crystals,
#    sticky resin, green and purple bud structure, realistic botanical texture,
#    macro product-photo composition, no eyes, no face, no candy, no gum,
#    no cartoon mascot, no humanoid features, no extra characters"
#
# Safety:
# - Backs up index.js first.
# - Adds a helper function if missing.
# - Patches known grounding/refinement entry points conservatively.
# - Runs:
#     node --check .\index.js
#     .\.venv\Scripts\python.exe -m py_compile .\local_ai_server.py
#
# Notes:
# - This does not alter Discord policy/permissions.
# - This only improves prompt interpretation and negative terms.

$ErrorActionPreference = "Stop"

try {
  [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
} catch {}

function Write-Info {
  param([string]$Message)
  Write-Host "[SeekDeep botanical-grounding] $Message" -ForegroundColor Cyan
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

  $backup = Join-Path $backupDir "index.js.botanical-grounding-$stamp.bak"
  Copy-Item -LiteralPath $indexPath -Destination $backup -Force
  Write-Pass "Backed up index.js to $backup"

  $patchPy = @'
from pathlib import Path
import re
import sys

if len(sys.argv) != 2:
    raise SystemExit("Usage: patch_botanical_grounding.py <index.js>")

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

helper = r"""function seekdeepGroundBotanicalSlangPrompt(prompt = '') {
  const raw = String(prompt || '').trim();
  const lower = raw.toLowerCase();

  const hasBud =
    /\b(bud|buds|flower|nug|nugs|nugget|weed|cannabis|marijuana|ganja|kush|herb|tree|trees)\b/i.test(lower);

  const hasSugaryVisual =
    /\b(sugary|sugar|frosty|frosted|crystal|crystals|crystalline|sticky|resin|resiny|trichome|trichomes|loud|dank|sparkly|snowy)\b/i.test(lower);

  if (!(hasBud && hasSugaryVisual)) {
    return raw;
  }

  const base = [
    'frosty cannabis flower close-up',
    'dense white trichomes like sugar crystals',
    'sticky resin',
    'green and purple bud structure',
    'realistic botanical texture',
    'macro product-photo composition',
    'sharp leaf and flower structure',
    'natural plant detail',
  ];

  const negatives = [
    'no eyes',
    'no face',
    'no candy',
    'no gum',
    'no cartoon mascot',
    'no humanoid features',
    'no extra characters',
    'no monster anatomy',
    'no surreal eyeballs',
  ];

  const cleaned = raw
    .replace(/\blookin['’]?/gi, 'looking')
    .replace(/\bshow me\b/gi, '')
    .replace(/\bgenerate\b/gi, '')
    .replace(/\bpicture of\b/gi, '')
    .replace(/\bimage of\b/gi, '')
    .replace(/\s+/g, ' ')
    .trim();

  const userHint = cleaned ? `user wording: ${cleaned}` : '';
  return [...base, userHint, ...negatives].filter(Boolean).join(', ');
}"""

if "function seekdeepGroundBotanicalSlangPrompt" not in text:
    insert_pos = text.find("function seekdeepGroundImagePrompt")
    if insert_pos < 0:
        insert_pos = text.find("async function seekdeepRefineImagePrompt")
    if insert_pos < 0:
        insert_pos = text.find("function seekdeepRefineImagePrompt")
    if insert_pos < 0:
        insert_pos = text.find("client.on('interactionCreate'")
    if insert_pos < 0:
        fail("Could not find insertion point for botanical grounding helper.")
    text = text[:insert_pos] + helper + "\n\n" + text[insert_pos:]

# Patch existing grounding function if present.
ground_fn, gs, ge = get_function(text, "seekdeepGroundImagePrompt")
if gs >= 0:
    if "seekdeepGroundBotanicalSlangPrompt" not in ground_fn:
        open_brace = ground_fn.find("{")
        injection = "\n  prompt = seekdeepGroundBotanicalSlangPrompt(prompt);\n"
        ground_fn = ground_fn[:open_brace + 1] + injection + ground_fn[open_brace + 1:]
        text = text[:gs] + ground_fn + text[ge:]

# Patch image refinement function if present.
for fn_name in ("seekdeepRefineImagePrompt", "seekdeepBuildImagePrompt", "seekdeepPrepareImagePrompt"):
    fn, s, e = get_function(text, fn_name)
    if s >= 0 and "seekdeepGroundBotanicalSlangPrompt" not in fn:
        open_brace = fn.find("{")
        injection = "\n  prompt = seekdeepGroundBotanicalSlangPrompt(prompt);\n"
        fn = fn[:open_brace + 1] + injection + fn[open_brace + 1:]
        text = text[:s] + fn + text[e:]

# Patch direct calls into the image senders if no known refinement/grounding function existed.
# This is conservative and only touches function entry for image senders.
patched_any_sender = False
for fn_name in ("seekdeepSendImageWithButtonsMessage", "seekdeepSendImageWithButtonsInteraction"):
    fn, s, e = get_function(text, fn_name)
    if s >= 0 and "seekdeepGroundBotanicalSlangPrompt" not in fn:
        open_brace = fn.find("{")
        injection = "\n  prompt = seekdeepGroundBotanicalSlangPrompt(prompt);\n"
        fn = fn[:open_brace + 1] + injection + fn[open_brace + 1:]
        text = text[:s] + fn + text[e:]
        patched_any_sender = True

# Add explicit grounding log if image prompt grounding log text already exists.
if "[SeekDeep] image prompt grounded:" in text and "botanical slang" not in text.lower():
    pass

# Validation.
for needle, label in [
    ("function seekdeepGroundBotanicalSlangPrompt", "botanical grounding helper"),
    ("frosty cannabis flower close-up", "botanical grounding phrase"),
    ("no eyes", "negative grounding phrase"),
    ("no candy", "negative candy phrase"),
]:
    if needle not in text:
        fail(f"Required anchor missing after patch: {label}")

if "seekdeepGroundImagePrompt" not in text and not patched_any_sender:
    fail("No grounding/refinement/image sender function was patched.")

out = text if newline == "\n" else text.replace("\n", "\r\n")
path.write_bytes(out.encode("utf-8"))
print("Patched botanical slang grounding.")
'@

  $patchPyPath = Join-Path $patchesDir "patch_botanical_grounding.py"
  [System.IO.File]::WriteAllText($patchPyPath, $patchPy, [System.Text.UTF8Encoding]::new($false))

  Push-Location $projectRoot
  try {
    Write-Info "Applying botanical slang grounding patch"
    & ".\.venv\Scripts\python.exe" $patchPyPath $indexPath
    if ($LASTEXITCODE -ne 0) { throw "Patch helper failed with exit code $LASTEXITCODE." }
    Write-Pass "Applied botanical slang grounding patch"

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
  Write-Pass "Botanical slang grounding patch completed."
  Write-Host "Backup created: $backup" -ForegroundColor Yellow
  Write-Host "Restart the bot before testing." -ForegroundColor Yellow
  Write-Host ""
  Write-Host "Retest:" -ForegroundColor Cyan
  Write-Host "@SEEKOTICS show me a sugary lookin' bud" -ForegroundColor White
  Write-Host ""
  Write-Host "Expected refined/grounded prompt should mention:" -ForegroundColor Cyan
  Write-Host "frosty cannabis flower, trichomes, sticky resin, realistic botanical texture" -ForegroundColor White
  Write-Host ""
  Write-Host "Expected negative terms should mention:" -ForegroundColor Cyan
  Write-Host "no eyes, no face, no candy, no gum, no cartoon mascot" -ForegroundColor White
  exit 0
} catch {
  Write-Host ""
  Write-Fail $_.Exception.Message
  Write-Host "Backup available:" -ForegroundColor Yellow
  if ($backup) { Write-Host $backup -ForegroundColor Yellow }
  exit 1
}
