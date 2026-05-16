from pathlib import Path
from datetime import datetime

path = Path('index.js')
text = path.read_text(encoding='utf-8-sig')

stamp = datetime.now().strftime('%Y%m%d-%H%M%S')
backup = Path(f'index.js.bak-image-prompt-refinement-{stamp}')
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
            if ch == '\n': line_comment = False
            i += 1; continue
        if block_comment:
            if ch == '*' and nxt == '/':
                block_comment = False; i += 2; continue
            i += 1; continue
        if in_string:
            if escape: escape = False
            elif ch == '\\': escape = True
            elif ch == in_string: in_string = None
            i += 1; continue
        if ch == '/' and nxt == '/':
            line_comment = True; i += 2; continue
        if ch == '/' and nxt == '*':
            block_comment = True; i += 2; continue
        if ch in ("'", '"', '`'):
            in_string = ch; i += 1; continue
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
            if ch == '\n': line_comment = False
            i += 1; continue
        if block_comment:
            if ch == '*' and nxt == '/':
                block_comment = False; i += 2; continue
            i += 1; continue
        if in_string:
            if escape: escape = False
            elif ch == '\\': escape = True
            elif ch == in_string: in_string = None
            i += 1; continue
        if ch == '/' and nxt == '/':
            line_comment = True; i += 2; continue
        if ch == '/' and nxt == '*':
            block_comment = True; i += 2; continue
        if ch in ("'", '"', '`'):
            in_string = ch; i += 1; continue
        if ch == '{': depth += 1
        elif ch == '}':
            depth -= 1
            if depth == 0:
                return start, i + 1
        i += 1
    raise SystemExit(f'Could not find closing brace for {name}.')

def replace_function(src: str, name: str, replacement: str):
    rng = find_function_range(src, name)
    if rng is None:
        raise SystemExit(f'Could not find function: {name}')
    start, end = rng
    return src[:start] + replacement.strip() + '\n\n' + src[end:].lstrip()

