from pathlib import Path
import re
import sys

if len(sys.argv) != 2:
    raise SystemExit("Usage: patch_grounded_image_subject_context.py <index.js>")

path = Path(sys.argv[1])
raw = path.read_bytes()
newline = "\r\n" if b"\r\n" in raw else "\n"
text = raw.decode("utf-8-sig").replace("\r\n", "\n").replace("\r", "\n")

def require_contains(haystack: str, needle: str, label: str):
    if needle not in haystack:
        raise SystemExit(f"Required anchor not found: {label}")

for needle, label in [
    ("function isNaturalImagePrompt", "isNaturalImagePrompt"),
    ("async function makeImageResult", "makeImageResult"),
    ("async function seekdeepSendImageWithButtonsMessage", "seekdeepSendImageWithButtonsMessage"),
    ("async function askChat", "askChat"),
    ("seekdeepEnqueueImageJob(job, runner)", "correct image queue contract"),
]:
    require_contains(text, needle, label)

if "seekdeepMakeImageQueueJobId" in text:
    raise SystemExit("Unsafe old queue helper found: seekdeepMakeImageQueueJobId")
if "job.run" in text:
    raise SystemExit("Unsafe job.run-style queue logic found")

helpers = r"""
// SEEKDEEP_GROUNDED_IMAGE_CONTEXT_START
const SEEKDEEP_RECENT_IMAGE_SUBJECTS = globalThis.__seekdeepRecentImageSubjects || new Map();
globalThis.__seekdeepRecentImageSubjects = SEEKDEEP_RECENT_IMAGE_SUBJECTS;

function seekdeepImageContextKeyFromMessage(message) {
  const channelId = message?.channel?.id || 'unknown-channel';
  const userId = message?.author?.id || 'unknown-user';
  return `${channelId}:${userId}`;
}

function seekdeepIsGenericImageFollowupPrompt(prompt = '') {
  const p = normalizeUserText(prompt).toLowerCase().trim();
  return /^(generate|create|make|draw|paint|sketch|illustrate|render|show)(\s+me)?\s+(an?\s+)?(image|picture|pic|art|drawing|illustration|it|that|this)$/i.test(p);
}

function seekdeepRememberImageSubjectPrompt(message, prompt = '') {
  const clean = normalizeUserText(prompt).trim();
  if (!clean || seekdeepIsGenericImageFollowupPrompt(clean)) return;
  if (clean.length < 3 || clean.length > 300) return;

  SEEKDEEP_RECENT_IMAGE_SUBJECTS.set(seekdeepImageContextKeyFromMessage(message), {
    prompt: clean,
    at: Date.now(),
  });
}

function seekdeepResolveImagePromptFromContext(message, prompt = '') {
  const clean = normalizeUserText(prompt).trim();
  if (!seekdeepIsGenericImageFollowupPrompt(clean)) {
    seekdeepRememberImageSubjectPrompt(message, clean);
    return { prompt: clean, resolvedFromContext: false, missingContext: false };
  }

  const item = SEEKDEEP_RECENT_IMAGE_SUBJECTS.get(seekdeepImageContextKeyFromMessage(message));
  const ttlMs = Number(process.env.SEEKDEEP_IMAGE_CONTEXT_TTL_MS || 10 * 60 * 1000);

  if (item?.prompt && (Date.now() - Number(item.at || 0)) <= ttlMs) {
    return { prompt: item.prompt, resolvedFromContext: true, missingContext: false };
  }

  return { prompt: clean, resolvedFromContext: false, missingContext: true };
}

function seekdeepLooksLikeTextQuestionForImageRoute(prompt = '') {
  const p = normalizeUserText(prompt).toLowerCase().trim();
  return /^(what|who|why|how|when|where|is|are|do|does|did|can|could|would|should)\b/.test(p) ||
    /\b(explain|tell me about|summarize|summary|define|definition|how to|guide|steps|instructions|difference between|compare|comparison|pros\/cons|pros and cons)\b/.test(p);
}

function seekdeepLooksLikeGroundableVisualSubject(prompt = '') {
  const p = normalizeUserText(prompt).toLowerCase().trim();
  if (!p || p.length > 220) return false;
  if (seekdeepLooksLikeTextQuestionForImageRoute(p)) return false;

  const specificCue = /\b(from|by|official|accurate|actual|game item|collectible|character|franchise)\b/.test(p);
  const namedCue = /\b(animal crossing|nintendo|pokemon|pok[eÃ©]mon|zelda|hyrule|mario|sailor moon|sonic|playstation|ps2|xbox|minecraft|fortnite|roblox|disney|marvel|dc comics|star wars|final fantasy|pepe)\b/.test(p);
  const objectCue = /\b(bag|bells|coin|coins|sword|shield|logo|emblem|badge|item|object|prop|weapon|helmet|armor|poster|cover|album cover|sticker|toy|figure)\b/.test(p);

  if (/^(a|an|the)\s+/.test(p) && (specificCue || namedCue) && objectCue) return true;
  if ((specificCue && namedCue && objectCue) || (namedCue && /\b(item|object|prop|bag|bells|coin|coins)\b/.test(p))) return true;

  return false;
}

function seekdeepNeedsImageGrounding(prompt = '') {
  const p = normalizeUserText(prompt).toLowerCase();
  if (!p || p.length > 280) return false;

  if (/\b(from|by|official|accurate|actual|game item|collectible|franchise)\b/.test(p) &&
      /\b(animal crossing|nintendo|pokemon|pok[eÃ©]mon|zelda|hyrule|mario|sailor moon|sonic|playstation|ps2|xbox|minecraft|fortnite|roblox|disney|marvel|dc comics|star wars|final fantasy|pepe)\b/.test(p)) {
    return true;
  }

  if (/\b(bag of bells|bells bag|master sword|pok[eÃ©]ball|mario mushroom|triforce|animal crossing)\b/.test(p)) return true;

  return false;
}

function seekdeepBuildImageGroundingSearchQuery(prompt = '') {
  const p = normalizeUserText(prompt).trim();

  if (/\banimal crossing\b/i.test(p) && /\b(bag of bells|bells|money bag)\b/i.test(p)) {
    return 'Animal Crossing bag of bells item appearance money bag bells Nintendo wiki';
  }

  return `${p} visual appearance official wiki item reference`;
}

function seekdeepCleanGroundedImagePrompt(value = '') {
  let out = String(value || '').replace(/\r\n/g, '\n').trim();
  out = out.replace(/```[\s\S]*?```/g, (block) => block.replace(/```[a-z]*|```/gi, '').trim());
  out = out.replace(/^\s*(grounded\s*)?(image\s*)?(prompt|visual prompt)\s*:\s*/i, '');
  out = out.replace(/\n\s*Sources?:[\s\S]*$/i, '');
  out = out.replace(/\n{2,}/g, '\n').split('\n').map((x) => x.trim()).filter(Boolean).join(', ');
  out = out.replace(/\s+/g, ' ').replace(/^["'`]+|["'`]+$/g, '').trim();

  if (out.length > 520) out = out.slice(0, 520).replace(/[,;:\s]+$/g, '').trim();
  return out;
}

async function seekdeepMaybeGroundImagePrompt(prompt = '') {
  const original = normalizeUserText(prompt).trim();
  if (!original || !seekdeepNeedsImageGrounding(original)) {
    return { prompt: original, grounded: false, searchQuery: '' };
  }

  if (/^(0|false|off|no)$/i.test(String(process.env.SEEKDEEP_IMAGE_WEB_GROUNDING || 'true'))) {
    return { prompt: original, grounded: false, searchQuery: '' };
  }

  const searchQuery = seekdeepBuildImageGroundingSearchQuery(original);

  try {
    const answer = await askChat([
      'Create a concise grounded image-generation prompt for the user request.',
      `User request: ${original}`,
      '',
      'Use web/search context if available.',
      'Only include visual facts useful for image generation.',
      'Do not answer with trivia, explanation, trading/gameplay advice, or sources.',
      'Do not invent details if context is weak; make a best-effort visual prompt grounded in the known subject.',
      '',
      'Return one line only. No markdown. No citations. No heading.',
    ].join('\n'), {
      web: 'always',
      system: [
        'You convert known objects, game items, characters, products, or franchise subjects into accurate image-generation prompts.',
        'Be concise and visual. Preserve the requested subject.',
        'Do not produce factual articles or gameplay explanations.',
      ].join('\n'),
      maxNewTokens: Number(process.env.SEEKDEEP_IMAGE_GROUNDING_MAX_TOKENS || 320),
      temperature: 0.1,
      searchQueryOverride: searchQuery,
    });

    const grounded = seekdeepCleanGroundedImagePrompt(answer);

    if (grounded && grounded.length >= 12 && !/^i can|^i cannot|^sorry\b/i.test(grounded)) {
      console.log(`[SeekDeep] image prompt grounded:\n  original: ${original}\n  grounded: ${grounded}`);
      return { prompt: grounded, grounded: true, searchQuery };
    }
  } catch (err) {
    console.warn('Image prompt grounding failed; using original prompt:', err?.message || err);
  }

  return { prompt: original, grounded: false, searchQuery };
}
// SEEKDEEP_GROUNDED_IMAGE_CONTEXT_END

"""

