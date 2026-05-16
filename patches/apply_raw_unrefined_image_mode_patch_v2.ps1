# SeekDeep / Seekotics raw/unrefined image mode patch v2
#
# Fixes failure from v1:
#   Could not patch isNaturalImagePrompt opening.
#
# v2 strategy:
# - Does not require an exact isNaturalImagePrompt function signature.
# - Adds raw/unrefined/no-refine token parsing.
# - Adds generic "generate" image-context routing at the messageCreate image route boundary.
# - Adds "generate for me <subject>" / "Generate spyro but like predator" as image triggers.
# - Strips raw/unrefined/no-grounding tokens from actual prompt text.
# - Adds raw mode to makeImageResult, skipping prompt refinement while preserving optional grounding.
# - Adds final visible lines:
#     Grounding: on/off
#     Refinement: on/off
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
  Write-Host "[SeekDeep raw-image-mode-v2] $Message" -ForegroundColor Cyan
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

  $indexBackup = Join-Path $backupDir "index.js.raw-unrefined-image-mode-v2-$stamp.bak"
  Copy-Item -LiteralPath $indexPath -Destination $indexBackup -Force
  Write-Pass "Backed up index.js to $indexBackup"

  $utf8NoBom = [System.Text.UTF8Encoding]::new($false)

  $patchPy = @'
from pathlib import Path
import re
import sys

if len(sys.argv) != 2:
    raise SystemExit("Usage: patch_raw_unrefined_image_mode_v2.py <index.js>")

path = Path(sys.argv[1])
raw = path.read_bytes()
newline = "\r\n" if b"\r\n" in raw else "\n"
text = raw.decode("utf-8-sig").replace("\r\n", "\n").replace("\r", "\n")

def require_contains(haystack: str, needle: str, label: str):
    if needle not in haystack:
        raise SystemExit(f"Required anchor not found: {label}")

for needle, label in [
    ("async function makeImageResult", "makeImageResult"),
    ("async function seekdeepSendImageWithButtonsMessage", "seekdeepSendImageWithButtonsMessage"),
    ("function seekdeepExtractImagePrompt", "seekdeepExtractImagePrompt"),
    ("function isNaturalImagePrompt", "isNaturalImagePrompt"),
    ("seekdeepEnqueueImageJob(job, runner)", "correct image queue contract"),
]:
    require_contains(text, needle, label)

if "seekdeepMakeImageQueueJobId" in text:
    raise SystemExit("Unsafe old queue helper found: seekdeepMakeImageQueueJobId")
if "job.run" in text:
    raise SystemExit("Unsafe job.run-style queue logic found")

helpers = r"""
// SEEKDEEP_RAW_IMAGE_MODE_START
function seekdeepImageRawModeRequested(prompt = '') {
  const p = normalizeUserText(prompt).toLowerCase().trim();
  return (
    /(^|\s)--?(raw|unrefined|no-refine|norefine)(\s|$)/i.test(p) ||
    /(^|\s)(raw|unrefined)\s+(generate|create|make|draw|paint|sketch|illustrate|render|show)\b/i.test(p) ||
    /(^|\s)(no\s+refine|without\s+refinement|skip\s+refinement)\b/i.test(p)
  );
}

function seekdeepImageGroundingDisabled(prompt = '') {
  const p = normalizeUserText(prompt).toLowerCase().trim();
  return (
    /(^|\s)--?(ungrounded|no-grounding|nogrounding)(\s|$)/i.test(p) ||
    /(^|\s)(no\s+grounding|without\s+grounding|skip\s+grounding)\b/i.test(p)
  );
}

function seekdeepCleanImageModeTokens(prompt = '') {
  let out = normalizeUserText(prompt);

  out = out
    .replace(/(^|\s)--?(raw|unrefined|no-refine|norefine)(?=\s|$)/gi, ' ')
    .replace(/(^|\s)--?(ungrounded|no-grounding|nogrounding)(?=\s|$)/gi, ' ')
    .replace(/\b(no\s+refine|without\s+refinement|skip\s+refinement)\b/gi, ' ')
    .replace(/\b(no\s+grounding|without\s+grounding|skip\s+grounding)\b/gi, ' ')
    .replace(/^\s*(raw|unrefined)\s+(?=(generate|create|make|draw|paint|sketch|illustrate|render|show)\b)/i, '')
    .replace(/\s+/g, ' ')
    .trim();

  return out;
}

function seekdeepImageModeOptionsFromPrompt(prompt = '') {
  return {
    refine: !seekdeepImageRawModeRequested(prompt),
    ground: !seekdeepImageGroundingDisabled(prompt),
    rawRequested: seekdeepImageRawModeRequested(prompt),
    groundingDisabled: seekdeepImageGroundingDisabled(prompt),
    cleanPrompt: seekdeepCleanImageModeTokens(prompt),
  };
}

function seekdeepIsGenericImageFollowupPrompt(prompt = '') {
  const p = normalizeUserText(prompt).toLowerCase().trim();
  return /^(generate|create|make|draw|paint|sketch|illustrate|render|show)(\s+me)?(?:\s+(an?\s+)?(image|picture|pic|art|drawing|illustration|it|that|this))?$/i.test(p);
}

function seekdeepRefinementStatusLine(enabled = true) {
  return `Refinement: ${enabled ? 'on' : 'off'}`;
}

function seekdeepGroundingStatusLine(result = null, options = {}) {
  if (options?.ground === false) return 'Grounding: off';
  if (result?.grounded) return 'Grounding: on';
  return '';
}
// SEEKDEEP_RAW_IMAGE_MODE_END

"""

