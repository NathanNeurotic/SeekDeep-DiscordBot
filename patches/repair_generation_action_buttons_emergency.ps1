# SeekDeep / Seekotics emergency fix for generated-image action buttons
# Fixes broken button interactions on generated image cards:
# - Regenerate
# - Archive
# - Legacy save/archive aliases
# - Legacy regenerate customIds
#
# Strategy:
# - Do NOT rewrite the fragile main interactionCreate router.
# - Append a dedicated sidecar interaction listener for the post-generation buttons.
# - Acknowledge the interaction immediately with deferReply() to prevent
#   Discord from showing "This interaction failed".
# - Reuse existing helpers already present in index.js for queueing and archiving.

$ErrorActionPreference = 'Stop'

function Write-Info { param([string]$Message) Write-Host "[SeekDeep image-action-emergency] $Message" -ForegroundColor Cyan }
function Write-Pass { param([string]$Message) Write-Host "[PASS] $Message" -ForegroundColor Green }
function Write-Fail { param([string]$Message) Write-Host "[FAIL] $Message" -ForegroundColor Red }

$backup = $null

try {
  $projectRoot = Join-Path $env:USERPROFILE 'SeekDeep-DiscordBot'
  if (-not (Test-Path (Join-Path $projectRoot 'index.js'))) {
    $projectRoot = (Get-Location).Path
  }

  $indexPath = Join-Path $projectRoot 'index.js'
  $serverPath = Join-Path $projectRoot 'local_ai_server.py'
  $patchesDir = Join-Path $projectRoot 'patches'
  $backupDir = Join-Path $patchesDir 'backups'
  $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'

  if (-not (Test-Path $indexPath)) { throw 'index.js not found.' }
  if (-not (Test-Path $serverPath)) { throw 'local_ai_server.py not found.' }

  New-Item -ItemType Directory -Path $patchesDir -Force | Out-Null
  New-Item -ItemType Directory -Path $backupDir -Force | Out-Null

  $backup = Join-Path $backupDir "index.js.before-image-action-emergency-$stamp.bak"
  Copy-Item $indexPath $backup -Force
  Write-Pass "Backed up index.js to $backup"

  $patchPy = @'
from pathlib import Path
import sys

if len(sys.argv) != 2:
    raise SystemExit("Usage: patch_image_action_emergency.py <index.js>")

path = Path(sys.argv[1])
raw = path.read_bytes()
newline = "\r\n" if b"\r\n" in raw else "\n"
text = raw.decode("utf-8-sig").replace("\r\n", "\n").replace("\r", "\n")

start_marker = "// SEEKDEEP_IMAGE_ACTION_EMERGENCY_START"
end_marker = "// SEEKDEEP_IMAGE_ACTION_EMERGENCY_END"

block = r'''// SEEKDEEP_IMAGE_ACTION_EMERGENCY_START
const SEEKDEEP_IMAGE_ACTION_EMERGENCY_SEEN = globalThis.__SEEKDEEP_IMAGE_ACTION_EMERGENCY_SEEN || new Set();
globalThis.__SEEKDEEP_IMAGE_ACTION_EMERGENCY_SEEN = SEEKDEEP_IMAGE_ACTION_EMERGENCY_SEEN;

function seekdeepEmergencyIsGeneratedImageActionCustomId(customId = '') {
  const value = String(customId || '').trim();
  return (
    /^seekdeep:regen:(original|refined|both):(.+)$/i.test(value) ||
    /^seekdeep:(regenerate|download|archive|save):(.+)$/i.test(value) ||
    /^seekdeep:image:(regen|archive|save):(.+)$/i.test(value)
  );
}

async function seekdeepEmergencyHandleGeneratedImageButton(interaction) {
  const startedAt = typeof seekdeepNowMs === 'function' ? seekdeepNowMs() : Date.now();
  const customId = String(interaction?.customId || '').trim();

  if (!seekdeepEmergencyIsGeneratedImageActionCustomId(customId)) {
    return false;
  }

  if (interaction?.id && SEEKDEEP_IMAGE_ACTION_EMERGENCY_SEEN.has(interaction.id)) {
    return true;
  }
  if (interaction?.id) {
    SEEKDEEP_IMAGE_ACTION_EMERGENCY_SEEN.add(interaction.id);
    setTimeout(() => {
      try { SEEKDEEP_IMAGE_ACTION_EMERGENCY_SEEN.delete(interaction.id); } catch {}
    }, 300000).unref?.();
  }

  try {
    if (!interaction?.deferred && !interaction?.replied) {
      await interaction.deferReply({ ephemeral: true });
    }
  } catch (err) {
    console.warn('Emergency generated-image button deferReply failed:', err?.message || err);
  }

  try {
    if (/^seekdeep:(?:image:)?(?:regen|regenerate)(?::|$)/i.test(customId)) {
      const regenUserId = typeof seekdeepRegenerateCooldownUserId === 'function'
        ? seekdeepRegenerateCooldownUserId(interaction)
        : (interaction?.user?.id || 'unknown');
      const remaining = typeof seekdeepImageCooldownRemaining === 'function'
        ? seekdeepImageCooldownRemaining(regenUserId)
        : 0;

      if (remaining > 0) {
        if (typeof seekdeepLogRoute === 'function') {
          seekdeepLogRoute('regenerate-cooldown', 'button-regenerate');
        }

        if (typeof seekdeepSendRegenerateCooldownNotice === 'function') {
          await seekdeepSendRegenerateCooldownNotice(interaction, remaining);
        } else {
          const payload = {
            content: typeof seekdeepAppendResponseFooter === 'function'
              ? seekdeepAppendResponseFooter(
                  typeof seekdeepImageCooldownText === 'function' ? seekdeepImageCooldownText(remaining) : `Image generation cooldown is active. Try again in ${remaining.toFixed ? remaining.toFixed(1) : remaining} seconds.`,
                  {
                    startedAt,
                    modelUsed: typeof seekdeepNoModelLabel === 'function' ? seekdeepNoModelLabel() : 'local command (no AI model)',
                  }
                )
              : `Image generation cooldown is active. Try again in ${remaining} seconds.`,
            ephemeral: true,
          };

          if (interaction?.replied || interaction?.deferred) {
            await interaction.editReply(payload);
          } else {
            await interaction.reply(payload);
          }
        }
        return true;
      }
    }
  } catch (err) {
    console.warn('Emergency regenerate cooldown check failed:', err?.message || err);
  }

  const parsed =
    customId.match(/^seekdeep:regen:(original|refined|both):(.+)$/i) ||
    customId.match(/^seekdeep:(regenerate|download|archive|save):(.+)$/i) ||
    customId.match(/^seekdeep:image:(regen|archive|save):(.+)$/i);

  if (!parsed) {
    return false;
  }

  let action = '';
  let mode = 'submitted';
  let actionId = '';

  if (/^seekdeep:regen:/i.test(customId)) {
    action = 'regenerate';
    mode = String(parsed[1] || 'submitted').toLowerCase();
    actionId = parsed[2] || '';
  } else if (/^seekdeep:image:/i.test(customId)) {
    action = parsed[1] === 'regen' ? 'regenerate' : (parsed[1] === 'save' ? 'archive' : parsed[1]);
    actionId = parsed[2] || '';
  } else {
    action = parsed[1] === 'save' ? 'archive' : parsed[1];
    actionId = parsed[2] || '';
  }

  let state = seekdeepTempImageStateIndex?.get?.(actionId) || null;
  if (!state && typeof seekdeepLoadTempImageState === 'function') {
    state = seekdeepLoadTempImageState(actionId);
  }

  if (!state) {
    await interaction.editReply({
      content: typeof seekdeepAppendResponseFooter === 'function'
        ? seekdeepAppendResponseFooter(
            'That image action expired from the temporary cache. Generate it again if you still want to use its buttons.',
            {
              startedAt,
              modelUsed: typeof seekdeepNoModelLabel === 'function' ? seekdeepNoModelLabel() : 'local command (no AI model)',
            }
          )
        : 'That image action expired from the temporary cache. Generate it again if you still want to use its buttons.',
    });
    return true;
  }

  if (action === 'archive') {
    try {
      const archiveResult = typeof seekdeepArchiveImageStateToDiscordThread === 'function'
        ? await seekdeepArchiveImageStateToDiscordThread(state, interaction)
        : null;

      await interaction.editReply({
        content: typeof seekdeepAppendResponseFooter === 'function'
          ? seekdeepAppendResponseFooter(
              [
                'Archived to this server.',
                archiveResult?.threadName ? `Thread: ${archiveResult.threadName}` : '',
              ].filter(Boolean).join('\n'),
              {
                startedAt,
                modelUsed: typeof seekdeepNoModelLabel === 'function' ? seekdeepNoModelLabel() : 'local command (no AI model)',
              }
            )
          : 'Archived to this server.',
      });
      return true;
    } catch (err) {
      console.warn('Emergency Discord thread archive failed; falling back to local archive:', err?.message || err);

      const savedPath = typeof seekdeepArchiveImageStateToDisk === 'function'
        ? seekdeepArchiveImageStateToDisk(state)
        : '';

      await interaction.editReply({
        content: typeof seekdeepAppendResponseFooter === 'function'
          ? seekdeepAppendResponseFooter(
              [
                'Discord thread archive failed.',
                savedPath ? 'Saved locally as fallback.' : 'No fallback file was written.',
                err?.message ? `Reason: ${String(err.message).slice(0, 500)}` : '',
              ].filter(Boolean).join('\n'),
              {
                startedAt,
                modelUsed: typeof seekdeepNoModelLabel === 'function' ? seekdeepNoModelLabel() : 'local command (no AI model)',
              }
            )
          : 'Discord thread archive failed.',
      });
      return true;
    }
  }

  if (action === 'download') {
    const downloadText = state?.downloadUrl || state?.url || state?.proxyURL || state?.attachmentUrl
      ? `Download URL:\n${state.downloadUrl || state.url || state.proxyURL || state.attachmentUrl}`
      : 'Use the image attachment in the channel to download this image.';

    await interaction.editReply({
      content: typeof seekdeepAppendResponseFooter === 'function'
        ? seekdeepAppendResponseFooter(downloadText, {
            startedAt,
            modelUsed: typeof seekdeepNoModelLabel === 'function' ? seekdeepNoModelLabel() : 'local command (no AI model)',
          })
        : downloadText,
    });
    return true;
  }

  if (action !== 'regenerate') {
    await interaction.editReply({
      content: typeof seekdeepAppendResponseFooter === 'function'
        ? seekdeepAppendResponseFooter('Unknown image action.', {
            startedAt,
            modelUsed: typeof seekdeepNoModelLabel === 'function' ? seekdeepNoModelLabel() : 'local command (no AI model)',
          })
        : 'Unknown image action.',
    });
    return true;
  }

  const basePrompt = state.originalPrompt || state.rawPrompt || state.prompt || 'image';
  const width = state.width || 1024;
  const height = state.height || 1024;
  const seed = state.seed ?? null;
  const grounded = state.ground !== false && state.imageModeOptions?.ground !== false;

  const queueOne = async (regenMode, routeName, suffix) => {
    const proxy = typeof seekdeepPromptChoiceProxyMessage === 'function'
      ? seekdeepPromptChoiceProxyMessage(interaction, interaction?.user?.id || '', suffix)
      : {
          author: { id: interaction?.user?.id || 'unknown' },
          channel: interaction?.channel || null,
          id: `${interaction?.id || 'regen'}:${suffix}:${Date.now().toString(36)}`,
          reply: async (payload) => {
            if (interaction?.channel && typeof interaction.channel.send === 'function') {
              return await interaction.channel.send(payload);
            }
            return null;
          },
        };

    if (typeof seekdeepLogRoute === 'function') {
      seekdeepLogRoute(routeName, basePrompt);
    }

    const modeOptions = typeof seekdeepRegenerateModeOptions === 'function'
      ? seekdeepRegenerateModeOptions(regenMode, {
          ...state,
          originalPrompt: basePrompt,
          ground: grounded,
        })
      : {
          ...(state?.imageModeOptions || {}),
          refine: regenMode !== 'original',
          ground: grounded,
          cleanPrompt: basePrompt,
          skipCooldown: true,
        };

    return await seekdeepSendImageWithButtonsMessage(
      proxy,
      basePrompt,
      width,
      height,
      seed,
      modeOptions,
    );
  };

  if (mode === 'both') {
    await interaction.editReply({
      content: typeof seekdeepAppendResponseFooter === 'function'
        ? seekdeepAppendResponseFooter(
            [
              'Queued both regenerate versions.',
              '',
              grounded ? 'Grounding: on' : 'Grounding: off',
              'Jobs queued:',
              '- Original prompt',
              '- Refined prompt',
            ].join('\n'),
            {
              startedAt,
              modelUsed: typeof seekdeepNoModelLabel === 'function' ? seekdeepNoModelLabel() : 'local command (no AI model)',
            }
          )
        : 'Queued both regenerate versions.',
    });

    void queueOne('original', 'image-choice-original', 'regen-original');
    void queueOne('refined', 'image-choice-refined', 'regen-refined');
    return true;
  }

  const responseMode = String(mode || 'submitted').toLowerCase();
  const resolvedMode = responseMode === 'original' || responseMode === 'raw'
    ? 'original'
    : responseMode === 'refined'
      ? 'refined'
      : ((state.refine === false || state.imageModeOptions?.refine === false) ? 'original' : 'refined');

  await interaction.editReply({
    content: typeof seekdeepAppendResponseFooter === 'function'
      ? seekdeepAppendResponseFooter(
          [
            resolvedMode === 'original' ? 'Queued original regenerate.' : 'Queued refined regenerate.',
            '',
            grounded ? 'Grounding: on' : 'Grounding: off',
            resolvedMode === 'original' ? 'Refinement: off' : 'Refinement: on',
            'Queued Jobs: 1',
          ].join('\n'),
          {
            startedAt,
            modelUsed: typeof seekdeepNoModelLabel === 'function' ? seekdeepNoModelLabel() : 'local command (no AI model)',
          }
        )
      : 'Queued regenerate.',
  });

  void queueOne(
    resolvedMode,
    resolvedMode === 'original' ? 'image-choice-original' : 'image-choice-refined',
    `regen-${resolvedMode}`
  );
  return true;
}

client.on('interactionCreate', async (interaction) => {
  try {
    if (!(interaction?.isButton && interaction.isButton())) return;
    const customId = String(interaction?.customId || '');
    if (!seekdeepEmergencyIsGeneratedImageActionCustomId(customId)) return;
    await seekdeepEmergencyHandleGeneratedImageButton(interaction);
  } catch (err) {
    console.error('Emergency generated-image button listener failed:', err);
    try {
      if (interaction?.deferred || interaction?.replied) {
        await interaction.editReply(`Image button failed.\n\nError:\n${err?.message || err}`);
      } else {
        await interaction.reply({
          content: `Image button failed.\n\nError:\n${err?.message || err}`,
          ephemeral: true,
        });
      }
    } catch {}
  }
});
// SEEKDEEP_IMAGE_ACTION_EMERGENCY_END
'''

if start_marker in text and end_marker in text:
    start = text.index(start_marker)
    end = text.index(end_marker) + len(end_marker)
    text = text[:start] + block + text[end:]
else:
    text = text.rstrip() + "\n\n" + block + "\n"

for needle in [
    'seekdeepEmergencyHandleGeneratedImageButton',
    'seekdeepEmergencyIsGeneratedImageActionCustomId',
    "await interaction.deferReply({ ephemeral: true })",
    "client.on('interactionCreate', async (interaction) => {",
]:
    if needle not in text:
        raise SystemExit(f'Missing required emergency patch element: {needle}')

path.write_bytes((text if newline == "\n" else text.replace("\n", "\r\n")).encode('utf-8'))
print('Installed emergency generated-image action listener.')
'@

  $patchPyPath = Join-Path $patchesDir 'patch_image_action_emergency.py'
  [System.IO.File]::WriteAllText($patchPyPath, $patchPy, [System.Text.UTF8Encoding]::new($false))

  Push-Location $projectRoot
  try {
    Write-Info 'Installing emergency generated-image action listener'
    & ".\.venv\Scripts\python.exe" $patchPyPath $indexPath
    if ($LASTEXITCODE -ne 0) { throw "Patch helper failed with exit code $LASTEXITCODE." }
    Write-Pass 'Installed emergency generated-image action listener'

    Write-Info 'Running node --check .\index.js'
    & node --check '.\index.js'
    if ($LASTEXITCODE -ne 0) { throw "node --check failed with exit code $LASTEXITCODE." }
    Write-Pass 'node --check passed'

    Write-Info 'Running Python compile check'
    & ".\.venv\Scripts\python.exe" -m py_compile '.\local_ai_server.py'
    if ($LASTEXITCODE -ne 0) { throw "Python compile check failed with exit code $LASTEXITCODE." }
    Write-Pass 'Python compile check passed'
  }
  finally {
    Pop-Location
  }

  Write-Host ''
  Write-Pass 'Emergency generated-image action listener repair completed.'
  Write-Host "Backup created: $backup" -ForegroundColor Yellow
  Write-Host 'Restart the bot before testing.' -ForegroundColor Yellow
  Write-Host ''
  Write-Host 'Retest:' -ForegroundColor Cyan
  Write-Host '@SEEKOTICS generate a red test orb' -ForegroundColor White
  Write-Host 'Click Both' -ForegroundColor White
  Write-Host 'Then test Regenerate and Archive on the generated image cards.' -ForegroundColor White
  exit 0
}
catch {
  Write-Host ''
  Write-Fail $_.Exception.Message
  Write-Host 'Backup available:' -ForegroundColor Yellow
  if ($backup) { Write-Host $backup -ForegroundColor Yellow }
  exit 1
}
