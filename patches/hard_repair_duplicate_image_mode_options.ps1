# SeekDeep / Seekotics hard repair for duplicate image-mode option declarations
#
# Fixes current broken state:
#   SyntaxError: Identifier 'seekdeepImageModeOptions' has already been declared
#
# Why this version is different:
# - It does NOT try to preserve/merge possibly duplicated option blocks.
# - It surgically removes every existing seekdeepImageModeOptions declaration block inside:
#     seekdeepSendImageWithButtonsMessage(...)
#     seekdeepSendImageWithButtonsInteraction(...)
# - Then inserts exactly one canonical option block after requestStartedAt.
# - It also keeps the raw/unrefined pass-through and reply-context force-image route.
#
# Safety:
# - backs up index.js first
# - patches only index.js
# - validates no duplicate seekdeepImageModeOptions declarations remain in either image sender
# - runs node --check and Python compile

$ErrorActionPreference = "Stop"

try {
  [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
} catch {}

function Write-Info {
  param([string]$Message)
  Write-Host "[SeekDeep hard-options-repair] $Message" -ForegroundColor Cyan
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

  $indexBackup = Join-Path $backupDir "index.js.hard-duplicate-image-mode-options-repair-$stamp.bak"
  Copy-Item -LiteralPath $indexPath -Destination $indexBackup -Force
  Write-Pass "Backed up index.js to $indexBackup"

  $utf8NoBom = [System.Text.UTF8Encoding]::new($false)

  $patchPy = @'
from pathlib import Path
import re
import sys

if len(sys.argv) != 2:
    raise SystemExit("Usage: hard_repair_duplicate_image_mode_options.py <index.js>")

path = Path(sys.argv[1])
raw = path.read_bytes()
newline = "\r\n" if b"\r\n" in raw else "\n"
text = raw.decode("utf-8-sig").replace("\r\n", "\n").replace("\r", "\n")

def fail(msg):
    raise SystemExit(msg)

def require(needle, label):
    if needle not in text:
        fail(f"Required anchor not found: {label}")

def find_function_bounds(src, name):
    start = src.find(f"async function {name}(")
    if start < 0:
        start = src.find(f"function {name}(")
    if start < 0:
        fail(f"Could not locate function {name}")

    brace = src.find("{", start)
    if brace < 0:
        fail(f"Could not locate opening brace for {name}")

    depth = 0
    i = brace
    in_str = None
    escape = False
    in_line_comment = False
    in_block_comment = False

    while i < len(src):
        ch = src[i]
        nxt = src[i + 1] if i + 1 < len(src) else ""

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

        if in_str:
            if escape:
                escape = False
            elif ch == "\\":
                escape = True
            elif ch == in_str:
                in_str = None
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

        if ch in ("'", '"', "`"):
            in_str = ch
            i += 1
            continue

        if ch == "{":
            depth += 1
        elif ch == "}":
            depth -= 1
            if depth == 0:
                return start, i + 1

        i += 1

    fail(f"Could not locate closing brace for {name}")

def canonical_option_block(interaction=False):
    suffix = "_INTERACTION" if interaction else ""
    return f"""
  // SEEKDEEP_RAW_IMAGE_SEND_OPTIONS{suffix}_START
  const seekdeepImageModeOptions = {{
    ...(typeof seekdeepImageModeOptionsFromPrompt === 'function' ? seekdeepImageModeOptionsFromPrompt(prompt) : {{}}),
    ...(imageModeOptions || {{}}),
  }};
  prompt = seekdeepImageModeOptions.cleanPrompt || seekdeepCleanImageModeTokens(prompt) || prompt;
  // SEEKDEEP_RAW_IMAGE_SEND_OPTIONS{suffix}_END
"""

def strip_existing_option_declarations(fn):
    # Remove marked raw option blocks from any previous patch.
    fn = re.sub(
        r"\n[ \t]*// SEEKDEEP_RAW_IMAGE_SEND_OPTIONS(?:_INTERACTION)?_START\n"
        r"[\s\S]*?"
        r"// SEEKDEEP_RAW_IMAGE_SEND_OPTIONS(?:_INTERACTION)?_END\n",
        "\n",
        fn,
        flags=re.MULTILINE,
    )

    # Remove bare two-line declarations from older patches.
    fn = re.sub(
        r"\n[ \t]*const\s+seekdeepImageModeOptions\s*=\s*seekdeepImageModeOptionsFromPrompt\(prompt\);\n"
        r"[ \t]*prompt\s*=\s*seekdeepImageModeOptions\.cleanPrompt\s*\|\|\s*prompt;\n",
        "\n",
        fn,
        flags=re.MULTILINE,
    )

    # Remove object-spread declarations from failed patch attempts if they were not marker-wrapped.
    fn = re.sub(
        r"\n[ \t]*const\s+seekdeepImageModeOptions\s*=\s*\{\n"
        r"[\s\S]*?"
        r"\n[ \t]*\};\n"
        r"[ \t]*prompt\s*=\s*seekdeepImageModeOptions\.cleanPrompt\s*\|\|[^\n]*;\n",
        "\n",
        fn,
        flags=re.MULTILINE,
    )

    # Last-resort removal: if a duplicate simple const remains, remove only the declaration line and
    # the immediately following prompt assignment if present.
    fn = re.sub(
        r"\n[ \t]*const\s+seekdeepImageModeOptions\s*=\s*[^\n]+;\n"
        r"(?:[ \t]*prompt\s*=\s*seekdeepImageModeOptions\.cleanPrompt[^\n]*;\n)?",
        "\n",
        fn,
        flags=re.MULTILINE,
    )

    return fn

def repair_sender(src, name, interaction=False):
    start, end = find_function_bounds(src, name)
    fn = src[start:end]

    if interaction:
        fn = fn.replace(
            "async function seekdeepSendImageWithButtonsInteraction(interaction, prompt, width = 1024, height = 1024, seed = null) {",
            "async function seekdeepSendImageWithButtonsInteraction(interaction, prompt, width = 1024, height = 1024, seed = null, imageModeOptions = null) {",
        )
    else:
        fn = fn.replace(
            "async function seekdeepSendImageWithButtonsMessage(message, prompt, width = 1024, height = 1024, seed = null) {",
            "async function seekdeepSendImageWithButtonsMessage(message, prompt, width = 1024, height = 1024, seed = null, imageModeOptions = null) {",
        )

    fn = strip_existing_option_declarations(fn)

    req = re.search(r"\n[ \t]*const\s+requestStartedAt\s*=\s*[^\n]+;\n", fn)
    if not req:
        fail(f"Could not locate requestStartedAt in {name}")

    insert_at = req.end()
    fn = fn[:insert_at] + canonical_option_block(interaction=interaction) + fn[insert_at:]

    fn = fn.replace(
        "const result = await makeImageResult(prompt, width, height, seed);",
        "const result = await makeImageResult(prompt, width, height, seed, seekdeepImageModeOptions);",
    )

    count = len(re.findall(r"\bconst\s+seekdeepImageModeOptions\b", fn))
    if count != 1:
        # Show nearby lines for manual diagnosis in the PowerShell output.
        lines = fn.splitlines()
        hits = [i + 1 for i, line in enumerate(lines) if "seekdeepImageModeOptions" in line]
        fail(f"{name} still has {count} const seekdeepImageModeOptions declarations. Hits: {hits[:20]}")

    if "makeImageResult(prompt, width, height, seed, seekdeepImageModeOptions)" not in fn:
        fail(f"{name} does not pass seekdeepImageModeOptions to makeImageResult")

    return src[:start] + fn + src[end:]

for needle, label in [
    ("function seekdeepImageModeOptionsFromPrompt", "image mode parser"),
    ("async function seekdeepSendImageWithButtonsMessage", "message image sender"),
    ("async function seekdeepSendImageWithButtonsInteraction", "interaction image sender"),
    ("async function makeImageResult", "makeImageResult"),
    ("seekdeepEnqueueImageJob(job, runner)", "queue contract"),
]:
    require(needle, label)

if "seekdeepMakeImageQueueJobId" in text:
    fail("Unsafe old queue helper found: seekdeepMakeImageQueueJobId")
if "job.run" in text:
    fail("Unsafe job.run-style queue logic found")

# Fix accidental async typo from earlier patch family, if present.
text = re.sub(r"\basync\s+async\s+function\b", "async function", text)

text = repair_sender(text, "seekdeepSendImageWithButtonsMessage", interaction=False)
text = repair_sender(text, "seekdeepSendImageWithButtonsInteraction", interaction=True)

# Ensure message route computes options before stripping raw tokens away.
old_dispatch = """      const imagePrompt = (typeof seekdeepExtractImagePrompt === 'function' ? seekdeepExtractImagePrompt(prompt) : prompt) || prompt;
      seekdeepLogRoute('image', imagePrompt);
      remember(key, 'user', `[natural-image] ${prompt}`);
      remember(key, 'assistant', `Queued image locally for: ${imagePrompt}`);
      await seekdeepSendImageWithButtonsMessage(message, imagePrompt, 1024, 1024, null);
"""
new_dispatch = """      const seekdeepMessageImageModeOptions = typeof seekdeepImageModeOptionsFromPrompt === 'function'
        ? seekdeepImageModeOptionsFromPrompt(prompt)
        : { refine: true, ground: true, cleanPrompt: prompt };
      const imagePrompt = (typeof seekdeepExtractImagePrompt === 'function' ? seekdeepExtractImagePrompt(prompt) : prompt) || seekdeepMessageImageModeOptions.cleanPrompt || prompt;
      seekdeepLogRoute('image', imagePrompt);
      remember(key, 'user', `[natural-image] ${prompt}`);
      remember(key, 'assistant', `Queued image locally for: ${imagePrompt}`);
      await seekdeepSendImageWithButtonsMessage(message, imagePrompt, 1024, 1024, null, seekdeepMessageImageModeOptions);
"""
if old_dispatch in text:
    text = text.replace(old_dispatch, new_dispatch, 1)
elif "await seekdeepSendImageWithButtonsMessage(message, imagePrompt, 1024, 1024, null, seekdeepMessageImageModeOptions);" not in text:
    fail("Could not patch message route image dispatch.")

# Ensure slash command route also preserves raw tokens.
old_slash = """      const seed = interaction.options.getInteger('seed');
      remember(key, 'user', `/image ${prompt}`);
      remember(key, 'assistant', `Generated image locally for: ${prompt}`);
      await seekdeepSendImageWithButtonsInteraction(interaction, prompt, width, height, seed ?? null);
"""
new_slash = """      const seed = interaction.options.getInteger('seed');
      const seekdeepImageModeOptions = typeof seekdeepImageModeOptionsFromPrompt === 'function'
        ? seekdeepImageModeOptionsFromPrompt(prompt)
        : { refine: true, ground: true, cleanPrompt: prompt };
      const cleanImagePrompt = seekdeepImageModeOptions.cleanPrompt || prompt;
      remember(key, 'user', `/image ${prompt}`);
      remember(key, 'assistant', `Generated image locally for: ${cleanImagePrompt}`);
      await seekdeepSendImageWithButtonsInteraction(interaction, cleanImagePrompt, width, height, seed ?? null, seekdeepImageModeOptions);
"""
if old_slash in text:
    text = text.replace(old_slash, new_slash, 1)

# Reply context placeholder filter.
old_reply = """    if (!replyText) return '';
    replyText = replyText.replace(/\s+/g, ' ').trim();
    return replyText;
"""
new_reply = """    if (!replyText) return '';
    replyText = replyText.replace(/\s+/g, ' ').trim();
    if (/^(?:gif|image|photo|picture|pic|emoji|emojis|sticker|video|attachment|file)$/i.test(replyText)) return '';
    return replyText;
"""
if old_reply in text:
    text = text.replace(old_reply, new_reply, 1)

# Force image route if reply-context consumed a generate-only reply.
if "const seekdeepForceImageFromReplyContext = Boolean(" not in text:
    old_prompt = """  let prompt = normalizeUserText(stripBotMentions(message.content));

  const seekdeepReplyPromptInfo = await seekdeepApplyReplyContextToPrompt(message, prompt);

  prompt = seekdeepReplyPromptInfo.prompt;
"""
    new_prompt = """  let prompt = normalizeUserText(stripBotMentions(message.content));
  const seekdeepPromptBeforeReplyContext = prompt;

  const seekdeepReplyPromptInfo = await seekdeepApplyReplyContextToPrompt(message, prompt);

  prompt = seekdeepReplyPromptInfo.prompt;
  const seekdeepForceImageFromReplyContext = Boolean(
    seekdeepReplyPromptInfo.usedReplyContext &&
    typeof seekdeepLooksLikeGenerateOnlyPrompt === 'function' &&
    seekdeepLooksLikeGenerateOnlyPrompt(seekdeepPromptBeforeReplyContext)
  );
"""
    if old_prompt in text:
        text = text.replace(old_prompt, new_prompt, 1)

if "seekdeepForceImageFromReplyContext ||" not in text:
    old_route = "if (!seekdeepShouldKeepPromptAsChatBeforeImage(prompt) && ((typeof seekdeepIsGenericImageFollowupPrompt === 'function' && seekdeepIsGenericImageFollowupPrompt(prompt)) || (typeof seekdeepLooksLikeShortNamedVisualSubject === 'function' && seekdeepLooksLikeShortNamedVisualSubject(prompt)) || isNaturalImagePrompt(prompt))) {"
    new_route = "if (seekdeepForceImageFromReplyContext || (!seekdeepShouldKeepPromptAsChatBeforeImage(prompt) && ((typeof seekdeepIsGenericImageFollowupPrompt === 'function' && seekdeepIsGenericImageFollowupPrompt(prompt)) || (typeof seekdeepLooksLikeShortNamedVisualSubject === 'function' && seekdeepLooksLikeShortNamedVisualSubject(prompt)) || isNaturalImagePrompt(prompt)))) {"
    if old_route in text:
        text = text.replace(old_route, new_route, 1)

# Final validations.
for name in ("seekdeepSendImageWithButtonsMessage", "seekdeepSendImageWithButtonsInteraction"):
    start, end = find_function_bounds(text, name)
    fn = text[start:end]
    count = len(re.findall(r"\bconst\s+seekdeepImageModeOptions\b", fn))
    if count != 1:
        fail(f"Validation failed: {name} has {count} const seekdeepImageModeOptions declarations")
    if "makeImageResult(prompt, width, height, seed, seekdeepImageModeOptions)" not in fn:
        fail(f"Validation failed: {name} is not passing seekdeepImageModeOptions")

for needle, label in [
    ("seekdeepForceImageFromReplyContext", "reply force image flag"),
    ("await seekdeepSendImageWithButtonsMessage(message, imagePrompt, 1024, 1024, null, seekdeepMessageImageModeOptions);", "message route passes options"),
    ("seekdeepEnqueueImageJob(job, runner)", "queue contract preserved"),
]:
    require(needle, label)

out = text if newline == "\n" else text.replace("\n", "\r\n")
path.write_bytes(out.encode("utf-8"))
print("Hard-repaired duplicate seekdeepImageModeOptions declarations.")
'@

  $patchPyPath = Join-Path $patchesDir "hard_repair_duplicate_image_mode_options.py"
  [System.IO.File]::WriteAllText($patchPyPath, $patchPy, $utf8NoBom)

  Push-Location $projectRoot
  try {
    Write-Info "Applying hard duplicate-options repair"
    & ".\.venv\Scripts\python.exe" $patchPyPath $indexPath
    if ($LASTEXITCODE -ne 0) {
      throw "Patch helper failed with exit code $LASTEXITCODE."
    }
    Write-Pass "Hard duplicate-options repair applied"

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
  Write-Pass "Hard duplicate-options repair completed."
  Write-Host "Backup created: $indexBackup" -ForegroundColor Yellow
  Write-Host "Restart the Discord bot before testing." -ForegroundColor Yellow
  Write-Host ""
  Write-Host "Retest:" -ForegroundColor Cyan
  Write-Host "@SEEKOTICS raw generate a pine tree" -ForegroundColor White
  Write-Host "Expected: Refinement: off" -ForegroundColor White
  exit 0
} catch {
  Write-Host ""
  Write-Fail $_.Exception.Message
  Write-Host "Backup available:" -ForegroundColor Yellow
  if ($indexBackup) { Write-Host $indexBackup -ForegroundColor Yellow }
  exit 1
}
