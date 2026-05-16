from pathlib import Path
import sys

if len(sys.argv) != 2:
    raise SystemExit("Usage: patch_prompt_choice_emergency.py <index.js>")

path = Path(sys.argv[1])
raw = path.read_bytes()
newline = "\r\n" if b"\r\n" in raw else "\n"
text = raw.decode("utf-8-sig").replace("\r\n", "\n").replace("\r", "\n")

start_marker = "// SEEKDEEP_PROMPT_CHOICE_EMERGENCY_START"
end_marker = "// SEEKDEEP_PROMPT_CHOICE_EMERGENCY_END"

block = r'''// SEEKDEEP_PROMPT_CHOICE_EMERGENCY_START
const SEEKDEEP_PROMPT_CHOICE_EMERGENCY_SEEN = globalThis.__SEEKDEEP_PROMPT_CHOICE_EMERGENCY_SEEN || new Set();
globalThis.__SEEKDEEP_PROMPT_CHOICE_EMERGENCY_SEEN = SEEKDEEP_PROMPT_CHOICE_EMERGENCY_SEEN;

async function seekdeepEmergencyHandlePromptChoiceButton(interaction) {
  const customId = String(interaction?.customId || '');
  const match = customId.match(/^seekdeep:prompt:(original|refined|both):(.+)$/);
  if (!match) return false;

  if (interaction?.id && SEEKDEEP_PROMPT_CHOICE_EMERGENCY_SEEN.has(interaction.id)) {
    return true;
  }
  if (interaction?.id) {
    SEEKDEEP_PROMPT_CHOICE_EMERGENCY_SEEN.add(interaction.id);
    setTimeout(() => {
      try { SEEKDEEP_PROMPT_CHOICE_EMERGENCY_SEEN.delete(interaction.id); } catch {}
    }, 300000).unref?.();
  }

  const action = match[1];
  const id = match[2];
  const startedAt = typeof seekdeepNowMs === 'function' ? seekdeepNowMs() : Date.now();

  try {
    if (!interaction.deferred && !interaction.replied) {
      await interaction.deferUpdate();
    }
  } catch (err) {
    console.warn('Emergency prompt-choice deferUpdate failed:', err?.message || err);
  }

  if (typeof seekdeepSweepPendingImagePrompts === 'function') {
    try { seekdeepSweepPendingImagePrompts(); } catch {}
  }

  const pendingMap = globalThis.SEEKDEEP_PENDING_IMAGE_PROMPTS || SEEKDEEP_PENDING_IMAGE_PROMPTS;
  const state = pendingMap?.get?.(id) || null;

  const editChoiceMessage = async (payload) => {
    try {
      if (interaction?.message && typeof interaction.message.edit === 'function') {
        await interaction.message.edit(payload);
        return true;
      }
    } catch (err) {
      console.warn('Emergency prompt-choice message edit failed:', err?.message || err);
    }

    try {
      if (interaction?.deferred || interaction?.replied) {
        await interaction.editReply(payload);
        return true;
      }
    } catch (err) {
      console.warn('Emergency prompt-choice editReply fallback failed:', err?.message || err);
    }

    return false;
  };

  const privateNotice = async (content) => {
    try {
      await interaction.followUp({ content, ephemeral: true });
    } catch (err) {
      console.warn('Emergency prompt-choice followUp failed:', err?.message || err);
    }
  };

  if (!state) {
    const expiredText = [
      'Prompt choice expired before a version was selected.',
      'Run the image request again to reopen Original / Refined / Both.',
    ].join('\n');

    await editChoiceMessage({
      content: typeof seekdeepAppendResponseFooter === 'function'
        ? seekdeepAppendResponseFooter(expiredText, {
            startedAt,
            modelUsed: typeof seekdeepNoModelLabel === 'function' ? seekdeepNoModelLabel() : 'local command (no AI model)',
          })
        : expiredText,
      components: [],
    });

    return true;
  }

  if (state.requesterId && interaction?.user?.id !== state.requesterId) {
    await privateNotice('Only the requester can use these image prompt buttons.');
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
    await privateNotice('That version has already been queued for this prompt.');
    return true;
  }

  state.originalQueued = Boolean(state.originalQueued || needsOriginal);
  state.refinedQueued = Boolean(state.refinedQueued || needsRefined);
  state.lastSelectedAt = Date.now();
  pendingMap.set(id, state);

  const allQueued = Boolean(state.originalQueued && state.refinedQueued);
  if (allQueued) {
    try { pendingMap.delete(id); } catch {}
  }

  const selectionSummary = [
    needsOriginal && needsRefined ? 'Queued both:' : needsOriginal ? 'Queued original.' : 'Queued refined.',
    needsOriginal && needsRefined ? 'â€¢ Original' : '',
    needsOriginal && needsRefined ? 'â€¢ Refined' : '',
    '',
    groundingLine,
    needsOriginal && !needsRefined ? 'Refinement: off' : '',
    needsRefined && !needsOriginal ? 'Refinement: on' : '',
    `Queued Jobs: ${[needsOriginal, needsRefined].filter(Boolean).length}`,
    '',
    allQueued ? 'Both versions have now been queued.' : 'You can still choose the remaining version from this prompt.',
  ].filter(Boolean).join('\n');

  const choiceRow = !allQueued && typeof seekdeepPendingPromptChoiceRow === 'function'
    ? [seekdeepPendingPromptChoiceRow(id, state)]
    : [];

  await editChoiceMessage({
    content: typeof seekdeepAppendResponseFooter === 'function'
      ? seekdeepAppendResponseFooter(selectionSummary, {
          startedAt,
          modelUsed: typeof seekdeepNoModelLabel === 'function' ? seekdeepNoModelLabel() : 'local command (no AI model)',
        })
      : selectionSummary,
    components: choiceRow,
  });

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
      console.warn(`Emergency prompt-choice generation failed (${routeName}):`, err?.stack || err?.message || err);
    }
  };

  if (needsOriginal) {
    const originalProxy = typeof seekdeepPromptChoiceProxyMessage === 'function'
      ? seekdeepPromptChoiceProxyMessage(interaction, state.requesterId, 'original')
      : {
          author: { id: state.requesterId || interaction?.user?.id || 'unknown' },
          channel: interaction?.channel || null,
          id: `${interaction?.id || 'prompt'}:original:${Date.now()}`,
          reply: async () => null,
        };

    void runQueuedSelection(
      originalProxy,
      basePrompt,
      {
        refine: false,
        ground: groundingOn,
        cleanPrompt: basePrompt,
        skipCooldown: true,
        silentAck: true,
      },
      'image-choice-original'
    );
  }

  if (needsRefined) {
    const refinedProxy = typeof seekdeepPromptChoiceProxyMessage === 'function'
      ? seekdeepPromptChoiceProxyMessage(interaction, state.requesterId, 'refined')
      : {
          author: { id: state.requesterId || interaction?.user?.id || 'unknown' },
          channel: interaction?.channel || null,
          id: `${interaction?.id || 'prompt'}:refined:${Date.now()}`,
          reply: async () => null,
        };

    void runQueuedSelection(
      refinedProxy,
      basePrompt,
      {
        refine: true,
        ground: groundingOn,
        cleanPrompt: basePrompt,
        skipCooldown: true,
        silentAck: true,
      },
      'image-choice-refined'
    );
  }

  return true;
}

client.on('interactionCreate', async (interaction) => {
  try {
    if (!(interaction?.isButton && interaction.isButton())) return;
    const customId = String(interaction?.customId || '');
    if (!customId.startsWith('seekdeep:prompt:')) return;
    await seekdeepEmergencyHandlePromptChoiceButton(interaction);
  } catch (err) {
    console.error('Emergency prompt-choice listener failed:', err);
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
// SEEKDEEP_PROMPT_CHOICE_EMERGENCY_END
'''

if start_marker in text and end_marker in text:
    start = text.index(start_marker)
    end = text.index(end_marker) + len(end_marker)
    text = text[:start] + block + text[end:]
else:
    text = text.rstrip() + "\n\n" + block + "\n"

for needle in [
    'seekdeepEmergencyHandlePromptChoiceButton',
    "customId.startsWith('seekdeep:prompt:')",
    'await interaction.deferUpdate()',
    'seekdeepSendImageWithButtonsMessage',
]:
    if needle not in text:
        raise SystemExit(f'Missing required emergency patch element: {needle}')

path.write_bytes((text if newline == "\n" else text.replace("\n", "\r\n")).encode('utf-8'))
print('Installed emergency prompt-choice listener.')