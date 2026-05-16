# SeekDeep / Seekotics pre-generation prompt choice buttons
#
# Phase 1 implementation:
# - Normal image requests no longer immediately enter the queue.
# - The bot prepares Original + Refined prompt choices and shows buttons:
#     Generate Refined
#     Generate Raw
#     Cancel
# - Only button clicks enter the image queue.
# - Explicit raw/unrefined requests still bypass preview and generate raw directly.
# - Object-safe wording normalization:
#     "PlayStation 2 anatomically correct"
#   becomes physically/hardware accurate instead of being misread as sexual/anatomical content.
#
# Safety:
# - Backs up index.js first.
# - Patches index.js only.
# - Preserves existing queue contract:
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
  Write-Host "[SeekDeep pregen-buttons] $Message" -ForegroundColor Cyan
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

  $indexBackup = Join-Path $backupDir "index.js.pregen-prompt-choice-buttons-$stamp.bak"
  Copy-Item -LiteralPath $indexPath -Destination $indexBackup -Force
  Write-Pass "Backed up index.js to $indexBackup"

  $utf8NoBom = [System.Text.UTF8Encoding]::new($false)

  $patchPy = @'
from pathlib import Path
import sys

if len(sys.argv) != 2:
    raise SystemExit("Usage: patch_pregen_prompt_choice_buttons.py <index.js>")

path = Path(sys.argv[1])
raw = path.read_bytes()
newline = "\r\n" if b"\r\n" in raw else "\n"
text = raw.decode("utf-8-sig").replace("\r\n", "\n").replace("\r", "\n")


def fail(msg):
    raise SystemExit(msg)


def require(needle, label):
    if needle not in text:
        fail(f"Required anchor not found: {label}")

for needle, label in [
    ("ActionRowBuilder", "discord action rows import"),
    ("ButtonBuilder", "discord button import"),
    ("ButtonStyle", "discord button style import"),
    ("function seekdeepImageActionRow", "existing image action row"),
    ("function seekdeepImageModeOptionsFromPrompt", "raw/refine mode parser"),
    ("function seekdeepExtractImagePrompt", "image prompt extractor"),
    ("async function seekdeepSendImageWithButtonsMessage", "message image sender"),
    ("async function seekdeepSendImageWithButtonsInteraction", "interaction image sender"),
    ("async function makeImageResult", "image result generator"),
    ("client.on('interactionCreate'", "interaction handler"),
    ("client.on('messageCreate'", "message handler"),
    ("seekdeepEnqueueImageJob(job, runner)", "queue contract"),
]:
    require(needle, label)

if "seekdeepMakeImageQueueJobId" in text:
    fail("Unsafe old queue helper found: seekdeepMakeImageQueueJobId")
if "job.run" in text:
    fail("Unsafe job.run-style queue logic found")

# ----------------------------------------------------------------------
# 1. Object-safe wording normalization.
# ----------------------------------------------------------------------
if "function seekdeepNormalizeObjectAccuracyPrompt" not in text:
    insert = r"""
function seekdeepNormalizeObjectAccuracyPrompt(prompt = '') {
  let out = normalizeUserText(prompt).trim();
  if (!out) return out;

  const lower = out.toLowerCase();
  const objectOrDevice = /\b(playstation|ps1|ps2|ps3|ps4|ps5|xbox|nintendo|gamecube|dreamcast|console|controller|laptop|computer|pc|phone|camera|car|truck|vehicle|tower|castle|cathedral|building|hardware|device|machine|robot|logo|emblem|bag|item|object|prop)\b/i.test(lower);
  const livingSubject = /\b(person|human|man|woman|girl|boy|body|face|portrait|hands|eyes|cat|dog|animal|creature|dragon|monster|toad|frog|pepe|ripto|spyro|sailor\s*moon|homer|simpson)\b/i.test(lower);

  if (objectOrDevice && !livingSubject) {
    out = out
      .replace(/\banatomically\s+correct\b/gi, 'physically accurate, correct proportions')
      .replace(/\banatomical\s+accuracy\b/gi, 'physical accuracy, correct proportions')
      .replace(/\banatomy\b/gi, 'physical structure')
      .replace(/\baccurate anatomy\b/gi, 'accurate physical structure');
  }

  return out.replace(/\s+/g, ' ').trim();
}

"""
    anchor = "function seekdeepImageModeOptionsFromPrompt(prompt = '') {"
    pos = text.find(anchor)
    if pos < 0:
        fail("Could not locate image mode options function for object normalization insertion.")
    text = text[:pos] + insert + text[pos:]

