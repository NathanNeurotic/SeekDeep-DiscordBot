
from pathlib import Path
from datetime import datetime
import re

path = Path('index.js')
text = path.read_text(encoding='utf-8-sig')

stamp = datetime.now().strftime('%Y%m%d-%H%M%S')
backup = Path(f'index.js.bak-image-queue-{stamp}')
backup.write_text(text, encoding='utf-8')
print(f'[SeekDeep] Backup written: {backup}')

def find_function_range(src: str, name: str):
    starts = []
    for prefix in [f"async function {name}", f"function {name}"]:
        pos = src.find(prefix)
        if pos != -1:
            starts.append(pos)
    if not starts:
        return None
    start = min(starts)

    depth = 0
    paren = 0
    in_string = None
    escape = False
    line_comment = False
    block_comment = False
    brace = None

    i = start
    while i < len(src):
        ch = src[i]
        nxt = src[i + 1] if i + 1 < len(src) else ''

        if line_comment:
            if ch == '\n': line_comment = False
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
            paren += 1
        elif ch == ')' and paren > 0:
            paren -= 1
        elif ch == '{' and paren == 0:
            brace = i
            break

        i += 1

    if brace is None:
        raise SystemExit(f'Could not find function body brace for {name}')

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
            if ch == '\n': line_comment = False
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

    raise SystemExit(f'Could not find closing brace for {name}')

def replace_function(src: str, name: str, replacement: str, required=True):
    rng = find_function_range(src, name)
    if rng is None:
        if required:
            raise SystemExit(f'Could not find function: {name}')
        print(f'[SeekDeep] Skipped missing function: {name}')
        return src, False
    start, end = rng
    return src[:start] + replacement.strip() + '\n\n' + src[end:].lstrip(), True

queue_helpers = r'''
// SEEKDEEP_IMAGE_QUEUE_START
const seekdeepImageQueueState = globalThis.__seekdeepImageQueueState || {
  active: null,
  pending: [],
  sequence: 0,
  completed: 0,
  failed: 0,
};

globalThis.__seekdeepImageQueueState = seekdeepImageQueueState;

const SEEKDEEP_IMAGE_COOLDOWN_MS = Math.max(0, Number(process.env.SEEKDEEP_IMAGE_COOLDOWN_MS || 0));
const seekdeepImageCooldowns = globalThis.__seekdeepImageCooldowns || new Map();
globalThis.__seekdeepImageCooldowns = seekdeepImageCooldowns;

function seekdeepImageCooldownRemaining(userId) {
  if (!SEEKDEEP_IMAGE_COOLDOWN_MS || !userId) return 0;

  const last = Number(seekdeepImageCooldowns.get(String(userId)) || 0);
  const remaining = SEEKDEEP_IMAGE_COOLDOWN_MS - (Date.now() - last);

  return Math.max(0, remaining);
}

function seekdeepRememberImageCooldown(userId) {
  if (!SEEKDEEP_IMAGE_COOLDOWN_MS || !userId) return;
  seekdeepImageCooldowns.set(String(userId), Date.now());
}

function seekdeepImageQueueCurrentPosition() {
  return seekdeepImageQueueState.pending.length + (seekdeepImageQueueState.active ? 1 : 0) + 1;
}

function seekdeepCreateImageQueueJob({ source = 'unknown', userId = '', channelId = '', prompt = '', width = 1024, height = 1024, seed = null } = {}) {
  seekdeepImageQueueState.sequence += 1;

  return {
    id: `imgq_${Date.now()}_${seekdeepImageQueueState.sequence}`,
    source,
    userId: String(userId || ''),
    channelId: String(channelId || ''),
    prompt: String(prompt || ''),
    width: Number(width || 1024),
    height: Number(height || 1024),
    seed: seed ?? null,
    enqueuedAt: Date.now(),
    startedAt: null,
    finishedAt: null,
  };
}

function seekdeepImageQueueJobLine(job) {
  if (!job) return 'none';

  return `${job.id} - ${seekdeepShortQueuePrompt(job.prompt)}`;
}

function seekdeepShortQueuePrompt(value, max = 90) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  if (text.length <= max) return text || '(empty prompt)';
  return `${text.slice(0, Math.max(0, max - 1)).trim()}…`;
}

function seekdeepImageQueueWaitSeconds(job) {
  const startedAt = Number(job?.startedAt || Date.now());
  const enqueuedAt = Number(job?.enqueuedAt || startedAt);
  return (Math.max(0, startedAt - enqueuedAt) / 1000).toFixed(2);
}

function seekdeepImageQueueRunSeconds(job) {
  const startedAt = Number(job?.startedAt || Date.now());
  const end = Number(job?.finishedAt || Date.now());
  return (Math.max(0, end - startedAt) / 1000).toFixed(2);
}

function seekdeepImageQueueAckText(job, position) {
  const active = seekdeepImageQueueState.active;
  const lines = [
    position <= 1 ? 'Image generation started.' : 'Image generation queued.',
    `Queue Position: ${position}`,
    `Job ID: ${job.id}`,
    `Prompt: ${seekdeepShortQueuePrompt(job.prompt, 160)}`,
  ];

  if (active) {
    lines.push(`Currently Running: ${seekdeepImageQueueJobLine(active)}`);
  }

  lines.push(`Pending Jobs: ${seekdeepImageQueueState.pending.length}`);

  return lines.join('\n');
}

function seekdeepImageQueueStatusText() {
  const pending = seekdeepImageQueueState.pending || [];
  const active = seekdeepImageQueueState.active;

  const lines = [
    'Image generation queue',
    '',
    `Active Job: ${active ? seekdeepImageQueueJobLine(active) : 'none'}`,
    `Pending Jobs: ${pending.length}`,
    `Completed Since Last Reboot: ${seekdeepImageQueueState.completed || 0}`,
    `Failed Since Last Reboot: ${seekdeepImageQueueState.failed || 0}`,
    `Cooldown: ${SEEKDEEP_IMAGE_COOLDOWN_MS ? `${(SEEKDEEP_IMAGE_COOLDOWN_MS / 1000).toFixed(0)}s per user` : 'off'}`,
  ];

  if (pending.length) {
    lines.push('', 'Pending:');
    pending.slice(0, 10).forEach((entry, index) => {
      lines.push(`${index + 1}. ${seekdeepImageQueueJobLine(entry.job)}`);
    });
  }

  return lines.join('\n');
}

async function seekdeepPumpImageQueue() {
  if (seekdeepImageQueueState.active) return;

  const entry = seekdeepImageQueueState.pending.shift();
  if (!entry) return;

  seekdeepImageQueueState.active = entry.job;
  entry.job.startedAt = Date.now();

  try {
    const result = await entry.runner(entry.job);
    seekdeepImageQueueState.completed += 1;
    entry.resolve(result);
  } catch (err) {
    seekdeepImageQueueState.failed += 1;
    entry.reject(err);
  } finally {
    entry.job.finishedAt = Date.now();
    seekdeepImageQueueState.active = null;

    if (typeof setImmediate === 'function') {
      setImmediate(() => { void seekdeepPumpImageQueue(); });
    } else {
      setTimeout(() => { void seekdeepPumpImageQueue(); }, 0);
    }
  }
}

function seekdeepEnqueueImageJob(job, runner) {
  return new Promise((resolve, reject) => {
    seekdeepImageQueueState.pending.push({ job, runner, resolve, reject });
    void seekdeepPumpImageQueue();
  });
}

function seekdeepImageCooldownText(remainingMs) {
  return [
    'Image generation cooldown is active.',
    `Try again in ${(Math.max(0, Number(remainingMs || 0)) / 1000).toFixed(1)} seconds.`,
  ].join('\n');
}
// SEEKDEEP_IMAGE_QUEUE_END
'''

