$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$ProjectRoot = (Get-Location).Path
$IndexPath = Join-Path $ProjectRoot 'index.js'
$PythonPath = Join-Path $ProjectRoot '.venv\Scripts\python.exe'
$LocalAiPath = Join-Path $ProjectRoot 'local_ai_server.py'
$BackupsDir = Join-Path $ProjectRoot 'backups'
$PatchesDir = Join-Path $ProjectRoot 'patches'

if (-not (Test-Path $IndexPath)) {
  throw "index.js not found at $IndexPath. Run this from the SeekDeep-DiscordBot project root."
}

New-Item -ItemType Directory -Path $BackupsDir -Force | Out-Null
New-Item -ItemType Directory -Path $PatchesDir -Force | Out-Null

$Stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$IndexBackupPath = Join-Path $BackupsDir "index.js.before-pending-image-subject-followup-v1-$Stamp.bak"
$PatchJsPath = Join-Path $PatchesDir "apply_pending_image_subject_followup_v1_$Stamp.cjs"

Copy-Item $IndexPath $IndexBackupPath -Force
Write-Host "Backup created: $IndexBackupPath"

@'
const fs = require('fs');
const path = require('path');

const indexPath = path.join(process.cwd(), 'index.js');
let source = fs.readFileSync(indexPath, 'utf8');
let text = source.replace(/\r\n/g, '\n');
const changes = [];

function replaceOnce(label, find, replace, required = true) {
  if (!text.includes(find)) {
    if (required) throw new Error(`Missing anchor for ${label}`);
    return false;
  }
  text = text.replace(find, replace);
  changes.push(label);
  return true;
}

function insertBefore(label, marker, block) {
  if (text.includes(block.split('\n')[0])) {
    changes.push(`${label} already present`);
    return false;
  }
  const idx = text.indexOf(marker);
  if (idx < 0) throw new Error(`Missing insertion marker for ${label}`);
  text = text.slice(0, idx) + block + '\n\n' + text.slice(idx);
  changes.push(label);
  return true;
}

// 1) Make prompt-choice builder store clean image subjects.
//    This fixes "generate me a goomba" being kept as the actual generation prompt.
replaceOnce(
  'clean prompt choice originalPrompt',
  `  const originalPrompt = seekdeepNormalizeObjectAccuracyPrompt(
    normalizeUserText(options.cleanPrompt || seekdeepCleanImageModeTokens(prompt) || prompt).trim() || 'image'
  );`,
  `  const rawOriginalPrompt = normalizeUserText(options.cleanPrompt || seekdeepCleanImageModeTokens(prompt) || prompt).trim();
  const extractedOriginalPrompt = typeof seekdeepExtractImagePrompt === 'function'
    ? seekdeepExtractImagePrompt(rawOriginalPrompt)
    : rawOriginalPrompt;
  const originalPrompt = seekdeepNormalizeObjectAccuracyPrompt(
    normalizeUserText(extractedOriginalPrompt || rawOriginalPrompt || 'image').trim() || 'image'
  );`,
  false
);

// 2) Make direct image sending also clean command verbs if callers pass cleanPrompt dirty.
replaceOnce(
  'clean send-image prompt after mode tokens',
  `  prompt = seekdeepImageModeOptions.cleanPrompt || seekdeepCleanImageModeTokens(prompt) || prompt;
  const seekdeepSkipImageCooldown = Boolean(seekdeepImageModeOptions.skipCooldown);`,
  `  prompt = seekdeepImageModeOptions.cleanPrompt || seekdeepCleanImageModeTokens(prompt) || prompt;
  if (typeof seekdeepExtractImagePrompt === 'function') {
    const seekdeepExtractedSendPrompt = seekdeepExtractImagePrompt(prompt);
    if (seekdeepExtractedSendPrompt) prompt = seekdeepExtractedSendPrompt;
  }
  const seekdeepSkipImageCooldown = Boolean(seekdeepImageModeOptions.skipCooldown);`
);

