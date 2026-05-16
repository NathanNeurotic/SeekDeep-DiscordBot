$ErrorActionPreference = 'Stop'

$Root = Get-Location
$IndexPath = Join-Path $Root 'index.js'
$BackupDir = Join-Path $Root 'backups'
$PatchDir = Join-Path $Root 'patches'
$Stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$BackupPath = Join-Path $BackupDir "index.js.restore-slash-router-v1-$Stamp.bak"

function Fail-And-Restore {
  param([string]$Reason)

  Write-Host "[FAIL] $Reason" -ForegroundColor Red
  if (Test-Path $BackupPath) {
    Copy-Item $BackupPath $IndexPath -Force
    Write-Host "[RESTORED] index.js restored from backup:" -ForegroundColor Yellow
    Write-Host "  $BackupPath"
  }
  exit 1
}

if (-not (Test-Path $IndexPath)) {
  throw "index.js not found. Run this from C:\Users\natha\SeekDeep-DiscordBot."
}

New-Item -ItemType Directory -Path $BackupDir -Force | Out-Null
New-Item -ItemType Directory -Path $PatchDir -Force | Out-Null
Copy-Item $IndexPath $BackupPath -Force
Write-Host "[BACKUP] $BackupPath"

$src = [System.IO.File]::ReadAllText($IndexPath)
$changed = $false

