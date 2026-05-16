from pathlib import Path
from datetime import datetime

path = Path('index.js')
text = path.read_text(encoding='utf-8-sig')

stamp = datetime.now().strftime('%Y%m%d-%H%M%S')
backup = Path(f'index.js.bak-typing-encoding-hotfix-{stamp}')
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

    # Find opening brace after the full parameter list, not the "{}" in default params.
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

# Fix common mojibake already present in identity/static strings.
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
        raise SystemExit('Found typing hotfix start marker but no end marker.')
    end += len('// SEEKDEEP_TYPING_WORKING_HOTFIX_END')
    text = text[:start] + typing_helpers.strip() + '\n\n' + text[end:].lstrip()
    print('[SeekDeep] Replaced typing helper block.')
else:
    anchor = '// SEEKDEEP_TYPING_DEDUPE_START'
    pos = text.find(anchor)
    if pos == -1:
        anchor = 'async function seekdeepSendImageWithButtonsMessage'
        pos = text.find(anchor)
    if pos == -1:
        raise SystemExit('Could not find insertion point for typing hotfix helpers.')
    text = text[:pos] + typing_helpers.strip() + '\n\n' + text[pos:]
    print('[SeekDeep] Inserted typing helper block.')

if 'function seekdeepEnqueueImageJob(' in text:
    queue_func = r'''
function seekdeepEnqueueImageJob(job) {
  if (!job || typeof job.run !== 'function') {
    throw new Error('Invalid image queue job.');
  }

  const normalizedJob = {
    id: job.id || seekdeepMakeImageQueueJobId(),
    prompt: job.prompt || '',
    userId: job.userId || 'unknown',
    channelId: job.channelId || 'unknown',
    createdAt: job.createdAt || Date.now(),
    startedAt: 0,
    finishedAt: 0,
    status: 'queued',
    run: job.run,
  };

  const position = seekdeepImageQueueState.activeJob ? seekdeepImageQueueState.pending.length + 2 : seekdeepImageQueueState.pending.length + 1;

  seekdeepImageQueueState.pending.push(normalizedJob);
  seekdeepRunNextImageJob().catch((err) => {
    console.error('Image queue runner failed:', err);
  });

  return {
    job: normalizedJob,
    position,
    pending: seekdeepImageQueueState.pending.length,
  };
}
'''
    text, replaced = replace_function(text, 'seekdeepEnqueueImageJob', queue_func, required=False)
    if replaced:
        print('[SeekDeep] Patched seekdeepEnqueueImageJob.')
else:
    print('[SeekDeep] Queue enqueue function not found; skipped queue enqueue patch.')

if 'function seekdeepEnqueueImageJob(' in text and 'async function seekdeepSendImageWithButtonsMessage(' in text:
    queued_msg_func = r'''
async function seekdeepSendImageWithButtonsMessage(message, prompt, width = 1024, height = 1024, seed = null) {
  const requestStartedAt = seekdeepNowMs();
  const workingLoop = seekdeepStartWorkingLoop(message?.channel, `image:${message?.id || prompt}`);

  const queueInfo = seekdeepEnqueueImageJob({
    prompt,
    userId: message?.author?.id || 'unknown',
    channelId: message?.channel?.id || 'unknown',
    run: async (runningJob) => {
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
          startedAt: runningJob.startedAt || requestStartedAt,
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
    },
  });

  const startNotice = [
    'Image generation started.',
    `Queue Position: ${queueInfo.position}`,
    `Job ID: ${queueInfo.job.id}`,
    `Prompt: ${prompt}`,
    `Pending Jobs: ${Math.max(0, queueInfo.pending - 1)}`,
  ].join('\n');

  try {
    await message.reply({
      content: seekdeepAppendResponseFooter(startNotice, {
        startedAt: requestStartedAt,
        modelUsed: seekdeepNoModelLabel(),
      }),
      allowedMentions: { repliedUser: false },
    });
  } catch (err) {
    console.warn('Image queue start reply failed; falling back to channel.send:', err?.message || err);

    if (message?.channel && typeof message.channel.send === 'function') {
      await message.channel.send({
        content: seekdeepAppendResponseFooter(startNotice, {
          startedAt: requestStartedAt,
          modelUsed: seekdeepNoModelLabel(),
        }),
        allowedMentions: { repliedUser: false },
      });
    }
  }

  return queueInfo;
}
'''
    text, replaced = replace_function(text, 'seekdeepSendImageWithButtonsMessage', queued_msg_func, required=False)
    if replaced:
        print('[SeekDeep] Patched queued seekdeepSendImageWithButtonsMessage.')
