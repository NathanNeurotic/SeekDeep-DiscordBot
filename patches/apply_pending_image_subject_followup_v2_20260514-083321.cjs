const fs = require('fs');
const path = require('path');

const indexPath = path.join(process.cwd(), 'index.js');
let source = fs.readFileSync(indexPath, 'utf8');
let text = source.replace(/\r\n/g, '\n');
const changes = [];

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

const helpers = `// SEEKDEEP_PENDING_IMAGE_SUBJECT_FOLLOWUP_V2_START
const SEEKDEEP_PENDING_IMAGE_SUBJECT_REQUESTS_V2 = globalThis.__seekdeepPendingImageSubjectRequestsV2 || new Map();
globalThis.__seekdeepPendingImageSubjectRequestsV2 = SEEKDEEP_PENDING_IMAGE_SUBJECT_REQUESTS_V2;

function seekdeepPendingImageSubjectKeyFromMessageV2(message) {
  const channelId = message?.channel?.id || 'unknown-channel';
  const userId = message?.author?.id || 'unknown-user';
  return channelId + ':' + userId;
}

function seekdeepPendingImageSubjectCleanPromptV2(prompt = '') {
  let clean = String(prompt || '');

  if (typeof seekdeepStripCommandAddressingForRouting === 'function') {
    clean = seekdeepStripCommandAddressingForRouting(clean);
  } else if (typeof seekdeepCleanMessageCommandPrompt === 'function') {
    clean = seekdeepCleanMessageCommandPrompt(clean);
  } else {
    clean = clean
      .replace(/<@!?\\d+>/g, ' ')
      .replace(/<@&\\d+>/g, ' ')
      .replace(/^\\s*(?:@?seekdeep|@?seekotics)[,:]?\\s+/i, ' ');
  }

  if (typeof seekdeepExtractImagePrompt === 'function') {
    const extracted = seekdeepExtractImagePrompt(clean);
    if (extracted) clean = extracted;
  }

  return normalizeUserText(clean).trim();
}

function seekdeepIsMissingImageSubjectPromptV2(prompt = '') {
  const clean = seekdeepPendingImageSubjectCleanPromptV2(prompt).toLowerCase();
  if (!clean) return false;

  return /^(?:generate|create|make|draw|draw\\s+me|sketch|render|paint|illustrate|design|image|picture|pic|photo|art|artwork)(?:\\s+(?:me|for\\s+me))?\\s*$/i.test(clean);
}

function seekdeepRememberPendingImageSubjectRequestV2(message, options = {}) {
  const key = seekdeepPendingImageSubjectKeyFromMessageV2(message);
  const now = Date.now();
  const ttlMs = Math.max(30000, Number(process.env.SEEKDEEP_PENDING_IMAGE_SUBJECT_TTL_MS || 2 * 60 * 1000));

  const existing = SEEKDEEP_PENDING_IMAGE_SUBJECT_REQUESTS_V2.get(key);
  const alreadyPending = Boolean(existing?.expiresAt && Number(existing.expiresAt) > now);

  const state = {
    ...(alreadyPending ? existing : {}),
    channelId: message?.channel?.id || '',
    userId: message?.author?.id || '',
    createdAt: alreadyPending ? existing.createdAt : now,
    updatedAt: now,
    expiresAt: now + ttlMs,
    width: Number(options.width || existing?.width || 1024),
    height: Number(options.height || existing?.height || 1024),
    seed: options.seed ?? existing?.seed ?? null,
    wantsOriginal: options.wantsOriginal !== false,
    wantsRefined: options.wantsRefined !== false,
    ground: options.ground !== false,
  };

  SEEKDEEP_PENDING_IMAGE_SUBJECT_REQUESTS_V2.set(key, state);
  return { alreadyPending, state };
}

function seekdeepPeekPendingImageSubjectRequestV2(message) {
  const key = seekdeepPendingImageSubjectKeyFromMessageV2(message);
  const state = SEEKDEEP_PENDING_IMAGE_SUBJECT_REQUESTS_V2.get(key);
  const now = Date.now();

  if (!state) return null;
  if (!state.expiresAt || Number(state.expiresAt) <= now) {
    SEEKDEEP_PENDING_IMAGE_SUBJECT_REQUESTS_V2.delete(key);
    return null;
  }

  return state;
}

function seekdeepConsumePendingImageSubjectRequestV2(message, prompt = '') {
  const state = seekdeepPeekPendingImageSubjectRequestV2(message);
  if (!state) return null;

  const raw = normalizeUserText(prompt).trim();
  if (!raw) return null;

  // Do not consume another incomplete image command as the subject. Refresh the pending state instead.
  if (seekdeepIsMissingImageSubjectPromptV2(raw)) return null;

  const lower = raw.toLowerCase();
  if (/^(?:help|commands|status|archive|setup|queue|cache|recent|purge|delete|remove|stop|cancel)\\b/i.test(lower)) return null;
  if (typeof seekdeepUtilityPromptKind === 'function' && seekdeepUtilityPromptKind(raw)) return null;
  if (/^(?:what|who|why|how|when|where|is|are|do|does|did|can|could|would|should)\\b/i.test(lower)) return null;

  const subject = seekdeepPendingImageSubjectCleanPromptV2(raw);
  if (!subject) return null;
  if (seekdeepIsMissingImageSubjectPromptV2(subject)) return null;
  if (typeof seekdeepIsGenericImageFollowupPrompt === 'function' && seekdeepIsGenericImageFollowupPrompt(subject)) return null;

  const key = seekdeepPendingImageSubjectKeyFromMessageV2(message);
  SEEKDEEP_PENDING_IMAGE_SUBJECT_REQUESTS_V2.delete(key);
  return { ...state, prompt: subject };
}

async function seekdeepHandleMissingImageSubjectCommandV2(message, prompt = '', key = '') {
  if (!seekdeepIsMissingImageSubjectPromptV2(prompt)) return false;

  seekdeepRememberPendingImageSubjectRequestV2(message, {
    width: 1024,
    height: 1024,
    seed: null,
    wantsOriginal: true,
    wantsRefined: true,
    ground: true,
  });

  if (typeof seekdeepLogRoute === 'function') seekdeepLogRoute('image-missing-subject', prompt);
  if (typeof remember === 'function' && key) {
    remember(key, 'user', prompt);
    remember(key, 'assistant', 'What should I generate an image of?');
  }
  if (typeof seekdeepSetResponseModel === 'function' && typeof seekdeepNoModelLabel === 'function') {
    seekdeepSetResponseModel(message, seekdeepNoModelLabel());
  }

  const footerOptions = {
    startedAt: typeof seekdeepNowMs === 'function' ? seekdeepNowMs() : Date.now(),
    modelUsed: typeof seekdeepNoModelLabel === 'function' ? seekdeepNoModelLabel() : 'local command (no AI model)',
  };

  const content = typeof seekdeepAppendResponseFooter === 'function'
    ? seekdeepAppendResponseFooter('What should I generate an image of?', footerOptions)
    : 'What should I generate an image of?';

  await message.reply({
    content,
    allowedMentions: { repliedUser: false },
  });
  return true;
}

async function seekdeepHandlePendingImageSubjectReplyV2(message, prompt = '', key = '') {
  const pending = seekdeepConsumePendingImageSubjectRequestV2(message, prompt);
  if (!pending?.prompt) return false;

  if (typeof seekdeepLogRoute === 'function') seekdeepLogRoute('image-pending-subject', pending.prompt);
  if (typeof remember === 'function' && key) {
    remember(key, 'user', '[pending-image-subject] ' + pending.prompt);
    remember(key, 'assistant', 'Queued pending image subject.');
  }
  if (typeof seekdeepSetResponseModel === 'function' && typeof seekdeepNoModelLabel === 'function') {
    seekdeepSetResponseModel(message, seekdeepNoModelLabel());
  }

  const footerOptions = {
    startedAt: typeof seekdeepNowMs === 'function' ? seekdeepNowMs() : Date.now(),
    modelUsed: typeof seekdeepNoModelLabel === 'function' ? seekdeepNoModelLabel() : 'local command (no AI model)',
  };

  const ack = typeof seekdeepAppendResponseFooter === 'function'
    ? seekdeepAppendResponseFooter('Queued both:\\n- Original\\n- Refined', footerOptions)
    : 'Queued both:\\n- Original\\n- Refined';

  await message.reply({
    content: ack,
    allowedMentions: { repliedUser: false },
  });

  if (typeof seekdeepSendImageWithButtonsMessage !== 'function') {
    throw new Error('seekdeepSendImageWithButtonsMessage is not available for pending image subject follow-up.');
  }

  await seekdeepSendImageWithButtonsMessage(message, pending.prompt, pending.width || 1024, pending.height || 1024, pending.seed ?? null, {
    refine: false,
    ground: pending.ground !== false,
    cleanPrompt: pending.prompt,
    skipCooldown: true,
    silentAck: true,
  });

  await seekdeepSendImageWithButtonsMessage(message, pending.prompt, pending.width || 1024, pending.height || 1024, pending.seed ?? null, {
    refine: true,
    ground: pending.ground !== false,
    cleanPrompt: pending.prompt,
    skipCooldown: true,
    silentAck: true,
  });

  return true;
}
// SEEKDEEP_PENDING_IMAGE_SUBJECT_FOLLOWUP_V2_END`;