if '// SEEKDEEP_IMAGE_QUEUE_START' in text:
    start = text.find('// SEEKDEEP_IMAGE_QUEUE_START')
    end = text.find('// SEEKDEEP_IMAGE_QUEUE_END', start)
    if end == -1:
        raise SystemExit('Found image queue start marker but no end marker.')
    end += len('// SEEKDEEP_IMAGE_QUEUE_END')
    text = text[:start] + queue_helpers.strip() + '\n\n' + text[end:].lstrip()
    print('[SeekDeep] Replaced image queue helpers.')
else:
    anchor = 'async function seekdeepSendImageWithButtonsMessage'
    pos = text.find(anchor)
    if pos == -1:
      raise SystemExit('Could not find image send function insertion point.')
    text = text[:pos] + queue_helpers.strip() + '\n\n' + text[pos:]
    print('[SeekDeep] Inserted image queue helpers.')

message_fn = r'''
async function seekdeepSendImageWithButtonsMessage(message, prompt, width = 1024, height = 1024, seed = null) {
  const userId = message?.author?.id || 'unknown';
  const cooldown = seekdeepImageCooldownRemaining(userId);

  if (cooldown > 0) {
    return await message.reply({
      content: seekdeepAppendResponseFooter(seekdeepImageCooldownText(cooldown), {
        startedAt: seekdeepNowMs(),
        modelUsed: seekdeepNoModelLabel(),
      }),
      allowedMentions: { repliedUser: false },
    });
  }

  seekdeepRememberImageCooldown(userId);

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

  try {
    await message.reply({
      content: seekdeepAppendResponseFooter(seekdeepImageQueueAckText(job, position), {
        startedAt: job.enqueuedAt,
        modelUsed: seekdeepNoModelLabel(),
      }),
      allowedMentions: { repliedUser: false },
    });
  } catch (err) {
    console.warn('Could not send image queue acknowledgement:', err?.message || err);
  }

  return await seekdeepEnqueueImageJob(job, async (runningJob) => {
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
  });
}
'''

