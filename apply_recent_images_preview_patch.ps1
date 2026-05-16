$ErrorActionPreference = "Stop"
cd "$env:USERPROFILE\SeekDeep-DiscordBot"

$pyExe = ".\.venv\Scripts\python.exe"
if (!(Test-Path $pyExe)) { $pyExe = "python" }

@'
from pathlib import Path
import re

path = Path('index.js')
text = path.read_text(encoding='utf-8-sig')

helper = r'''
// SEEKDEEP_BATCH1_UTILITY_START
function seekdeepAdminIds() {
  return new Set(String(process.env.SEEKDEEP_ADMIN_IDS || process.env.ADMIN_USER_IDS || '')
    .split(/[\s,;]+/)
    .map((x) => x.trim())
    .filter(Boolean));
}

function seekdeepIsAdminSource(source) {
  const userId = String(source?.user?.id || source?.author?.id || '');
  if (userId && seekdeepAdminIds().has(userId)) return true;

  try {
    if (source?.memberPermissions?.has && source.memberPermissions.has('Administrator')) return true;
  } catch {}

  try {
    if (source?.member?.permissions?.has && source.member.permissions.has('Administrator')) return true;
  } catch {}

  return false;
}

function seekdeepAdminLine(source) {
  return `Admin: ${seekdeepIsAdminSource(source) ? 'YES' : 'NO'}`;
}

function seekdeepFormatBytes(bytes = 0) {
  const value = Number(bytes || 0);
  if (!Number.isFinite(value) || value <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let size = value;
  let unit = 0;
  while (size >= 1024 && unit < units.length - 1) {
    size /= 1024;
    unit += 1;
  }
  return `${size.toFixed(unit === 0 ? 0 : 2)} ${units[unit]}`;
}

function seekdeepSafeReadJson(fullPath) {
  try {
    return JSON.parse(fs.readFileSync(fullPath, 'utf8'));
  } catch {
    return null;
  }
}

function seekdeepWalkFiles(dir) {
  if (!dir || !fs.existsSync(dir)) return [];
  const out = [];
  for (const name of fs.readdirSync(dir)) {
    const fullPath = path.join(dir, name);
    try {
      const stat = fs.statSync(fullPath);
      if (stat.isFile()) out.push({ name, fullPath, stat });
    } catch {}
  }
  return out;
}

function seekdeepDirFileStats(dir, imageOnly = false) {
  const files = seekdeepWalkFiles(dir);
  const imageExts = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp', '.avif']);
  const filtered = imageOnly ? files.filter((f) => imageExts.has(path.extname(f.name).toLowerCase())) : files;
  const bytes = filtered.reduce((sum, file) => sum + Number(file.stat?.size || 0), 0);
  return { files: filtered, count: filtered.length, bytes };
}

function seekdeepTempImageCacheDir() {
  try {
    if (typeof SEEKDEEP_IMAGE_CACHE_DIR !== 'undefined' && SEEKDEEP_IMAGE_CACHE_DIR) return SEEKDEEP_IMAGE_CACHE_DIR;
  } catch {}
  return path.join(__dirname, 'temp', 'image-cache');
}

function seekdeepArchiveDirResolved() {
  try {
    if (typeof seekdeepArchiveDir === 'function') return seekdeepArchiveDir();
  } catch {}
  return path.join(__dirname, 'saved_generations');
}

function seekdeepReadTempImageCacheMetadata() {
  const dir = seekdeepTempImageCacheDir();
  return seekdeepWalkFiles(dir)
    .filter((file) => file.name.toLowerCase().endsWith('.json'))
    .map((file) => ({ ...seekdeepSafeReadJson(file.fullPath), __metaPath: file.fullPath, __stat: file.stat, __kind: 'temp' }))
    .filter((item) => item && item.id);
}

function seekdeepInferArchivePromptFromFilename(name = '') {
  const base = path.basename(String(name || ''), path.extname(String(name || '')));
  return base
    .replace(/^\d{4}-\d{2}-\d{2}t\d{2}-\d{2}-\d{2}-\d{3}z[-_ ]*/i, '')
    .replace(/^\d{2}[-_ ]\d{2}[-_ ]\d{2}[-_ ]\d{3}z[-_ ]*/i, '')
    .replace(/[-_]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim() || name;
}

function seekdeepReadArchiveMetadata() {
  const dir = seekdeepArchiveDirResolved();
  const jsonItems = seekdeepWalkFiles(dir)
    .filter((file) => file.name.toLowerCase().endsWith('.json'))
    .map((file) => ({ ...seekdeepSafeReadJson(file.fullPath), __metaPath: file.fullPath, __stat: file.stat, __kind: 'archive' }))
    .filter((item) => item && (item.id || item.prompt));

  if (jsonItems.length) return jsonItems;

  return seekdeepDirFileStats(dir, true).files.map((file) => ({
    id: path.basename(file.name, path.extname(file.name)),
    prompt: seekdeepInferArchivePromptFromFilename(file.name),
    filename: file.name,
    binaryPath: file.fullPath,
    createdAt: file.stat.mtimeMs,
    __stat: file.stat,
    __kind: 'archive',
  }));
}

function seekdeepFormatTimestamp(ms) {
  const value = Number(ms || 0);
  if (!value) return 'unknown';
  try { return new Date(value).toLocaleString(); } catch { return 'unknown'; }
}

function seekdeepShorten(value, max = 140) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(0, max - 1)).trim()}…`;
}

function seekdeepHelpText(source = null) {
  return [
    'Seekotics command map',
    '',
    'Chat:',
    '@SEEKOTICS ask anything',
    '/ask prompt:<text>',
    '',
    'Images:',
    '@SEEKOTICS hyper realistic cannabis plant',
    '@SEEKOTICS I need picture of fat cat',
    '/image prompt:<text>',
    'Buttons: Regenerate / Download / Archive',
    '',
    'Vision:',
    'Reply to an image: @SEEKOTICS what is this?',
    '/vision file:<upload> prompt:<optional question>',
    '',
    'Archive and cache:',
    '@SEEKOTICS post archive',
    '@SEEKOTICS archive status',
    '@SEEKOTICS cache status',
    '@SEEKOTICS recent images',
    '@SEEKOTICS recent prompts',
    '',
    'Status:',
    '@SEEKOTICS status',
    '@SEEKOTICS ping',
    '',
    'Admin foundation:',
    seekdeepAdminLine(source),
    'Admin IDs can be configured with SEEKDEEP_ADMIN_IDS in .env.',
  ].join('\n');
}

function seekdeepCacheStatusText() {
  const dir = seekdeepTempImageCacheDir();
  const allStats = seekdeepDirFileStats(dir, false);
  const imageStats = seekdeepDirFileStats(dir, true);
  const metas = seekdeepReadTempImageCacheMetadata();
  const now = Date.now();
  const expired = metas.filter((m) => Number(m.expiresAt || 0) && Number(m.expiresAt || 0) <= now).length;
  const newest = metas.slice().sort((a, b) => Number(b.createdAt || 0) - Number(a.createdAt || 0))[0];

  return [
    'Temp image cache status',
    '',
    `Path: ${dir}`,
    `Files: ${allStats.count}`,
    `Images: ${imageStats.count}`,
    `Metadata entries: ${metas.length}`,
    `Expired metadata entries: ${expired}`,
    `Size: ${seekdeepFormatBytes(allStats.bytes)}`,
    `Retention: ${typeof SEEKDEEP_IMAGE_CACHE_TTL_HOURS !== 'undefined' ? SEEKDEEP_IMAGE_CACHE_TTL_HOURS : 24} hours`,
    newest ? `Newest prompt: ${seekdeepShorten(newest.prompt || newest.filename || newest.id, 160)}` : 'Newest prompt: none',
  ].join('\n');
}

function seekdeepArchiveStatusText() {
  const dir = seekdeepArchiveDirResolved();
  const allStats = seekdeepDirFileStats(dir, false);
  const imageStats = seekdeepDirFileStats(dir, true);
  const jsonCount = seekdeepWalkFiles(dir).filter((f) => f.name.toLowerCase().endsWith('.json')).length;
  const newest = imageStats.files.slice().sort((a, b) => b.stat.mtimeMs - a.stat.mtimeMs)[0];

  return [
    'Image archive status',
    '',
    `Path: ${dir}`,
    `Images: ${imageStats.count}`,
    `Metadata files: ${jsonCount}`,
    `Total files: ${allStats.count}`,
    `Size: ${seekdeepFormatBytes(allStats.bytes)}`,
    newest ? `Newest file: ${newest.name}` : 'Newest file: none',
  ].join('\n');
}

function seekdeepRecentImagesRequestedLimit(prompt = '', fallback = 5, max = 10) {
  const p = normalizeUserText(prompt).toLowerCase().trim();
  const m = p.match(/\b(\d{1,2})\b/);
  let value = m ? Number(m[1]) : fallback;
  if (!Number.isFinite(value) || value < 1) value = fallback;
  value = Math.max(1, Math.min(max, value));
  return value;
}

function seekdeepNormalizeRecentImageEntry(item) {
  if (!item) return null;

  const kind = item.__kind === 'archive' ? 'archive' : 'temp';
  const createdAt = Number(item.createdAt || item.__stat?.mtimeMs || 0) || 0;
  let binaryPath = String(item.binaryPath || '').trim();
  let filename = String(item.filename || '').trim();

  if (!binaryPath && filename) {
    binaryPath = path.join(kind === 'archive' ? seekdeepArchiveDirResolved() : seekdeepTempImageCacheDir(), filename);
  }

  if (!binaryPath || !fs.existsSync(binaryPath)) return null;

  if (!filename) {
    filename = path.basename(binaryPath);
  }

  if (kind === 'temp') {
    const expiresAt = Number(item.expiresAt || 0);
    if (expiresAt && expiresAt <= Date.now()) return null;
  }

  return {
    ...item,
    __kind: kind,
    createdAt,
    binaryPath,
    filename,
    prompt: seekdeepShorten(item.prompt || filename || item.id || '(unknown prompt)', 160),
    displayId: item.id || path.basename(filename, path.extname(filename)) || 'unknown',
  };
}

function seekdeepCollectRecentImageEntries(limit = 5) {
  const temp = seekdeepReadTempImageCacheMetadata().map(seekdeepNormalizeRecentImageEntry).filter(Boolean);
  const archive = seekdeepReadArchiveMetadata().map(seekdeepNormalizeRecentImageEntry).filter(Boolean);

  return [...temp, ...archive]
    .sort((a, b) => Number(b.createdAt || 0) - Number(a.createdAt || 0))
    .slice(0, Math.max(1, Math.min(10, Number(limit || 5))));
}

function seekdeepRecentImagesText(limit = 10) {
  const items = seekdeepCollectRecentImageEntries(limit);

  if (!items.length) return 'Recent images\n\nNo recent image files found.';

  return [
    'Recent images',
    '',
    ...items.map((item, index) => {
      const when = seekdeepFormatTimestamp(item.createdAt || 0);
      return `${index + 1}. [${item.__kind}] ${item.prompt}\n   Created: ${when}\n   ID/File: ${item.displayId}`;
    }),
  ].join('\n');
}

function seekdeepRecentImageCaption(item, index, total) {
  return [
    `Recent image ${index + 1}/${total}`,
    `Source: ${item.__kind}`,
    `Prompt: ${item.prompt}`,
    `Created: ${seekdeepFormatTimestamp(item.createdAt || 0)}`,
    `ID: ${item.displayId}`,
  ].join('\n');
}

async function seekdeepPostRecentImagesToChannel(channel, limit = 5) {
  const startedAt = seekdeepNowMs();
  const modelUsed = seekdeepNoModelLabel();
  const items = seekdeepCollectRecentImageEntries(limit);

  if (!items.length) {
    return {
      summary: 'Recent images\n\nNo recent image files found.',
      startedAt,
      modelUsed,
      posted: 0,
      failed: 0,
    };
  }

  const safeLimit = Math.max(1, Math.min(10, Number(limit || 5)));
  let posted = 0;
  let failed = 0;

  await channel.send(seekdeepAppendResponseFooter(`Posting ${items.length} recent image(s).`, {
    startedAt,
    modelUsed,
  }));

  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    const itemStartedAt = seekdeepNowMs();

    try {
      await channel.send({
        content: seekdeepAppendResponseFooter(seekdeepRecentImageCaption(item, i, items.length), {
          startedAt: itemStartedAt,
          modelUsed,
        }),
        files: [new AttachmentBuilder(item.binaryPath, { name: item.filename })],
      });
      posted += 1;
    } catch (err) {
      failed += 1;
      console.error(`Recent image post failed: ${item.binaryPath}`, err?.message || err);
    }
  }

  return {
    summary: `Recent image post complete.\nRequested: ${safeLimit}\nPosted: ${posted}\nFailed: ${failed}`,
    startedAt,
    modelUsed,
    posted,
    failed,
  };
}

async function seekdeepPostRecentImagesFromMessage(message, limit = 5) {
  seekdeepMarkRequestStart(message);
  seekdeepSetResponseModel(message, seekdeepNoModelLabel());
  stopSeekDeepTypingLoopForMessage(message);

  const result = await seekdeepPostRecentImagesToChannel(message.channel, limit);
  const finalContent = seekdeepAppendResponseFooter(result.summary, {
    startedAt: result.startedAt || message?.__seekdeepRequestStartedAt,
    modelUsed: result.modelUsed || seekdeepNoModelLabel(),
  });

  await message.reply({
    content: finalContent,
    allowedMentions: { repliedUser: false },
  });

  return finalContent;
}

async function seekdeepPostRecentImagesFromInteraction(interaction, limit = 5) {
  seekdeepMarkRequestStart(interaction);
  seekdeepSetResponseModel(interaction, seekdeepNoModelLabel());

  const result = await seekdeepPostRecentImagesToChannel(interaction.channel, limit);
  const finalContent = seekdeepAppendResponseFooter(result.summary, {
    startedAt: result.startedAt || interaction?.__seekdeepRequestStartedAt,
    modelUsed: result.modelUsed || seekdeepNoModelLabel(),
  });

  await safeEditOrReply(interaction, {
    content: finalContent,
    allowedMentions: { repliedUser: false },
  });

  return finalContent;
}

function seekdeepRecentPromptsText(key, limit = 12) {
  const entries = (CHANNEL_MEMORY.get(key) || [])
    .filter((entry) => entry.role === 'user')
    .slice(-limit)
    .reverse();

  if (!entries.length) return 'Recent prompts\n\nNo recent channel prompts in memory yet.';

  return [
    'Recent prompts',
    '',
    ...entries.map((entry, index) => `${index + 1}. ${seekdeepShorten(entry.text, 180)}`),
  ].join('\n');
}

function seekdeepUtilityPromptKind(prompt = '') {
  const p = normalizeUserText(prompt).toLowerCase().trim();

  if (/^(help|commands|command list|what can you do|what are your commands)\b/.test(p)) return 'help';
  if (/^(cache status|image cache status|temp cache status|cache)\b/.test(p)) return 'cache';
  if (/^(archive status|saved generation status|saved generations status)\b/.test(p)) return 'archive';
  if (/^(recent images|recent image|image history|recent generations|generation history)\b/.test(p)) return 'recent-images';
  if (/^(recent prompts|recent prompt|prompt history|last prompts|last prompt)\b/.test(p)) return 'recent-prompts';
  if (/^(admin status|am i admin)\b/.test(p)) return 'admin';

  return '';
}

function seekdeepUtilityText(kind, source, key) {
  switch (kind) {
    case 'help': return seekdeepHelpText(source);
    case 'cache': return seekdeepCacheStatusText();
    case 'archive': return seekdeepArchiveStatusText();
    case 'recent-images': return seekdeepRecentImagesText(10);
    case 'recent-prompts': return seekdeepRecentPromptsText(key, 12);
    case 'admin': return ['Seekotics admin status', '', seekdeepAdminLine(source)].join('\n');
    default: return '';
  }
}
// SEEKDEEP_BATCH1_UTILITY_END
'''