insertBefore(
  'insert pending image subject follow-up v2 helpers',
  'function seekdeepUtilityPromptKind(prompt = \'\') {',
  helpers
);

const routeMarker = '    // SEEKDEEP_COMMAND_SUGGESTION_ROUTE_V1_START';
const routeBlock = `    // SEEKDEEP_PENDING_IMAGE_SUBJECT_ROUTE_V2_START
    if (typeof seekdeepHandlePendingImageSubjectReplyV2 === 'function' && await seekdeepHandlePendingImageSubjectReplyV2(message, prompt, key)) {
      return;
    }

    if (typeof seekdeepHandleMissingImageSubjectCommandV2 === 'function' && await seekdeepHandleMissingImageSubjectCommandV2(message, prompt, key)) {
      return;
    }
    // SEEKDEEP_PENDING_IMAGE_SUBJECT_ROUTE_V2_END`;

if (!text.includes('SEEKDEEP_PENDING_IMAGE_SUBJECT_ROUTE_V2_START')) {
  const idx = text.indexOf(routeMarker);
  if (idx < 0) throw new Error('Could not find command suggestion route marker.');
  text = text.slice(0, idx) + routeBlock + '\n\n' + text.slice(idx);
  changes.push('insert pending image subject route before command suggestions');
} else {
  changes.push('pending image subject route v2 already present');
}