// 3) Add pending-subject helpers.
//    If user clicks Both on "generate me", the next normal message becomes the missing image subject.
const pendingHelpers = `// SEEKDEEP_PENDING_IMAGE_SUBJECT_FOLLOWUP_V1_START
const SEEKDEEP_PENDING_IMAGE_SUBJECT_REQUESTS = globalThis.__seekdeepPendingImageSubjectRequests || new Map();
globalThis.__seekdeepPendingImageSubjectRequests = SEEKDEEP_PENDING_IMAGE_SUBJECT_REQUESTS;

function seekdeepPendingImageSubjectKeyFromMessage(message) {
  const channelId = message?.channel?.id || 'unknown-channel';
  const userId = message?.author?.id || 'unknown-user';
  return \`\${channelId}:\${userId}\`;
}

function seekdeepPendingImageSubjectCleanPrompt(prompt = '') {
  let clean = typeof seekdeepStripCommandAddressingForRouting === 'function'
    ? seekdeepStripCommandAddressingForRouting(prompt)
    : seekdeepCleanMessageCommandPrompt(prompt);

  if (typeof seekdeepExtractImagePrompt === 'function') {
    const extracted = seekdeepExtractImagePrompt(clean);
    if (extracted) clean = extracted;
  }

  return normalizeUserText(clean).trim();
}

function seekdeepRememberPendingImageSubjectRequest(message, options = {}) {
  const key = seekdeepPendingImageSubjectKeyFromMessage(message);
  const now = Date.now();
  const ttlMs = Math.max(30000, Number(process.env.SEEKDEEP_PENDING_IMAGE_SUBJECT_TTL_MS || 2 * 60 * 1000));
  const existing = SEEKDEEP_PENDING_IMAGE_SUBJECT_REQUESTS.get(key);
  const alreadyPending = Boolean(existing?.expiresAt && Number(existing.expiresAt) > now);

  const imageModeOptions = options.imageModeOptions || {};
  const state = alreadyPending ? { ...existing } : {
    channelId: message?.channel?.id || '',
    userId: message?.author?.id || '',
    createdAt: now,
    wantsOriginal: false,
    wantsRefined: false,
  };

  if (imageModeOptions.refine === false) state.wantsOriginal = true;
  if (imageModeOptions.refine !== false) state.wantsRefined = true;
  if (!state.wantsOriginal && !state.wantsRefined) state.wantsRefined = true;

  state.width = options.width || state.width || 1024;
  state.height = options.height || state.height || 1024;
  state.seed = options.seed ?? state.seed ?? null;
  state.ground = imageModeOptions.ground !== false;
  state.expiresAt = now + ttlMs;
  state.updatedAt = now;

  SEEKDEEP_PENDING_IMAGE_SUBJECT_REQUESTS.set(key, state);
  return { alreadyPending, state };
}

function seekdeepConsumePendingImageSubjectRequest(message, prompt = '') {
  const key = seekdeepPendingImageSubjectKeyFromMessage(message);
  const state = SEEKDEEP_PENDING_IMAGE_SUBJECT_REQUESTS.get(key);
  const now = Date.now();

  if (!state) return null;
  if (!state.expiresAt || Number(state.expiresAt) <= now) {
    SEEKDEEP_PENDING_IMAGE_SUBJECT_REQUESTS.delete(key);
    return null;
  }

  const raw = normalizeUserText(prompt).trim();
  if (!raw) return null;

  const lower = raw.toLowerCase();
  if (/^(?:help|commands|status|archive|setup|queue|cache|recent|purge|delete|remove|stop|cancel)\\b/i.test(lower)) return null;
  if (typeof seekdeepUtilityPromptKind === 'function' && seekdeepUtilityPromptKind(raw)) return null;
  if (/^(?:what|who|why|how|when|where|is|are|do|does|did|can|could|would|should)\\b/i.test(lower)) return null;

  const subject = seekdeepPendingImageSubjectCleanPrompt(raw);
  if (!subject) return null;
  if (typeof seekdeepIsGenericImageFollowupPrompt === 'function' && seekdeepIsGenericImageFollowupPrompt(subject)) return null;

  SEEKDEEP_PENDING_IMAGE_SUBJECT_REQUESTS.delete(key);
  return { ...state, prompt: subject };
}

async function seekdeepHandlePendingImageSubjectReply(message, prompt = '', key = '') {
  const pending = seekdeepConsumePendingImageSubjectRequest(message, prompt);
  if (!pending?.prompt) return false;

  if (typeof seekdeepLogRoute === 'function') seekdeepLogRoute('image-pending-subject', pending.prompt);
  if (typeof remember === 'function' && key) remember(key, 'user', \`[pending-image-subject] \${pending.prompt}\`);

  const wantsOriginal = Boolean(pending.wantsOriginal);
  const wantsRefined = Boolean(pending.wantsRefined);
  const width = pending.width || 1024;
  const height = pending.height || 1024;
  const seed = pending.seed ?? null;
  const ground = pending.ground !== false;

  if (wantsOriginal && wantsRefined) {
    await message.reply({
      content: seekdeepAppendResponseFooter('Queued both:\\n- Original\\n- Refined', {
        startedAt: seekdeepNowMs(),
        modelUsed: seekdeepNoModelLabel(),
      }),
      allowedMentions: { repliedUser: false },
    });

    await seekdeepSendImageWithButtonsMessage(message, pending.prompt, width, height, seed, {
      refine: false,
      ground,
      cleanPrompt: pending.prompt,
      skipCooldown: true,
      silentAck: true,
    });

    await seekdeepSendImageWithButtonsMessage(message, pending.prompt, width, height, seed, {
      refine: true,
      ground,
      cleanPrompt: pending.prompt,
      skipCooldown: true,
      silentAck: true,
    });

    return true;
  }

  await seekdeepSendImageWithButtonsMessage(message, pending.prompt, width, height, seed, {
    refine: !wantsOriginal,
    ground,
    cleanPrompt: pending.prompt,
  });

  return true;
}
// SEEKDEEP_PENDING_IMAGE_SUBJECT_FOLLOWUP_V1_END`;