old = "    cleanPrompt: seekdeepCleanImageModeTokens(prompt),"
new = "    cleanPrompt: seekdeepNormalizeObjectAccuracyPrompt(seekdeepCleanImageModeTokens(prompt)),"
if old in text:
    text = text.replace(old, new, 1)

if "SEEKDEEP_OBJECT_ACCURACY_EXTRACT_NORMALIZE" not in text:
    old = """  t = t.replace(/\\s+/g, ' ').trim();

  return t;
}"""
    new = """  t = t.replace(/\\s+/g, ' ').trim();
  // SEEKDEEP_OBJECT_ACCURACY_EXTRACT_NORMALIZE
  t = seekdeepNormalizeObjectAccuracyPrompt(t);

  return t;
}"""
    if old not in text:
        fail("Could not patch seekdeepExtractImagePrompt final normalization.")
    text = text.replace(old, new, 1)

# ----------------------------------------------------------------------
# 2. Pre-generation prompt choice helpers.
# ----------------------------------------------------------------------
helpers = r"""

// SEEKDEEP_PREGEN_PROMPT_CHOICE_START
const SEEKDEEP_PENDING_IMAGE_PROMPTS = globalThis.__seekdeepPendingImagePrompts || new Map();
globalThis.__seekdeepPendingImagePrompts = SEEKDEEP_PENDING_IMAGE_PROMPTS;
const SEEKDEEP_PENDING_IMAGE_PROMPT_TTL_MS = Number(process.env.SEEKDEEP_PENDING_IMAGE_PROMPT_TTL_MS || 2 * 60 * 1000);

function seekdeepSweepPendingImagePrompts() {
  const now = Date.now();
  for (const [id, state] of SEEKDEEP_PENDING_IMAGE_PROMPTS.entries()) {
    if (!state || Number(state.expiresAt || 0) <= now) SEEKDEEP_PENDING_IMAGE_PROMPTS.delete(id);
  }
}

function seekdeepNewPendingImagePromptId() {
  seekdeepSweepPendingImagePrompts();
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function seekdeepPendingPromptChoiceRow(id, disabled = false) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`seekdeep:prompt:refined:${id}`)
      .setLabel('Generate Refined')
      .setStyle(ButtonStyle.Primary)
      .setDisabled(disabled),
    new ButtonBuilder()
      .setCustomId(`seekdeep:prompt:raw:${id}`)
      .setLabel('Generate Raw')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(disabled),
    new ButtonBuilder()
      .setCustomId(`seekdeep:prompt:cancel:${id}`)
      .setLabel('Cancel')
      .setStyle(ButtonStyle.Danger)
      .setDisabled(disabled),
  );
}

function seekdeepShouldUsePromptChoicePreview(imageModeOptions = {}) {
  if (/^(0|false|off|no)$/i.test(String(process.env.SEEKDEEP_PREGEN_PROMPT_CHOICE || 'true'))) return false;

  // Explicit raw/unrefined requests should still immediately generate raw.
  // The preview system is for normal image requests where the user has not already chosen.
  if (imageModeOptions?.rawRequested || imageModeOptions?.refine === false) return false;

  return true;
}

async function seekdeepBuildImagePromptChoice(prompt = '', imageModeOptions = {}) {
  const options = {
    ...(typeof seekdeepImageModeOptionsFromPrompt === 'function' ? seekdeepImageModeOptionsFromPrompt(prompt) : {}),
    ...(imageModeOptions || {}),
  };

  const originalPrompt = seekdeepNormalizeObjectAccuracyPrompt(
    normalizeUserText(options.cleanPrompt || seekdeepCleanImageModeTokens(prompt) || prompt).trim() || 'image'
  );

  const ground = options.ground !== false;
  const grounded = ground && typeof seekdeepMaybeGroundImagePrompt === 'function'
    ? await seekdeepMaybeGroundImagePrompt(originalPrompt)
    : { prompt: originalPrompt, grounded: false, searchQuery: '' };

  const prepared = typeof seekdeepPrepareImagePrompt === 'function'
    ? seekdeepPrepareImagePrompt(grounded.prompt || originalPrompt)
    : { originalPrompt, refinedPrompt: grounded.prompt || originalPrompt, generationPrompt: grounded.prompt || originalPrompt, changed: false };

  const sanitized = typeof seekdeepSanitizeObjectImagePromptInfo === 'function'
    ? seekdeepSanitizeObjectImagePromptInfo(prepared)
    : prepared;

  return {
    originalPrompt,
    rawPrompt: originalPrompt,
    refinedPrompt: sanitized.generationPrompt || sanitized.refinedPrompt || grounded.prompt || originalPrompt,
    displayRefinedPrompt: sanitized.refinedPrompt || sanitized.generationPrompt || grounded.prompt || originalPrompt,
    grounding: grounded,
    imageOptions: options,
  };
}

function seekdeepPromptChoiceContent(choice, requesterId = '') {
  const groundingLine = choice?.grounding?.grounded ? 'Grounding: on' : 'Grounding: off';
  const requesterLine = requesterId ? `Requester: <@${requesterId}>` : '';

  return [
    'Image prompt prepared. Choose a version before queueing.',
    requesterLine,
    '',
    `Original Prompt: ${seekdeepClipForDiscord(choice.originalPrompt, 650)}`,
    `Refined Prompt: ${seekdeepClipForDiscord(choice.displayRefinedPrompt, 900)}`,
    groundingLine,
    '',
    'No image has been queued yet.',
  ].filter(Boolean).join('\n');
}

function seekdeepRememberPendingImagePrompt(state) {
  const id = seekdeepNewPendingImagePromptId();

  SEEKDEEP_PENDING_IMAGE_PROMPTS.set(id, {
    ...state,
    id,
    createdAt: Date.now(),
    expiresAt: Date.now() + SEEKDEEP_PENDING_IMAGE_PROMPT_TTL_MS,
  });

  return id;
}

async function seekdeepSendImagePromptChoiceMessage(message, prompt, width = 1024, height = 1024, seed = null, imageModeOptions = {}) {
  const startedAt = seekdeepNowMs();
  const requesterId = message?.author?.id || 'unknown';
  const choice = await seekdeepBuildImagePromptChoice(prompt, imageModeOptions);
  const id = seekdeepRememberPendingImagePrompt({
    source: 'message',
    requesterId,
    channelId: message?.channel?.id || '',
    originalPrompt: choice.originalPrompt,
    rawPrompt: choice.rawPrompt,
    refinedPrompt: choice.refinedPrompt,
    width,
    height,
    seed,
    ground: choice.imageOptions?.ground !== false,
  });

  return await message.reply({
    content: seekdeepAppendResponseFooter(seekdeepPromptChoiceContent(choice, requesterId), {
      startedAt,
      modelUsed: seekdeepNoModelLabel(),
    }),
    components: [seekdeepPendingPromptChoiceRow(id)],
    allowedMentions: { repliedUser: false },
  });
}

async function seekdeepSendImagePromptChoiceInteraction(interaction, prompt, width = 1024, height = 1024, seed = null, imageModeOptions = {}) {
  const startedAt = interaction?.__seekdeepRequestStartedAt || seekdeepNowMs();
  const requesterId = interaction?.user?.id || 'unknown';
  const choice = await seekdeepBuildImagePromptChoice(prompt, imageModeOptions);
  const id = seekdeepRememberPendingImagePrompt({
    source: 'interaction',
    requesterId,
    channelId: interaction?.channel?.id || '',
    originalPrompt: choice.originalPrompt,
    rawPrompt: choice.rawPrompt,
    refinedPrompt: choice.refinedPrompt,
    width,
    height,
    seed,
    ground: choice.imageOptions?.ground !== false,
  });

  return await safeEditOrReply(interaction, {
    content: seekdeepAppendResponseFooter(seekdeepPromptChoiceContent(choice, requesterId), {
      startedAt,
      modelUsed: seekdeepNoModelLabel(),
    }),
    components: [seekdeepPendingPromptChoiceRow(id)],
    allowedMentions: { repliedUser: false },
  });
}

async function seekdeepHandlePromptChoiceButton(interaction) {
  const customId = String(interaction?.customId || '');
  const match = customId.match(/^seekdeep:prompt:(refined|raw|cancel):(.+)$/);
  if (!match) return false;

  const action = match[1];
  const id = match[2];
  seekdeepSweepPendingImagePrompts();
  const state = SEEKDEEP_PENDING_IMAGE_PROMPTS.get(id) || null;
  const startedAt = seekdeepNowMs();

  if (!state) {
    await interaction.reply({
      content: seekdeepAppendResponseFooter('That prompt choice expired. Run the image request again.', {
        startedAt,
        modelUsed: seekdeepNoModelLabel(),
      }),
      ephemeral: true,
    });
    return true;
  }

  if (state.requesterId && interaction?.user?.id !== state.requesterId) {
    await interaction.reply({
      content: 'Only the requester can use these image prompt buttons.',
      ephemeral: true,
    });
    return true;
  }

  if (action === 'cancel') {
    SEEKDEEP_PENDING_IMAGE_PROMPTS.delete(id);
    await interaction.update({
      content: seekdeepAppendResponseFooter('Image prompt choice cancelled.', {
        startedAt,
        modelUsed: seekdeepNoModelLabel(),
      }),
      components: [],
    });
    return true;
  }

  SEEKDEEP_PENDING_IMAGE_PROMPTS.delete(id);

  try {
    if (interaction?.message && typeof interaction.message.edit === 'function') {
      await interaction.message.edit({ components: [seekdeepPendingPromptChoiceRow(id, true)] }).catch(() => null);
    }
  } catch {}

  await interaction.deferReply();

  const selectedPrompt = action === 'raw' ? state.rawPrompt : state.originalPrompt;
  const selectedOptions = action === 'raw'
    ? { refine: false, ground: false, cleanPrompt: state.rawPrompt, rawRequested: true }
    : { refine: true, ground: state.ground !== false, cleanPrompt: state.originalPrompt };

  if (typeof seekdeepLogRoute === 'function') {
    seekdeepLogRoute(action === 'raw' ? 'image-choice-raw' : 'image-choice-refined', selectedPrompt);
  }

  return await seekdeepSendImageWithButtonsInteraction(
    interaction,
    selectedPrompt,
    state.width || 1024,
    state.height || 1024,
    state.seed ?? null,
    selectedOptions,
  );
}
// SEEKDEEP_PREGEN_PROMPT_CHOICE_END
"""

