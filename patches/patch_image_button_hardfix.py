from pathlib import Path
import re
import sys

if len(sys.argv) != 2:
    raise SystemExit("Usage: patch_image_button_hardfix.py <index.js>")

path = Path(sys.argv[1])
raw = path.read_bytes()
newline = "\r\n" if b"\r\n" in raw else "\n"
text = raw.decode("utf-8-sig").replace("\r\n", "\n").replace("\r", "\n")


def fail(msg):
    raise SystemExit(msg)


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
        nxt = source[i + 1] if i + 1 < len(source) else ''

        if in_line_comment:
            if ch == '\n':
                in_line_comment = False
            i += 1
            continue

        if in_block_comment:
            if ch == '*' and nxt == '/':
                in_block_comment = False
                i += 2
                continue
            i += 1
            continue

        if in_single:
            if not escaped and ch == '\\':
                escaped = True
            elif not escaped and ch == "'":
                in_single = False
            else:
                escaped = False
            i += 1
            continue

        if in_double:
            if not escaped and ch == '\\':
                escaped = True
            elif not escaped and ch == '"':
                in_double = False
            else:
                escaped = False
            i += 1
            continue

        if in_template:
            if not escaped and ch == '\\':
                escaped = True
            elif not escaped and ch == '`':
                in_template = False
            else:
                escaped = False
            i += 1
            continue

        if ch == '/' and nxt == '/':
            in_line_comment = True
            i += 2
            continue

        if ch == '/' and nxt == '*':
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

        if ch == '`':
            in_template = True
            i += 1
            continue

        if ch == '{':
            depth += 1
        elif ch == '}':
            depth -= 1
            if depth == 0:
                return i

        i += 1

    fail('Could not find matching closing brace.')


def get_function(source, name):
    for prefix in ('async function ', 'function '):
        start = source.find(f'{prefix}{name}(')
        if start >= 0:
            break
    else:
        return None, -1, -1

    open_brace = source.find('{', start)
    if open_brace < 0:
        fail(f'Could not locate opening brace for {name}.')
    close_brace = find_matching_brace(source, open_brace)
    return source[start:close_brace + 1], start, close_brace + 1


def replace_function(source, name, new_fn):
    _, start, end = get_function(source, name)
    if start < 0:
        fail(f'Missing function: {name}')
    return source[:start] + new_fn.rstrip() + source[end:]


# ------------------------------------------------------------------
# Ensure regenerate-mode helper exists and is correct.
# ------------------------------------------------------------------
helper = r"""function seekdeepRegenerateModeOptions(mode = 'submitted', action = null) {
  const normalized = String(mode || 'submitted').toLowerCase();
  const basePrompt = action?.originalPrompt || action?.prompt || action?.rawPrompt || 'image';
  const base = {
    ground: action?.ground !== false && action?.imageModeOptions?.ground !== false,
    cleanPrompt: basePrompt,
    silentAck: true,
    skipCooldown: true,
  };

  if (normalized === 'original' || normalized === 'raw') {
    return { ...base, refine: false };
  }

  if (normalized === 'refined') {
    return { ...base, refine: true };
  }

  const originallyRaw =
    action?.refine === false ||
    action?.refinement === false ||
    action?.refinementMode === 'off' ||
    action?.imageModeOptions?.refine === false;

  return { ...base, refine: !originallyRaw };
}"""

if 'function seekdeepRegenerateModeOptions' in text:
    text = replace_function(text, 'seekdeepRegenerateModeOptions', helper)
else:
    pos = text.find('async function seekdeepHandleImageButton(')
    if pos < 0:
        fail('Could not find insertion point for seekdeepRegenerateModeOptions.')
    text = text[:pos] + helper + '\n\n' + text[pos:]