interaction_fn = r'''
async function seekdeepSendImageWithButtonsInteraction(interaction, prompt, width = 1024, height = 1024, seed = null) {
  const userId = interaction?.user?.id || 'unknown';
  const cooldown = seekdeepImageCooldownRemaining(userId);

  if (cooldown > 0) {
    return await safeEditOrReply(interaction, {
      content: seekdeepAppendResponseFooter(seekdeepImageCooldownText(cooldown), {
        startedAt: interaction?.__seekdeepRequestStartedAt || seekdeepNowMs(),
        modelUsed: seekdeepNoModelLabel(),
      }),
      allowedMentions: { repliedUser: false },
    });
  }

  seekdeepRememberImageCooldown(userId);

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
      startedAt: job.enqueuedAt,
      modelUsed: seekdeepNoModelLabel(),
    }),
    allowedMentions: { repliedUser: false },
  });

  return await seekdeepEnqueueImageJob(job, async (runningJob) => {
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
  });
}
'''

button_fn = r'''
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

status_fn = r'''
async function statusText() {
  const health = await fetchJson(`${LOCAL_AI_BASE_URL}/health`);
  const loadedTask = health.loaded_task || 'none';
  const currentLoadedModel = seekdeepCurrentLoadedModelFromHealth(health);
  const botUptime = seekdeepFormatDuration(Date.now() - seekdeepBotMetrics.startedAt);
  const responsesByModel = seekdeepFormatResponsesByModel();

  return [
    'Local AI server status',
    '',
    `Endpoint: ${LOCAL_AI_BASE_URL}`,
    `Health: ${health.status}`,
    `Device: ${health.device}`,
    `CUDA: ${health.cuda_available ? 'YES' : 'NO'}`,
    `Loaded task: ${loadedTask}`,
    `Current Loaded Model: ${currentLoadedModel}`,
    `Keep mode: ${health.keep_mode}`,
    '',
    'Bot runtime:',
    `Bot Uptime: ${botUptime}`,
    `Responses Since Last Reboot: ${seekdeepBotMetrics.responsesSinceBoot}`,
    '',
    'Image queue:',
    seekdeepImageQueueStatusText(),
    '',
    'Responses By Model:',
    responsesByModel,
    '',
    'Configured local models:',
    `Chat: ${health.models?.chat}`,
    `Vision: ${health.models?.vision}`,
    `Image: ${health.models?.image}`,
    `Offline model loading: ${health.offline_model_loading ? 'YES' : 'NO'}`,
  ].join('\n');
}
'''

text, _ = replace_function(text, 'seekdeepSendImageWithButtonsMessage', message_fn)
text, _ = replace_function(text, 'seekdeepSendImageWithButtonsInteraction', interaction_fn)
text, _ = replace_function(text, 'seekdeepHandleImageButton', button_fn)
text, _ = replace_function(text, 'statusText', status_fn)

if "return 'image-queue';" not in text:
    text = text.replace(
        "  if (/^(admin status|am i admin)\\b/.test(p)) return 'admin';",
        "  if (/^(admin status|am i admin)\\b/.test(p)) return 'admin';\n  if (/^(queue status|image queue|generation queue|image generation queue)\\b/.test(p)) return 'image-queue';",
        1,
    )

if "case 'image-queue': return seekdeepImageQueueStatusText();" not in text:
    text = text.replace(
        "    case 'admin': return ['Seekotics admin status', '', seekdeepAdminLine(source)].join('\\n');",
        "    case 'admin': return ['Seekotics admin status', '', seekdeepAdminLine(source)].join('\\n');\n    case 'image-queue': return seekdeepImageQueueStatusText();",
        1,
    )

if '@SEEKOTICS queue status' not in text:
    text = text.replace(
        "    '@SEEKOTICS recent prompts',",
        "    '@SEEKOTICS recent prompts',\n    '@SEEKOTICS queue status',",
        1,
    )

required = [
    'SEEKDEEP_IMAGE_QUEUE_START',
    'function seekdeepEnqueueImageJob(',
    'function seekdeepImageQueueStatusText(',
    'async function seekdeepSendImageWithButtonsMessage(',
    'async function seekdeepSendImageWithButtonsInteraction(',
    'async function seekdeepHandleImageButton(',
    'Image generation queued.',
    'Queue Position:',
    'Queue Wait:',
    "return 'image-queue';",
]

missing = [item for item in required if item not in text]
if missing:
    raise SystemExit('Patch failed. Missing: ' + ', '.join(missing))

path.write_text(text, encoding='utf-8')
print('[SeekDeep] Batch 2 image queue patch written.')