if '// SEEKDEEP_BATCH1_UTILITY_START' not in text or '// SEEKDEEP_BATCH1_UTILITY_END' not in text:
    raise SystemExit('Could not find SEEKDEEP_BATCH1_UTILITY block. Apply the batch1 utility patch first.')

start = text.find('// SEEKDEEP_BATCH1_UTILITY_START')
end = text.find('// SEEKDEEP_BATCH1_UTILITY_END', start)
end += len('// SEEKDEEP_BATCH1_UTILITY_END')
text = text[:start] + helper.strip() + '\n\n' + text[end:].lstrip()

interaction_pattern = re.compile(
    r"\s*// SEEKDEEP_BATCH1_INTERACTION_ROUTE[\s\S]*?\n\s*if \(interaction\.commandName === 'postarchive'\) \{",
    re.M,
)
interaction_replacement = '''
    // SEEKDEEP_BATCH1_INTERACTION_ROUTE
    if (['help', 'cachestatus', 'archivestatus', 'recent'].includes(interaction.commandName)) {
      if (!(await safeDefer(interaction))) return;
      const key = memoryKeyFrom(interaction);
      let kind = interaction.commandName;

      if (interaction.commandName === 'cachestatus') kind = 'cache';
      if (interaction.commandName === 'archivestatus') kind = 'archive';
      if (interaction.commandName === 'recent') {
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

    if (interaction.commandName === 'postarchive') {'''
