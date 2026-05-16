from pathlib import Path
from datetime import datetime

path = Path("index.js")
text = path.read_text(encoding="utf-8")

stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
backup = Path(f"index.js.bak-routing-text-guard-{stamp}")
backup.write_text(text, encoding="utf-8")
print(f"[SeekDeep] Backup written: {backup}")

def find_function_range(src: str, name: str):
    start = src.find(f"function {name}")
    if start == -1:
        return None

    brace = src.find("{", start)
    if brace == -1:
        raise SystemExit(f"Found {name}, but no opening brace.")

    depth = 0
    in_string = None
    escape = False
    line_comment = False
    block_comment = False

    i = brace
    while i < len(src):
        ch = src[i]
        nxt = src[i + 1] if i + 1 < len(src) else ""

        if line_comment:
            if ch == "\n":
                line_comment = False
            i += 1
            continue

        if block_comment:
            if ch == "*" and nxt == "/":
                block_comment = False
                i += 2
                continue
            i += 1
            continue

        if in_string:
            if escape:
                escape = False
            elif ch == "\\":
                escape = True
            elif ch == in_string:
                in_string = None
            i += 1
            continue

        if ch == "/" and nxt == "/":
            line_comment = True
            i += 2
            continue

        if ch == "/" and nxt == "*":
            block_comment = True
            i += 2
            continue

        if ch in ("'", '"', "`"):
            in_string = ch
            i += 1
            continue

        if ch == "{":
            depth += 1
        elif ch == "}":
            depth -= 1
            if depth == 0:
                return start, i + 1

        i += 1

    raise SystemExit(f"Could not find closing brace for {name}.")

def replace_function(src: str, name: str, replacement: str):
    rng = find_function_range(src, name)
    if rng is None:
        print(f"[SeekDeep] Function not found, skipped: {name}")
        return src, False

    start, end = rng
    return src[:start] + replacement.strip() + "\n\n" + src[end:].lstrip(), True

helper_block = r'''
// SEEKDEEP_ROUTING_TEXT_GUARD_HELPERS_START
function seekdeepHasExplicitImageRequest(p = '') {
  return /\b(generate|create|make|draw|render|paint|illustrate|design)\s+(?:me\s+)?(?:an?\s+|some\s+)?(?:image|picture|photo|pic|art|artwork|drawing|wallpaper|banner|logo|icon|poster|portrait)\b/i.test(p) ||
    /\b(image|picture|photo|pic|artwork|drawing|wallpaper|banner|logo|icon|poster|portrait)\s+(?:of|for)\b/i.test(p) ||
    /\b(?:image|picture|photo|pic)\b/i.test(p);
}

function seekdeepHasTextListIntent(p = '') {
  return /\b(names?|nicknames?|name ideas?|list|ideas?|options?|suggestions?|recommendations?|examples?|titles?|captions?|phrases?|slogans?|handles?|usernames?|commands?|features?|checklist|bullet points?)\b/i.test(p);
}

function seekdeepHasCountRequest(p = '') {
  return /\b(?:give me|make me|create|generate|list|suggest|name)\s+(?:a\s+)?(?:list\s+of\s+)?\d{1,3}\b/i.test(p) ||
    /^\s*\d{1,3}\s+\w+/i.test(p);
}

function seekdeepHasQuestionOrExplanationIntent(p = '') {
  return /\b(refine|rewrite|improve|explain|tell me about|story|checklist|what is|who is|why|how|status|help|advice|compare|summarize|describe in words)\b/i.test(p);
}

function seekdeepHasVisualStyleWords(p = '') {
  return /\b(hyper\s*realistic|photorealistic|realistic|cinematic|anime|manga|oil painting|watercolor|digital art|illustration|poster|portrait|wallpaper|logo|icon|sticker|3d render|render|concept art|fantasy|surreal|gothic|punk|emo|cottagecore|cyberpunk|vaporwave|liminal|hd|ultra hd|4k|8k)\b/i.test(p);
}

function seekdeepHasVisualSubjectWords(p = '') {
  return /\b(cat|dog|frog|pepe|girl|woman|man|person|character|creature|monster|plant|flower|tree|forest|castle|city|room|car|robot|machine|dragon|elf|wizard|goblin|demon|angel|portrait|scene|background|landscape|avatar|emote|cannabis|marijuana)\b/i.test(p);
}

function seekdeepHasLikelyVisualDescription(p = '') {
  const words = String(p || '').split(/\s+/).filter(Boolean);
  if (words.length > 20) return false;

  if (seekdeepHasVisualStyleWords(p) && seekdeepHasVisualSubjectWords(p)) {
    return true;
  }

  if (/^(i need|need|i want|want)\b/i.test(p) && seekdeepHasVisualSubjectWords(p)) {
    return true;
  }

  return false;
}

function seekdeepShouldStayChatInsteadOfImage(p = '') {
  if (!p) return true;

  if (seekdeepHasExplicitImageRequest(p)) {
    return false;
  }

  if (seekdeepHasTextListIntent(p)) {
    return true;
  }

  if (seekdeepHasCountRequest(p)) {
    return true;
  }

  if (seekdeepHasQuestionOrExplanationIntent(p)) {
    return true;
  }

  return false;
}
// SEEKDEEP_ROUTING_TEXT_GUARD_HELPERS_END
'''