else:
    print('[SeekDeep] Queue image message function not patched; queue function missing.')

if 'function seekdeepEnqueueImageJob(' not in text and 'async function seekdeepSendImageWithButtonsMessage(' in text:
    legacy_msg_func = r'''
async function seekdeepSendImageWithButtonsMessage(message, prompt, width = 1024, height = 1024, seed = null) {
  const startedAt = seekdeepNowMs();
  const workingLoop = seekdeepStartWorkingLoop(message?.channel, `image:${message?.id || prompt}`);

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

    const content = seekdeepAppendResponseFooter(`Generated locally: ${prompt}`, {
      startedAt,
      modelUsed: seekdeepImageModelLabel(),
    });

    let sent = await message.reply({
      content,
      files: [normalized.attachment],
      components: [seekdeepImageActionRow(actionId)],
      allowedMentions: { repliedUser: false },
    });

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
}
'''
    text, replaced = replace_function(text, 'seekdeepSendImageWithButtonsMessage', legacy_msg_func, required=False)
    if replaced:
        print('[SeekDeep] Patched legacy seekdeepSendImageWithButtonsMessage.')

old_route = '''      stopSeekDeepTypingLoopForMessage(message);

      if (typeof seekdeepSendImageWithButtonsMessage === 'function') {
        await seekdeepSendImageWithButtonsMessage(message, prompt, 1024, 1024, null);
      } else {'''
new_route = '''      if (typeof seekdeepSendImageWithButtonsMessage === 'function') {
        await seekdeepSendImageWithButtonsMessage(message, prompt, 1024, 1024, null);
      } else {'''
if old_route in text:
    text = text.replace(old_route, new_route, 1)
    print('[SeekDeep] Removed premature typing-stop from natural image route.')
else:
    print('[SeekDeep] Premature natural image route stop block not found; skipped.')

early_old = '''      stopSeekDeepTypingLoopForMessage(message);

      await seekdeepSendImageWithButtonsMessage(message, imagePrompt, 1024, 1024, null);'''
early_new = '''      await seekdeepSendImageWithButtonsMessage(message, imagePrompt, 1024, 1024, null);'''
if early_old in text:
    text = text.replace(early_old, early_new, 1)
    print('[SeekDeep] Removed premature typing-stop from early image route.')
else:
    print('[SeekDeep] Early image route premature stop not found; skipped.')

if "if (action === 'regen') {" in text and "const regenWorkingLoop = seekdeepStartWorkingLoop(interaction?.channel" not in text:
    regen_start = text.find("  if (action === 'regen') {")
    if regen_start != -1:
        insert_after = text.find("{", regen_start) + 1
        text = text[:insert_after] + "\n    const regenWorkingLoop = seekdeepStartWorkingLoop(interaction?.channel, `regen:${id}`);\n" + text[insert_after:]

        regen_end_return = text.find("    return true;", insert_after)
        if regen_end_return != -1:
            text = text[:regen_end_return] + "    seekdeepStopWorkingLoop(regenWorkingLoop);\n" + text[regen_end_return:]
            print('[SeekDeep] Added regenerate working indicator.')
        else:
            print('[SeekDeep] Could not find regenerate return for stop insertion.')
else:
    print('[SeekDeep] Regenerate working indicator already present or regen branch missing.')

required = [
    'SEEKDEEP_TYPING_WORKING_HOTFIX_START',
    'function seekdeepStartWorkingLoop(',
    'seekdeepStartWorkingLoop(message?.channel',
    'seekdeepStopWorkingLoop(workingLoop)',
]

missing = [item for item in required if item not in text]
if missing:
    raise SystemExit('Patch failed. Missing: ' + ', '.join(missing))

path.write_text(text, encoding='utf-8')
print('[SeekDeep] Typing indicator and encoding hotfix written.')
