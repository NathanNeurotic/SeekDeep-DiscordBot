from pathlib import Path
from datetime import datetime

path = Path('index.js')
text = path.read_text(encoding='utf-8-sig')


def find_function_range(src: str, name: str):
    starts=[]
    for prefix in [f'async function {name}', f'function {name}']:
        pos=src.find(prefix)
        if pos!=-1: starts.append(pos)
    if not starts: return None
    start=min(starts)
    paren=src.find('(',start)
    if paren==-1: raise SystemExit(f'No paren for {name}')
    depth=0; in_string=None; escape=False; line=False; block=False; i=paren
    while i<len(src):
        ch=src[i]; nxt=src[i+1] if i+1<len(src) else ''
        if line:
            if ch=='\n': line=False
            i+=1; continue
        if block:
            if ch=='*' and nxt=='/': block=False; i+=2; continue
            i+=1; continue
        if in_string:
            if escape: escape=False
            elif ch=='\\': escape=True
            elif ch==in_string: in_string=None
            i+=1; continue
        if ch=='/' and nxt=='/': line=True; i+=2; continue
        if ch=='/' and nxt=='*': block=True; i+=2; continue
        if ch in ("'",'"','`'): in_string=ch; i+=1; continue
        if ch=='(': depth+=1
        elif ch==')':
            depth-=1
            if depth==0:
                i+=1; break
        i+=1
    brace=src.find('{',i)
    if brace==-1: raise SystemExit(f'No brace for {name}')
    depth=0; in_string=None; escape=False; line=False; block=False; i=brace
    while i<len(src):
        ch=src[i]; nxt=src[i+1] if i+1<len(src) else ''
        if line:
            if ch=='\n': line=False
            i+=1; continue
        if block:
            if ch=='*' and nxt=='/': block=False; i+=2; continue
            i+=1; continue
        if in_string:
            if escape: escape=False
            elif ch=='\\': escape=True
            elif ch==in_string: in_string=None
            i+=1; continue
        if ch=='/' and nxt=='/': line=True; i+=2; continue
        if ch=='/' and nxt=='*': block=True; i+=2; continue
        if ch in ("'",'"','`'): in_string=ch; i+=1; continue
        if ch=='{': depth+=1
        elif ch=='}':
            depth-=1
            if depth==0: return start,i+1
        i+=1
    raise SystemExit(f'No close for {name}')

def replace_function(src,name,repl):
    rng=find_function_range(src,name)
    if not rng: raise SystemExit(f'Missing {name}')
    s,e=rng
    return src[:s]+repl.strip()+"\n\n"+src[e:].lstrip()

utility = r'''
function seekdeepUtilityPromptKind(prompt = '') {
  const p = normalizeUserText(prompt).toLowerCase().trim();

  if (!p) return '';

  // Archive dump is a hard command. Keep it out of chat/model routing.
  if (typeof isPostArchivePrompt === 'function' && isPostArchivePrompt(p)) return 'post-archive';
  if (/^(post|show|dump|upload|send)\s+(the\s+)?archive\b/.test(p)) return 'post-archive';

  // Queue status, including common typo observed during testing.
  if (/^(queue|que)\s+status\b/.test(p)) return 'image-queue';
  if (/^(image\s+queue|generation\s+queue|image\s+generation\s+queue)\b/.test(p)) return 'image-queue';

  if (/^(help|commands|command list|what can you do|what are your commands)\b/.test(p)) return 'help';
  if (/^(cache status|image cache status|temp cache status|cache)\b/.test(p)) return 'cache';
  if (/^(archive status|saved generation status|saved generations status)\b/.test(p)) return 'archive';
  if (/^(recent images|recent image|image history|recent generations|generation history)\b/.test(p)) return 'recent-images';
  if (/^(recent prompts|recent prompt|prompt history|last prompts|last prompt)\b/.test(p)) return 'recent-prompts';
  if (/^(admin status|am i admin)\b/.test(p)) return 'admin';

  return '';
}
'''
text = replace_function(text,'seekdeepUtilityPromptKind',utility)