// Keep the suggestion system from suggesting "draw me <image idea>" for incomplete image subject commands.
// If this replacement misses due to drift, the route above still wins before suggestions.
const suggestionNeedle = `function seekdeepCommandSuggestionText(prompt = '') {
  const p = seekdeepNormalizeCommandSuggestionInput(prompt);
  if (!p) return '';`;
if (text.includes(suggestionNeedle) && !text.includes('SEEKDEEP_SKIP_MISSING_IMAGE_SUBJECT_SUGGESTION_V2')) {
  text = text.replace(
    suggestionNeedle,
    `function seekdeepCommandSuggestionText(prompt = '') {
  const p = seekdeepNormalizeCommandSuggestionInput(prompt);
  if (!p) return '';

  // SEEKDEEP_SKIP_MISSING_IMAGE_SUBJECT_SUGGESTION_V2
  if (typeof seekdeepIsMissingImageSubjectPromptV2 === 'function' && seekdeepIsMissingImageSubjectPromptV2(prompt)) return '';`
  );
  changes.push('suppress command suggestion for incomplete image commands');
}

// Improve extraction for variants like "generate me a goomba" if the current extractor is still dirty.
if (!text.includes('SEEKDEEP_EXTRACT_GENERATE_ME_CLEANUP_V2')) {
  const extractMarker = `  t = t.replace(/\\s+/g, ' ').trim();
  // SEEKDEEP_OBJECT_ACCURACY_EXTRACT_NORMALIZE`;
  if (text.includes(extractMarker)) {
    text = text.replace(
      extractMarker,
      `  // SEEKDEEP_EXTRACT_GENERATE_ME_CLEANUP_V2
  t = t.replace(/^(?:generate|create|make|draw(?:\\s+me)?|sketch|render|paint|illustrate|design)\\s+(?:me\\s+)?/i, '');
  t = t.replace(/\\s+/g, ' ').trim();
  // SEEKDEEP_OBJECT_ACCURACY_EXTRACT_NORMALIZE`
    );
    changes.push('add generate-me extractor cleanup');
  } else {
    changes.push('extractor cleanup marker not found; pending route still applied');
  }
}

if (text === source.replace(/\r\n/g, '\n')) {
  throw new Error('Patch made no changes; refusing to continue.');
}

fs.writeFileSync(indexPath, text, 'utf8');
console.log('Patched index.js successfully.');
for (const change of changes) console.log('- ' + change);