seekdeep_classifier = r'''
function seekdeepLooksLikeImagePrompt(text = '') {
  const p = normalizeUserText(text).toLowerCase().trim();
  if (!p) return false;

  if (typeof seekdeepLooksLikeVisionPrompt === 'function' && seekdeepLooksLikeVisionPrompt(p)) {
    return false;
  }

  if (/\b(image prompt|prompt only|describe an image|description only)\b/i.test(p)) {
    return false;
  }

  if (seekdeepShouldStayChatInsteadOfImage(p)) {
    return false;
  }

  if (seekdeepHasExplicitImageRequest(p)) {
    return true;
  }

  if (/\b(generate|create|make|draw|render|paint|illustrate|design|show me|show)\b/i.test(p) && seekdeepHasVisualSubjectWords(p)) {
    return true;
  }

  if (seekdeepHasLikelyVisualDescription(p)) {
    return true;
  }

  return false;
}
'''

natural_classifier = r'''
function isNaturalImagePrompt(prompt) {
  const p = normalizeUserText(prompt).toLowerCase().trim();
  if (!p) return false;

  if (typeof isNaturalVisionPrompt === 'function' && isNaturalVisionPrompt(p)) {
    return false;
  }

  if (/\b(image prompt|prompt only|describe an image|description only)\b/i.test(p)) {
    return false;
  }

  if (seekdeepShouldStayChatInsteadOfImage(p)) {
    return false;
  }

  if (seekdeepHasExplicitImageRequest(p)) {
    return true;
  }

  if (/\b(generate|create|make|draw|render|paint|illustrate|design|show me|show)\b/i.test(p) && seekdeepHasVisualSubjectWords(p)) {
    return true;
  }

  if (seekdeepHasLikelyVisualDescription(p)) {
    return true;
  }

  return false;
}
'''

start_marker = "// SEEKDEEP_ROUTING_TEXT_GUARD_HELPERS_START"
end_marker = "// SEEKDEEP_ROUTING_TEXT_GUARD_HELPERS_END"

if start_marker in text:
    start = text.find(start_marker)
    end = text.find(end_marker, start)
    if end == -1:
        raise SystemExit("Found routing helper start marker but no end marker.")

    end += len(end_marker)
    text = text[:start] + helper_block.strip() + "\n\n" + text[end:].lstrip()
    print("[SeekDeep] Replaced existing routing text-guard helpers.")
else:
    pos = text.find("function seekdeepLooksLikeImagePrompt")
    if pos == -1:
        pos = text.find("function isNaturalImagePrompt")

    if pos == -1:
        raise SystemExit("Could not find image classifier insertion point.")

    text = text[:pos] + helper_block.strip() + "\n\n" + text[pos:]
    print("[SeekDeep] Inserted routing text-guard helpers.")

text, changed_a = replace_function(text, "seekdeepLooksLikeImagePrompt", seekdeep_classifier)
text, changed_b = replace_function(text, "isNaturalImagePrompt", natural_classifier)

if not changed_a and not changed_b:
    raise SystemExit("No image classifier functions were found to replace.")

required = [
    "function seekdeepShouldStayChatInsteadOfImage(",
    "function seekdeepHasTextListIntent(",
    "function seekdeepLooksLikeImagePrompt(",
    "function isNaturalImagePrompt(",
]

missing = [item for item in required if item not in text]
if missing:
    raise SystemExit("Patch failed. Missing: " + ", ".join(missing))

path.write_text(text, encoding="utf-8")

print(f"[SeekDeep] Patched seekdeepLooksLikeImagePrompt: {changed_a}")
print(f"[SeekDeep] Patched isNaturalImagePrompt: {changed_b}")