if "SEEKDEEP_PREGEN_PROMPT_CHOICE_START" not in text:
    anchor = "\n\nfunction seekdeepAttachmentDownloadUrl(sentMessage)"
    if anchor not in text:
        fail("Could not locate image action helper insertion point.")
    text = text.replace(anchor, helpers + anchor, 1)

# ----------------------------------------------------------------------
# 3. Route prompt choice buttons before regular image buttons.
# ----------------------------------------------------------------------
interaction_start = text.find("client.on('interactionCreate'")
if interaction_start < 0:
    fail("Could not find interactionCreate handler")
if "seekdeepHandlePromptChoiceButton(interaction)" not in text[interaction_start:interaction_start + 900]:
    old = """  if (interaction.isButton && interaction.isButton()) {
    try {
      if (await seekdeepHandleImageButton(interaction)) return;
"""
    new = """  if (interaction.isButton && interaction.isButton()) {
    try {
      if (await seekdeepHandlePromptChoiceButton(interaction)) return;
      if (await seekdeepHandleImageButton(interaction)) return;
"""
    if old not in text:
        fail("Could not patch interaction button handler.")
    text = text.replace(old, new, 1)

# ----------------------------------------------------------------------
# 4. Message image route: preview first unless raw/unrefined was explicit.
# ----------------------------------------------------------------------
old = """      seekdeepLogRoute('image', imagePrompt);
      remember(key, 'user', `[natural-image] ${prompt}`);
      remember(key, 'assistant', `Queued image locally for: ${imagePrompt}`);
      await seekdeepSendImageWithButtonsMessage(message, imagePrompt, 1024, 1024, null, seekdeepMessageImageModeOptions);
      return;
"""
new = """      seekdeepLogRoute('image', imagePrompt);
      remember(key, 'user', `[natural-image] ${prompt}`);
      if (seekdeepShouldUsePromptChoicePreview(seekdeepMessageImageModeOptions)) {
        remember(key, 'assistant', `Prepared image prompt choices for: ${imagePrompt}`);
        await seekdeepSendImagePromptChoiceMessage(message, imagePrompt, 1024, 1024, null, seekdeepMessageImageModeOptions);
      } else {
        remember(key, 'assistant', `Queued image locally for: ${imagePrompt}`);
        await seekdeepSendImageWithButtonsMessage(message, imagePrompt, 1024, 1024, null, seekdeepMessageImageModeOptions);
      }
      return;
"""
if old in text:
    text = text.replace(old, new, 1)