text, count = interaction_pattern.subn(interaction_replacement, text, count=1)
if count != 1:
    raise SystemExit('Could not patch SEEKDEEP_BATCH1_INTERACTION_ROUTE block.')

message_pattern = re.compile(
    r"\s*// SEEKDEEP_BATCH1_MESSAGE_ROUTE[\s\S]*?\n\s*if \(isNaturalStatusPrompt\(prompt\)\) \{",
    re.M,
)
message_replacement = '''
    // SEEKDEEP_BATCH1_MESSAGE_ROUTE
    const utilityKind = seekdeepUtilityPromptKind(prompt);
    if (utilityKind) {
      remember(key, 'user', prompt);
      seekdeepSetResponseModel(message, seekdeepNoModelLabel());

      if (utilityKind === 'recent-images') {
        remember(key, 'assistant', 'Posted recent images.');
        await seekdeepPostRecentImagesFromMessage(message, seekdeepRecentImagesRequestedLimit(prompt, 5, 10));
        return;
      }

      const content = seekdeepUtilityText(utilityKind, message, key);
      remember(key, 'assistant', content);
      await sendLongMessageReply(message, asTextBlock(content));
      return;
    }

    if (isNaturalStatusPrompt(prompt)) {'''
text, count = message_pattern.subn(message_replacement, text, count=1)
if count != 1:
    raise SystemExit('Could not patch SEEKDEEP_BATCH1_MESSAGE_ROUTE block.')

path.write_text(text, encoding='utf-8')
print('Patched index.js successfully.')
'@ | Set-Content .\patch_recent_images_preview.py -Encoding UTF8

& $pyExe .\patch_recent_images_preview.py
node --check .\index.js

Write-Host ""
Write-Host "[SeekDeep] Recent images preview patch complete. Restart the bot." -ForegroundColor Green
