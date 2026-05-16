# SeekDeep / Seekotics prompt-choice UX repair
#
# Fixes:
# - Removes Cancel from image prompt preview buttons
# - Replaces "Generate Raw" with "Original"
# - Replaces "Generate Refined" with "Refined"
# - Adds "Both"
# - After a button is clicked, the preview buttons vanish instead of staying lit/clickable
# - Expired choices edit the original preview message and remove buttons when possible
# - Avoids ephemeral expired-message spam when possible
# - Both queues two images:
#     1. Original / unrefined
#     2. Refined
# - Both counts as one cooldown action; second job skips cooldown
# - Keeps raw/unrefined command behavior intact
#
# Safety:
# - Backs up index.js first
# - Patches index.js only
# - Does not touch local_ai_server.py except compile check
# - Runs:
#     node --check .\index.js
#     .\.venv\Scripts\python.exe -m py_compile .\local_ai_server.py

$ErrorActionPreference = "Stop"

try {
  [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
} catch {}

function Write-Info {
  param([string]$Message)
  Write-Host "[SeekDeep prompt-choice-ux-repair] $Message" -ForegroundColor Cyan
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

  $indexBackup = Join-Path $backupDir "index.js.prompt-choice-ux-repair-$stamp.bak"
  Copy-Item -LiteralPath $indexPath -Destination $indexBackup -Force
  Write-Pass "Backed up index.js to $indexBackup"

  $utf8NoBom = [System.Text.UTF8Encoding]::new($false)

  $patchPy = @'
from pathlib import Path
import re
import sys

if len(sys.argv) != 2:
    raise SystemExit("Usage: patch_prompt_choice_ux_repair.py <index.js>")

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
    ("async function seekdeepSendImageWithButtonsInteraction", "interaction image sender"),
    ("function seekdeepRememberPendingImagePrompt", "pending prompt storage"),
    ("seekdeepEnqueueImageJob(job, runner)", "image queue contract"),
]:
    require(needle, label)

if "seekdeepMakeImageQueueJobId" in text:
    fail("Unsafe old queue helper found: seekdeepMakeImageQueueJobId")
if "job.run" in text:
    fail("Unsafe job.run-style queue logic found")

# ----------------------------------------------------------------------
# 1. Prompt-choice row: Original / Refined / Both, no Cancel.
# ----------------------------------------------------------------------
new_row = r"""function seekdeepPendingPromptChoiceRow(id, disabled = false) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`seekdeep:prompt:original:${id}`)
      .setLabel('Original')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(disabled),
    new ButtonBuilder()
      .setCustomId(`seekdeep:prompt:refined:${id}`)
      .setLabel('Refined')
      .setStyle(ButtonStyle.Primary)
      .setDisabled(disabled),
    new ButtonBuilder()
      .setCustomId(`seekdeep:prompt:both:${id}`)
      .setLabel('Both')
      .setStyle(ButtonStyle.Success)
      .setDisabled(disabled),
  );
}"""
text = replace_named_function(text, "function seekdeepPendingPromptChoiceRow(id, disabled = false)", new_row)

# ----------------------------------------------------------------------
# 2. Proxy message helper for queued jobs started from button interactions.
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
# 3. Add skipCooldown support to image senders.
#    This makes Both count as one user action while still queueing two jobs.
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
text = patch_sender_skip_cooldown(
    text,
    "async function seekdeepSendImageWithButtonsInteraction(interaction, prompt, width = 1024, height = 1024, seed = null, imageModeOptions = null)"
)

# ----------------------------------------------------------------------
# 4. Replace prompt-choice button handler.
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
      // Avoid spamming public channels with expired-click messages.
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

  SEEKDEEP_PENDING_IMAGE_PROMPTS.delete(id);

  const basePrompt = state.originalPrompt || state.rawPrompt || 'image';
  const width = state.width || 1024;
  const height = state.height || 1024;
  const seed = state.seed ?? null;
  const groundingOn = state.ground !== false;
  const groundingLine = groundingOn ? 'Grounding: on' : 'Grounding: off';

  let selectionSummary = '';
  if (action === 'original') {
    selectionSummary = [
      'Queued original prompt.',
      '',
      groundingLine,
      'Refinement: off',
      'Queued Jobs: 1',
    ].join('\n');
  } else if (action === 'refined') {
    selectionSummary = [
      'Queued refined prompt.',
      '',
      groundingLine,
      'Refinement: on',
      'Queued Jobs: 1',
    ].join('\n');
  } else {
    selectionSummary = [
      'Queued both prompt versions.',
      '',
      groundingLine,
      'Jobs queued:',
      '1. Original prompt',
      '2. Refined prompt',
    ].join('\n');
  }

  try {
    await interaction.update({
      content: seekdeepAppendResponseFooter(selectionSummary, {
        startedAt,
        modelUsed: seekdeepNoModelLabel(),
      }),
      components: [],
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

  if (action === 'both') {
    const originalProxy = seekdeepPromptChoiceProxyMessage(interaction, state.requesterId, 'original');
    const refinedProxy = seekdeepPromptChoiceProxyMessage(interaction, state.requesterId, 'refined');

    const originalOptions = {
      refine: false,
      ground: groundingOn,
      cleanPrompt: basePrompt,
      skipCooldown: false,
    };

    const refinedOptions = {
      refine: true,
      ground: groundingOn,
      cleanPrompt: basePrompt,
      skipCooldown: true,
    };

    void runQueuedSelection(originalProxy, basePrompt, originalOptions, 'image-choice-original');
    void runQueuedSelection(refinedProxy, basePrompt, refinedOptions, 'image-choice-refined');
    return true;
  }

  const messageProxy = seekdeepPromptChoiceProxyMessage(interaction, state.requesterId, action);
  const selectionOptions = action === 'original'
    ? {
        refine: false,
        ground: groundingOn,
        cleanPrompt: basePrompt,
        skipCooldown: false,
      }
    : {
        refine: true,
        ground: groundingOn,
        cleanPrompt: basePrompt,
        skipCooldown: false,
      };

  void runQueuedSelection(
    messageProxy,
    basePrompt,
    selectionOptions,
    action === 'original' ? 'image-choice-original' : 'image-choice-refined'
  );

  return true;
}"""
text = replace_named_function(text, "async function seekdeepHandlePromptChoiceButton(interaction)", new_handler)

# ----------------------------------------------------------------------
# 5. Update existing prompt-choice copy, if the earlier patch left old labels.
# ----------------------------------------------------------------------
text = text.replace("Choose a version before queueing.", "Choose Original, Refined, or Both before queueing.")
text = text.replace("That prompt choice expired. Run the image request again.", "Prompt choice expired before a version was selected.\nRun the image request again to reopen Original / Refined / Both.")

# ----------------------------------------------------------------------
# 6. Validation.
# ----------------------------------------------------------------------
for needle, label in [
    ("setLabel('Original')", "Original button"),
    ("setLabel('Refined')", "Refined button"),
    ("setLabel('Both')", "Both button"),
    ("function seekdeepPromptChoiceProxyMessage(", "prompt-choice proxy helper"),
    ("skipCooldown", "skip cooldown support"),
    ("original|refined|both", "new prompt-choice regex"),
    ("Queued both prompt versions.", "Both queue summary"),
    ("components: []", "buttons vanish after selection/expiry"),
    ("Prompt choice expired before a version was selected.", "improved expiry text"),
    ("seekdeepEnqueueImageJob(job, runner)", "queue contract preserved"),
]:
    require(needle, label)

if "setLabel('Cancel')" in text or 'setLabel("Cancel")' in text:
    fail("Cancel button still exists after patch.")
if "seekdeep:prompt:cancel" in text:
    fail("Cancel customId still exists after patch.")
if "Generate Raw" in text or "Generate Refined" in text:
    fail("Old Generate Raw / Generate Refined labels still exist after patch.")

out = text if newline == "\n" else text.replace("\n", "\r\n")
path.write_bytes(out.encode("utf-8"))
print("Patched prompt choice UX: Original / Refined / Both, no Cancel, vanish-after-click, cleaner expiry.")
'@

  $patchPyPath = Join-Path $patchesDir "patch_prompt_choice_ux_repair.py"
  [System.IO.File]::WriteAllText($patchPyPath, $patchPy, $utf8NoBom)

  Push-Location $projectRoot
  try {
    Write-Info "Applying prompt-choice UX repair"
    & ".\.venv\Scripts\python.exe" $patchPyPath $indexPath
    if ($LASTEXITCODE -ne 0) {
      throw "Patch helper failed with exit code $LASTEXITCODE."
    }
    Write-Pass "Applied prompt-choice UX repair"

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
  Write-Pass "Prompt-choice UX repair completed."
  Write-Host "Backup created: $indexBackup" -ForegroundColor Yellow
  Write-Host "Restart the Discord bot before testing." -ForegroundColor Yellow
  Write-Host ""
  Write-Host "Retest:" -ForegroundColor Cyan
  Write-Host "1) @SEEKOTICS generate tiger roaring" -ForegroundColor White
  Write-Host "   Expected: preview buttons are Original / Refined / Both. No Cancel." -ForegroundColor White
  Write-Host ""
  Write-Host "2) Click Original" -ForegroundColor White
  Write-Host "   Expected: preview buttons vanish; one image queues with Refinement: off." -ForegroundColor White
  Write-Host ""
  Write-Host "3) Click Refined" -ForegroundColor White
  Write-Host "   Expected: preview buttons vanish; one image queues with Refinement: on." -ForegroundColor White
  Write-Host ""
  Write-Host "4) Click Both" -ForegroundColor White
  Write-Host "   Expected: preview buttons vanish; two images queue, Original then Refined." -ForegroundColor White
  Write-Host ""
  Write-Host "5) Let a choice expire and click it" -ForegroundColor White
  Write-Host "   Expected: original preview edits to expired message and buttons vanish." -ForegroundColor White
  exit 0
} catch {
  Write-Host ""
  Write-Fail $_.Exception.Message
  Write-Host "Backup available:" -ForegroundColor Yellow
  if ($indexBackup) { Write-Host $indexBackup -ForegroundColor Yellow }
  exit 1
}