elif "seekdeepSendImagePromptChoiceMessage(message, imagePrompt" not in text:
    fail("Could not patch message image route for prompt choice preview.")

# ----------------------------------------------------------------------
# 5. Slash /image route: preview first unless raw/unrefined was explicit.
# ----------------------------------------------------------------------
old = """      const seed = interaction.options.getInteger('seed');
      const seekdeepImageModeOptions = typeof seekdeepImageModeOptionsFromPrompt === 'function'
        ? seekdeepImageModeOptionsFromPrompt(prompt)
        : { refine: true, ground: true, cleanPrompt: prompt };
      const cleanImagePrompt = seekdeepImageModeOptions.cleanPrompt || prompt;
      remember(key, 'user', `/image ${prompt}`);
      remember(key, 'assistant', `Generated image locally for: ${cleanImagePrompt}`);
      await seekdeepSendImageWithButtonsInteraction(interaction, cleanImagePrompt, width, height, seed ?? null, seekdeepImageModeOptions);
      return;
"""
new = """      const seed = interaction.options.getInteger('seed');
      const seekdeepImageModeOptions = typeof seekdeepImageModeOptionsFromPrompt === 'function'
        ? seekdeepImageModeOptionsFromPrompt(prompt)
        : { refine: true, ground: true, cleanPrompt: prompt };
      const cleanImagePrompt = seekdeepImageModeOptions.cleanPrompt || prompt;
      remember(key, 'user', `/image ${prompt}`);
      if (seekdeepShouldUsePromptChoicePreview(seekdeepImageModeOptions)) {
        remember(key, 'assistant', `Prepared image prompt choices for: ${cleanImagePrompt}`);
        await seekdeepSendImagePromptChoiceInteraction(interaction, cleanImagePrompt, width, height, seed ?? null, seekdeepImageModeOptions);
      } else {
        remember(key, 'assistant', `Generated image locally for: ${cleanImagePrompt}`);
        await seekdeepSendImageWithButtonsInteraction(interaction, cleanImagePrompt, width, height, seed ?? null, seekdeepImageModeOptions);
      }
      return;
"""
if old in text:
    text = text.replace(old, new, 1)