if "SEEKDEEP_RAW_IMAGE_MODE_START" not in text:
    pos = text.find("function seekdeepExtractImagePrompt")
    if pos < 0:
        raise SystemExit("Could not locate seekdeepExtractImagePrompt anchor.")
    text = text[:pos] + helpers + "\n" + text[pos:]

# Make extractor strip raw/unrefined/no-grounding tokens without relying on exact function signature.
if "SEEKDEEP_RAW_IMAGE_EXTRACT_CLEAN_START" not in text:
    m = re.search(r"function\s+seekdeepExtractImagePrompt\s*\([^)]*\)\s*\{\s*\n\s*let\s+t\s*=\s*normalizeUserText\(([^)]*)\);\s*\n", text)
    if not m:
        raise SystemExit("Could not locate seekdeepExtractImagePrompt normalizeUserText line.")
    replacement = "function seekdeepExtractImagePrompt(text = '') {\n  // SEEKDEEP_RAW_IMAGE_EXTRACT_CLEAN_START\n  let t = seekdeepCleanImageModeTokens(text);\n  // SEEKDEEP_RAW_IMAGE_EXTRACT_CLEAN_END\n\n"
    text = text[:m.start()] + replacement + text[m.end():]

# Make explicit-image trigger understand "generate for me X" and "generate X".
if "SEEKDEEP_GENERATE_FOR_ME_IMAGE_TRIGGER_START" not in text:
    pos = text.find("function seekdeepHasExplicitImageRequest")
    if pos < 0:
        raise SystemExit("Could not locate seekdeepHasExplicitImageRequest.")
    marker_pos = text.find("if (!text) return false;", pos)
    if marker_pos < 0:
        raise SystemExit("Could not locate text empty check in seekdeepHasExplicitImageRequest.")
    insert_at = text.find("\n", marker_pos) + 1
    trigger = r"""

  // SEEKDEEP_GENERATE_FOR_ME_IMAGE_TRIGGER_START
  if (/^(?:generate|create|make|render|draw|paint|sketch|illustrate|design)\s+(?:(?:for\s+)?me\s+)?\S+/i.test(text) &&
      !/\b(?:table|spreadsheet|list|pros|cons|summary|explanation|code|script|powershell)\b/i.test(text)) {
    return true;
  }
  // SEEKDEEP_GENERATE_FOR_ME_IMAGE_TRIGGER_END
"""
    text = text[:insert_at] + trigger + text[insert_at:]

# Strip "for me" in extraction.
old_extract = "t = t.replace(/^(?:please\\s+)?(?:show me|make me|generate|create|draw|sketch|render|paint|illustrate|design)\\s+(?:me\\s+)?/i, '');"
new_extract = "t = t.replace(/^(?:please\\s+)?(?:show me|make me|generate|create|draw|sketch|render|paint|illustrate|design)\\s+(?:(?:for\\s+)?me\\s+)?/i, '');"
if old_extract in text:
    text = text.replace(old_extract, new_extract, 1)

# Message route should treat bare "generate" as image route, relying on context resolver to reuse prior subject or ask locally.
if "SEEKDEEP_RAW_IMAGE_MESSAGE_ROUTE_START" not in text:
    old_route = "    if (isNaturalImagePrompt(prompt)) {"
    new_route = """    // SEEKDEEP_RAW_IMAGE_MESSAGE_ROUTE_START
    if ((typeof seekdeepIsGenericImageFollowupPrompt === 'function' && seekdeepIsGenericImageFollowupPrompt(prompt)) || isNaturalImagePrompt(prompt)) {
    // SEEKDEEP_RAW_IMAGE_MESSAGE_ROUTE_END"""
    if old_route not in text:
        raise SystemExit("Could not locate messageCreate natural image route.")
    text = text.replace(old_route, new_route, 1)