$slashRouter = @'
// SEEKDEEP_SLASH_ROUTER_RESTORE_V1_START
client.on('interactionCreate', async (interaction) => {
  try {
    if (!(interaction?.isChatInputCommand && interaction.isChatInputCommand())) return;

    if (typeof seekdeepMarkRequestStart === 'function') {
      seekdeepMarkRequestStart(interaction);
    }

    if (interaction?.id && typeof seekdeepClaimEventOnce === 'function' && !seekdeepClaimEventOnce(`interaction:${interaction.id}`)) {
      console.warn(`Duplicate Discord interaction suppressed: ${interaction.id}`);
      return;
    }

    const commandName = String(interaction.commandName || '').toLowerCase();

    if (['help', 'cachestatus', 'archivestatus', 'recent'].includes(commandName)) {
      if (!(await safeDefer(interaction))) return;
      const key = memoryKeyFrom(interaction);
      let kind = commandName;

      if (commandName === 'cachestatus') kind = 'cache';
      if (commandName === 'archivestatus') kind = 'archive';
      if (commandName === 'recent') {
        const requested = interaction.options.getString('kind') || 'images';
        kind = requested === 'prompts' ? 'recent-prompts' : 'recent-images';
      }

      seekdeepSetResponseModel(interaction, seekdeepNoModelLabel());

      if (kind === 'recent-images') {
        await seekdeepPostRecentImagesFromInteraction(interaction, 5);
        return;
      }

      const content = seekdeepUtilityText(kind, interaction, key);
      await sendLongInteractionReply(interaction, asTextBlock(content));
      return;
    }

    if (commandName === 'postarchive') {
      if (!(await safeDefer(interaction))) return;
      seekdeepSetResponseModel(interaction, seekdeepNoModelLabel());
      await seekdeepPostArchiveFromInteraction(interaction);
      return;
    }

    if (commandName === 'status') {
      if (!(await safeDefer(interaction))) return;
      seekdeepSetResponseModel(interaction, seekdeepNoModelLabel());
      await sendLongInteractionReply(interaction, asTextBlock(await statusText()));
      return;
    }

    if (commandName === 'ask') {
      if (!(await safeDefer(interaction))) return;
      const prompt = normalizeUserText(interaction.options.getString('prompt', true));
      const web = interaction.options.getString('web') || 'auto';
      const key = memoryKeyFrom(interaction);
      const answer = await askChat(prompt, { web, memoryKey: key });
      seekdeepSetResponseModel(interaction, seekdeepChatModelLabel());
      remember(key, 'user', prompt);
      remember(key, 'assistant', answer);
      await sendLongInteractionReply(interaction, answer);
      return;
    }

    if (commandName === 'refine') {
      if (!(await safeDefer(interaction))) return;

      const prompt = normalizeUserText(interaction.options.getString('prompt', true));
      const key = memoryKeyFrom(interaction);
      const refineInput = buildRefineUserPrompt(prompt, key);
      const web = refineExplicitlyRequestsWeb(prompt) ? 'always' : 'off';
      const maxNewTokens = maxTokensForRefine(prompt);
      const temperature = Number(process.env.REFINE_TEMPERATURE || 0.72);

      let answer = await askChat(refineInput, {
        web,
        system: REFINE_SYSTEM_PROMPT,
        maxNewTokens,
        temperature,
        memoryKey: null,
      });

      answer = cleanupRefinedPrompt(answer);

      if (hasRefineRepetitionIssue(answer)) {
        const retryInput = [
          refineInput,
          '',
          'The previous draft repeated itself. Regenerate once. Every sentence must add new information. Do not reuse paragraph structures or repeated filler phrasing.',
        ].join('\n');

        answer = await askChat(retryInput, {
          web: 'off',
          system: REFINE_SYSTEM_PROMPT,
          maxNewTokens,
          temperature: Math.max(temperature, 0.8),
          memoryKey: null,
        });

        answer = cleanupRefinedPrompt(answer);
      }

      seekdeepSetResponseModel(interaction, seekdeepChatModelLabel());
      remember(key, 'user', prompt);
      remember(key, 'assistant', answer);
      await sendLongInteractionReply(interaction, answer);
      return;
    }

    if (commandName === 'image') {
      if (!(await safeDefer(interaction))) return;
      const prompt = normalizeUserText(interaction.options.getString('prompt', true));
      const key = memoryKeyFrom(interaction);
      const width = interaction.options.getInteger('width') || 1024;
      const height = interaction.options.getInteger('height') || 1024;
      const seed = interaction.options.getInteger('seed');
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
    }

    if (commandName === 'vision') {
      if (!(await safeDefer(interaction))) return;
      const attachment = interaction.options.getAttachment('file', true);
      const prompt = normalizeUserText(interaction.options.getString('prompt') || 'Describe this media clearly.');
      const key = memoryKeyFrom(interaction);
      const answer = await askVision(attachment, buildPromptWithMemory(prompt, key));
      seekdeepSetResponseModel(interaction, seekdeepVisionModelLabel());
      remember(key, 'user', `/vision ${prompt}`);
      remember(key, 'assistant', answer);
      await sendLongInteractionReply(interaction, answer);
      return;
    }
  } catch (err) {
    console.error(err);
    try {
      const configuredChatModel = process.env.LOCAL_CHAT_MODEL_ID || 'Qwen/Qwen3-8B';
      seekdeepSetResponseModel(interaction, seekdeepNoModelLabel());
      await sendLongInteractionReply(interaction, [
        'SeekDeep request failed.',
        '',
        'Configured chat provider: Local NVIDIA model server',
        `Configured chat model: ${configuredChatModel}`,
        '',
        'Error:',
        err?.message || String(err),
      ].join('\n'));
    } catch (replyErr) {
      console.error('Slash command failure notice also failed:', replyErr?.message || replyErr);
    }
  }
});
// SEEKDEEP_SLASH_ROUTER_RESTORE_V1_END
'@

