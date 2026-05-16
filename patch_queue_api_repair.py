from pathlib import Path
from datetime import datetime

path = Path('index.js')
text = path.read_text(encoding='utf-8-sig')

stamp = datetime.now().strftime('%Y%m%d-%H%M%S')
backup = Path(f'index.js.bak-queue-api-repair-{stamp}')
backup.write_text(text, encoding='utf-8')
print(f'[SeekDeep] Backup written: {backup}')

def find_function_range(src: str, name: str):
    starts = []
    for prefix in [f'async function {name}', f'function {name}']:
        pos = src.find(prefix)
        if pos != -1:
            starts.append(pos)

    if not starts:
        return None

    start = min(starts)
    paren = src.find('(', start)
    if paren == -1:
        raise SystemExit(f'Found {name}, but no opening parenthesis.')

    depth_paren = 0
    in_string = None
    escape = False
    line_comment = False
    block_comment = False
    i = paren

    while i < len(src):
        ch = src[i]
        nxt = src[i + 1] if i + 1 < len(src) else ''

        if line_comment:
            if ch == '\n':
                line_comment = False
            i += 1
            continue

        if block_comment:
            if ch == '*' and nxt == '/':
                block_comment = False
                i += 2
                continue
            i += 1
            continue

        if in_string:
            if escape:
                escape = False
            elif ch == '\\':
                escape = True
            elif ch == in_string:
                in_string = None
            i += 1
            continue

        if ch == '/' and nxt == '/':
            line_comment = True
            i += 2
            continue

        if ch == '/' and nxt == '*':
            block_comment = True
            i += 2
            continue

        if ch in ("'", '"', '`'):
            in_string = ch
            i += 1
            continue

        if ch == '(':
            depth_paren += 1
        elif ch == ')':
            depth_paren -= 1
            if depth_paren == 0:
                i += 1
                break

        i += 1

    brace = src.find('{', i)
    if brace == -1:
        raise SystemExit(f'Found {name}, but no function body brace.')

    depth = 0
    in_string = None
    escape = False
    line_comment = False
    block_comment = False
    i = brace

    while i < len(src):
        ch = src[i]
        nxt = src[i + 1] if i + 1 < len(src) else ''

        if line_comment:
            if ch == '\n':
                line_comment = False
            i += 1
            continue

        if block_comment:
            if ch == '*' and nxt == '/':
                block_comment = False
                i += 2
                continue
            i += 1
            continue

        if in_string:
            if escape:
                escape = False
            elif ch == '\\':
                escape = True
            elif ch == in_string:
                in_string = None
            i += 1
            continue

        if ch == '/' and nxt == '/':
            line_comment = True
            i += 2
            continue

        if ch == '/' and nxt == '*':
            block_comment = True
            i += 2
            continue

        if ch in ("'", '"', '`'):
            in_string = ch
            i += 1
            continue

        if ch == '{':
            depth += 1
        elif ch == '}':
            depth -= 1
            if depth == 0:
                return start, i + 1

        i += 1

    raise SystemExit(f'Could not find closing brace for {name}.')

def replace_function(src: str, name: str, replacement: str, required=True):
    rng = find_function_range(src, name)
    if rng is None:
        if required:
            raise SystemExit(f'Could not find function: {name}')
        print(f'[SeekDeep] Skipped missing function: {name}')
        return src, False

    start, end = rng
    return src[:start] + replacement.strip() + '\n\n' + src[end:].lstrip(), True

# Keep/fix mojibake cleanup.
mojibake_replacements = {
    'Iâ€™m': 'I’m',
    'youâ€™re': 'you’re',
    'Youâ€™re': 'You’re',
    'donâ€™t': 'don’t',
    'Donâ€™t': 'Don’t',
    'canâ€™t': 'can’t',
    'Canâ€™t': 'Can’t',
    'wonâ€™t': 'won’t',
    'Wonâ€™t': 'Won’t',
    'itâ€™s': 'it’s',
    'Itâ€™s': 'It’s',
    'thatâ€™s': 'that’s',
    'Thatâ€™s': 'That’s',
    'Nathanâ€™s': 'Nathan’s',
    'â€”': '—',
    'â€œ': '“',
    'â€': '”',
    'â€˜': '‘',
    'â€™': '’',
    'rÃ©sumÃ©': 'résumé',
}
fixed_count = 0
for bad, good in mojibake_replacements.items():
    if bad in text:
        fixed_count += text.count(bad)
        text = text.replace(bad, good)
