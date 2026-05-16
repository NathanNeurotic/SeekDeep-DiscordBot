from pathlib import Path
from datetime import datetime

path = Path('index.js')
text = path.read_text(encoding='utf-8-sig')

stamp = datetime.now().strftime('%Y%m%d-%H%M%S')
backup = Path(f'index.js.bak-early-image-route-hotfix-{stamp}')
backup.write_text(text, encoding='utf-8')
print(f'[SeekDeep] Backup written: {backup}')

marker = '// SEEKDEEP_EARLY_IMAGE_ROUTE_HOTFIX_START'

if marker in text:
    print('[SeekDeep] Early image route hotfix already present; refreshing block.')
    start = text.find(marker)
    end_marker = '// SEEKDEEP_EARLY_IMAGE_ROUTE_HOTFIX_END'
    end = text.find(end_marker, start)
    if end == -1:
        raise SystemExit('Found early image route start marker but no end marker.')
    end += len(end_marker)
    text = text[:start] + text[end:].lstrip()

needle = "    const key = memoryKeyFrom(message);\n"
if needle not in text:
    raise SystemExit('Could not find message handler key anchor.')

block = r'''
    // SEEKDEEP_EARLY_IMAGE_ROUTE_HOTFIX_START
    // Force obvious image-generation prompts into the image queue before status/chat/utility routing.
    // This protects prompts like:
    //   "generate an image of a hyper realistic cannabis plant"
    //   "hyper realistic cannabis plant"
    //   "show me a fat cat in hyrule with a green hat"
    if (
      typeof isNaturalImagePrompt === 'function' &&
      typeof seekdeepSendImageWithButtonsMessage === 'function' &&
      isNaturalImagePrompt(prompt)
    ) {
      const imagePrompt =
        (typeof seekdeepExtractImagePrompt === 'function' ? seekdeepExtractImagePrompt(prompt) : prompt) ||
        prompt;

      console.log(`[SeekDeep] early image route -> ${imagePrompt}`);

      remember(key, 'user', `[natural-image] ${prompt}`);
      remember(key, 'assistant', `Queued image locally for: ${imagePrompt}`);

      stopSeekDeepTypingLoopForMessage(message);

      await seekdeepSendImageWithButtonsMessage(message, imagePrompt, 1024, 1024, null);
      return;
    }
    // SEEKDEEP_EARLY_IMAGE_ROUTE_HOTFIX_END

'''

text = text.replace(needle, needle + block, 1)

required = [
    'SEEKDEEP_EARLY_IMAGE_ROUTE_HOTFIX_START',
    'early image route ->',
    'await seekdeepSendImageWithButtonsMessage(message, imagePrompt, 1024, 1024, null);',
]

missing = [item for item in required if item not in text]
if missing:
    raise SystemExit('Patch failed. Missing: ' + ', '.join(missing))

path.write_text(text, encoding='utf-8')
print('[SeekDeep] Early image route hotfix written.')