insertBefore(
  'insert pending image subject follow-up helpers',
  'function seekdeepResolveImagePromptFromContext(message, prompt = \'\') {',
  pendingHelpers
);

// 4) When context is missing, remember that the next message should be treated as the image subject.
//    Also suppress duplicate "What should..." replies when Both queues Original+Refined.
replaceOnce(
  'remember pending subject on missing context',
  `  if (seekdeepResolvedImagePrompt.missingContext) {
    return await message.reply({
      content: seekdeepAppendResponseFooter('What should I generate an image of?', {
        startedAt: requestStartedAt,
        modelUsed: seekdeepNoModelLabel(),
      }),
      allowedMentions: { repliedUser: false },
    });
  }`,
  `  if (seekdeepResolvedImagePrompt.missingContext) {
    const pendingSubjectInfo = typeof seekdeepRememberPendingImageSubjectRequest === 'function'
      ? seekdeepRememberPendingImageSubjectRequest(message, { width, height, seed, imageModeOptions: seekdeepImageModeOptions })
      : null;

    if (pendingSubjectInfo?.alreadyPending && seekdeepSuppressQueueAck) return null;

    return await message.reply({
      content: seekdeepAppendResponseFooter('What should I generate an image of?', {
        startedAt: requestStartedAt,
        modelUsed: seekdeepNoModelLabel(),
      }),
      allowedMentions: { repliedUser: false },
    });
  }`
);

// 5) Before falling to Qwen chat, consume pending image subject replies like "red rain".
replaceOnce(
  'route pending image subject before chat',
  `    // SEEKDEEP_RESEARCH_TABLE_MESSAGE_HOOK_END

    seekdeepLogRoute('chat', prompt);`,
  `    // SEEKDEEP_RESEARCH_TABLE_MESSAGE_HOOK_END

    // SEEKDEEP_PENDING_IMAGE_SUBJECT_REPLY_ROUTE_V1_START
    if (typeof seekdeepHandlePendingImageSubjectReply === 'function' && await seekdeepHandlePendingImageSubjectReply(message, prompt, key)) {
      return;
    }
    // SEEKDEEP_PENDING_IMAGE_SUBJECT_REPLY_ROUTE_V1_END

    seekdeepLogRoute('chat', prompt);`
);

if (text === source) {
  throw new Error('Patch made no changes; refusing to continue.');
}

fs.writeFileSync(indexPath, text, 'utf8');
console.log('Patched index.js successfully.');
for (const change of changes) console.log('- ' + change);

'@ | Set-Content -Path $PatchJsPath -Encoding UTF8

try {
  Write-Host "Applying patch with: $PatchJsPath"
  node $PatchJsPath
  if ($LASTEXITCODE -ne 0) { throw "Node patcher failed with exit code $LASTEXITCODE" }

  Write-Host "Running node --check..."
  node --check $IndexPath
  if ($LASTEXITCODE -ne 0) { throw "node --check failed with exit code $LASTEXITCODE" }

  if ((Test-Path $PythonPath) -and (Test-Path $LocalAiPath)) {
    Write-Host "Running Python compile check..."
    & $PythonPath -m py_compile $LocalAiPath
    if ($LASTEXITCODE -ne 0) { throw "Python compile check failed with exit code $LASTEXITCODE" }
  } else {
    Write-Host "Python compile check skipped (venv python or local_ai_server.py not found)."
  }

  Write-Host ""
  Write-Host "Patch applied successfully."
  Write-Host "Changed behavior:"
  Write-Host "- If the bot asks 'What should I generate an image of?', the next normal user message is treated as the missing image subject."
  Write-Host "- 'red rain' after 'generate me' should route to image generation instead of Qwen chat."
  Write-Host "- If Both was selected before the subject was provided, the follow-up subject queues Original and Refined."
  Write-Host "- Dirty prompts like 'generate me a goomba' are cleaned to 'a goomba' before generation where possible."
} catch {
  Write-Host ""
  Write-Host "Patch failed. Restoring backup..."
  Copy-Item $IndexBackupPath $IndexPath -Force
  Write-Host "Restored: $IndexBackupPath"
  throw
}