# Patch send image function to resolve options and clean prompt before context/cooldown/job.
if "SEEKDEEP_RAW_IMAGE_SEND_OPTIONS_START" not in text:
    pos = text.find("async function seekdeepSendImageWithButtonsMessage")
    if pos < 0:
        raise SystemExit("Could not locate seekdeepSendImageWithButtonsMessage.")
    anchor = "  const requestStartedAt = seekdeepNowMs();\n"
    anchor_pos = text.find(anchor, pos)
    if anchor_pos < 0:
        raise SystemExit("Could not locate requestStartedAt in seekdeepSendImageWithButtonsMessage.")
    insert_at = anchor_pos + len(anchor)
    block = """
  // SEEKDEEP_RAW_IMAGE_SEND_OPTIONS_START
  const seekdeepImageModeOptions = seekdeepImageModeOptionsFromPrompt(prompt);
  prompt = seekdeepImageModeOptions.cleanPrompt || prompt;
  // SEEKDEEP_RAW_IMAGE_SEND_OPTIONS_END

"""
    text = text[:insert_at] + block + text[insert_at:]

# Patch makeImageResult signature.
if "async function makeImageResult(prompt, width = 1024, height = 1024, seed = null, imageOptions = {})" not in text:
    text = text.replace(
        "async function makeImageResult(prompt, width = 1024, height = 1024, seed = null) {",
        "async function makeImageResult(prompt, width = 1024, height = 1024, seed = null, imageOptions = {}) {",
        1
    )

# Patch promptInfo creation. Support grounded patch, object sanitizer patch, or original plain line.
if "SEEKDEEP_RAW_IMAGE_MAKE_OPTIONS_START" not in text:
    replacements = [
        (
            "  // SEEKDEEP_IMAGE_WEB_GROUNDING_CALL_START\n  const seekdeepGroundedImagePrompt = await seekdeepMaybeGroundImagePrompt(prompt);\n  const promptInfo = seekdeepSanitizeObjectImagePromptInfo(seekdeepPrepareImagePrompt(seekdeepGroundedImagePrompt.prompt || prompt));\n  // SEEKDEEP_IMAGE_WEB_GROUNDING_CALL_END\n\n",
            "grounded_sanitized"
        ),
        (
            "  // SEEKDEEP_IMAGE_WEB_GROUNDING_CALL_START\n  const seekdeepGroundedImagePrompt = await seekdeepMaybeGroundImagePrompt(prompt);\n  const promptInfo = seekdeepPrepareImagePrompt(seekdeepGroundedImagePrompt.prompt || prompt);\n  // SEEKDEEP_IMAGE_WEB_GROUNDING_CALL_END\n\n",
            "grounded_plain"
        ),
        (
            "  const promptInfo = seekdeepPrepareImagePrompt(prompt);\n",
            "plain"
        ),
    ]
    new_block = """  // SEEKDEEP_IMAGE_WEB_GROUNDING_CALL_START
  // SEEKDEEP_RAW_IMAGE_MAKE_OPTIONS_START
  const seekdeepImageOptions = {
    refine: imageOptions?.refine !== false,
    ground: imageOptions?.ground !== false,
  };
  const seekdeepGroundedImagePrompt = seekdeepImageOptions.ground && typeof seekdeepMaybeGroundImagePrompt === 'function'
    ? await seekdeepMaybeGroundImagePrompt(prompt)
    : { prompt, grounded: false, searchQuery: '' };

  let promptInfo;
  if (seekdeepImageOptions.refine) {
    const prepared = seekdeepPrepareImagePrompt(seekdeepGroundedImagePrompt.prompt || prompt);
    promptInfo = typeof seekdeepSanitizeObjectImagePromptInfo === 'function'
      ? seekdeepSanitizeObjectImagePromptInfo(prepared)
      : prepared;
  } else {
    const rawPrompt = normalizeUserText(seekdeepGroundedImagePrompt.prompt || prompt).trim();
    promptInfo = {
      originalPrompt: normalizeUserText(prompt).trim(),
      refinedPrompt: rawPrompt,
      generationPrompt: rawPrompt,
      changed: rawPrompt !== normalizeUserText(prompt).trim(),
    };
  }
  // SEEKDEEP_RAW_IMAGE_MAKE_OPTIONS_END
  // SEEKDEEP_IMAGE_WEB_GROUNDING_CALL_END

"""
    done = False
    for old, _label in replacements:
        if old in text:
            text = text.replace(old, new_block, 1)
            done = True
            break
    if not done:
        raise SystemExit("Could not locate promptInfo creation in makeImageResult.")