helpers = r'''
// SEEKDEEP_IMAGE_PROMPT_REFINEMENT_START
const SEEKDEEP_IMAGE_PROMPT_REFINEMENT_ENABLED = !/^(0|false|off|no)$/i.test(String(process.env.SEEKDEEP_IMAGE_PROMPT_REFINEMENT || 'true'));
const SEEKDEEP_IMAGE_PROMPT_REFINEMENT_LOG = /^(1|true|on|yes)$/i.test(String(process.env.SEEKDEEP_IMAGE_PROMPT_REFINEMENT_LOG || 'true'));
const SEEKDEEP_IMAGE_PROMPT_MAX_CHARS = Math.max(300, Number(process.env.SEEKDEEP_IMAGE_PROMPT_MAX_CHARS || 900));

function seekdeepImagePromptHasAny(lower, words) {
  return words.some((word) => lower.includes(word));
}

function seekdeepImagePromptAdd(parts, phrase) {
  const clean = String(phrase || '').replace(/\s+/g, ' ').trim();
  if (!clean) return;
  const lower = clean.toLowerCase();
  if (!parts.some((part) => String(part).toLowerCase() === lower)) parts.push(clean);
}

function seekdeepPrepareImagePrompt(prompt = '') {
  const originalPrompt = normalizeUserText(prompt || '').trim() || 'image';

  if (!SEEKDEEP_IMAGE_PROMPT_REFINEMENT_ENABLED) {
    return { originalPrompt, refinedPrompt: originalPrompt, generationPrompt: originalPrompt, changed: false };
  }

  const lower = originalPrompt.toLowerCase();
  const parts = [originalPrompt];
  const hasStyle = /\b(hyper\s*realistic|photorealistic|realistic|cinematic|anime|manga|comic|oil painting|watercolor|pixel art|3d|render|illustration|illustrated|stylized|painterly|graphic|vector|logo|icon|poster|album art|wallpaper|sketch|low poly|claymation|stop motion)\b/i.test(originalPrompt);
  const hasQuality = /\b(high quality|detailed|sharp|clean|polished|professional|masterpiece|ultra detailed|high detail|hd|4k|8k|coherent|clear)\b/i.test(originalPrompt);
  const hasLighting = /\b(lighting|lit|glow|shadow|sunset|sunrise|moonlight|neon|ambient|dramatic light|soft light|studio light|rim light|backlit)\b/i.test(originalPrompt);
  const hasComposition = /\b(composition|centered|off center|wide shot|close up|portrait|landscape|symmetrical|asymmetrical|negative space|foreground|background|depth)\b/i.test(originalPrompt);
  const asksText = /\b(text|words|lettering|title|caption|says|saying|sign|label|typography|font)\b/i.test(originalPrompt);

  if (seekdeepImagePromptHasAny(lower, ['logo', 'icon', 'emblem', 'badge'])) {
    if (!hasStyle) seekdeepImagePromptAdd(parts, 'clean graphic emblem design, bold readable silhouette, scalable vector-like shapes');
    if (!hasComposition) seekdeepImagePromptAdd(parts, 'balanced centered composition with strong negative space');
    seekdeepImagePromptAdd(parts, 'no random lettering, no fake brand marks, no malformed symbols');
  } else if (seekdeepImagePromptHasAny(lower, ['banner', 'wallpaper', 'cover art', 'album art', 'poster'])) {
    if (!hasStyle) seekdeepImagePromptAdd(parts, 'polished graphic illustration with a strong focal point');
    if (!hasComposition) seekdeepImagePromptAdd(parts, 'clear composition, usable negative space, layered background depth');
  } else if (/\b(hyper\s*realistic|photorealistic|realistic|photo)\b/i.test(originalPrompt)) {
    seekdeepImagePromptAdd(parts, 'natural materials, accurate structure, believable surface detail');
    if (!hasLighting) seekdeepImagePromptAdd(parts, 'controlled realistic lighting with clear depth');
  } else if (!hasStyle) {
    seekdeepImagePromptAdd(parts, 'stylized detailed illustration, strong readable subject, polished composition');
  }

  if (seekdeepImagePromptHasAny(lower, ['cat', 'dog', 'fox', 'frog', 'animal', 'creature', 'dragon', 'bird', 'horse'])) seekdeepImagePromptAdd(parts, 'coherent animal anatomy, expressive face, natural pose');
  if (seekdeepImagePromptHasAny(lower, ['girl', 'woman', 'boy', 'man', 'person', 'human', 'elf', 'character', 'portrait'])) seekdeepImagePromptAdd(parts, 'coherent face, natural anatomy, clean hands, readable character design');
  if (seekdeepImagePromptHasAny(lower, ['plant', 'flower', 'tree', 'forest', 'leaf', 'leaves', 'cannabis', 'marijuana', 'moss', 'fungi'])) seekdeepImagePromptAdd(parts, 'botanical detail, clear leaf structure, organic texture, natural growth pattern');
  if (seekdeepImagePromptHasAny(lower, ['hyrule', 'fantasy kingdom', 'castle', 'wizard', 'dungeon', 'forest', 'deku'])) seekdeepImagePromptAdd(parts, 'fantasy adventure atmosphere, detailed environment, whimsical but coherent world design');
  if (!hasQuality) seekdeepImagePromptAdd(parts, 'high quality, coherent details, clean edges, no muddy artifacts');
  if (!hasLighting) seekdeepImagePromptAdd(parts, 'intentional lighting, color harmony, clear depth separation');
  if (!asksText) seekdeepImagePromptAdd(parts, 'no random text, no unreadable letters');
  seekdeepImagePromptAdd(parts, 'avoid malformed limbs, duplicated faces, distorted eyes, warped anatomy, cluttered composition');

  let refinedPrompt = parts.join(', ').replace(/\s+/g, ' ').trim();
  if (refinedPrompt.length > SEEKDEEP_IMAGE_PROMPT_MAX_CHARS) refinedPrompt = refinedPrompt.slice(0, SEEKDEEP_IMAGE_PROMPT_MAX_CHARS).replace(/[,;:\s]+$/g, '').trim();
  return { originalPrompt, refinedPrompt, generationPrompt: refinedPrompt, changed: refinedPrompt !== originalPrompt };
}
// SEEKDEEP_IMAGE_PROMPT_REFINEMENT_END
'''

