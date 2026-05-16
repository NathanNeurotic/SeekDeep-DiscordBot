$ErrorActionPreference = "Stop"
cd "$env:USERPROFILE\SeekDeep-DiscordBot"

$pyExe = ".\.venv\Scripts\python.exe"
if (!(Test-Path $pyExe)) { $pyExe = "python" }

@'
from pathlib import Path
from datetime import datetime

path = Path('index.js')
text = path.read_text(encoding='utf-8-sig')

stamp = datetime.now().strftime('%Y%m%d-%H%M%S')
backup = Path(f'index.js.bak-drawme-dedupe-polish-{stamp}')
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
                i += 1; break
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

explicit_func = r'''
function seekdeepHasExplicitImageRequest(p = '') {
  const text = normalizeUserText(p).toLowerCase().trim();

  if (!text) return false;

  if (/\b(generate|create|make|draw|render|paint|illustrate|design)\s+(?:me\s+)?(?:an?\s+|some\s+)?(?:image|picture|photo|pic|art|artwork|drawing|wallpaper|banner|logo|icon|poster|portrait)\b/i.test(text)) {
    return true;
  }

  if (/\b(image|picture|photo|pic|artwork|drawing|wallpaper|banner|logo|icon|poster|portrait)\s+(?:of|for)\b/i.test(text)) {
    return true;
  }

  if (/\b(?:image|picture|photo|pic)\b/i.test(text)) {
    return true;
  }

  // Natural draw/sketch/paint wording without requiring the word "image".
  // Examples:
  //   draw me a fat cat
  //   draw me an elf wizard
  //   draw me pepe in a blue shirt
  //   sketch me a haunted robot
  if (/\b(?:draw|sketch|paint|illustrate)\s+me\s+(?:an?\s+|some\s+)?\S+/i.test(text)) {
    return true;
  }

  if (/\b(?:draw|sketch|paint|illustrate)\s+(?:an?\s+|some\s+)?\S+/i.test(text) && seekdeepHasVisualSubjectWords(text)) {
    return true;
  }

  return false;
}
'''

text, _ = replace_function(text, 'seekdeepHasExplicitImageRequest', explicit_func)
print('[SeekDeep] Patched seekdeepHasExplicitImageRequest for draw-me prompts.')

old_trigger = "const SEEKDEEP_IMAGE_TRIGGER_RE = /\\b(generate|create|make|draw|render|paint|illustrate|show me|show|image of|picture of|photo of|portrait of|poster of|wallpaper of|design)\\b/i;"
new_trigger = "const SEEKDEEP_IMAGE_TRIGGER_RE = /\\b(generate|create|make|draw|draw me|sketch|sketch me|render|paint|paint me|illustrate|illustrate me|show me|show|image of|picture of|photo of|portrait of|poster of|wallpaper of|design)\\b/i;"
if old_trigger in text:
    text = text.replace(old_trigger, new_trigger, 1)
    print('[SeekDeep] Expanded SEEKDEEP_IMAGE_TRIGGER_RE.')
elif 'const SEEKDEEP_IMAGE_TRIGGER_RE' in text:
    print('[SeekDeep] Image trigger regex exists but exact prior text differed; explicit function patch should still cover draw-me.')
else:
    print('[SeekDeep] Image trigger regex not found; explicit function patch should still cover draw-me.')

extract_func = r'''
function seekdeepExtractImagePrompt(text = '') {
  let t = normalizeUserText(text);

  t = t.replace(/<@!?\d+>/g, ' ').trim();
  t = t.replace(/^(?:hey|yo|hi|hello)\s+/i, '');
  t = t.replace(/^(?:seekdeep|seekotics|neurabot|plugtalk)[,:]?\s+/i, '');
  t = t.replace(/^(?:please\s+)?(?:can you|could you|would you)\s+/i, '');
  t = t.replace(/^(?:please\s+)?(?:show me|make me|generate|create|draw|sketch|render|paint|illustrate|design)\s+(?:me\s+)?/i, '');
  t = t.replace(/^(?:an?\s+)?(?:image|picture|photo|pic|art|artwork|drawing|wallpaper|banner|logo|icon|poster|portrait)\s+(?:of|for)\s+/i, '');
  t = t.replace(/^(?:i need|need|i want|want)\s+(?:an?\s+|some\s+)?(?:image|picture|photo|pic|art|artwork|drawing|wallpaper|banner|logo|icon|poster|portrait)?\s*(?:of|for)?\s*/i, '');
  t = t.replace(/\s+/g, ' ').trim();

  return t;
}
'''
text, _ = replace_function(text, 'seekdeepExtractImagePrompt', extract_func)
print('[SeekDeep] Patched seekdeepExtractImagePrompt.')