print(f'[SeekDeep] Fixed mojibake occurrences: {fixed_count}')

typing_helpers = r'''
// SEEKDEEP_TYPING_WORKING_HOTFIX_START
function seekdeepStartWorkingLoop(channel, label = 'working') {
  if (typeof startSeekDeepTypingLoop === 'function') {
    return startSeekDeepTypingLoop(channel, label);
  }

  let stopped = false;
  let interval = null;

  const tick = async () => {
    if (stopped) return;
    try {
      if (channel && typeof channel.sendTyping === 'function') {
        await channel.sendTyping();
      }
    } catch (err) {
      console.warn(`Working indicator failed for ${label}:`, err?.message || err);
    }
  };

  tick();
  interval = setInterval(tick, Number(process.env.SEEKDEEP_TYPING_INTERVAL_MS || 8000));

  return {
    stop() {
      stopped = true;
      if (interval) clearInterval(interval);
      interval = null;
    },
  };
}

function seekdeepStopWorkingLoop(loop) {
  try {
    if (loop && typeof loop.stop === 'function') loop.stop();
  } catch {}
}
// SEEKDEEP_TYPING_WORKING_HOTFIX_END
'''

if '// SEEKDEEP_TYPING_WORKING_HOTFIX_START' in text:
    start = text.find('// SEEKDEEP_TYPING_WORKING_HOTFIX_START')
    end = text.find('// SEEKDEEP_TYPING_WORKING_HOTFIX_END', start)
    if end == -1:
        raise SystemExit('Found typing helper start marker but no end marker.')
    end += len('// SEEKDEEP_TYPING_WORKING_HOTFIX_END')
    text = text[:start] + typing_helpers.strip() + '\n\n' + text[end:].lstrip()
    print('[SeekDeep] Refreshed typing helper block.')
else:
    anchor = '// SEEKDEEP_TYPING_DEDUPE_START'
    pos = text.find(anchor)
    if pos == -1:
        anchor = 'async function seekdeepSendImageWithButtonsMessage'
        pos = text.find(anchor)
    if pos == -1:
        raise SystemExit('Could not find insertion point for typing helper block.')
    text = text[:pos] + typing_helpers.strip() + '\n\n' + text[pos:]
    print('[SeekDeep] Inserted typing helper block.')

enqueue_func = r'''
function seekdeepEnqueueImageJob(job, runner) {
  if (!job || typeof runner !== 'function') {
    throw new Error('Invalid image queue job.');
  }

  return new Promise((resolve, reject) => {
    seekdeepImageQueueState.pending.push({ job, runner, resolve, reject });
    void seekdeepPumpImageQueue();
  });
}
'''
text, _ = replace_function(text, 'seekdeepEnqueueImageJob', enqueue_func)
print('[SeekDeep] Restored seekdeepEnqueueImageJob(job, runner) API.')