if '// SEEKDEEP_IMAGE_PROMPT_REFINEMENT_START' in text:
    start = text.find('// SEEKDEEP_IMAGE_PROMPT_REFINEMENT_START')
    end = text.find('// SEEKDEEP_IMAGE_PROMPT_REFINEMENT_END', start)
    if end == -1: raise SystemExit('Found refinement start marker but no end marker.')
    end += len('// SEEKDEEP_IMAGE_PROMPT_REFINEMENT_END')
    text = text[:start] + helpers.strip() + '\n\n' + text[end:].lstrip()
    print('[SeekDeep] Replaced image prompt refinement helpers.')
else:
    anchor = 'async function makeImageResult('
    pos = text.find(anchor)
    if pos == -1: raise SystemExit('Could not find makeImageResult insertion anchor.')
    text = text[:pos] + helpers.strip() + '\n\n' + text[pos:]
    print('[SeekDeep] Inserted image prompt refinement helpers.')

make_image_result = r'''
async function makeImageResult(prompt, width = 1024, height = 1024, seed = null) {
  const promptInfo = seekdeepPrepareImagePrompt(prompt);

  if (promptInfo.changed && SEEKDEEP_IMAGE_PROMPT_REFINEMENT_LOG) {
    console.log(`[SeekDeep] image prompt refined:\n  original: ${promptInfo.originalPrompt}\n  refined : ${promptInfo.refinedPrompt}`);
  }

  const response = await postLocal('/image', {
    prompt: promptInfo.generationPrompt,
    width,
    height,
    steps: 2,
    guidance_scale: Number(process.env.IMAGE_GUIDANCE_SCALE || 0.0),
    seed,
  });

  const buffer = Buffer.from(response.image_b64, 'base64');
  const filename = response.filename || 'seekdeep_image.png';

  return {
    file: new AttachmentBuilder(buffer, { name: filename }),
    buffer,
    filename,
    prompt: promptInfo.originalPrompt,
    originalPrompt: promptInfo.originalPrompt,
    refinedPrompt: promptInfo.refinedPrompt,
    generationPrompt: promptInfo.generationPrompt,
    promptRefined: promptInfo.changed,
    width,
    height,
    seed,
  };
}
'''
text = replace_function(text, 'makeImageResult', make_image_result)
print('[SeekDeep] Replaced makeImageResult with deterministic prompt refinement.')

old_meta = '''    prompt: state?.prompt || '',
    width: Number(state?.width || 1024),'''
new_meta = '''    prompt: state?.prompt || '',
    originalPrompt: state?.originalPrompt || state?.prompt || '',
    refinedPrompt: state?.refinedPrompt || state?.prompt || '',
    generationPrompt: state?.generationPrompt || state?.refinedPrompt || state?.prompt || '',
    promptRefined: Boolean(state?.promptRefined),
    width: Number(state?.width || 1024),'''
if old_meta in text and new_meta not in text:
    text = text.replace(old_meta, new_meta, 1)
    print('[SeekDeep] Added refinement metadata support to temp cache.')

required = [
    'SEEKDEEP_IMAGE_PROMPT_REFINEMENT_START',
    'function seekdeepPrepareImagePrompt(',
    'const promptInfo = seekdeepPrepareImagePrompt(prompt);',
    'prompt: promptInfo.generationPrompt',
    'originalPrompt: promptInfo.originalPrompt',
    'refinedPrompt: promptInfo.refinedPrompt',
]
missing = [item for item in required if item not in text]
if missing:
    raise SystemExit('Patch failed. Missing: ' + ', '.join(missing))

path.write_text(text, encoding='utf-8')
print('[SeekDeep] Image prompt refinement patch written.')