dedupe_helper = r'''
// SEEKDEEP_HARD_COMMAND_DEDUPE_EXEMPT_START
function seekdeepIsPromptDedupeExempt(prompt = '') {
  const p = normalizeUserText(prompt).toLowerCase().trim();

  if (!p) return false;

  if (typeof isNaturalPongPrompt === 'function' && isNaturalPongPrompt(p)) return true;
  if (typeof isExactPongTest === 'function' && isExactPongTest(p)) return true;
  if (typeof isNaturalStatusPrompt === 'function' && isNaturalStatusPrompt(p)) return true;
  if (typeof seekdeepUtilityPromptKind === 'function' && seekdeepUtilityPromptKind(p)) return true;

  return /^(?:queue|que)\s+status\b/.test(p) ||
    /^post\s+archive\b/.test(p) ||
    /^archive\s+status\b/.test(p) ||
    /^cache\s+status\b/.test(p) ||
    /^recent\s+(?:images|image|prompts|prompt)\b/.test(p) ||
    /^admin\s+status\b/.test(p) ||
    /^(?:help|commands)\b/.test(p);
}
// SEEKDEEP_HARD_COMMAND_DEDUPE_EXEMPT_END
'''

if '// SEEKDEEP_HARD_COMMAND_DEDUPE_EXEMPT_START' in text:
    start = text.find('// SEEKDEEP_HARD_COMMAND_DEDUPE_EXEMPT_START')
    end = text.find('// SEEKDEEP_HARD_COMMAND_DEDUPE_EXEMPT_END', start)
    if end == -1:
        raise SystemExit('Found dedupe helper start marker but no end marker.')
    end += len('// SEEKDEEP_HARD_COMMAND_DEDUPE_EXEMPT_END')
    text = text[:start] + dedupe_helper.strip() + '\n\n' + text[end:].lstrip()
    print('[SeekDeep] Replaced hard-command dedupe helper.')
else:
    anchor = "client.on('messageCreate', async (message) => {"
    pos = text.find(anchor)
    if pos == -1:
        raise SystemExit('Could not find messageCreate anchor for dedupe helper.')
    text = text[:pos] + dedupe_helper.strip() + '\n\n' + text[pos:]
    print('[SeekDeep] Inserted hard-command dedupe helper.')

old_dedupe = '''  if (!seekdeepClaimPromptOnce('message', message.author?.id || 'unknown', message.channel?.id || 'unknown', prompt || '(no-text)')) {
    console.warn(`Duplicate prompt suppressed from ${message.author?.id || 'unknown'} in ${message.channel?.id || 'unknown'}`);
    stopSeekDeepTypingLoopForMessage(message);
    return;
  }'''
new_dedupe = '''  if (!seekdeepIsPromptDedupeExempt(prompt) && !seekdeepClaimPromptOnce('message', message.author?.id || 'unknown', message.channel?.id || 'unknown', prompt || '(no-text)')) {
    console.warn(`Duplicate prompt suppressed from ${message.author?.id || 'unknown'} in ${message.channel?.id || 'unknown'}`);
    stopSeekDeepTypingLoopForMessage(message);
    return;
  }'''

if old_dedupe in text:
    text = text.replace(old_dedupe, new_dedupe, 1)
    print('[SeekDeep] Patched prompt dedupe to exempt hard commands.')
elif 'seekdeepIsPromptDedupeExempt(prompt)' in text:
    print('[SeekDeep] Hard-command dedupe exemption already installed.')
else:
    raise SystemExit('Could not find dedupe block to patch.')

required = [
    'draw|sketch|paint|illustrate',
    'function seekdeepIsPromptDedupeExempt(',
    '!seekdeepIsPromptDedupeExempt(prompt) && !seekdeepClaimPromptOnce',
    'function seekdeepExtractImagePrompt(',
]

missing = [item for item in required if item not in text]
if missing:
    raise SystemExit('Patch failed. Missing: ' + ', '.join(missing))

path.write_text(text, encoding='utf-8')
print('[SeekDeep] Draw-me trigger and hard-command dedupe polish written.')
'@ | Set-Content .\patch_drawme_dedupe_polish.py -Encoding UTF8

& $pyExe .\patch_drawme_dedupe_polish.py

node --check .\index.js
.\.venv\Scripts\python.exe -m py_compile .\local_ai_server.py

Write-Host ""
Write-Host "[SeekDeep] Draw-me trigger / dedupe polish complete. Restart with launcher option 8." -ForegroundColor Green
