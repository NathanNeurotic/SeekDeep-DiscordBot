# SeekDeep / Seekotics image-choice button interaction failure repair
#
# Fixes symptom:
# - Clicking Original / Refined / Both shows: "This interaction failed"
# - Console may show undefined customId / match issues in seekdeepHandleImageButton
# - Button interaction is not acknowledged quickly enough
#
# Strategy:
# - Make a backup first
# - Repair seekdeepHandleImageButton with a hardened top-of-function prelude
# - Ensure customId and match are defined before any use
# - Acknowledge the component interaction early with deferUpdate()
# - Run node --check afterwards

$ErrorActionPreference = 'Stop'

function Write-Info { param([string]$Message) Write-Host "[SeekDeep image-choice-fix] $Message" -ForegroundColor Cyan }
function Write-Pass { param([string]$Message) Write-Host "[PASS] $Message" -ForegroundColor Green }
function Write-Fail { param([string]$Message) Write-Host "[FAIL] $Message" -ForegroundColor Red }

try {
  $projectRoot = Join-Path $env:USERPROFILE 'SeekDeep-DiscordBot'
  if (-not (Test-Path (Join-Path $projectRoot 'index.js'))) {
    $projectRoot = (Get-Location).Path
  }

  $indexPath = Join-Path $projectRoot 'index.js'
  if (-not (Test-Path $indexPath)) { throw 'index.js not found.' }

  $patchesDir = Join-Path $projectRoot 'patches'
  $backupDir  = Join-Path $patchesDir 'backups'
  New-Item -ItemType Directory -Force -Path $patchesDir | Out-Null
  New-Item -ItemType Directory -Force -Path $backupDir  | Out-Null

  $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
  $backupPath = Join-Path $backupDir "index.js.before-image-choice-fix-$stamp.bak"
  Copy-Item $indexPath $backupPath -Force
  Write-Pass "Backed up index.js to $backupPath"

  $pythonPatch = @'
from pathlib import Path
import re
import sys

if len(sys.argv) != 2:
    raise SystemExit('Usage: patch_image_choice_button.py <index.js>')

path = Path(sys.argv[1])
raw = path.read_bytes()
newline = '\r\n' if b'\r\n' in raw else '\n'
text = raw.decode('utf-8-sig').replace('\r\n', '\n').replace('\r', '\n')

m = re.search(r'async function seekdeepHandleImageButton\s*\(([^)]*)\)\s*\{', text)
if not m:
    raise SystemExit('Could not locate async function seekdeepHandleImageButton(...).')

start = m.start()
body_start = m.end()

# Find matching closing brace for the function block.
depth = 1
in_single = False
in_double = False
in_template = False
in_line_comment = False
in_block_comment = False
escaped = False
pos = body_start
while pos < len(text):
    ch = text[pos]
    nxt = text[pos + 1] if pos + 1 < len(text) else ''

    if in_line_comment:
        if ch == '\n':
            in_line_comment = False
        pos += 1
        continue

    if in_block_comment:
        if ch == '*' and nxt == '/':
            in_block_comment = False
            pos += 2
            continue
        pos += 1
        continue

    if in_single:
        if not escaped and ch == "'":
            in_single = False
        escaped = (ch == '\\' and not escaped)
        if ch != '\\':
            escaped = False
        pos += 1
        continue

    if in_double:
        if not escaped and ch == '"':
            in_double = False
        escaped = (ch == '\\' and not escaped)
        if ch != '\\':
            escaped = False
        pos += 1
        continue

    if in_template:
        if not escaped and ch == '`':
            in_template = False
        escaped = (ch == '\\' and not escaped)
        if ch != '\\':
            escaped = False
        pos += 1
        continue

    if ch == '/' and nxt == '/':
        in_line_comment = True
        pos += 2
        continue
    if ch == '/' and nxt == '*':
        in_block_comment = True
        pos += 2
        continue
    if ch == "'":
        in_single = True
        pos += 1
        continue
    if ch == '"':
        in_double = True
        pos += 1
        continue
    if ch == '`':
        in_template = True
        pos += 1
        continue

    if ch == '{':
        depth += 1
    elif ch == '}':
        depth -= 1
        if depth == 0:
            body_end = pos
            break
    pos += 1
else:
    raise SystemExit('Could not find end of seekdeepHandleImageButton function.')

fn_header = text[start:body_start]
fn_body = text[body_start:body_end]
fn_footer = text[body_end:body_end+1]

# Remove previous broken/duplicate top declarations if present.
fn_body = re.sub(r'^\s*(const|let|var)\s+customId\s*=.*?;\s*', '', fn_body, count=1, flags=re.S)
fn_body = re.sub(r'^\s*(const|let|var)\s+match\s*=.*?;\s*', '', fn_body, count=1, flags=re.S)
fn_body = re.sub(r'^\s*await\s+interaction\.deferUpdate\(\);\s*', '', fn_body, count=1, flags=re.S)

prelude = """
  const customId = interaction?.customId || '';
  const match =
    customId.match(/^seekdeep:(?:image-choice|regen):(original|refined|both):(.+)$/) ||
    customId.match(/^seekdeep:(original|refined|both):(.+)$/) ||
    customId.match(/^seekdeep:(regenerate|download|archive):(.+)$/) ||
    null;

  if (interaction && !interaction.deferred && !interaction.replied) {
    try {
      await interaction.deferUpdate();
    } catch {}
  }

"""

new_fn = fn_header + '\n' + prelude + fn_body.lstrip('\n') + fn_footer
new_text = text[:start] + new_fn + text[body_end+1:]

# Small sanity checks.
if "Cannot access 'customId' before initialization" in new_text:
    raise SystemExit('Unexpected literal error text found in source.')
if new_text.count('async function seekdeepHandleImageButton') != 1:
    raise SystemExit('Unexpected duplicate seekdeepHandleImageButton definitions.')
if 'await interaction.deferUpdate();' not in new_text:
    raise SystemExit('deferUpdate() prelude was not inserted.')

out = new_text if newline == '\n' else new_text.replace('\n', '\r\n')
path.write_bytes(out.encode('utf-8'))
print('Patched seekdeepHandleImageButton prelude.')
'@

  $patchPyPath = Join-Path $patchesDir 'patch_image_choice_button.py'
  [System.IO.File]::WriteAllText($patchPyPath, $pythonPatch, [System.Text.UTF8Encoding]::new($false))

  Push-Location $projectRoot
  try {
    Write-Info 'Applying image-choice interaction failure repair'
    & ".\.venv\Scripts\python.exe" $patchPyPath $indexPath
    if ($LASTEXITCODE -ne 0) { throw "Patch helper failed with exit code $LASTEXITCODE." }
    Write-Pass 'Applied image-choice interaction failure repair'

    Write-Info 'Running node --check .\index.js'
    & node --check .\index.js
    if ($LASTEXITCODE -ne 0) { throw "node --check failed with exit code $LASTEXITCODE." }
    Write-Pass 'node --check passed'
  }
  finally {
    Pop-Location
  }

  Write-Host ''
  Write-Pass 'Repair completed.'
  Write-Host 'Backup:' -ForegroundColor Yellow
  Write-Host $backupPath -ForegroundColor Yellow
  Write-Host ''
  Write-Host 'Restart the bot, then retest:' -ForegroundColor Cyan
  Write-Host '@SEEKOTICS generate a red test orb' -ForegroundColor White
  Write-Host 'Click: Both' -ForegroundColor White
  exit 0
}
catch {
  Write-Host ''
  Write-Fail $_.Exception.Message
  if ($backupPath) {
    Write-Host 'Backup available:' -ForegroundColor Yellow
    Write-Host $backupPath -ForegroundColor Yellow
  }
  exit 1
}