message_func = r'''
async function seekdeepSendImageWithButtonsMessage(message, prompt, width = 1024, height = 1024, seed = null) {
  const requestStartedAt = seekdeepNowMs();
  const userId = message?.author?.id || 'unknown';
  const cooldown = seekdeepImageCooldownRemaining(userId);

  if (cooldown > 0) {
    return await message.reply({
      content: seekdeepAppendResponseFooter(seekdeepImageCooldownText(cooldown), {
        startedAt: requestStartedAt,
        modelUsed: seekdeepNoModelLabel(),
      }),
      allowedMentions: { repliedUser: false },
    });
  }

  seekdeepRememberImageCooldown(userId);

  const workingLoop = seekdeepStartWorkingLoop(message?.channel, `image:${message?.id || prompt}`);
  const position = seekdeepImageQueueCurrentPosition();
  const job = seekdeepCreateImageQueueJob({
    source: 'message',
    userId,
    channelId: message?.channel?.id || '',
    prompt,
    width,
    height,
    seed,
  });

  const startNotice = seekdeepImageQueueAckText(job, position);

  try {
    await message.reply({
      content: seekdeepAppendResponseFooter(startNotice, {
        startedAt: job.enqueuedAt || requestStartedAt,
        modelUsed: seekdeepNoModelLabel(),
      }),
      allowedMentions: { repliedUser: false },
    });
  } catch (err) {
    console.warn('Could not send image queue acknowledgement; falling back to channel.send:', err?.message || err);

    try {
      if (message?.channel && typeof message.channel.send === 'function') {
        await message.channel.send({
          content: seekdeepAppendResponseFooter(startNotice, {
            startedAt: job.enqueuedAt || requestStartedAt,
            modelUsed: seekdeepNoModelLabel(),
          }),
          allowedMentions: { repliedUser: false },
        });
      }
    } catch (fallbackErr) {
      console.warn('Could not send fallback image queue acknowledgement:', fallbackErr?.message || fallbackErr);
    }
  }

  return await seekdeepEnqueueImageJob(job, async (runningJob) => {
    try {
      const result = await makeImageResult(prompt, width, height, seed);
      const normalized = seekdeepNormalizeGeneratedImageResult(result);
      const actionId = seekdeepMakeImageActionId();

      const state = seekdeepRememberTempImageState({
        id: actionId,
        prompt,
        width,
        height,
        seed,
        filename: normalized.filename,
        buffer: normalized.buffer,
        mimeType: 'image/png',
        createdAt: Date.now(),
        expiresAt: Date.now() + SEEKDEEP_IMAGE_CACHE_TTL_MS,
      });

      const content = seekdeepAppendResponseFooter([
        `Generated locally: ${prompt}`,
        `Queue Wait: ${seekdeepImageQueueWaitSeconds(runningJob)} seconds`,
        `Job ID: ${runningJob.id}`,
      ].join('\n'), {
        startedAt: runningJob.startedAt,
        modelUsed: seekdeepImageModelLabel(),
      });

      let sent = null;

      try {
        sent = await message.reply({
          content,
          files: [normalized.attachment],
          components: [seekdeepImageActionRow(actionId)],
          allowedMentions: { repliedUser: false },
        });
      } catch (err) {
        console.warn('Image result reply failed; falling back to channel.send:', err?.message || err);

        if (message?.channel && typeof message.channel.send === 'function') {
          sent = await message.channel.send({
            content,
            files: [normalized.attachment],
            components: [seekdeepImageActionRow(actionId)],
            allowedMentions: { repliedUser: false },
          });
        } else {
          throw err;
        }
      }

      try {
        sent = await seekdeepAttachDownloadButton(sent, state.id);
      } catch (err) {
        console.warn('Could not attach Download button after image generation:', err?.message || err);
      }

      return sent;
    } finally {
      seekdeepStopWorkingLoop(workingLoop);
      stopSeekDeepTypingLoopForMessage(message);
    }
  });
}
'''
text, _ = replace_function(text, 'seekdeepSendImageWithButtonsMessage', message_func)
print('[SeekDeep] Repaired queued message image function with working indicator.')

