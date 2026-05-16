# SeekDeep / Seekotics prompt-choice multi-select repair
#
# Fixes the current prompt-choice UX regression:
# - Buttons no longer vanish after the first valid click.
# - A requester can click Original, then Refined later from the same prompt preview.
# - Both queues whichever versions have not already been queued.
# - Once both versions are queued, buttons are removed.
# - Re-clicking an already queued version does not queue duplicates.
# - Prompt-choice image jobs skip the normal cooldown because the prompt chooser itself is the gate.
# - "Only requester can use these buttons" stays enforced.
# - Expired prompt choices still remove buttons and avoid spam.
#
# Files patched:
# - index.js
#
# Safety:
# - Backs up index.js first
# - Patches only index.js
# - Runs node --check and Python compile check

$ErrorActionPreference = "Stop"

try {
  [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
} catch {}

function Write-Info {
  param([string]$Message)
  Write-Host "[SeekDeep prompt-choice-multiselect] $Message" -ForegroundColor Cyan
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

  $indexBackup = Join-Path $backupDir "index.js.prompt-choice-multiselect-$stamp.bak"
  Copy-Item -LiteralPath $indexPath -Destination $indexBackup -Force
  Write-Pass "Backed up index.js to $indexBackup"

  $utf8NoBom = [System.Text.UTF8Encoding]::new($false)

  $patchPy = @'
from pathlib import Path
import re
import sys

if len(sys.argv) != 2:
    raise SystemExit("Usage: patch_prompt_choice_multiselect.py <index.js>")

path = Path(sys.argv[1])
raw = path.read_bytes()
newline = "\r\n" if b"\r\n" in raw else "\n"
text = raw.decode("utf-8-sig").replace("\r\n", "\n").replace("\r", "\n")

def fail(msg):
    raise SystemExit(msg)

def require(needle, label):
    if needle not in text:
        fail(f"Required anchor not found: {label}")

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
                i += 1
                continue
            if not escaped and ch == "'":
                in_single = False
            escaped = False
            i += 1
            continue

        if in_double:
            if not escaped and ch == "\\":
                escaped = True
                i += 1
                continue
            if not escaped and ch == '"':
                in_double = False
            escaped = False
            i += 1
            continue

        if in_template:
            if not escaped and ch == "\\":
                escaped = True
                i += 1
                continue
            if not escaped and ch == "`":
                in_template = False
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

def replace_named_function(source, signature, new_block):
    start = source.find(signature)
    if start < 0:
        fail(f"Could not locate function: {signature}")
    brace_open = source.find("{", start)
    if brace_open < 0:
        fail(f"Could not locate opening brace for: {signature}")
    brace_close = find_matching_brace(source, brace_open)
    return source[:start] + new_block.rstrip() + source[brace_close + 1:]

def get_named_function(source, signature):
    start = source.find(signature)
    if start < 0:
        fail(f"Could not locate function: {signature}")
    brace_open = source.find("{", start)
    if brace_open < 0:
        fail(f"Could not locate opening brace for: {signature}")
    brace_close = find_matching_brace(source, brace_open)
    return source[start:brace_close + 1], start, brace_close + 1

for needle, label in [
    ("function seekdeepPendingPromptChoiceRow", "prompt-choice row"),
    ("async function seekdeepHandlePromptChoiceButton", "prompt-choice handler"),
    ("async function seekdeepSendImageWithButtonsMessage", "message image sender"),
    ("function seekdeepRememberPendingImagePrompt", "pending prompt state"),
    ("seekdeepEnqueueImageJob(job, runner)", "image queue contract"),
]:
    require(needle, label)

# ----------------------------------------------------------------------
# 1. Prompt row supports partially disabled buttons.
# ----------------------------------------------------------------------
new_row = r"""function seekdeepPendingPromptChoiceRow(id, disabledOrState = false) {
  const state = typeof disabledOrState === 'object' && disabledOrState
    ? disabledOrState
    : { disabled: Boolean(disabledOrState) };

  const allDisabled = Boolean(state.disabled);
  const originalDone = Boolean(state.originalQueued || state.original || state.selectedOriginal);
  const refinedDone = Boolean(state.refinedQueued || state.refined || state.selectedRefined);
  const bothDone = originalDone && refinedDone;

  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`seekdeep:prompt:original:${id}`)
      .setLabel(originalDone ? 'Original Queued' : 'Original')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(allDisabled || originalDone),
    new ButtonBuilder()
      .setCustomId(`seekdeep:prompt:refined:${id}`)
      .setLabel(refinedDone ? 'Refined Queued' : 'Refined')
      .setStyle(ButtonStyle.Primary)
      .setDisabled(allDisabled || refinedDone),
    new ButtonBuilder()
      .setCustomId(`seekdeep:prompt:both:${id}`)
      .setLabel(bothDone ? 'Both Queued' : 'Both')
      .setStyle(ButtonStyle.Success)
      .setDisabled(allDisabled || bothDone),
  );
}"""
text = replace_named_function(text, "function seekdeepPendingPromptChoiceRow(id", new_row)

# ----------------------------------------------------------------------
# 2. Proxy helper if missing.
# ----------------------------------------------------------------------
if "function seekdeepPromptChoiceProxyMessage(" not in text:
    _, _, insert_at = get_named_function(text, "function seekdeepRememberPendingImagePrompt(state)")
    helper = r"""

function seekdeepPromptChoiceProxyMessage(interaction, requesterId = '', suffix = '') {
  const fallbackId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const baseId = interaction?.message?.id || interaction?.id || 'prompt-choice';
  const uniqueId = suffix ? `${baseId}:${suffix}:${fallbackId}` : `${baseId}:${fallbackId}`;

  return {
    author: { id: requesterId || interaction?.user?.id || 'unknown' },
    channel: interaction?.channel || null,
    id: uniqueId,
    reply: async (payload) => {
      if (interaction?.channel && typeof interaction.channel.send === 'function') {
        return await interaction.channel.send(payload);
      }
      return null;
    },
  };
}
"""
    text = text[:insert_at] + helper + text[insert_at:]

# ----------------------------------------------------------------------
# 3. Ensure image sender understands skipCooldown.
# ----------------------------------------------------------------------
def patch_sender_skip_cooldown(source, signature):
    fn, start, end = get_named_function(source, signature)

    if "const seekdeepSkipImageCooldown = Boolean(seekdeepImageModeOptions.skipCooldown);" not in fn:
        old = "  prompt = seekdeepImageModeOptions.cleanPrompt || seekdeepCleanImageModeTokens(prompt) || prompt;\n"
        new = "  prompt = seekdeepImageModeOptions.cleanPrompt || seekdeepCleanImageModeTokens(prompt) || prompt;\n  const seekdeepSkipImageCooldown = Boolean(seekdeepImageModeOptions.skipCooldown);\n"
        if old not in fn:
            fail(f"Could not insert skipCooldown into {signature}")
        fn = fn.replace(old, new, 1)

    if "if (!seekdeepSkipImageCooldown && cooldown > 0) {" not in fn:
        if "  if (cooldown > 0) {" not in fn:
            fail(f"Could not patch cooldown gate in {signature}")
        fn = fn.replace("  if (cooldown > 0) {", "  if (!seekdeepSkipImageCooldown && cooldown > 0) {", 1)

    if "if (!seekdeepSkipImageCooldown) seekdeepRememberImageCooldown(userId);" not in fn:
        if "  seekdeepRememberImageCooldown(userId);" not in fn:
            fail(f"Could not patch cooldown remember in {signature}")
        fn = fn.replace("  seekdeepRememberImageCooldown(userId);", "  if (!seekdeepSkipImageCooldown) seekdeepRememberImageCooldown(userId);", 1)

    return source[:start] + fn + source[end:]

text = patch_sender_skip_cooldown(
    text,
    "async function seekdeepSendImageWithButtonsMessage(message, prompt, width = 1024, height = 1024, seed = null, imageModeOptions = null)"
)

# ----------------------------------------------------------------------
# 4. Replace handler with multi-select behavior.
# ----------------------------------------------------------------------
new_handler = r"""async function seekdeepHandlePromptChoiceButton(interaction) {
  const customId = String(interaction?.customId || '');
  const match = customId.match(/^seekdeep:prompt:(original|refined|both):(.+)$/);
  if (!match) return false;

  const action = match[1];
  const id = match[2];
  seekdeepSweepPendingImagePrompts();
  const state = SEEKDEEP_PENDING_IMAGE_PROMPTS.get(id) || null;
  const startedAt = seekdeepNowMs();

  if (!state) {
    const expiredText = [
      'Prompt choice expired before a version was selected.',
      'Run the image request again to reopen Original / Refined / Both.',
    ].join('\n');

    try {
      await interaction.update({
        content: seekdeepAppendResponseFooter(expiredText, {
          startedAt,
          modelUsed: seekdeepNoModelLabel(),
        }),
        components: [],
      });
    } catch (err) {
      try {
        if (!interaction?.replied && !interaction?.deferred) {
          await interaction.reply({
            content: seekdeepAppendResponseFooter(expiredText, {
              startedAt,
              modelUsed: seekdeepNoModelLabel(),
            }),
            ephemeral: true,
          });
        }
      } catch {}
    }

    return true;
  }

  if (state.requesterId && interaction?.user?.id !== state.requesterId) {
    await interaction.reply({
      content: 'Only the requester can use these image prompt buttons.',
      ephemeral: true,
    });
    return true;
  }

  const basePrompt = state.originalPrompt || state.rawPrompt || 'image';
  const width = state.width || 1024;
  const height = state.height || 1024;
  const seed = state.seed ?? null;
  const groundingOn = state.ground !== false;
  const groundingLine = groundingOn ? 'Grounding: on' : 'Grounding: off';

  const needsOriginal = (action === 'original' || action === 'both') && !state.originalQueued;
  const needsRefined = (action === 'refined' || action === 'both') && !state.refinedQueued;

  if (!needsOriginal && !needsRefined) {
    await interaction.reply({
      content: 'That version has already been queued for this prompt.',
      ephemeral: true,
    });
    return true;
  }

  state.originalQueued = Boolean(state.originalQueued || needsOriginal);
  state.refinedQueued = Boolean(state.refinedQueued || needsRefined);
  state.lastSelectedAt = Date.now();
  SEEKDEEP_PENDING_IMAGE_PROMPTS.set(id, state);

  const queuedLines = [];
  if (needsOriginal) queuedLines.push('Original prompt');
  if (needsRefined) queuedLines.push('Refined prompt');

  const allQueued = Boolean(state.originalQueued && state.refinedQueued);
  const selectionSummary = [
    needsOriginal && needsRefined ? 'Queued both prompt versions.' : needsOriginal ? 'Queued original prompt.' : 'Queued refined prompt.',
    '',
    groundingLine,
    needsOriginal && !needsRefined ? 'Refinement: off' : '',
    needsRefined && !needsOriginal ? 'Refinement: on' : '',
    `Queued Jobs: ${queuedLines.length}`,
    queuedLines.length ? 'Versions queued now:' : '',
    ...queuedLines.map((line, i) => `${i + 1}. ${line}`),
    '',
    allQueued ? 'Both versions have now been queued.' : 'You can still choose the remaining version from this prompt.',
  ].filter(Boolean).join('\n');

  if (allQueued) {
    SEEKDEEP_PENDING_IMAGE_PROMPTS.delete(id);
  }

  try {
    await interaction.update({
      content: seekdeepAppendResponseFooter(selectionSummary, {
        startedAt,
        modelUsed: seekdeepNoModelLabel(),
      }),
      components: allQueued ? [] : [seekdeepPendingPromptChoiceRow(id, state)],
    });
  } catch (err) {
    try {
      await interaction.reply({
        content: seekdeepAppendResponseFooter(selectionSummary, {
          startedAt,
          modelUsed: seekdeepNoModelLabel(),
        }),
        ephemeral: true,
      });
    } catch {}
  }

  const runQueuedSelection = async (messageProxy, selectionPrompt, selectionOptions, routeName) => {
    try {
      if (typeof seekdeepLogRoute === 'function') {
        seekdeepLogRoute(routeName, selectionPrompt);
      }

      await seekdeepSendImageWithButtonsMessage(
        messageProxy,
        selectionPrompt,
        width,
        height,
        seed,
        selectionOptions,
      );
    } catch (err) {
      console.warn(`Prompt choice generation failed (${routeName}):`, err?.message || err);
    }
  };

  if (needsOriginal) {
    const originalProxy = seekdeepPromptChoiceProxyMessage(interaction, state.requesterId, 'original');
    void runQueuedSelection(
      originalProxy,
      basePrompt,
      {
        refine: false,
        ground: groundingOn,
        cleanPrompt: basePrompt,
        skipCooldown: true,
      },
      'image-choice-original'
    );
  }

  if (needsRefined) {
    const refinedProxy = seekdeepPromptChoiceProxyMessage(interaction, state.requesterId, 'refined');
    void runQueuedSelection(
      refinedProxy,
      basePrompt,
      {
        refine: true,
        ground: groundingOn,
        cleanPrompt: basePrompt,
        skipCooldown: true,
      },
      'image-choice-refined'
    );
  }

  return true;
}"""
text = replace_named_function(text, "async function seekdeepHandlePromptChoiceButton(interaction)", new_handler)

# Text cleanup from previous UX.
text = text.replace("Choose a version before queueing.", "Choose Original, Refined, or Both before queueing.")
text = text.replace("Generate Raw", "Original")
text = text.replace("Generate Refined", "Refined")

# Validate.
for needle, label in [
    ("setLabel(originalDone ? 'Original Queued' : 'Original')", "partial Original button state"),
    ("setLabel(refinedDone ? 'Refined Queued' : 'Refined')", "partial Refined button state"),
    ("setLabel(bothDone ? 'Both Queued' : 'Both')", "partial Both button state"),
    ("You can still choose the remaining version from this prompt.", "remaining choice summary"),
    ("Both versions have now been queued.", "completed choice summary"),
    ("skipCooldown: true", "prompt-choice jobs skip cooldown"),
    ("components: allQueued ? [] : [seekdeepPendingPromptChoiceRow(id, state)]", "keep buttons only while useful"),
    ("seekdeepEnqueueImageJob(job, runner)", "queue contract"),
]:
    require(needle, label)

if "setLabel('Cancel')" in text or "seekdeep:prompt:cancel" in text:
    fail("Cancel still exists.")
if "Generate Raw" in text or "Generate Refined" in text:
    fail("Old Generate labels still exist.")

out = text if newline == "\n" else text.replace("\n", "\r\n")
path.write_bytes(out.encode("utf-8"))
print("Patched prompt-choice multi-select UX.")
'@

  $patchPyPath = Join-Path $patchesDir "patch_prompt_choice_multiselect.py"
  [System.IO.File]::WriteAllText($patchPyPath, $patchPy, $utf8NoBom)

  Push-Location $projectRoot
  try {
    Write-Info "Applying prompt-choice multi-select repair"
    & ".\.venv\Scripts\python.exe" $patchPyPath $indexPath
    if ($LASTEXITCODE -ne 0) {
      throw "Patch helper failed with exit code $LASTEXITCODE."
    }
    Write-Pass "Applied prompt-choice multi-select repair"

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
  Write-Pass "Prompt-choice multi-select repair completed."
  Write-Host "Backup created: $indexBackup" -ForegroundColor Yellow
  Write-Host "Restart the Discord bot before testing." -ForegroundColor Yellow
  Write-Host ""
  Write-Host "Retest:" -ForegroundColor Cyan
  Write-Host "1) @SEEKOTICS generate tiger roaring" -ForegroundColor White
  Write-Host "2) Click Original. Expected: Original queues, Refined/Both remain available." -ForegroundColor White
  Write-Host "3) Click Refined on the same prompt. Expected: Refined queues, buttons disappear because both are done." -ForegroundColor White
  Write-Host "4) Fresh prompt, click Both. Expected: original + refined both queue, no cooldown error." -ForegroundColor White
  Write-Host "5) Let prompt expire and click. Expected: preview edits to expired text and buttons vanish." -ForegroundColor White
  exit 0
} catch {
  Write-Host ""
  Write-Fail $_.Exception.Message
  Write-Host "Backup available:" -ForegroundColor Yellow
  if ($indexBackup) { Write-Host $indexBackup -ForegroundColor Yellow }
  exit 1
}