try {
  if (-not $src.Contains('// SEEKDEEP_SLASH_ROUTER_RESTORE_V1_START')) {
    $hasSlashRouter = $false
    $handlerMatches = [regex]::Matches($src, "client\.on\('interactionCreate',\s*async\s*\(interaction\)\s*=>\s*\{")
    foreach ($m in $handlerMatches) {
      $length = [Math]::Min(5000, $src.Length - $m.Index)
      if ($length -gt 0) {
        $snippet = $src.Substring($m.Index, $length)
        if ($snippet.Contains('isChatInputCommand')) {
          $hasSlashRouter = $true
          break
        }
      }
    }

    if ($hasSlashRouter) {
      Write-Host '[SKIP] Existing slash interaction router detected.'
    } else {
      $anchor = 'client.login(TOKEN);'
      $anchorIndex = $src.IndexOf($anchor)
      if ($anchorIndex -lt 0) {
        throw 'Could not find client.login(TOKEN); anchor for slash router restore.'
      }
      $src = $src.Substring(0, $anchorIndex) + $slashRouter + "`r`n`r`n" + $src.Substring($anchorIndex)
      $changed = $true
      Write-Host '[PATCH] Restored slash command interaction router.'
    }
  } else {
    Write-Host '[SKIP] Slash router restore marker already present.'
  }

  if (-not $src.Contains('// SEEKDEEP_PROMPT_CHOICE_GLOBAL_CLAIM_V1')) {
    $promptPattern = '(async function seekdeepEmergencyHandlePromptChoiceButton\(interaction\) \{\s*\r?\n\s*const customId = String\(interaction\?\.customId \|\| ''''\);\s*\r?\n\s*const match = customId\.match\(/\^seekdeep:prompt:\(original\|refined\|both\):\(\.\+\)\$/\);\s*\r?\n\s*if \(!match\) return false;\s*)'
    $promptRegex = [regex]::new($promptPattern, [System.Text.RegularExpressions.RegexOptions]::Singleline)
    if (-not $promptRegex.IsMatch($src)) {
      throw 'Could not find emergency prompt-choice handler anchor.'
    }
    $src = $promptRegex.Replace($src, {
      param($m)
      return $m.Groups[1].Value + "`r`n  // SEEKDEEP_PROMPT_CHOICE_GLOBAL_CLAIM_V1`r`n  if (interaction?.id && typeof seekdeepClaimEventOnce === 'function' && !seekdeepClaimEventOnce(``interaction:`${interaction.id}``)) {`r`n    return true;`r`n  }`r`n"
    }, 1)
    $changed = $true
    Write-Host '[PATCH] Added global duplicate guard to prompt-choice buttons.'
  } else {
    Write-Host '[SKIP] Prompt-choice global duplicate guard already present.'
  }

  if (-not $src.Contains('// SEEKDEEP_IMAGE_ACTION_GLOBAL_CLAIM_V1')) {
    $imagePattern = '(async function seekdeepEmergencyHandleGeneratedImageButton\(interaction\) \{[\s\S]*?if \(!seekdeepEmergencyIsGeneratedImageActionCustomId\(customId\)\) \{\s*\r?\n\s*return false;\s*\r?\n\s*\}\s*)'
    $imageRegex = [regex]::new($imagePattern, [System.Text.RegularExpressions.RegexOptions]::Singleline)
    if (-not $imageRegex.IsMatch($src)) {
      throw 'Could not find emergency generated-image action handler anchor.'
    }
    $src = $imageRegex.Replace($src, {
      param($m)
      return $m.Groups[1].Value + "`r`n  // SEEKDEEP_IMAGE_ACTION_GLOBAL_CLAIM_V1`r`n  if (interaction?.id && typeof seekdeepClaimEventOnce === 'function' && !seekdeepClaimEventOnce(``interaction:`${interaction.id}``)) {`r`n    return true;`r`n  }`r`n"
    }, 1)
    $changed = $true
    Write-Host '[PATCH] Added global duplicate guard to generated-image action buttons.'
  } else {
    Write-Host '[SKIP] Generated-image action global duplicate guard already present.'
  }

  if ($changed) {
    $utf8NoBom = New-Object System.Text.UTF8Encoding($false)
    [System.IO.File]::WriteAllText($IndexPath, $src, $utf8NoBom)
    Write-Host '[WRITE] index.js updated.'
  } else {
    Write-Host '[NOOP] No source changes were needed.'
  }
} catch {
  Fail-And-Restore "Patch application failed: $($_.Exception.Message)"
}

Write-Host '[CHECK] node --check .\index.js'
& node --check .\index.js
if ($LASTEXITCODE -ne 0) {
  Fail-And-Restore 'node --check failed.'
}

$PythonPath = Join-Path $Root '.venv\Scripts\python.exe'
$LocalAiPath = Join-Path $Root 'local_ai_server.py'
if ((Test-Path $PythonPath) -and (Test-Path $LocalAiPath)) {
  Write-Host '[CHECK] .\.venv\Scripts\python.exe -m py_compile .\local_ai_server.py'
  & $PythonPath -m py_compile .\local_ai_server.py
  if ($LASTEXITCODE -ne 0) {
    Fail-And-Restore 'Python compile check failed.'
  }
} else {
  Write-Host '[SKIP] Python compile check skipped because venv or local_ai_server.py was not found.'
}

Write-Host '[PASS] Slash command router restored and button duplicate guards installed.' -ForegroundColor Green
Write-Host '[NEXT] Restart the bot, run /status, then test one image prompt choice. Paste the console output if anything fails.'