interaction_func = r'''
async function seekdeepSendImageWithButtonsInteraction(interaction, prompt, width = 1024, height = 1024, seed = null) {
  const requestStartedAt = interaction?.__seekdeepRequestStartedAt || seekdeepNowMs();
  const userId = interaction?.user?.id || 'unknown';
  const cooldown = seekdeepImageCooldownRemaining(userId);

  if (cooldown > 0) {
    return await safeEditOrReply(interaction, {
      content: seekdeepAppendResponseFooter(seekdeepImageCooldownText(cooldown), {
        startedAt: requestStartedAt,
        modelUsed: seekdeepNoModelLabel(),
      }),
      allowedMentions: { repliedUser: false },
    });
  }

  seekdeepRememberImageCooldown(userId);

  const workingLoop = seekdeepStartWorkingLoop(interaction?.channel, `slash-image:${interaction?.id || prompt}`);
  const position = seekdeepImageQueueCurrentPosition();
  const job = seekdeepCreateImageQueueJob({
    source: 'slash',
    userId,
    channelId: interaction?.channel?.id || '',
    prompt,
    width,
    height,
    seed,
  });

  await safeEditOrReply(interaction, {
    content: seekdeepAppendResponseFooter(seekdeepImageQueueAckText(job, position), {
      startedAt: job.enqueuedAt || requestStartedAt,
      modelUsed: seekdeepNoModelLabel(),
    }),
    allowedMentions: { repliedUser: false },
  });

  return await seekdeepEnqueueImageJob(job, async (runningJob) => {
    try {
      const result = await makeImageResult(prompt, width, height, seed);
      const normalized = seekdeepNormalizeGeneratedImageResult(result);
      const actionId = seekdeepMakeImageActionId();

      const state = seekdeepRememberTempImageState({
        id: actionId,
        prompt,
        width,
        height,
        seed,
        filename: normalized.filename,
        buffer: normalized.buffer,
        mimeType: 'image/png',
        createdAt: Date.now(),
        expiresAt: Date.now() + SEEKDEEP_IMAGE_CACHE_TTL_MS,
      });

      const content = seekdeepAppendResponseFooter([
        `Generated locally: ${prompt}`,
        `Queue Wait: ${seekdeepImageQueueWaitSeconds(runningJob)} seconds`,
        `Job ID: ${runningJob.id}`,
      ].join('\n'), {
        startedAt: runningJob.startedAt,
        modelUsed: seekdeepImageModelLabel(),
      });

      let sent = await safeEditOrReply(interaction, {
        content,
        files: [normalized.attachment],
        components: [seekdeepImageActionRow(state.id)],
        allowedMentions: { repliedUser: false },
      });

      if (!sent && typeof interaction.fetchReply === 'function') {
        sent = await interaction.fetchReply().catch(() => null);
      }

      return await seekdeepAttachDownloadButton(sent, state.id);
    } finally {
      seekdeepStopWorkingLoop(workingLoop);
    }
  });
}
'''
text, _ = replace_function(text, 'seekdeepSendImageWithButtonsInteraction', interaction_func)
print('[SeekDeep] Repaired queued slash image function with working indicator.')