helpers = r'''
// SEEKDEEP_STABILIZED_DISPATCH_HELPERS_START
function seekdeepCountBotMentionTags(message) {
  try {
    const id = message?.client?.user?.id || client?.user?.id || '';
    if (!id) return 0;
    const re = new RegExp(`<@!?${id}>`, 'g');
    return (String(message?.content || '').match(re) || []).length;
  } catch {
    return 0;
  }
}

function seekdeepMultipleCommandText() {
  return [
    'Multiple Seekotics commands were detected in one Discord message.',
    '',
    'Send one command per message so routing stays deterministic.',
    '',
    'Examples:',
    '@SEEKOTICS queue status',
    '@SEEKOTICS post archive',
    '@SEEKOTICS I need an image of a fat cat in Hyrule',
  ].join('\n');
}

function seekdeepLogRoute(kind, prompt) {
  try {
    console.log(`[SeekDeep] route=${kind} prompt=${String(prompt || '').slice(0, 180)}`);
  } catch {}
}
// SEEKDEEP_STABILIZED_DISPATCH_HELPERS_END
'''
if '// SEEKDEEP_STABILIZED_DISPATCH_HELPERS_START' in text:
    s=text.find('// SEEKDEEP_STABILIZED_DISPATCH_HELPERS_START')
    e=text.find('// SEEKDEEP_STABILIZED_DISPATCH_HELPERS_END',s)
    if e==-1: raise SystemExit('bad helper marker')
    e+=len('// SEEKDEEP_STABILIZED_DISPATCH_HELPERS_END')
    text=text[:s]+helpers.strip()+"\n\n"+text[e:].lstrip()
else:
    anchor="client.on('messageCreate', async (message) => {"
    pos=text.find(anchor)
    if pos==-1: raise SystemExit('missing message handler anchor')
    text=text[:pos]+helpers.strip()+"\n\n"+text[pos:]