# ------------------------------------------------------------------
# Replace image action row with Original / Refined / Both.
# ------------------------------------------------------------------
new_row = r"""function seekdeepImageActionRow(actionId, downloadUrl = null) {
  const buttons = [
    new ButtonBuilder()
      .setCustomId(`seekdeep:regen:original:${actionId}`)
      .setLabel('Original')
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(`seekdeep:regen:refined:${actionId}`)
      .setLabel('Refined')
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId(`seekdeep:regen:both:${actionId}`)
      .setLabel('Both')
      .setStyle(ButtonStyle.Success),
  ];

  if (downloadUrl) {
    buttons.push(
      new ButtonBuilder()
        .setLabel('Download')
        .setStyle(ButtonStyle.Link)
        .setURL(downloadUrl)
    );
  }

  buttons.push(
    new ButtonBuilder()
      .setCustomId(`seekdeep:archive:${actionId}`)
      .setLabel('Archive')
      .setStyle(ButtonStyle.Success)
  );

  return new ActionRowBuilder().addComponents(...buttons);
}"""

if 'function seekdeepImageActionRow' in text:
    text = replace_function(text, 'seekdeepImageActionRow', new_row)

# ------------------------------------------------------------------
# Preserve more metadata in temp image state for future regenerate.
# Patch both sender functions if they exist.
# ------------------------------------------------------------------
for fn_name in ('seekdeepSendImageWithButtonsMessage', 'seekdeepSendImageWithButtonsInteraction'):
    fn, s, e = get_function(text, fn_name)
    if s < 0:
        continue
    marker = 'const state = seekdeepRememberTempImageState({'
    idx = fn.find(marker)
    if idx >= 0 and 'originalPrompt:' not in fn[idx:idx+500]:
        replacement = """const state = seekdeepRememberTempImageState({
          id: actionId,
          prompt,
          originalPrompt: seekdeepImageModeOptions.cleanPrompt || prompt,
          width,
          height,
          seed,
          refine: seekdeepImageModeOptions.refine !== false,
          ground: seekdeepImageModeOptions.ground !== false,
          imageModeOptions: {
            refine: seekdeepImageModeOptions.refine !== false,
            ground: seekdeepImageModeOptions.ground !== false,
          },"""
        fn = fn.replace("""const state = seekdeepRememberTempImageState({
        id: actionId,
        prompt,
        width,
        height,
        seed,""", replacement, 1)
        text = text[:s] + fn + text[e:]

