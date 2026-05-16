# SeekDeep / Seekotics combined repair
# Fixes:
# 1) raw / unrefined image mode was lost before generation because the routing layer
#    extracted a cleaned image prompt and dropped raw-mode tokens.
# 2) generate-only reply-context prompts could still route to chat instead of image.
# 3) placeholder reply-context values like "GIF" / "emojis" are ignored.
#
# Safety:
# - backs up index.js first
# - patches only index.js
# - runs syntax validation after patching

$ErrorActionPreference = 'Stop'

try {
  [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
} catch {}

function Write-Info {
  param([string]$Message)
  Write-Host "[SeekDeep raw-reply-force-image] $Message" -ForegroundColor Cyan
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
  $projectRoot = Join-Path $env:USERPROFILE 'SeekDeep-DiscordBot'
  if (-not (Test-Path -LiteralPath (Join-Path $projectRoot 'index.js'))) {
    $projectRoot = (Get-Location).Path
  }

  $indexPath = Join-Path $projectRoot 'index.js'
  $serverPath = Join-Path $projectRoot 'local_ai_server.py'
  $patchesDir = Join-Path $projectRoot 'patches'
  $backupDir = Join-Path $patchesDir 'backups'
  $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'

  if (-not (Test-Path -LiteralPath $indexPath)) { throw 'index.js not found.' }
  if (-not (Test-Path -LiteralPath $serverPath)) { throw 'local_ai_server.py not found.' }

  New-Item -ItemType Directory -Path $patchesDir -Force | Out-Null
  New-Item -ItemType Directory -Path $backupDir -Force | Out-Null

  Write-Info "Project root: $projectRoot"

  $indexBackup = Join-Path $backupDir "index.js.raw-reply-force-image-$stamp.bak"
  Copy-Item -LiteralPath $indexPath -Destination $indexBackup -Force
  Write-Pass "Backed up index.js to $indexBackup"

  $utf8NoBom = [System.Text.UTF8Encoding]::new($false)

  $patchPy = @'
from pathlib import Path
import sys

if len(sys.argv) != 2:
    raise SystemExit("Usage: patch_raw_reply_force_image.py <index.js>")

path = Path(sys.argv[1])
raw = path.read_bytes()
newline = "\r\n" if b"\r\n" in raw else "\n"
text = raw.decode("utf-8-sig").replace("\r\n", "\n").replace("\r", "\n")
original = text

def must_contain(needle: str, label: str):
    if needle not in text:
        raise SystemExit(f"Required anchor not found: {label}")

must_contain("async function seekdeepSendImageWithButtonsMessage", "message image sender")
must_contain("async function seekdeepSendImageWithButtonsInteraction", "interaction image sender")
must_contain("client.on('messageCreate'", "messageCreate handler")
must_contain("async function seekdeepApplyReplyContextToPrompt", "reply-context helper")
must_contain("function seekdeepImageModeOptionsFromPrompt", "raw image mode helper")

# 1) Preserve raw/unrefined options through the message image path.
text = text.replace(
    "async function seekdeepSendImageWithButtonsMessage(message, prompt, width = 1024, height = 1024, seed = null) {",
    "async function seekdeepSendImageWithButtonsMessage(message, prompt, width = 1024, height = 1024, seed = null, imageModeOptions = null) {"
)

old_msg_options = """  // SEEKDEEP_RAW_IMAGE_SEND_OPTIONS_START
  const seekdeepImageModeOptions = seekdeepImageModeOptionsFromPrompt(prompt);
  prompt = seekdeepImageModeOptions.cleanPrompt || prompt;
  // SEEKDEEP_RAW_IMAGE_SEND_OPTIONS_END
"""
new_msg_options = """  // SEEKDEEP_RAW_IMAGE_SEND_OPTIONS_START
  const seekdeepImageModeOptions = {
    ...(typeof seekdeepImageModeOptionsFromPrompt === 'function' ? seekdeepImageModeOptionsFromPrompt(prompt) : {}),
    ...(imageModeOptions || {}),
  };
  prompt = seekdeepImageModeOptions.cleanPrompt || seekdeepCleanImageModeTokens(prompt) || prompt;
  // SEEKDEEP_RAW_IMAGE_SEND_OPTIONS_END
"""
if old_msg_options in text:
    text = text.replace(old_msg_options, new_msg_options, 1)
elif new_msg_options not in text:
    raise SystemExit("Could not patch message raw-image options block.")

text = text.replace(
    "const result = await makeImageResult(prompt, width, height, seed);",
    "const result = await makeImageResult(prompt, width, height, seed, seekdeepImageModeOptions);"
)

# 2) Preserve raw/unrefined options through the slash-image path too.
text = text.replace(
    "async function seekdeepSendImageWithButtonsInteraction(interaction, prompt, width = 1024, height = 1024, seed = null) {",
    "async function seekdeepSendImageWithButtonsInteraction(interaction, prompt, width = 1024, height = 1024, seed = null, imageModeOptions = null) {"
)

interaction_anchor = """async function seekdeepSendImageWithButtonsInteraction(interaction, prompt, width = 1024, height = 1024, seed = null, imageModeOptions = null) {
  const requestStartedAt = interaction?.__seekdeepRequestStartedAt || seekdeepNowMs();
"""
interaction_insert = """async function seekdeepSendImageWithButtonsInteraction(interaction, prompt, width = 1024, height = 1024, seed = null, imageModeOptions = null) {
  const requestStartedAt = interaction?.__seekdeepRequestStartedAt || seekdeepNowMs();

  // SEEKDEEP_RAW_IMAGE_SEND_OPTIONS_INTERACTION_START
  const seekdeepImageModeOptions = {
    ...(typeof seekdeepImageModeOptionsFromPrompt === 'function' ? seekdeepImageModeOptionsFromPrompt(prompt) : {}),
    ...(imageModeOptions || {}),
  };
  prompt = seekdeepImageModeOptions.cleanPrompt || seekdeepCleanImageModeTokens(prompt) || prompt;
  // SEEKDEEP_RAW_IMAGE_SEND_OPTIONS_INTERACTION_END
"""
if interaction_anchor in text and "SEEKDEEP_RAW_IMAGE_SEND_OPTIONS_INTERACTION_START" not in text:
    text = text.replace(interaction_anchor, interaction_insert, 1)
elif "SEEKDEEP_RAW_IMAGE_SEND_OPTIONS_INTERACTION_START" not in text:
    raise SystemExit("Could not patch interaction raw-image options block.")

slash_old = """      const seed = interaction.options.getInteger('seed');
      remember(key, 'user', `/image ${prompt}`);
      remember(key, 'assistant', `Generated image locally for: ${prompt}`);
      await seekdeepSendImageWithButtonsInteraction(interaction, prompt, width, height, seed ?? null);
"""
slash_new = """      const seed = interaction.options.getInteger('seed');
      const seekdeepImageModeOptions = typeof seekdeepImageModeOptionsFromPrompt === 'function'
        ? seekdeepImageModeOptionsFromPrompt(prompt)
        : { refine: true, ground: true, cleanPrompt: prompt };
      const cleanImagePrompt = seekdeepImageModeOptions.cleanPrompt || prompt;
      remember(key, 'user', `/image ${prompt}`);
      remember(key, 'assistant', `Generated image locally for: ${cleanImagePrompt}`);
      await seekdeepSendImageWithButtonsInteraction(interaction, cleanImagePrompt, width, height, seed ?? null, seekdeepImageModeOptions);
"""
if slash_old in text:
    text = text.replace(slash_old, slash_new, 1)
elif slash_new not in text:
    raise SystemExit("Could not patch /image interaction call path.")

# 3) Ignore placeholder reply-context blobs like GIF / emojis.
reply_placeholder_old = """    if (!replyText) return '';
    replyText = replyText.replace(/\s+/g, ' ').trim();
    return replyText;
"""
reply_placeholder_new = """    if (!replyText) return '';
    replyText = replyText.replace(/\s+/g, ' ').trim();
    if (/^(?:gif|image|photo|picture|pic|emoji|emojis|sticker|video|attachment|file)$/i.test(replyText)) return '';
    return replyText;
"""
if reply_placeholder_old in text:
    text = text.replace(reply_placeholder_old, reply_placeholder_new, 1)
elif reply_placeholder_new not in text:
    raise SystemExit("Could not patch reply-context placeholder filter.")

# 4) Force image route when reply-context was intentionally used for a generate-only message.
msg_prompt_old = """  let prompt = normalizeUserText(stripBotMentions(message.content));

  const seekdeepReplyPromptInfo = await seekdeepApplyReplyContextToPrompt(message, prompt);

  prompt = seekdeepReplyPromptInfo.prompt;
"""
msg_prompt_new = """  let prompt = normalizeUserText(stripBotMentions(message.content));
  const seekdeepPromptBeforeReplyContext = prompt;

  const seekdeepReplyPromptInfo = await seekdeepApplyReplyContextToPrompt(message, prompt);

  prompt = seekdeepReplyPromptInfo.prompt;
  const seekdeepForceImageFromReplyContext = Boolean(
    seekdeepReplyPromptInfo.usedReplyContext &&
    typeof seekdeepLooksLikeGenerateOnlyPrompt === 'function' &&
    seekdeepLooksLikeGenerateOnlyPrompt(seekdeepPromptBeforeReplyContext)
  );
"""
if msg_prompt_old in text:
    text = text.replace(msg_prompt_old, msg_prompt_new, 1)
elif "const seekdeepForceImageFromReplyContext = Boolean(" not in text:
    raise SystemExit("Could not patch reply-context force-image flag.")

route_old = "if (!seekdeepShouldKeepPromptAsChatBeforeImage(prompt) && ((typeof seekdeepIsGenericImageFollowupPrompt === 'function' && seekdeepIsGenericImageFollowupPrompt(prompt)) || (typeof seekdeepLooksLikeShortNamedVisualSubject === 'function' && seekdeepLooksLikeShortNamedVisualSubject(prompt)) || isNaturalImagePrompt(prompt))) {"
route_new = "if (seekdeepForceImageFromReplyContext || (!seekdeepShouldKeepPromptAsChatBeforeImage(prompt) && ((typeof seekdeepIsGenericImageFollowupPrompt === 'function' && seekdeepIsGenericImageFollowupPrompt(prompt)) || (typeof seekdeepLooksLikeShortNamedVisualSubject === 'function' && seekdeepLooksLikeShortNamedVisualSubject(prompt)) || isNaturalImagePrompt(prompt)))) {"
if route_old in text:
    text = text.replace(route_old, route_new, 1)
elif route_new not in text:
    raise SystemExit("Could not patch force-image route condition.")

message_image_old = """      const imagePrompt = (typeof seekdeepExtractImagePrompt === 'function' ? seekdeepExtractImagePrompt(prompt) : prompt) || prompt;
      seekdeepLogRoute('image', imagePrompt);
      remember(key, 'user', `[natural-image] ${prompt}`);
      remember(key, 'assistant', `Queued image locally for: ${imagePrompt}`);
      await seekdeepSendImageWithButtonsMessage(message, imagePrompt, 1024, 1024, null);
"""
message_image_new = """      const seekdeepMessageImageModeOptions = typeof seekdeepImageModeOptionsFromPrompt === 'function'
        ? seekdeepImageModeOptionsFromPrompt(prompt)
        : { refine: true, ground: true, cleanPrompt: prompt };
      const imagePrompt = (typeof seekdeepExtractImagePrompt === 'function' ? seekdeepExtractImagePrompt(prompt) : prompt) || seekdeepMessageImageModeOptions.cleanPrompt || prompt;
      seekdeepLogRoute('image', imagePrompt);
      remember(key, 'user', `[natural-image] ${prompt}`);
      remember(key, 'assistant', `Queued image locally for: ${imagePrompt}`);
      await seekdeepSendImageWithButtonsMessage(message, imagePrompt, 1024, 1024, null, seekdeepMessageImageModeOptions);
"""
if message_image_old in text:
    text = text.replace(message_image_old, message_image_new, 1)
elif "await seekdeepSendImageWithButtonsMessage(message, imagePrompt, 1024, 1024, null, seekdeepMessageImageModeOptions);" not in text:
    raise SystemExit("Could not patch message image dispatch call.")

if text == original:
    raise SystemExit("No changes were applied; file shape may already differ from the expected checkpoint.")

# Final validation anchors.
for needle, label in [
    ("seekdeepForceImageFromReplyContext", "reply force-image flag"),
    ("seekdeepSendImageWithButtonsMessage(message, imagePrompt, 1024, 1024, null, seekdeepMessageImageModeOptions);", "message image dispatch with options"),
    ("seekdeepSendImageWithButtonsInteraction(interaction, cleanImagePrompt, width, height, seed ?? null, seekdeepImageModeOptions);", "interaction image dispatch with options"),
    ("await makeImageResult(prompt, width, height, seed, seekdeepImageModeOptions);", "makeImageResult with options"),
    ("/^(?:gif|image|photo|picture|pic|emoji|emojis|sticker|video|attachment|file)$/i.test(replyText)", "placeholder reply filter"),
]:
    if needle not in text:
        raise SystemExit(f"Validation failed: missing {label}")

out = text if newline == "\n" else text.replace("\n", "\r\n")
path.write_bytes(out.encode("utf-8"))
print("Patched raw/unrefined carry-through, reply-context force-image routing, and placeholder reply filtering.")
'@

  $patchPyPath = Join-Path $patchesDir 'patch_raw_reply_force_image.py'
  [System.IO.File]::WriteAllText($patchPyPath, $patchPy, $utf8NoBom)

  Push-Location $projectRoot
  try {
    Write-Info 'Applying combined raw/reply force-image repair'
    & '.\.venv\Scripts\python.exe' $patchPyPath $indexPath
    if ($LASTEXITCODE -ne 0) {
      throw "Patch helper failed with exit code $LASTEXITCODE."
    }
    Write-Pass 'Applied combined raw/reply force-image repair'

    Invoke-CheckedCommand 'node --check .\index.js' {
      & node --check '.\index.js'
    }

    Invoke-CheckedCommand '.\.venv\Scripts\python.exe -m py_compile .\local_ai_server.py' {
      & '.\.venv\Scripts\python.exe' -m py_compile '.\local_ai_server.py'
    }
  } finally {
    Pop-Location
  }

  Write-Host ''
  Write-Pass 'Combined raw/reply force-image repair completed.'
  Write-Host 'Backup created:' -ForegroundColor Yellow
  Write-Host $indexBackup -ForegroundColor Yellow
  Write-Host 'Restart the Discord bot before testing.' -ForegroundColor Yellow
  Write-Host ''
  Write-Host 'Retest these exact cases:' -ForegroundColor Cyan
  Write-Host '1) @SEEKOTICS raw generate a pine tree' -ForegroundColor White
  Write-Host '   Expected: Refinement: off, no refined style suffixes added.' -ForegroundColor White
  Write-Host '2) Reply to: Nothing matrix here. Matrix is greenish. Ripto ...' -ForegroundColor White
  Write-Host '   Send: @SEEKOTICS generate' -ForegroundColor White
  Write-Host '   Expected: route=image, not route=chat.' -ForegroundColor White
  Write-Host '3) Reply to a GIF/emoji-only message with @SEEKOTICS generate' -ForegroundColor White
  Write-Host '   Expected: ask what to generate instead of using placeholder text like emojis/GIF.' -ForegroundColor White
  exit 0
} catch {
  Write-Host ''
  Write-Fail $_.Exception.Message
  Write-Host 'Backup available:' -ForegroundColor Yellow
  if ($indexBackup) { Write-Host $indexBackup -ForegroundColor Yellow }
  exit 1
}
