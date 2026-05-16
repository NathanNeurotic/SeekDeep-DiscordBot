# SeekDeep / Seekotics reply-context guard + raw-mode pass-through repair
#
# Fixes two current checkpoint issues:
#
# 1. Raw/unrefined image options are parsed in seekdeepSendImageWithButtonsMessage(...)
#    but normal message image generation still calls:
#      makeImageResult(prompt, width, height, seed)
#    so raw/unrefined mode may be ignored.
#
# 2. Reply-context patch is too aggressive:
#      @SEEKOTICS generate
#    while replying to non-visual chat text replaces the prompt with that text and sends it to chat.
#    Reply context should only become an image prompt when the replied message looks visual.
#
# Also formalizes reply translation:
#   Reply to a foreign-language message with:
#     @SEEKOTICS translate this to english
#   The bot translates the replied message instead of losing context.
#
# Safety:
# - Backs up index.js first
# - Patches index.js only
# - Preserves queue contract:
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
  Write-Host "[SeekDeep reply/raw repair] $Message" -ForegroundColor Cyan
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

  $indexBackup = Join-Path $backupDir "index.js.reply-context-raw-passthrough-repair-$stamp.bak"
  Copy-Item -LiteralPath $indexPath -Destination $indexBackup -Force
  Write-Pass "Backed up index.js to $indexBackup"

  $utf8NoBom = [System.Text.UTF8Encoding]::new($false)

  $patchPy = @'
from pathlib import Path
import re
import sys

if len(sys.argv) != 2:
    raise SystemExit("Usage: repair_reply_context_and_raw_passthrough.py <index.js>")

path = Path(sys.argv[1])
raw = path.read_bytes()
newline = "\r\n" if b"\r\n" in raw else "\n"
text = raw.decode("utf-8-sig").replace("\r\n", "\n").replace("\r", "\n")


def require_contains(haystack: str, needle: str, label: str):
    if needle not in haystack:
        raise SystemExit(f"Required anchor not found: {label}")

for needle, label in [
    ("async function seekdeepApplyReplyContextToPrompt", "reply context function"),
    ("async function seekdeepSendImageWithButtonsMessage", "image send function"),
    ("async function makeImageResult", "makeImageResult"),
    ("seekdeepEnqueueImageJob(job, runner)", "correct image queue contract"),
]:
    require_contains(text, needle, label)

if "seekdeepMakeImageQueueJobId" in text:
    raise SystemExit("Unsafe old queue helper found: seekdeepMakeImageQueueJobId")
if "job.run" in text:
    raise SystemExit("Unsafe job.run-style queue logic found")

# 1) Fix raw/unrefined pass-through for normal message image generation.
old_call = "const result = await makeImageResult(prompt, width, height, seed);"
new_call = "const result = await makeImageResult(prompt, width, height, seed, seekdeepImageModeOptions);"
if old_call in text:
    text = text.replace(old_call, new_call, 1)
elif new_call not in text:
    raise SystemExit("Could not locate or verify makeImageResult options pass-through call.")

# 2) Replace seekdeepApplyReplyContextToPrompt with safer version and helper functions.
start = text.find("async function seekdeepApplyReplyContextToPrompt")
if start < 0:
    raise SystemExit("Could not locate seekdeepApplyReplyContextToPrompt.")
end_marker = "\n// SEEKDEEP_REPLY_CONTEXT_IMAGE_PROMPT_END"
end = text.find(end_marker, start)
if end < 0:
    raise SystemExit("Could not locate end of reply context block.")

replacement = r'''function seekdeepLooksLikeReplyVisualPrompt(replyText = '') {
  const p = normalizeUserText(replyText).trim();
  if (!p) return false;

  // Do not treat obvious text/research/translation content as an image prompt.
  if (typeof seekdeepShouldKeepPromptAsChatBeforeImage === 'function' && seekdeepShouldKeepPromptAsChatBeforeImage(p)) return false;
  if (/\b(translate|translation|what does this mean|explain|why|how|when|where|who|what|search|internet|web|table|code|script|powershell)\b/i.test(p)) return false;

  // Use current image route detectors when available.
  if (typeof seekdeepLooksLikeShortNamedVisualSubject === 'function' && seekdeepLooksLikeShortNamedVisualSubject(p)) return true;
  if (typeof seekdeepLooksLikeGroundableVisualSubject === 'function' && seekdeepLooksLikeGroundableVisualSubject(p)) return true;
  if (typeof seekdeepLooksLikeVisualRequest === 'function' && seekdeepLooksLikeVisualRequest(p)) return true;
  if (typeof isNaturalImagePrompt === 'function' && isNaturalImagePrompt(p)) return true;

  return false;
}

function seekdeepIsReplyTranslationRequest(prompt = '') {
  const p = normalizeUserText(prompt).toLowerCase().trim();
  return /^(translate|translation)\b/.test(p) || /\btranslate\s+(this|that|it|message|reply)\s+(to|into)\s+english\b/.test(p) || /^what\s+does\s+this\s+say\s+in\s+english\b/.test(p);
}

async function seekdeepApplyReplyContextToPrompt(message, prompt = '') {
  const original = normalizeUserText(prompt || '');
  const replyText = await seekdeepResolveReplyContextText(message);
  if (!replyText) {
    return {
      prompt: original,
      usedReplyContext: false,
      replyContext: ''
    };
  }

  const cleaned = seekdeepCleanReplyContextPrompt(original);
  const isGenerateOnly = seekdeepLooksLikeGenerateOnlyPrompt(original);
  const replyLooksVisual = seekdeepLooksLikeReplyVisualPrompt(replyText);

  // Only replace the prompt with replied text for image-style trigger messages
  // when the replied message itself looks like a visual prompt.
  if ((isGenerateOnly || !cleaned) && replyLooksVisual) {
    return {
      prompt: replyText,
      usedReplyContext: true,
      replyContext: replyText,
      replyContextMode: 'image'
    };
  }

  // Keep the user's actual command. Other reply-aware workflows, like translation,
  // can consume replyContext explicitly without hijacking prompt routing.
  return {
    prompt: original,
    usedReplyContext: false,
    replyContext: replyText,
    replyContextMode: 'available'
  };
}
'''