elif "seekdeepSendImagePromptChoiceInteraction(interaction, cleanImagePrompt" not in text:
    fail("Could not patch slash image route for prompt choice preview.")

# ----------------------------------------------------------------------
# 6. Validation.
# ----------------------------------------------------------------------
for needle, label in [
    ("function seekdeepNormalizeObjectAccuracyPrompt", "object-safe accuracy normalization"),
    ("SEEKDEEP_OBJECT_ACCURACY_EXTRACT_NORMALIZE", "extract object accuracy normalization hook"),
    ("SEEKDEEP_PREGEN_PROMPT_CHOICE_START", "pre-generation prompt choice helpers"),
    ("function seekdeepShouldUsePromptChoicePreview", "prompt choice mode gate"),
    ("async function seekdeepHandlePromptChoiceButton", "prompt choice button handler"),
    ("seekdeepHandlePromptChoiceButton(interaction)", "interaction handler routes prompt choice buttons"),
    ("await seekdeepSendImagePromptChoiceMessage(message, imagePrompt", "message route prompt preview"),
    ("await seekdeepSendImagePromptChoiceInteraction(interaction, cleanImagePrompt", "slash route prompt preview"),
    ("seekdeepEnqueueImageJob(job, runner)", "queue contract preserved"),
]:
    require(needle, label)