if "SEEKDEEP_GROUNDED_IMAGE_CONTEXT_START" not in text:
    pos = text.find("function isNaturalImagePrompt")
    if pos < 0:
        raise SystemExit("Could not locate isNaturalImagePrompt helper anchor.")
    text = text[:pos] + helpers + "\n" + text[pos:]

# Add early route for groundable short subject phrases.
if "SEEKDEEP_GROUNDED_IMAGE_SUBJECT_ROUTE_START" not in text:
    marker = "  if (!p) return false;\n"
    pos = text.find("function isNaturalImagePrompt")
    if pos < 0:
        raise SystemExit("Could not locate isNaturalImagePrompt.")
    local = text[pos:pos + 1200]
    if marker not in local:
        raise SystemExit("Could not locate insertion point inside isNaturalImagePrompt.")
    replacement = marker + """
  // SEEKDEEP_GROUNDED_IMAGE_SUBJECT_ROUTE_START
  if (seekdeepLooksLikeGroundableVisualSubject(p)) return true;
  // SEEKDEEP_GROUNDED_IMAGE_SUBJECT_ROUTE_END

"""
    text = text[:pos] + local.replace(marker, replacement, 1) + text[pos + len(local):]

# Resolve generic image prompts from context inside send image function.
if "SEEKDEEP_GENERIC_IMAGE_CONTEXT_RESOLUTION_START" not in text:
    anchor = "  const requestStartedAt = seekdeepNowMs();\n"
    pos = text.find("async function seekdeepSendImageWithButtonsMessage")
    if pos < 0:
        raise SystemExit("Could not locate seekdeepSendImageWithButtonsMessage.")
    local = text[pos:pos + 1800]
    if anchor not in local:
        raise SystemExit("Could not locate requestStartedAt anchor in seekdeepSendImageWithButtonsMessage.")
    block = anchor + """
  // SEEKDEEP_GENERIC_IMAGE_CONTEXT_RESOLUTION_START
  const seekdeepResolvedImagePrompt = seekdeepResolveImagePromptFromContext(message, prompt);
  if (seekdeepResolvedImagePrompt.missingContext) {
    return await message.reply({
      content: seekdeepAppendResponseFooter('What should I generate an image of?', {
        startedAt: requestStartedAt,
        modelUsed: seekdeepNoModelLabel(),
      }),
      allowedMentions: { repliedUser: false },
    });
  }
  if (seekdeepResolvedImagePrompt.resolvedFromContext) {
    console.log(`[SeekDeep] image prompt context reused: ${prompt} -> ${seekdeepResolvedImagePrompt.prompt}`);
  }
  prompt = seekdeepResolvedImagePrompt.prompt;
  // SEEKDEEP_GENERIC_IMAGE_CONTEXT_RESOLUTION_END

"""
    text = text[:pos] + local.replace(anchor, block, 1) + text[pos + len(local):]