text = text[:start] + replacement + text[end:]

# 3) Add explicit reply-translation route before image routing / chat fallback.
if "SEEKDEEP_REPLY_TRANSLATION_ROUTE_START" not in text:
    anchor = "    // SEEKDEEP_RAW_IMAGE_MESSAGE_ROUTE_START\n"
    pos = text.find(anchor)
    if pos < 0:
        raise SystemExit("Could not locate image route anchor for reply translation insertion.")
    block = r'''    // SEEKDEEP_REPLY_TRANSLATION_ROUTE_START
    if (seekdeepReplyPromptInfo?.replyContext && seekdeepIsReplyTranslationRequest(prompt)) {
      seekdeepLogRoute('reply-translate', prompt);
      const translationPrompt = [
        'Translate the following message to English.',
        'Return only the translation unless a note is necessary for slang or profanity.',
        '',
        seekdeepReplyPromptInfo.replyContext,
      ].join('\n');
      const answer = await askChat(translationPrompt, {
        web: 'off',
        memoryKey: key,
        temperature: 0.1,
        maxNewTokens: 500,
      });
      remember(key, 'user', `[reply-translate] ${prompt}\n${seekdeepReplyPromptInfo.replyContext}`);
      remember(key, 'assistant', answer);
      seekdeepSetResponseModel(message, seekdeepChatModelLabel());
      await sendLongMessageReply(message, answer);
      return;
    }
    // SEEKDEEP_REPLY_TRANSLATION_ROUTE_END

'''
    text = text[:pos] + block + text[pos:]

# 4) Make logging less misleading: only says image prompt when used for image.
old_log = "console.log(`[SeekDeep] reply-context image prompt:\\n  reply: ${seekdeepReplyPromptInfo.replyContext}\\n  final: ${prompt}`);"
new_log = "console.log(`[SeekDeep] reply-context prompt used (${seekdeepReplyPromptInfo.replyContextMode || 'context'}):\\n  reply: ${seekdeepReplyPromptInfo.replyContext}\\n  final: ${prompt}`);"
if old_log in text:
    text = text.replace(old_log, new_log, 1)

for needle, label in [
    ("makeImageResult(prompt, width, height, seed, seekdeepImageModeOptions)", "raw options pass-through"),
    ("function seekdeepLooksLikeReplyVisualPrompt", "reply visual guard"),
    ("function seekdeepIsReplyTranslationRequest", "reply translation detector"),
    ("replyLooksVisual", "reply context gated by visual detection"),
    ("SEEKDEEP_REPLY_TRANSLATION_ROUTE_START", "reply translation route"),
    ("seekdeepEnqueueImageJob(job, runner)", "queue contract preserved"),
]:
    require_contains(text, needle, label)

out = text if newline == "\n" else text.replace("\n", "\r\n")
path.write_bytes(out.encode("utf-8"))
print("Repaired reply-context routing and raw image option pass-through.")
'@

  $patchPyPath = Join-Path $patchesDir "repair_reply_context_and_raw_passthrough.py"
  [System.IO.File]::WriteAllText($patchPyPath, $patchPy, $utf8NoBom)

  Push-Location $projectRoot
  try {
    Write-Info "Applying reply-context/raw pass-through repair"
    & ".\.venv\Scripts\python.exe" $patchPyPath $indexPath
    if ($LASTEXITCODE -ne 0) {
      throw "Patch helper failed with exit code $LASTEXITCODE."
    }
    Write-Pass "Applied reply-context/raw pass-through repair"

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
  Write-Pass "Reply-context/raw pass-through repair completed."
  Write-Host "Backup created: $indexBackup" -ForegroundColor Yellow
  Write-Host "Restart the Discord bot before testing." -ForegroundColor Yellow
  Write-Host ""
  Write-Host "Retest:" -ForegroundColor Cyan
  Write-Host "1) @SEEKOTICS raw generate Ripto from Spyro in the matrix" -ForegroundColor White
  Write-Host "   Expected: Refinement: off" -ForegroundColor White
  Write-Host ""
  Write-Host "2) Reply to a non-visual text message with: @SEEKOTICS generate" -ForegroundColor White
  Write-Host "   Expected: What should I generate an image of? or normal generate handling, not route=chat using vulgar text" -ForegroundColor White
  Write-Host ""
  Write-Host "3) Reply to Polish text with: @SEEKOTICS translate this to english" -ForegroundColor White
  Write-Host "   Expected: route=reply-translate and translated reply text" -ForegroundColor White
  exit 0
} catch {
  Write-Host ""
  Write-Fail $_.Exception.Message
  Write-Host "Backup available:" -ForegroundColor Yellow
  if ($indexBackup) { Write-Host $indexBackup -ForegroundColor Yellow }
  exit 1
}
