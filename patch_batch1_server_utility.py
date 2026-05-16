from pathlib import Path
from datetime import datetime

path = Path('index.js')
text = path.read_text(encoding='utf-8-sig')

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
            i += 1; continue
        if block_comment:
            if ch == '*' and nxt == '/': block_comment = False; i += 2; continue
            i += 1; continue
        if in_string:
            if escape: escape = False
            elif ch == '\\': escape = True
            elif ch == in_string: in_string = None
            i += 1; continue
        if ch == '/' and nxt == '/': line_comment = True; i += 2; continue
        if ch == '/' and nxt == '*': block_comment = True; i += 2; continue
        if ch in ("'", '"', '`'): in_string = ch; i += 1; continue
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
    i = brace
    while i < len(src):
        ch = src[i]
        nxt = src[i+1] if i+1 < len(src) else ''
        if line_comment:
            if ch == '\n': line_comment = False
            i+=1; continue
        if block_comment:
            if ch=='*' and nxt=='/': block_comment=False; i+=2; continue
            i+=1; continue
        if in_string:
            if escape: escape=False
            elif ch=='\\': escape=True
            elif ch==in_string: in_string=None
            i+=1; continue
        if ch=='/' and nxt=='/': line_comment=True; i+=2; continue
        if ch=='/' and nxt=='*': block_comment=True; i+=2; continue
        if ch in ("'", '"', '`'): in_string=ch; i+=1; continue
        if ch=='{': depth += 1
        elif ch=='}':
            depth -= 1
            if depth == 0:
                return start, i+1
        i += 1
    raise SystemExit(f'Could not find closing brace for {name}')

# Helper block
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

function seekdeepReadArchiveMetadata() {
  const dir = seekdeepArchiveDirResolved();
  const jsonItems = seekdeepWalkFiles(dir)
    .filter((file) => file.name.toLowerCase().endsWith('.json'))
    .map((file) => ({ ...seekdeepSafeReadJson(file.fullPath), __metaPath: file.fullPath, __stat: file.stat, __kind: 'archive' }))
    .filter((item) => item && (item.id || item.prompt));

  if (jsonItems.length) return jsonItems;

  return seekdeepDirFileStats(dir, true).files.map((file) => ({
    id: path.basename(file.name, path.extname(file.name)),
    prompt: path.basename(file.name, path.extname(file.name)).replace(/^\d{4}-\d{2}-\d{2}t/i, '').replace(/[-_]+/g, ' ').trim() || file.name,
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

function seekdeepRecentImagesText(limit = 10) {
  const temp = seekdeepReadTempImageCacheMetadata();
  const archive = seekdeepReadArchiveMetadata();
  const items = [...temp, ...archive]
    .sort((a, b) => Number(b.createdAt || b.__stat?.mtimeMs || 0) - Number(a.createdAt || a.__stat?.mtimeMs || 0))
    .slice(0, limit);

  if (!items.length) return 'Recent images\n\nNo recent image metadata found.';

  return [
    'Recent images',
    '',
    ...items.map((item, index) => {
      const label = item.__kind === 'archive' ? 'archive' : 'temp';
      const when = seekdeepFormatTimestamp(item.createdAt || item.__stat?.mtimeMs || 0);
      const prompt = seekdeepShorten(item.prompt || item.filename || item.id || '(unknown prompt)', 130);
      return `${index + 1}. [${label}] ${prompt}\n   Created: ${when}\n   ID/File: ${item.id || item.filename || 'unknown'}`;
    }),
  ].join('\n');
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

# insert helper before commands or replace
if 'SEEKDEEP_BATCH1_UTILITY_START' in text:
    start = text.find('// SEEKDEEP_BATCH1_UTILITY_START')
    end = text.find('// SEEKDEEP_BATCH1_UTILITY_END', start)
    if end == -1: raise SystemExit('Missing batch1 utility end marker')
    end += len('// SEEKDEEP_BATCH1_UTILITY_END')
    text = text[:start] + helper.strip() + '\n\n' + text[end:].lstrip()
else:
    anchor = 'const commands = ['
    pos = text.find(anchor)
    if pos == -1: raise SystemExit('Could not find commands array anchor')
    text = text[:pos] + helper.strip() + '\n\n' + text[pos:]

# add slash commands before status
if ".setName('help')" not in text:
    status_marker = "  new SlashCommandBuilder()\n    .setName('status')"
    insert = r'''  new SlashCommandBuilder()
    .setName('help')
    .setDescription('Show Seekotics command help.'),
  new SlashCommandBuilder()
    .setName('cachestatus')
    .setDescription('Show temp image cache status.'),
  new SlashCommandBuilder()
    .setName('archivestatus')
    .setDescription('Show permanent image archive status.'),
  new SlashCommandBuilder()
    .setName('recent')
    .setDescription('Show recent Seekotics items.')
    .addStringOption((o) =>
      o.setName('kind')
        .setDescription('Recent item type')
        .setRequired(false)
        .addChoices(
          { name: 'images', value: 'images' },
          { name: 'prompts', value: 'prompts' },
        )
    ),
'''
    if status_marker not in text: raise SystemExit('Could not find status command marker')
    text = text.replace(status_marker, insert + status_marker, 1)

# add interaction route before postarchive
if 'SEEKDEEP_BATCH1_INTERACTION_ROUTE' not in text:
    marker = "    if (interaction.commandName === 'postarchive') {"
    route = r'''    // SEEKDEEP_BATCH1_INTERACTION_ROUTE
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

      const content = seekdeepUtilityText(kind, interaction, key);
      seekdeepSetResponseModel(interaction, seekdeepNoModelLabel());
      await sendLongInteractionReply(interaction, asTextBlock(content));
      return;
    }

'''
    if marker not in text: raise SystemExit('Could not find postarchive interaction marker')
    text = text.replace(marker, route + marker, 1)

# add message route after key
if 'SEEKDEEP_BATCH1_MESSAGE_ROUTE' not in text:
    marker = "    const key = memoryKeyFrom(message);\n"
    route = r'''    // SEEKDEEP_BATCH1_MESSAGE_ROUTE
    const utilityKind = seekdeepUtilityPromptKind(prompt);
    if (utilityKind) {
      const content = seekdeepUtilityText(utilityKind, message, key);
      remember(key, 'user', prompt);
      remember(key, 'assistant', content);
      seekdeepSetResponseModel(message, seekdeepNoModelLabel());
      await sendLongMessageReply(message, asTextBlock(content));
      return;
    }

'''
    if marker not in text: raise SystemExit('Could not find message key marker')
    text = text.replace(marker, marker + route, 1)

# update Ready text optionally
text = text.replace("Ready. Use: /ask, /refine, /image, /vision, /status", "Ready. Use: /ask, /refine, /image, /vision, /status, /help")

required = ['SEEKDEEP_BATCH1_UTILITY_START', 'function seekdeepHelpText(', 'function seekdeepCacheStatusText(', 'SEEKDEEP_BATCH1_MESSAGE_ROUTE', 'SEEKDEEP_BATCH1_INTERACTION_ROUTE', ".setName('help')", ".setName('cachestatus')", ".setName('archivestatus')", ".setName('recent')"]
missing=[x for x in required if x not in text]
if missing:
    raise SystemExit('Missing: '+', '.join(missing))

path.write_text(text, encoding='utf-8')