# Ground prompt before normal image refinement.
if "SEEKDEEP_IMAGE_WEB_GROUNDING_CALL_START" not in text:
    old = "async function makeImageResult(prompt, width = 1024, height = 1024, seed = null) {\n  const promptInfo = seekdeepPrepareImagePrompt(prompt);\n"
    new = """async function makeImageResult(prompt, width = 1024, height = 1024, seed = null) {
  // SEEKDEEP_IMAGE_WEB_GROUNDING_CALL_START
  const seekdeepGroundedImagePrompt = await seekdeepMaybeGroundImagePrompt(prompt);
  const promptInfo = seekdeepPrepareImagePrompt(seekdeepGroundedImagePrompt.prompt || prompt);
  // SEEKDEEP_IMAGE_WEB_GROUNDING_CALL_END

"""
    if old in text:
        text = text.replace(old, new, 1)
    else:
        raise SystemExit("Could not patch makeImageResult grounding call anchor.")

# Remember subject for explicit image messages as early as possible in message handler if helper is available.
# This is optional; seekdeepSendImageWithButtonsMessage already remembers. Do not patch dispatcher further.

for needle, label in [
    ("SEEKDEEP_GROUNDED_IMAGE_CONTEXT_START", "grounded image helper block"),
    ("function seekdeepLooksLikeGroundableVisualSubject", "groundable subject detector"),
    ("function seekdeepMaybeGroundImagePrompt", "grounded prompt async helper"),
    ("SEEKDEEP_GROUNDED_IMAGE_SUBJECT_ROUTE_START", "image subject route"),
    ("SEEKDEEP_GENERIC_IMAGE_CONTEXT_RESOLUTION_START", "generic prompt context resolution"),
    ("SEEKDEEP_IMAGE_WEB_GROUNDING_CALL_START", "makeImageResult grounding call"),
    ("searchQueryOverride: searchQuery", "grounding search override"),
    ("seekdeepEnqueueImageJob(job, runner)", "image queue contract preserved"),
]:
    require_contains(text, needle, label)

out = text if newline == "\n" else text.replace("\n", "\r\n")
path.write_bytes(out.encode("utf-8"))
print("Patched grounded image subject routing and context reuse.")