new_handler = r'''
client.on('messageCreate', async (message) => {
  seekdeepMarkRequestStart(message);

  if (message?.id && !seekdeepClaimEventOnce(`message:${message.id}`)) {
    console.warn(`Duplicate Discord message event suppressed: ${message.id}`);
    return;
  }

  if (message.author?.bot || !client.user) return;
  if (!message.mentions?.has(client.user)) return;

  const mentionCount = seekdeepCountBotMentionTags(message);
  const prompt = normalizeUserText(stripBotMentions(message.content));

  if (!prompt) {
    await message.reply({
      content: seekdeepAppendResponseFooter('No command text found after the bot mention. Try `@SEEKOTICS help`.', {
        startedAt: message?.__seekdeepRequestStartedAt,
        modelUsed: seekdeepNoModelLabel(),
      }),
      allowedMentions: { repliedUser: false },
    });
    return;
  }

  if (mentionCount > 1) {
    seekdeepSetResponseModel(message, seekdeepNoModelLabel());
    await message.reply({
      content: seekdeepAppendResponseFooter(seekdeepMultipleCommandText(), {
        startedAt: message?.__seekdeepRequestStartedAt,
        modelUsed: seekdeepNoModelLabel(),
      }),
      allowedMentions: { repliedUser: false },
    });
    return;
  }

  if (!seekdeepClaimFinalReply('message-start', message?.id)) {
    console.warn(`Duplicate message handler path suppressed before generation: ${message?.id}`);
    stopSeekDeepTypingLoopForMessage(message);
    return;
  }

  if (!seekdeepClaimPromptOnce('message', message.author?.id || 'unknown', message.channel?.id || 'unknown', prompt || '(no-text)')) {
    console.warn(`Duplicate prompt suppressed from ${message.author?.id || 'unknown'} in ${message.channel?.id || 'unknown'}`);
    stopSeekDeepTypingLoopForMessage(message);
    return;
  }

  const typingLoop = startSeekDeepTypingLoop(message.channel, `message:${message.id}`);
  try {
    message.__seekdeepTypingLoop = typingLoop;
  } catch {}

  try {
    const key = memoryKeyFrom(message);
    const utilityKind = seekdeepUtilityPromptKind(prompt);

    // Hard local commands always win before AI chat/image routing.
    if (isNaturalPongPrompt(prompt) || isExactPongTest(prompt)) {
      seekdeepLogRoute('pong', prompt);
      remember(key, 'user', prompt);
      remember(key, 'assistant', 'pong');
      seekdeepSetResponseModel(message, seekdeepNoModelLabel());
      await sendLongMessageReply(message, 'pong');
      return;
    }

    if (utilityKind === 'post-archive') {
      seekdeepLogRoute('post-archive', prompt);
      remember(key, 'user', prompt);
      remember(key, 'assistant', 'Posting archive.');
      await seekdeepPostArchiveFromMessage(message);
      return;
    }

    if (utilityKind) {
      seekdeepLogRoute(utilityKind, prompt);
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

    if (isNaturalStatusPrompt(prompt) || isExplicitStatusRequest(prompt)) {
      seekdeepLogRoute('status', prompt);
      const status = await statusText();
      remember(key, 'user', prompt);
      remember(key, 'assistant', status);
      seekdeepSetResponseModel(message, seekdeepNoModelLabel());
      await sendLongMessageReply(message, asTextBlock(status));
      return;
    }

    if (isBotIdentityQuestion(prompt)) {
      seekdeepLogRoute('identity', prompt);
      const answer = botIdentityAnswer(message.client?.user?.username || client.user?.username || 'Seekotics');
      remember(key, 'user', prompt);
      remember(key, 'assistant', answer);
      seekdeepSetResponseModel(message, seekdeepNoModelLabel());
      await sendLongMessageReply(message, answer);
      return;
    }

    const visionTarget = await resolveVisionAttachment(message);
    const shouldUseVision =
      !!visionTarget.attachment &&
      (
        visionTarget.origin === 'direct' ||
        !prompt ||
        isNaturalVisionPrompt(prompt)
      );

    if (shouldUseVision) {
      seekdeepLogRoute('vision', prompt);
      const rawPrompt = prompt || 'Describe this media clearly.';
      const answer = await askVision(visionTarget.attachment, buildPromptWithMemory(rawPrompt, key));
      remember(key, 'user', rawPrompt);
      remember(key, 'assistant', answer);
      seekdeepSetResponseModel(message, seekdeepVisionModelLabel());
      await sendLongMessageReply(message, answer);
      return;
    }

    if (isNaturalImagePrompt(prompt)) {
      const imagePrompt = (typeof seekdeepExtractImagePrompt === 'function' ? seekdeepExtractImagePrompt(prompt) : prompt) || prompt;
      seekdeepLogRoute('image', imagePrompt);
      remember(key, 'user', `[natural-image] ${prompt}`);
      remember(key, 'assistant', `Queued image locally for: ${imagePrompt}`);
      await seekdeepSendImageWithButtonsMessage(message, imagePrompt, 1024, 1024, null);
      return;
    }

    seekdeepLogRoute('chat', prompt);
    const answer = await askChat(prompt, { web: 'auto', memoryKey: key });
    remember(key, 'user', prompt);
    remember(key, 'assistant', answer);
    seekdeepSetResponseModel(message, seekdeepChatModelLabel());
    await sendLongMessageReply(message, answer);
  } catch (err) {
    console.error(err);
    stopSeekDeepTypingLoopForMessage(message);
    seekdeepSetResponseModel(message, seekdeepNoModelLabel());
    await sendLongMessageReply(message, `SeekDeep request failed.\n\nError:\n${err.message}`);
  }
});
'''
start=text.find("client.on('messageCreate', async (message) => {")
if start==-1: raise SystemExit('missing handler')
end_marker='\nclient.login(TOKEN);'
end=text.find(end_marker,start)
if end==-1: raise SystemExit('missing login after handler')
# Replace only handler, keep login
text=text[:start]+new_handler.strip()+"\n\n"+text[end:].lstrip()

stamp = datetime.now().strftime('%Y%m%d-%H%M%S')
backup = Path(f'index.js.bak-stabilized-dispatch-{stamp}')
backup.write_text(path.read_text(encoding='utf-8-sig'), encoding='utf-8')
print(f'[SeekDeep] Backup written: {backup}')

required = [
    "function seekdeepUtilityPromptKind(prompt = '')",
    "return 'post-archive';",
    "return 'image-queue';",
    "SEEKDEEP_STABILIZED_DISPATCH_HELPERS_START",
    "Multiple Seekotics commands were detected",
    "if (utilityKind === 'post-archive')",
    "await seekdeepPostArchiveFromMessage(message);",
    "seekdeepLogRoute('image', imagePrompt)",
]
missing = [item for item in required if item not in text]
if missing:
    raise SystemExit('Stabilization patch failed. Missing: ' + ', '.join(missing))

path.write_text(text, encoding='utf-8')
print('[SeekDeep] Stabilized dispatcher patch written.')

