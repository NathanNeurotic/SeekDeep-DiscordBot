const fs = require('fs');

function applyFix() {
    let content = fs.readFileSync('index.js', 'utf8');

    // --- 1. Generic Followup Prompt Routing ---
    const genericTarget = `function seekdeepIsGenericImageFollowupPrompt(prompt = '') {
  const p = normalizeUserText(prompt).toLowerCase().trim();
  if (seekdeepLooksLikeGenerateOnlyPrompt(p)) return true;
  // Standalone command without a real subject ("draw it", "make a picture").
  if (/^(generate|create|make|draw|paint|sketch|illustrate|render|show)(\\s+me)?(?:\\s+(an?\\s+)?(image|picture|pic|art|drawing|illustration|it|that|this))?$/i.test(p)) return true;
  // Pronoun-only references ("draw him", "draw her", "make her", "image of him", "picture of them").
  if (/^(generate|create|make|draw|paint|sketch|illustrate|render|show)(\\s+me)?\\s+(an?\\s+(?:image|picture|pic|portrait|drawing|illustration)\\s+of\\s+)?(him|her|them|that|this|it|us|those|these)\\b\\s*[.!?]*$/i.test(p)) return true;
  if (/^(?:an?\\s+)?(image|picture|pic|portrait|drawing|illustration|render)\\s+of\\s+(him|her|them|that|this|it|us|those|these)\\b\\s*[.!?]*$/i.test(p)) return true;
  return false;
}`;

    const genericReplacement = `function seekdeepIsGenericImageFollowupPrompt(prompt = '') {
  const p = normalizeUserText(prompt).toLowerCase().trim();
  if (seekdeepLooksLikeGenerateOnlyPrompt(p)) return true;

  // Correction phrases
  if (/^(?:no,?\\s*)?(?:make|create|draw|generate|render|turn)\\s+(?:an?\\s+)?(?:image|picture|pic|art)\\s*(?:from|out of|with)\\s+(?:that|this|the)\\s+(?:prompt|idea)(?:\\s+instead)?(?:\\s+please)?\\.?[!?]*$/i.test(p)) return true;
  if (/^(?:no,?\\s*)?(?:use|take)\\s+(?:that|this|the)\\s+(?:prompt|idea)\\s+(?:for|to make|and make)\\s+(?:an?\\s+)?(?:image|picture|pic|art)\\.?[!?]*$/i.test(p)) return true;
  if (/^(?:no,?\\s*)?(?:make|turn)\\s+(?:it|that|this)\\s+(?:into\\s+)?(?:an?\\s+)?(?:image|picture|pic|art|picture)\\.?[!?]*$/i.test(p)) return true;
  if (/^(?:no,?\\s*)?(?:draw|generate|render|make)\\s+(?:it|that)\\s*(?:instead)?(?:\\s+into\\s+a\\s+picture)?(?:\\s+please)?\\.?[!?]*$/i.test(p)) return true;
  if (/^(?:no,?\\s*)?(?:make|create|draw|generate|render)\\s+(?:an?\\s+)?(?:image|picture|pic|art)\\s+from\\s+(?:that|this|it)(?:\\s+prompt)?(?:\\s+please)?\\.?[!?]*$/i.test(p)) return true;
  if (/^(?:no,?\\s*)?(?:use|make)\\s+(?:that|this)\\s+prompt(?:\\s+please)?\\.?[!?]*$/i.test(p)) return true;
  if (/^(?:no,?\\s*)?make\\s+an\\s+image\\s+from\\s+that(?:\\s+prompt)?(?:\\s+please)?\\.?[!?]*$/i.test(p)) return true;

  // Standalone command without a real subject ("draw it", "make a picture").
  if (/^(generate|create|make|draw|paint|sketch|illustrate|render|show)(\\s+me)?(?:\\s+(an?\\s+)?(image|picture|pic|art|drawing|illustration|it|that|this))?$/i.test(p)) return true;
  // Pronoun-only references ("draw him", "draw her", "make her", "image of him", "picture of them").
  if (/^(generate|create|make|draw|paint|sketch|illustrate|render|show)(\\s+me)?\\s+(an?\\s+(?:image|picture|pic|portrait|drawing|illustration)\\s+of\\s+)?(him|her|them|that|this|it|us|those|these)\\b\\s*[.!?]*$/i.test(p)) return true;
  if (/^(?:an?\\s+)?(image|picture|pic|portrait|drawing|illustration|render)\\s+of\\s+(him|her|them|that|this|it|us|those|these)\\b\\s*[.!?]*$/i.test(p)) return true;
  return false;
}`;

    if (content.includes(genericTarget)) {
        content = content.replace(genericTarget, genericReplacement);
    } else {
        console.error("Could not find seekdeepIsGenericImageFollowupPrompt target");
    }

    // --- 2. Contextual Text Followups ---
    const keepChatTarget = `function seekdeepShouldKeepPromptAsChatBeforeImage(prompt = '') {
  const p = normalizeUserText(prompt).toLowerCase().trim();
  if (!p) return false;

  if (typeof seekdeepHasTextListIntent === 'function' && seekdeepHasTextListIntent(p)) return true;
  if (/\\b(?:image|picture|photo|art|visual|scene|prompt)\\s+(?:ideas?|concepts?|directions?|options?|suggestions?|variations?|prompts?)\\b/i.test(p)) return true;
  if (/\\b(?:next|another|more|additional|same direction|same vibe|same style)\\b.*\\b(?:ideas?|concepts?|directions?|options?|suggestions?|variations?)\\b/i.test(p)) return true;
  if (typeof seekdeepHasCountRequest === 'function' && seekdeepHasCountRequest(p) && /\\b(?:ideas?|concepts?|directions?|options?|suggestions?|variations?|examples?)\\b/i.test(p)) return true;
  if (typeof seekdeepLooksLikeConversationalImageEditFollowup === 'function' && seekdeepLooksLikeConversationalImageEditFollowup(p)) return true;`;

    const keepChatReplacement = `function seekdeepShouldKeepPromptAsChatBeforeImage(prompt = '') {
  const p = normalizeUserText(prompt).toLowerCase().trim();
  if (!p) return false;

  // Reject text work, but don't reject visual override
  if (!(/\\b(infographic|panels?|comic|diagram)\\b/i.test(p)) && /\\b(tutorial|steps|plan|instructions|noob friendly|explain|summarize|summary|how to|guide)\\b/i.test(p)) return true;

  if (typeof seekdeepHasTextListIntent === 'function' && seekdeepHasTextListIntent(p)) return true;
  if (/\\b(?:image|picture|photo|art|visual|scene|prompt)\\s+(?:ideas?|concepts?|directions?|options?|suggestions?|variations?|prompts?)\\b/i.test(p)) return true;
  if (/\\b(?:next|another|more|additional|same direction|same vibe|same style)\\b.*\\b(?:ideas?|concepts?|directions?|options?|suggestions?|variations?)\\b/i.test(p)) return true;
  if (typeof seekdeepHasCountRequest === 'function' && seekdeepHasCountRequest(p) && /\\b(?:ideas?|concepts?|directions?|options?|suggestions?|variations?|examples?)\\b/i.test(p)) return true;
  if (typeof seekdeepLooksLikeConversationalImageEditFollowup === 'function' && seekdeepLooksLikeConversationalImageEditFollowup(p)) return true;`;

    if (content.includes(keepChatTarget)) {
        content = content.replace(keepChatTarget, keepChatReplacement);
    } else {
        console.error("Could not find seekdeepShouldKeepPromptAsChatBeforeImage target");
    }

    const visualRequestTarget = `function seekdeepLooksLikeVisualRequest(prompt = '') {
  const p = String(prompt || '').trim().toLowerCase();
  if (!p) return false;
  if (typeof seekdeepShouldKeepPromptAsChatBeforeImage === 'function' && seekdeepShouldKeepPromptAsChatBeforeImage(p)) return false;

  const visualNouns = /\\b(image|picture|pic|photo|art|artwork|drawing|illustration|painting|poster|album cover|cover art|banner|wallpaper|logo|icon|emblem|badge|character design|scene|portrait|sticker|thumbnail|concept art|screenshot|visual)\\b/i;
  const creationVerbs = /\\b(make|create|generate|render|draw|paint|sketch|illustrate|visualize|depict|design|show|give me|turn this into|can i see|could i see|i want|i'd like|id like)\\b/i;
  const scenePreps = /\\b(of|with|wearing|holding|standing|sitting|smoking|on a|in a|inside|outside|under|over|during|at sunset|at sunrise|at night|in armor|in the style of|with a|over a|under a)\\b/i;
  const subjectCues = /\\b(pepe|frog|cat|kitten|siamese|dog|dragon|robot|monster|anime|sailor moon|wizard|castle|cathedral|forest|tower|gothic|metal|punk|emo|screamo|hardcore|neon|album|poster|burning|armor|balcony|sunset|dead forest)\\b/i;`;

    const visualRequestReplacement = `function seekdeepLooksLikeVisualRequest(prompt = '') {
  const p = String(prompt || '').trim().toLowerCase();
  if (!p) return false;
  if (typeof seekdeepShouldKeepPromptAsChatBeforeImage === 'function' && seekdeepShouldKeepPromptAsChatBeforeImage(p)) return false;

  const visualNouns = /\\b(image|picture|pic|photo|art|artwork|drawing|illustration|painting|poster|album cover|cover art|banner|wallpaper|logo|icon|avatar|emblem|badge|character design|scene|portrait|sticker|thumbnail|concept art|screenshot|visual)\\b/i;
  const creationVerbs = /\\b(make|create|generate|render|draw|paint|sketch|illustrate|visualize|depict|design|show|give me|turn this into|can i see|could i see|i want|i'd like|id like)\\b/i;
  const scenePreps = /\\b(of|with|wearing|holding|standing|sitting|looking|pointing|carrying|smoking|on a|in a|inside|outside|under|over|during|at sunset|at sunrise|at night|in armor|in the style of|with a|over a|under a|in .* style)\\b/i;
  const subjectCues = /\\b(pepe|frog|cat|kitten|siamese|dog|dragon|robot|monster|anime|sailor moon|wizard|castle|cathedral|forest|tower|gothic|metal|punk|emo|screamo|hardcore|neon|album|poster|burning|armor|balcony|sunset|dead forest|looneytunes|pixel|3d|cartoon)\\b/i;

  // Specific visual cues to strengthen detection
  if (/holding a sign/i.test(p)) return true;
  if (/sign that says|text that says|says ".*"/i.test(p)) return true;
  if (/in .* style/i.test(p)) return true;`;

    if (content.includes(visualRequestTarget)) {
        content = content.replace(visualRequestTarget, visualRequestReplacement);
    } else {
        console.error("Could not find seekdeepLooksLikeVisualRequest target");
    }

    // --- 3. Pending Image Subject ---
    const pendingV2Target = `async function seekdeepHandlePendingImageSubjectReplyV2(message, prompt = '', key = '') {
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

  const wantsOriginal = Boolean(pending.wantsOriginal);
  const wantsRefined = Boolean(pending.wantsRefined);`;

    const pendingV2Replacement = `async function seekdeepHandlePendingImageSubjectReplyV2(message, prompt = '', key = '') {
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

  const cleanP = prompt.toLowerCase().trim();
  const wantsBothExplicitly = /make both|original and refined|do both versions|queue both/.test(cleanP);

  let wantsOriginal = Boolean(pending.wantsOriginal);
  let wantsRefined = Boolean(pending.wantsRefined);

  if (wantsOriginal && wantsRefined && !wantsBothExplicitly) {
      wantsOriginal = true;
      wantsRefined = false;
  }`;

    if (content.includes(pendingV2Target)) {
        content = content.replace(pendingV2Target, pendingV2Replacement);
    } else {
        console.error("Could not find pendingV2 target");
    }

    const pendingV1Target = `async function seekdeepHandlePendingImageSubjectReply(message, prompt = '', key = '') {
  const pending = seekdeepConsumePendingImageSubjectRequest(message, prompt);
  if (!pending?.prompt) return false;

  if (typeof seekdeepLogRoute === 'function') seekdeepLogRoute('image-pending-subject', pending.prompt);
  if (typeof remember === 'function' && key) remember(key, 'user', \`[pending-image-subject] \${pending.prompt}\`);

  const wantsOriginal = Boolean(pending.wantsOriginal);
  const wantsRefined = Boolean(pending.wantsRefined);`;

    const pendingV1Replacement = `async function seekdeepHandlePendingImageSubjectReply(message, prompt = '', key = '') {
  const pending = seekdeepConsumePendingImageSubjectRequest(message, prompt);
  if (!pending?.prompt) return false;

  if (typeof seekdeepLogRoute === 'function') seekdeepLogRoute('image-pending-subject', pending.prompt);
  if (typeof remember === 'function' && key) remember(key, 'user', \`[pending-image-subject] \${pending.prompt}\`);

  const cleanP = prompt.toLowerCase().trim();
  const wantsBothExplicitly = /make both|original and refined|do both versions|queue both/.test(cleanP);

  let wantsOriginal = Boolean(pending.wantsOriginal);
  let wantsRefined = Boolean(pending.wantsRefined);

  if (wantsOriginal && wantsRefined && !wantsBothExplicitly) {
      wantsOriginal = true;
      wantsRefined = false;
  }`;

    if (content.includes(pendingV1Target)) {
        content = content.replace(pendingV1Target, pendingV1Replacement);
    } else {
        console.error("Could not find pendingV1 target");
    }

    // --- 4. stripQwenThinkingBlocks ---
    // Actually we only need to redefine cleanupAssistantReply since stripQwenThinkingBlocks is already in the file and we don't want to duplicate it.
    const cleanupTarget = `function cleanupAssistantReply(value) {
  let text = stripQwenThinkingBlocks(value);
  text = String(text ?? '').replace(/\\r\\n/g, '\\n');`;

    const cleanupReplacement = `function cleanupAssistantReply(value) {
  let text = typeof stripQwenThinkingBlocks === 'function' ? stripQwenThinkingBlocks(value) : String(value ?? '');
  text = String(text ?? '').replace(/\\r\\n/g, '\\n');`;

    if (content.includes(cleanupTarget)) {
        content = content.replace(cleanupTarget, cleanupReplacement);
    } else {
        console.error("Could not find cleanup target");
    }

    // --- 5. BigInt globally ---
    content = content.replace(/try \{ return JSON\.stringify\(a\); \} catch \{ return String\(a\); \}/g, "try { return JSON.stringify(a, (_, v) => typeof v === 'bigint' ? v.toString() : v); } catch { return String(a); }");
    content = content.replace(/JSON\.stringify\(([^,]+?),\s*null,\s*2\)/g, "JSON.stringify($1, (_, v) => typeof v === 'bigint' ? v.toString() : v, null, 2)");
    content = content.replace(/body:\s*JSON\.stringify\(body\)/g, "body: JSON.stringify(body, (_, v) => typeof v === 'bigint' ? v.toString() : v)");
    content = content.replace(/try \{ text = typeof detail === 'string' \? detail : JSON\.stringify\(detail\); \} catch \{ text = String\(detail\); \}/g, "try { text = typeof detail === 'string' ? detail : JSON.stringify(detail, (_, v) => typeof v === 'bigint' ? v.toString() : v); } catch { text = String(detail); }");
    content = content.replace(/detailText = typeof detail === 'string' \? detail : JSON\.stringify\(detail\);/g, "detailText = typeof detail === 'string' ? detail : JSON.stringify(detail, (_, v) => typeof v === 'bigint' ? v.toString() : v);");

    // --- 6. Missing visual override on chat safety gate ---
    const chatSafetyGateTarget = `if (isContextualFollowup && !lastWasImage && !hasExplicitImage) {
      if (typeof seekdeepLogRoute === 'function') {
        seekdeepLogRoute('chat-context-safety-gate', prompt);
      }`;

    const chatSafetyGateReplacement = `if (isContextualFollowup && !lastWasImage && !hasExplicitImage) {
      if (typeof seekdeepRememberImageSubjectPrompt === 'function' && typeof seekdeepLooksLikeVisualRequest === 'function' && seekdeepLooksLikeVisualRequest(prompt)) {
          seekdeepRememberImageSubjectPrompt(message, prompt);
      }
      if (typeof seekdeepLogRoute === 'function') {
        seekdeepLogRoute('chat-context-safety-gate', prompt);
      }`;

    if (content.includes(chatSafetyGateTarget)) {
        content = content.replace(chatSafetyGateTarget, chatSafetyGateReplacement);
    } else {
        console.error("Could not find chatSafetyGateTarget");
    }

    // --- 7. Context Menu Generation ---
    const contextMenuTarget = `async function seekdeepHandleContextMenuGenerateImage(interaction, targetMessage) {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const rawPrompt = seekdeepExtractContextMenuPromptText(targetMessage);
  if (!rawPrompt) {
    await interaction.editReply({
      content: 'That message has no text I can use as an image prompt (only attachments/embeds). Pick a message with text.',
    });
    return;
  }

  const prompt = rawPrompt.slice(0, 500).replace(/[,;:\\s]+$/g, '').trim();

  // Right-click is an intentional user action — do NOT block on frustration
  // heuristics. If the user picked this message on purpose, send it through.

  if (typeof seekdeepLogRoute === 'function') {
    seekdeepLogRoute('context-menu-generate-image', prompt);
  }

  await interaction.editReply({
    content: 'Queued: original (no refinement)\\nPrompt: ' + prompt.slice(0, 400),
  });

  // Build a proxy message so we can reuse seekdeepSendImageWithButtons exactly
  // like the regular natural-language path. The proxy replies into the original channel.
  const proxy = {
    author: { id: interaction.user?.id || 'unknown' },
    channel: interaction.channel || null,
    guild: interaction.guild || null,
    client: interaction.client || client,
    reply: async (payload) => {
      try { return await interaction.channel.send(payload); } catch (e) { console.error('ContextMenu proxy send failed', e); }
    },
  };

  await seekdeepSendImageWithButtons(proxy, prompt, 1024, 1024, null, {
    refine: false,
    ground: true,
    cleanPrompt: prompt,
  });
}`;

    const contextMenuReplacement = `const SEEKDEEP_CONTEXT_MENU_GUARD = new Map();

async function seekdeepHandleContextMenuGenerateImage(interaction, targetMessage) {
  const guardKey = \`generate-image-from-this:\${interaction.user?.id || 'unknown'}:\${targetMessage?.id || 'unknown'}\`;
  if (SEEKDEEP_CONTEXT_MENU_GUARD.has(guardKey)) {
      try {
          await interaction.reply({ content: 'Already processing that request.', flags: MessageFlags.Ephemeral });
      } catch {}
      return;
  }
  SEEKDEEP_CONTEXT_MENU_GUARD.set(guardKey, true);

  try {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    let rawPrompt = seekdeepExtractContextMenuPromptText(targetMessage);

    if (!rawPrompt && targetMessage?.content) {
       if (targetMessage.content.startsWith('Refined prompt:') || targetMessage.content.startsWith('Prompt:')) {
           rawPrompt = targetMessage.content.replace(/^Refined prompt:\\s*|^Prompt:\\s*/i, '').trim();
       }
    }

    if (!rawPrompt || /^(Image generation failed:|Queued:|Generated:|Time to Generate:|Model Used:|Refinement:|Queue Wait:|Job ID:)/i.test(targetMessage?.content || '')) {
      await interaction.editReply({
        content: 'That message has no valid text I can use as an image prompt or is a status/error message. Pick a message with a text prompt.',
      });
      return;
    }

    const prompt = rawPrompt.slice(0, 500).replace(/[,;:\\s]+$/g, '').trim();

    if (typeof seekdeepLogRoute === 'function') {
      seekdeepLogRoute('context-menu-generate-image', prompt);
    }

    await interaction.editReply({
      content: 'Queued: original (no refinement)\\nPrompt: ' + prompt.slice(0, 400),
    });

    const proxy = {
      author: { id: String(interaction.user?.id || 'unknown') },
      channel: { id: String(interaction.channelId || '') },
      guild: interaction.guildId ? { id: String(interaction.guildId) } : null,
      id: \`ctx:\${interaction.id}\`,
      content: prompt,
      reply: async (payload) => {
        if (interaction.channel && typeof interaction.channel.send === 'function') {
          return await interaction.channel.send(payload);
        }
        return null;
      },
    };

    try {
      await seekdeepSendImageWithButtons(proxy, prompt, 1024, 1024, null, {
        refine: false,
        ground: true,
        cleanPrompt: prompt,
        skipCooldown: false,
        silentAck: true,
      });
    } catch (err) {
      console.error('Context menu Generate Image failed:', err?.stack || err?.message || err);
      try {
        await interaction.followUp({
          content: 'Image generation failed: ' + (err?.message || 'unknown error').slice(0, 500),
          flags: MessageFlags.Ephemeral,
        });
      } catch {}
    }
  } finally {
      setTimeout(() => SEEKDEEP_CONTEXT_MENU_GUARD.delete(guardKey), 10000);
  }
}`;

    if (content.includes(contextMenuTarget)) {
        content = content.replace(contextMenuTarget, contextMenuReplacement);
    } else {
        console.error("Could not find contextMenuTarget");
    }

    // --- 8. Re-Refine Mode Context Logic ---
    const reRefineTarget = `const queueOne = async (regenMode, routeName, suffix) => {
    const proxy = typeof seekdeepPromptChoiceProxyMessage === 'function'`;

    const reRefineReplacement = `const queueOne = async (regenMode, routeName, suffix) => {
    let finalPrompt = basePrompt;
    if (regenMode === 'rerefine' && typeof seekdeepIsGenericImageFollowupPrompt === 'function' && seekdeepIsGenericImageFollowupPrompt(finalPrompt)) {
        const item = SEEKDEEP_RECENT_IMAGE_SUBJECTS.get(seekdeepImageContextKeyFromMessage(interaction));
        if (item && item.prompt) {
             finalPrompt = item.prompt;
        }
    }
    const proxy = typeof seekdeepPromptChoiceProxyMessage === 'function'`;

    if (content.includes(reRefineTarget)) {
        content = content.replace(reRefineTarget, reRefineReplacement);
    } else {
        console.error("Could not find reRefineTarget");
    }

    const queueOptionsTarget = `const regenOptions = seekdeepRegenerateModeOptions(regenMode, { ...state, originalPrompt: basePrompt });
    seekdeepLogRoute(routeName, basePrompt);
    return seekdeepSendImageWithButtons(proxy, basePrompt, width, height, seed, {`;

    const queueOptionsReplacement = `const regenOptions = seekdeepRegenerateModeOptions(regenMode, { ...state, originalPrompt: finalPrompt });
    seekdeepLogRoute(routeName, finalPrompt);
    return seekdeepSendImageWithButtons(proxy, finalPrompt, width, height, seed, {`;

    if (content.includes(queueOptionsTarget)) {
        content = content.replace(queueOptionsTarget, queueOptionsReplacement);
    } else {
        console.error("Could not find queueOptionsTarget");
    }

    fs.writeFileSync('index.js', content);
}
applyFix();