# Pass options from queue runner to makeImageResult.
if "makeImageResult(prompt, width, height, seed, seekdeepImageModeOptions)" not in text:
    old = "const result = await makeImageResult(prompt, width, height, seed);"
    if old not in text:
        raise SystemExit("Could not patch makeImageResult call in image queue runner.")
    text = text.replace(old, "const result = await makeImageResult(prompt, width, height, seed, seekdeepImageModeOptions);", 1)

# Add status lines to final image content.
if "seekdeepRefinementStatusLine(result?.refinementEnabled !== false)" not in text:
    anchor = "        `Queue Wait: ${seekdeepImageQueueWaitSeconds(runningJob)} seconds`,"
    if anchor not in text:
        raise SystemExit("Could not locate queue wait line in final image content.")
    status = "        seekdeepGroundingStatusLine(result?.grounding, result?.imageOptions),\n        seekdeepRefinementStatusLine(result?.refinementEnabled !== false),\n"
    text = text.replace(anchor, status + anchor, 1)

# Add metadata to makeImageResult return.
if "refinementEnabled: seekdeepImageOptions.refine" not in text:
    anchor = "    promptRefined: promptInfo.changed,\n"
    if anchor not in text:
        raise SystemExit("Could not locate promptRefined return metadata.")
    meta = "    refinementEnabled: seekdeepImageOptions.refine,\n    grounding: seekdeepGroundedImagePrompt,\n    imageOptions: seekdeepImageOptions,\n"
    text = text.replace(anchor, anchor + meta, 1)

# Add object sanitizer if missing. This repairs object prompts even if previous object-refinement patch was not applied.
if "function seekdeepSanitizeObjectImagePromptInfo" not in text:
    sanitizer = r"""
function seekdeepLooksLikeObjectOnlyImagePrompt(prompt = '') {
  const p = normalizeUserText(prompt).toLowerCase();

  const objectCue = /\b(bag|pouch|sack|bells|bell|coin|coins|logo|emblem|badge|icon|item|object|prop|weapon|sword|shield|helmet|armor|ring|book|box|bottle|cup|mug|car|laptop|console|controller|poster|album cover|wallpaper)\b/.test(p);
  const characterCue = /\b(person|human|man|woman|girl|boy|face|portrait|hands|eyes|cat|dog|frog|dragon|monster|character|sailor moon|pepe|ripto|spyro)\b/.test(p);

  return objectCue && !characterCue;
}

function seekdeepSanitizeObjectImagePromptInfo(promptInfo) {
  if (!promptInfo || !seekdeepLooksLikeObjectOnlyImagePrompt(promptInfo.originalPrompt || promptInfo.generationPrompt || '')) return promptInfo;

  const cleanOne = (value = '') => String(value || '')
    .replace(/,?\s*expressive subject/gi, '')
    .replace(/,?\s*coherent anatomy/gi, '')
    .replace(/,?\s*natural anatomy/gi, '')
    .replace(/,?\s*clean hands/gi, '')
    .replace(/,?\s*plastic skin/gi, '')
    .replace(/,?\s*avoid malformed anatomy/gi, '')
    .replace(/,?\s*avoid malformed limbs/gi, '')
    .replace(/,?\s*duplicated faces/gi, '')
    .replace(/,?\s*distorted eyes/gi, '')
    .replace(/\s*,\s*,+/g, ',')
    .replace(/,\s*$/g, '')
    .trim();

  const objectAdd = 'centered object composition, accurate prop silhouette, readable item design, crisp edges, no extra characters, no face, no limbs';
  const refined = cleanOne(promptInfo.refinedPrompt);
  const generation = cleanOne(promptInfo.generationPrompt);

  promptInfo.refinedPrompt = refined.includes('centered object composition') ? refined : `${refined}, ${objectAdd}`;
  promptInfo.generationPrompt = generation.includes('centered object composition') ? generation : `${generation}, ${objectAdd}`;
  return promptInfo;
}

"""
    pos = text.find("async function makeImageResult")
    if pos < 0:
        raise SystemExit("Could not locate makeImageResult for sanitizer insertion.")
    text = text[:pos] + sanitizer + "\n" + text[pos:]

