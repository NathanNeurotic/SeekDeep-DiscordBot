# SeekDeep / Seekotics image route question guard + Toad/Mario visual subject patch
#
# Fixes observed issues:
# - "what happens when you eat mario's mushrooms" routed to image. It is a question and should stay chat.
# - "toad from mario" routed to chat. It is a short visual subject and should route image.
#
# This patch:
# - Adds a conservative chat guard before image routing for question/explanation prompts.
# - Adds Toad/Mario cues to short named visual subject routing.
# - Adds Toad/Mario to grounding cues when those helper blocks exist.
#
# Files patched:
# - index.js
#
# Workflow guarantees:
# - Backs up index.js first
# - UTF-8-safe patching
# - Does not touch queue contract
# - Preserves:
#     seekdeepEnqueueImageJob(job, runner)
# - Runs:
#     node --check .\index.js
#     .\.venv\Scripts\python.exe -m py_compile .\local_ai_server.py

$ErrorActionPreference = "Stop"

try {
  [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
} catch {}

function Write-Info {
  param([string]$Message)
  Write-Host "[SeekDeep image-question-guard] $Message" -ForegroundColor Cyan
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

  $indexBackup = Join-Path $backupDir "index.js.image-question-guard-toad-mario-$stamp.bak"
  Copy-Item -LiteralPath $indexPath -Destination $indexBackup -Force
  Write-Pass "Backed up index.js to $indexBackup"

  $utf8NoBom = [System.Text.UTF8Encoding]::new($false)

  $patchPy = @'
from pathlib import Path
import sys
import re

if len(sys.argv) != 2:
    raise SystemExit("Usage: patch_image_question_guard_toad_mario.py <index.js>")

path = Path(sys.argv[1])
raw = path.read_bytes()
newline = "\r\n" if b"\r\n" in raw else "\n"
text = raw.decode("utf-8-sig").replace("\r\n", "\n").replace("\r", "\n")

def require_contains(haystack: str, needle: str, label: str):
    if needle not in haystack:
        raise SystemExit(f"Required anchor not found: {label}")

for needle, label in [
    ("client.on('messageCreate'", "messageCreate handler"),
    ("function isNaturalImagePrompt", "isNaturalImagePrompt"),
    ("seekdeepEnqueueImageJob(job, runner)", "correct image queue contract"),
]:
    require_contains(text, needle, label)

if "seekdeepMakeImageQueueJobId" in text:
    raise SystemExit("Unsafe old queue helper found: seekdeepMakeImageQueueJobId")
if "job.run" in text:
    raise SystemExit("Unsafe job.run-style queue logic found")

helper = r"""
// SEEKDEEP_IMAGE_ROUTE_CHAT_GUARD_START
function seekdeepShouldKeepPromptAsChatBeforeImage(prompt = '') {
  const p = normalizeUserText(prompt).toLowerCase().trim();
  if (!p) return false;

  // Direct visual commands should still be image even if they contain "can/could" later.
  if (/^(show|draw|paint|sketch|illustrate|render|generate|create|make|design)\b/.test(p)) return false;

  // Clear question/explanation/research shapes should not become image prompts
  // just because they mention a visual franchise/entity.
  if (/^(what|who|why|how|when|where|is|are|do|does|did|can|could|would|should)\b/.test(p)) return true;
  if (/\b(explain|tell me about|summarize|summary|define|definition|what happens|how does|how do|why does|why do|difference between|compare|comparison|pros\/cons|pros and cons|look up|search|internet|web)\b/.test(p)) return true;

  return false;
}
// SEEKDEEP_IMAGE_ROUTE_CHAT_GUARD_END

"""

if "SEEKDEEP_IMAGE_ROUTE_CHAT_GUARD_START" not in text:
    # Put near other image helpers, before isNaturalImagePrompt.
    pos = text.find("function isNaturalImagePrompt")
    if pos < 0:
        raise SystemExit("Could not locate isNaturalImagePrompt anchor.")
    text = text[:pos] + helper + text[pos:]

# Patch the image route condition inside messageCreate.
msg_start = text.find("client.on('messageCreate'")
if msg_start < 0:
    raise SystemExit("Could not locate messageCreate.")

# Known route variants from prior patches.
route_variants = [
    "    if ((typeof seekdeepIsGenericImageFollowupPrompt === 'function' && seekdeepIsGenericImageFollowupPrompt(prompt)) || (typeof seekdeepLooksLikeShortNamedVisualSubject === 'function' && seekdeepLooksLikeShortNamedVisualSubject(prompt)) || isNaturalImagePrompt(prompt)) {",
    "    if ((typeof seekdeepIsGenericImageFollowupPrompt === 'function' && seekdeepIsGenericImageFollowupPrompt(prompt)) || isNaturalImagePrompt(prompt)) {",
    "    if ((typeof seekdeepLooksLikeShortNamedVisualSubject === 'function' && seekdeepLooksLikeShortNamedVisualSubject(prompt)) || isNaturalImagePrompt(prompt)) {",
    "    if (isNaturalImagePrompt(prompt)) {",
]

patched = False
for old in route_variants:
    pos = text.find(old, msg_start)
    if pos >= 0:
        if "seekdeepShouldKeepPromptAsChatBeforeImage(prompt)" in old:
            patched = True
            break
        condition = old.strip()
        # Strip leading "if (" and trailing ") {"
        inner = condition[len("if ("):-len(") {")]
        new = "    if (!seekdeepShouldKeepPromptAsChatBeforeImage(prompt) && (" + inner + ")) {"
        text = text[:pos] + new + text[pos + len(old):]
        patched = True
        break

if not patched:
    # Regex fallback: first indented if containing isNaturalImagePrompt(prompt) after messageCreate.
    m = re.search(r"    if \((?P<inner>[^\n]*isNaturalImagePrompt\(prompt\)[^\n]*)\) \{", text[msg_start:])
    if not m:
        raise SystemExit("Could not locate image route condition inside messageCreate.")
    start = msg_start + m.start()
    end = msg_start + m.end()
    old = text[start:end]
    inner = m.group("inner")
    if "seekdeepShouldKeepPromptAsChatBeforeImage" not in inner:
      new = "    if (!seekdeepShouldKeepPromptAsChatBeforeImage(prompt) && (" + inner + ")) {"
      text = text[:start] + new + text[end:]

# Expand short named subject cues if helper exists.
if "function seekdeepLooksLikeShortNamedVisualSubject" in text:
    # Add Toad where obvious cue lists already exist.
    text = text.replace("spyro|ripto|predator|xenomorph", "toad|spyro|ripto|predator|xenomorph")
    text = text.replace("sp\\s*yro|ripto", "toad|sp\\s*yro|ripto")
    text = text.replace("spyro|ripto|predator|matrix|homer|simpson", "toad|spyro|ripto|predator|matrix|homer|simpson")
    text = text.replace("sailor\\s*moon|pepe|sonic|mario", "sailor\\s*moon|pepe|sonic|toad|mario")
    text = text.replace("sailor moon|sonic|spyro|ripto|matrix|playstation", "sailor moon|sonic|toad|spyro|ripto|matrix|playstation")

# If groundable helper exists, add Toad cue to franchise/name route.
if "function seekdeepLooksLikeGroundableVisualSubject" in text:
    text = text.replace("animal crossing|nintendo|pokemon|pok[eé]mon|zelda|hyrule|mario", "animal crossing|nintendo|pokemon|pok[eé]mon|zelda|hyrule|toad|mario")

# Add deterministic Toad visual grounding if grounding helper exists.
if "async function seekdeepMaybeGroundImagePrompt" in text and "SEEKDEEP_KNOWN_TOAD_MARIO_GROUNDING_START" not in text:
    anchor = "  const searchQuery = seekdeepBuildImageGroundingSearchQuery(original);\n"
    if anchor in text:
        toad = """  // SEEKDEEP_KNOWN_TOAD_MARIO_GROUNDING_START
  if (/\\btoad\\b/i.test(original) && /\\bmario\\b/i.test(original)) {
    const grounded = 'Toad from the Mario games, small mushroom-headed humanoid character, large white mushroom cap with colored spots, simple vest, tiny body, cheerful Nintendo-style cartoon proportions, centered character, no text';
    console.log(`[SeekDeep] image prompt grounded:\\n  original: ${original}\\n  grounded: ${grounded}`);
    return { prompt: grounded, grounded: true, searchQuery: 'known-subject:toad-from-mario' };
  }
  // SEEKDEEP_KNOWN_TOAD_MARIO_GROUNDING_END

""" + anchor
        text = text.replace(anchor, toad, 1)

for needle, label in [
    ("function seekdeepShouldKeepPromptAsChatBeforeImage", "chat guard helper"),
    ("what happens", "question guard phrase"),
    ("!seekdeepShouldKeepPromptAsChatBeforeImage(prompt)", "message route uses chat guard"),
    ("seekdeepEnqueueImageJob(job, runner)", "queue contract preserved"),
]:
    require_contains(text, needle, label)

# At least one of these should be present after cue expansion.
if "toad" not in text.lower():
    raise SystemExit("Toad cue was not added.")

out = text if newline == "\n" else text.replace("\n", "\r\n")
path.write_bytes(out.encode("utf-8"))
print("Patched image question guard and Toad/Mario visual subject routing.")
'@

  $patchPyPath = Join-Path $patchesDir "patch_image_question_guard_toad_mario.py"
  [System.IO.File]::WriteAllText($patchPyPath, $patchPy, $utf8NoBom)

  Push-Location $projectRoot
  try {
    Write-Info "Applying image question guard / Toad-Mario patch"
    & ".\.venv\Scripts\python.exe" $patchPyPath $indexPath
    if ($LASTEXITCODE -ne 0) {
      throw "Patch helper failed with exit code $LASTEXITCODE."
    }
    Write-Pass "Applied image question guard / Toad-Mario patch"

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
  Write-Pass "Image question guard / Toad-Mario patch completed."
  Write-Host "Backup created: $indexBackup" -ForegroundColor Yellow
  Write-Host "Restart the Discord bot before testing." -ForegroundColor Yellow
  Write-Host ""
  Write-Host "Retest:" -ForegroundColor Cyan
  Write-Host "@SEEKOTICS what happens when you eat mario's mushrooms" -ForegroundColor White
  Write-Host "@SEEKOTICS toad from mario" -ForegroundColor White
  Write-Host "@SEEKOTICS generate" -ForegroundColor White
  exit 0
} catch {
  Write-Host ""
  Write-Fail $_.Exception.Message
  Write-Host "Backup available:" -ForegroundColor Yellow
  if ($indexBackup) { Write-Host $indexBackup -ForegroundColor Yellow }
  exit 1
}