# ------------------------------------------------------------------
# Replace the entire image-button handler.
# ------------------------------------------------------------------
new_handler = r"""async function seekdeepHandleImageButton(interaction) {
  const startedAt = seekdeepNowMs();
  const customId = String(interaction?.customId || '').trim();

  if (!customId.startsWith('seekdeep:')) {
    return false;
  }

  if (/^seekdeep:prompt:(original|refined|both):/.test(customId)) {
    if (typeof seekdeepHandlePromptChoiceButton === 'function') {
      return await seekdeepHandlePromptChoiceButton(interaction);
    }
    return false;
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
            content: seekdeepAppendResponseFooter(seekdeepImageCooldownText(remaining), {
              startedAt,
              modelUsed: seekdeepNoModelLabel(),
            }),
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
    console.warn('Regenerate button cooldown check failed:', err?.message || err);
  }

  const parsed =
    customId.match(/^seekdeep:regen:(original|refined|both):(.+)$/) ||
    customId.match(/^seekdeep:(regenerate|download|archive|save):(.+)$/) ||
    customId.match(/^seekdeep:image:(regen|archive|save):(.+)$/);

  if (!parsed) {
    return false;
  }

  let action = '';
  let mode = 'submitted';
  let actionId = '';

  if (customId.startsWith('seekdeep:regen:')) {
    action = 'regenerate';
    mode = parsed[1] || 'submitted';
    actionId = parsed[2] || '';
  } else if (customId.startsWith('seekdeep:image:')) {
    action = parsed[1] === 'regen' ? 'regenerate' : (parsed[1] === 'save' ? 'archive' : parsed[1]);
    actionId = parsed[2] || '';
  } else {
    action = parsed[1] === 'save' ? 'archive' : parsed[1];
    actionId = parsed[2] || '';
  }

  if (!interaction?.deferred && !interaction?.replied) {
    await interaction.deferReply({ ephemeral: true });
  }

  let state = seekdeepTempImageStateIndex?.get?.(actionId) || null;
  if (!state && typeof seekdeepLoadTempImageState === 'function') {
    state = seekdeepLoadTempImageState(actionId);
  }

  if (!state) {
    await interaction.editReply({
      content: seekdeepAppendResponseFooter('That image action expired from the temporary cache. Generate it again if you still want to use its buttons.', {
        startedAt,
        modelUsed: seekdeepNoModelLabel(),
      }),
    });
    return true;
  }

  if (action === 'archive') {
    const savedPath = seekdeepArchiveImageStateToDisk(state);
    const shownPath = typeof seekdeepRedactArchivePathForDiscord === 'function'
      ? seekdeepRedactArchivePathForDiscord(savedPath)
      : savedPath;

    await interaction.editReply({
      content: seekdeepAppendResponseFooter(`Archived on the bot host:\n\`${shownPath}\``, {
        startedAt,
        modelUsed: seekdeepNoModelLabel(),
      }),
    });
    return true;
  }

  if (action === 'download') {
    const downloadText = state?.downloadUrl || state?.url || state?.proxyURL || state?.attachmentUrl
      ? `Download URL:\n${state.downloadUrl || state.url || state.proxyURL || state.attachmentUrl}`
      : 'Use the image attachment in the channel to download this image.';

    await interaction.editReply({
      content: seekdeepAppendResponseFooter(downloadText, {
        startedAt,
        modelUsed: seekdeepNoModelLabel(),
      }),
    });
    return true;
  }

  if (action !== 'regenerate') {
    await interaction.editReply({
      content: seekdeepAppendResponseFooter('Unknown image action.', {
        startedAt,
        modelUsed: seekdeepNoModelLabel(),
      }),
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

    return await seekdeepSendImageWithButtonsMessage(
      proxy,
      basePrompt,
      width,
      height,
      seed,
      seekdeepRegenerateModeOptions(regenMode, {
        ...state,
        originalPrompt: basePrompt,
        ground: grounded,
      }),
    );
  };

  if (mode === 'both') {
    await interaction.editReply({
      content: seekdeepAppendResponseFooter([
        'Queued both regenerate versions.',
        '',
        grounded ? 'Grounding: on' : 'Grounding: off',
        'Jobs queued:',
        '1. Original prompt',
        '2. Refined prompt',
      ].join('\n'), {
        startedAt,
        modelUsed: seekdeepNoModelLabel(),
      }),
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
    content: seekdeepAppendResponseFooter([
      resolvedMode === 'original' ? 'Queued original regenerate.' : 'Queued refined regenerate.',
      '',
      grounded ? 'Grounding: on' : 'Grounding: off',
      resolvedMode === 'original' ? 'Refinement: off' : 'Refinement: on',
      'Queued Jobs: 1',
    ].join('\n'), {
      startedAt,
      modelUsed: seekdeepNoModelLabel(),
    }),
  });

  void queueOne(resolvedMode, resolvedMode === 'original' ? 'image-choice-original' : 'image-choice-refined', `regen-${resolvedMode}`);
  return true;
}"""

text = replace_function(text, 'seekdeepHandleImageButton', new_handler)

# scrub obvious stale leftovers inside the new function body check
handler, _, _ = get_function(text, 'seekdeepHandleImageButton')
if 'const match =' in handler or re.search(r'\bmatch\[', handler):
    fail('Stale match references still remain in seekdeepHandleImageButton.')
if handler.count('const customId =') != 1:
    fail('Unexpected customId declaration count in seekdeepHandleImageButton.')

out = text if newline == '\n' else text.replace('\n', '\r\n')
path.write_bytes(out.encode('utf-8'))
print('Applied image button hard-fix.')