# Add known Animal Crossing override if missing and grounding helper exists.
if "SEEKDEEP_KNOWN_IMAGE_GROUNDING_OVERRIDE_START" not in text and "async function seekdeepMaybeGroundImagePrompt" in text:
    anchor = "  const searchQuery = seekdeepBuildImageGroundingSearchQuery(original);\n"
    if anchor in text:
        override = """  // SEEKDEEP_KNOWN_IMAGE_GROUNDING_OVERRIDE_START
  if (/\\banimal crossing\\b/i.test(original) && /\\b(bag of bells|bells bag|bell bag|bells)\\b/i.test(original)) {
    const grounded = 'Animal Crossing Bells money bag, small tan cloth drawstring pouch, rounded simple game item shape, tied top, dark star-shaped bell/currency symbol on the front, cute clean Nintendo-style object icon, centered prop, no face, no character, no loose coins, no text';
    console.log(`[SeekDeep] image prompt grounded:\\n  original: ${original}\\n  grounded: ${grounded}`);
    return { prompt: grounded, grounded: true, searchQuery: 'known-subject:animal-crossing-bells-bag' };
  }
  // SEEKDEEP_KNOWN_IMAGE_GROUNDING_OVERRIDE_END

""" + anchor
        text = text.replace(anchor, override, 1)

for needle, label in [
    ("SEEKDEEP_RAW_IMAGE_MODE_START", "raw mode helpers"),
    ("SEEKDEEP_RAW_IMAGE_EXTRACT_CLEAN_START", "extract clean hook"),
    ("SEEKDEEP_GENERATE_FOR_ME_IMAGE_TRIGGER_START", "generate-for-me image trigger"),
    ("SEEKDEEP_RAW_IMAGE_MESSAGE_ROUTE_START", "message route hook"),
    ("SEEKDEEP_RAW_IMAGE_SEND_OPTIONS_START", "send options hook"),
    ("SEEKDEEP_RAW_IMAGE_MAKE_OPTIONS_START", "make options hook"),
    ("makeImageResult(prompt, width, height, seed, seekdeepImageModeOptions)", "image options passed to makeImageResult"),
    ("Refinement: ${enabled ? 'on' : 'off'}", "refinement status line"),
    ("refinementEnabled: seekdeepImageOptions.refine", "refinement metadata"),
    ("function seekdeepSanitizeObjectImagePromptInfo", "object sanitizer"),
    ("seekdeepEnqueueImageJob(job, runner)", "queue contract preserved"),
]:
    require_contains(text, needle, label)

out = text if newline == "\n" else text.replace("\n", "\r\n")
path.write_bytes(out.encode("utf-8"))
print("Patched raw/unrefined image mode v2.")
'@

  $patchPyPath = Join-Path $patchesDir "patch_raw_unrefined_image_mode_v2.py"
  [System.IO.File]::WriteAllText($patchPyPath, $patchPy, $utf8NoBom)

  Push-Location $projectRoot
  try {
    Write-Info "Applying raw/unrefined image mode patch v2"
    & ".\.venv\Scripts\python.exe" $patchPyPath $indexPath
    if ($LASTEXITCODE -ne 0) {
      throw "Patch helper failed with exit code $LASTEXITCODE."
    }
    Write-Pass "Applied raw/unrefined image mode patch v2"

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
  Write-Pass "Raw/unrefined image mode v2 completed."
  Write-Host "Backup created: $indexBackup" -ForegroundColor Yellow
  Write-Host "Restart the Discord bot before testing." -ForegroundColor Yellow
  Write-Host ""
  Write-Host "Retest:" -ForegroundColor Cyan
  Write-Host "@SEEKOTICS generate" -ForegroundColor White
  Write-Host "@SEEKOTICS raw generate Ripto from Spyro in the matrix" -ForegroundColor White
  Write-Host "@SEEKOTICS generate Ripto from Spyro in the matrix --raw" -ForegroundColor White
  Write-Host "@SEEKOTICS unrefined a bag of bells from Animal Crossing by Nintendo" -ForegroundColor White
  Write-Host "@SEEKOTICS generate a bag of bells from Animal Crossing by Nintendo --no-grounding" -ForegroundColor White
  exit 0
} catch {
  Write-Host ""
  Write-Fail $_.Exception.Message
  Write-Host "Backup available:" -ForegroundColor Yellow
  if ($indexBackup) { Write-Host $indexBackup -ForegroundColor Yellow }
  exit 1
}