button_func = r'''
async function seekdeepHandleImageButton(interaction) {
  const startedAt = seekdeepNowMs();
  const customId = String(interaction.customId || '');
  const match = customId.match(/^seekdeep:image:(regen|archive|save):(.+)$/);

  if (!match) {
    return false;
  }

  const action = match[1] === 'save' ? 'archive' : match[1];
  const id = match[2];

  await interaction.deferReply({ ephemeral: true });

  let state = seekdeepTempImageStateIndex.get(id) || null;
  if (!state) {
    state = seekdeepLoadTempImageState(id);
  }

  if (!state) {
    await interaction.editReply({
      content: seekdeepAppendResponseFooter('That image action expired from the 24-hour cache. Generate it again if you still want to use its buttons.', {
        startedAt,
        modelUsed: seekdeepNoModelLabel(),
      }),
    });
    return true;
  }

  if (action === 'archive') {
    const savedPath = seekdeepArchiveImageStateToDisk(state);

    await interaction.editReply({
      content: seekdeepAppendResponseFooter(`Archived on the bot host:\n\`${savedPath}\``, {
        startedAt,
        modelUsed: seekdeepNoModelLabel(),
      }),
    });

    return true;
  }

  if (action === 'regen') {
    const userId = interaction?.user?.id || 'unknown';
    const workingLoop = seekdeepStartWorkingLoop(interaction?.channel, `regen:${id}`);
    const position = seekdeepImageQueueCurrentPosition();
    const job = seekdeepCreateImageQueueJob({
      source: 'button-regenerate',
      userId,
      channelId: interaction?.channel?.id || '',
      prompt: state.prompt,
      width: state.width || 1024,
      height: state.height || 1024,
      seed: state.seed ?? null,
    });

    await interaction.editReply({
      content: seekdeepAppendResponseFooter(seekdeepImageQueueAckText(job, position), {
        startedAt: job.enqueuedAt,
        modelUsed: seekdeepNoModelLabel(),
      }),
    });

    await seekdeepEnqueueImageJob(job, async (runningJob) => {
      try {
        const result = await makeImageResult(state.prompt, state.width || 1024, state.height || 1024, state.seed ?? null);
        const normalized = seekdeepNormalizeGeneratedImageResult(result);
        const newActionId = seekdeepMakeImageActionId();

        const newState = seekdeepRememberTempImageState({
          id: newActionId,
          prompt: state.prompt,
          width: state.width || 1024,
          height: state.height || 1024,
          seed: state.seed ?? null,
          filename: normalized.filename,
          buffer: normalized.buffer,
          mimeType: 'image/png',
          createdAt: Date.now(),
          expiresAt: Date.now() + SEEKDEEP_IMAGE_CACHE_TTL_MS,
        });

        let sent = null;

        if (interaction.channel && typeof interaction.channel.send === 'function') {
          sent = await interaction.channel.send({
            content: seekdeepAppendResponseFooter([
              `Regenerated locally: ${state.prompt}`,
              `Queue Wait: ${seekdeepImageQueueWaitSeconds(runningJob)} seconds`,
              `Job ID: ${runningJob.id}`,
            ].join('\n'), {
              startedAt: runningJob.startedAt,
              modelUsed: seekdeepImageModelLabel(),
            }),
            files: [normalized.attachment],
            components: [seekdeepImageActionRow(newState.id)],
          });

          try {
            await seekdeepAttachDownloadButton(sent, newState.id);
          } catch (err) {
            console.warn('Could not attach Download button after regeneration:', err?.message || err);
          }
        }

        await interaction.editReply({
          content: seekdeepAppendResponseFooter(sent ? 'Regenerated and posted.' : 'Regenerated, but I could not post the new image back to the channel.', {
            startedAt: runningJob.startedAt,
            modelUsed: seekdeepImageModelLabel(),
          }),
        });

        return sent;
      } finally {
        seekdeepStopWorkingLoop(workingLoop);
      }
    });

    return true;
  }

  await interaction.editReply({
    content: seekdeepAppendResponseFooter('Unknown image action.', {
      startedAt,
      modelUsed: seekdeepNoModelLabel(),
    }),
  });

  return true;
}
'''
text, _ = replace_function(text, 'seekdeepHandleImageButton', button_func)
print('[SeekDeep] Repaired image button handler.')

# Remove premature stop in image routes if it still exists.
for old, new, label in [
    (
        '''      stopSeekDeepTypingLoopForMessage(message);

      if (typeof seekdeepSendImageWithButtonsMessage === 'function') {
        await seekdeepSendImageWithButtonsMessage(message, prompt, 1024, 1024, null);
      } else {''',
        '''      if (typeof seekdeepSendImageWithButtonsMessage === 'function') {
        await seekdeepSendImageWithButtonsMessage(message, prompt, 1024, 1024, null);
      } else {''',
        'natural image route',
    ),
    (
        '''      stopSeekDeepTypingLoopForMessage(message);

      await seekdeepSendImageWithButtonsMessage(message, imagePrompt, 1024, 1024, null);''',
        '''      await seekdeepSendImageWithButtonsMessage(message, imagePrompt, 1024, 1024, null);''',
        'early image route',
    ),
]:
    if old in text:
        text = text.replace(old, new, 1)
        print(f'[SeekDeep] Removed premature stop from {label}.')

required = [
    'function seekdeepEnqueueImageJob(job, runner)',
    'return new Promise((resolve, reject) => {',
    'const workingLoop = seekdeepStartWorkingLoop(message?.channel',
    'const workingLoop = seekdeepStartWorkingLoop(interaction?.channel',
    'seekdeepStopWorkingLoop(workingLoop)',
    'seekdeepCreateImageQueueJob({',
]

missing = [item for item in required if item not in text]
if missing:
    raise SystemExit('Repair failed. Missing: ' + ', '.join(missing))

path.write_text(text, encoding='utf-8')
print('[SeekDeep] Queue API repair complete.')