for fn_name in ("seekdeepSendImageWithButtonsMessage", "seekdeepSendImageWithButtonsInteraction"):
    fn_start = text.find(f"async function {fn_name}")
    if fn_start < 0:
        fail(f"Missing {fn_name}")
    fn_next = text.find("\nasync function ", fn_start + 1)
    if fn_next < 0:
        fn_next = min(len(text), fn_start + 12000)
    fn = text[fn_start:fn_next]
    if "makeImageResult(prompt, width, height, seed, seekdeepImageModeOptions)" not in fn:
        fail(f"{fn_name} no longer passes seekdeepImageModeOptions to makeImageResult")

out = text if newline == "\n" else text.replace("\n", "\r\n")
path.write_bytes(out.encode("utf-8"))
print("Patched pre-generation prompt choice buttons and object-safe accuracy normalization.")
'@

  $patchPyPath = Join-Path $patchesDir "patch_pregen_prompt_choice_buttons.py"
  [System.IO.File]::WriteAllText($patchPyPath, $patchPy, $utf8NoBom)

  Push-Location $projectRoot
  try {
    Write-Info "Applying pre-generation prompt choice button patch"
    & ".\.venv\Scripts\python.exe" $patchPyPath $indexPath
    if ($LASTEXITCODE -ne 0) {
      throw "Patch helper failed with exit code $LASTEXITCODE."
    }
    Write-Pass "Applied pre-generation prompt choice button patch"

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
  Write-Pass "Pre-generation prompt choice button patch completed."
  Write-Host "Backup created: $indexBackup" -ForegroundColor Yellow
  Write-Host "Restart the Discord bot before testing." -ForegroundColor Yellow
  Write-Host ""
  Write-Host "Retest:" -ForegroundColor Cyan
  Write-Host "1) @SEEKOTICS generate a PlayStation 2 anatomically correct" -ForegroundColor White
  Write-Host "   Expected: prompt preview with Generate Refined / Generate Raw / Cancel; no image queued yet." -ForegroundColor White
  Write-Host ""
  Write-Host "2) Click Generate Refined" -ForegroundColor White
  Write-Host "   Expected: image queues and generates with refinement on." -ForegroundColor White
  Write-Host ""
  Write-Host "3) @SEEKOTICS raw generate a PlayStation 2 anatomically correct" -ForegroundColor White
  Write-Host "   Expected: immediate image queue, Refinement: off." -ForegroundColor White
  Write-Host ""
  Write-Host "4) @SEEKOTICS generate a pine tree" -ForegroundColor White
  Write-Host "   Expected: prompt preview; clicking Generate Raw gives Refinement: off." -ForegroundColor White
  exit 0
} catch {
  Write-Host ""
  Write-Fail $_.Exception.Message
  Write-Host "Backup available:" -ForegroundColor Yellow
  if ($indexBackup) { Write-Host $indexBackup -ForegroundColor Yellow }
  exit 1
}
