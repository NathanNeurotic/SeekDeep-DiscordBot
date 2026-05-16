from pathlib import Path
from datetime import datetime

path = Path("index.js")
text = path.read_text(encoding="utf-8")

stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
backup = Path(f"index.js.bak-bare-image-prompt-{stamp}")
backup.write_text(text, encoding="utf-8")
print(f"[SeekDeep] Backup written: {backup}")

def replace_function(src, name, replacement):
    start = src.find(f"function {name}")
    if start == -1:
        return src, False

    open_brace = src.find("{", start)
    if open_brace == -1:
        raise SystemExit(f"Found {name}, but could not find opening brace.")

    depth = 0
    in_single = False
    in_double = False
    in_template = False
    in_line_comment = False
    in_block_comment = False
    escape = False

    i = open_brace
    while i < len(src):
        ch = src[i]
        nxt = src[i + 1] if i + 1 < len(src) else ""

        if in_line_comment:
            if ch == "\n":
                in_line_comment = False
            i += 1
            continue

        if in_block_comment:
            if ch == "*" and nxt == "/":
                in_block_comment = False
                i += 2
                continue
            i += 1
            continue

        if in_single:
            if escape:
                escape = False
            elif ch == "\\":
                escape = True
            elif ch == "'":
                in_single = False
            i += 1
            continue

        if in_double:
            if escape:
                escape = False
            elif ch == "\\":
                escape = True
            elif ch == '"':
                in_double = False
            i += 1
            continue

        if in_template:
            if escape:
                escape = False
            elif ch == "\\":
                escape = True
            elif ch == "`":
                in_template = False
            i += 1
            continue

        if ch == "/" and nxt == "/":
            in_line_comment = True
            i += 2
            continue

        if ch == "/" and nxt == "*":
            in_block_comment = True
            i += 2
            continue

        if ch == "'":
            in_single = True
            i += 1
            continue

        if ch == '"':
            in_double = True
            i += 1
            continue

        if ch == "`":
            in_template = True
            i += 1
            continue

        if ch == "{":
            depth += 1

        if ch == "}":
            depth -= 1
            if depth == 0:
                end = i + 1
                return src[:start] + replacement.strip() + "\n\n" + src[end:].lstrip(), True

        i += 1

    raise SystemExit(f"Could not find closing brace for {name}.")

image_classifier = r'''
function isNaturalImagePrompt(prompt) {
  const p = normalizeUserText(prompt).toLowerCase().trim();
  if (!p) return false;

  if (typeof isNaturalVisionPrompt === 'function' && isNaturalVisionPrompt(p)) return false;

  // Strong text-only intents should stay chat.
  if (/\b(refine|rewrite|improve|explain|tell me about|list|story|checklist|nickname|nicknames|name ideas?|what is|who is|why|how|status)\b/i.test(p)) {
    return false;
  }

  if (/\b(image prompt|prompt only|describe an image|description only)\b/i.test(p)) return false;

  // Explicit image verbs.
  if (/\b(generate|create|make|draw|render|paint|illustrate|design|show me|show)\b/i.test(p)) {
    return true;
  }

  // Explicit visual object phrases.
  if (/\b(image|picture|photo|pic|art|artwork|drawing|wallpaper|banner|logo|icon|portrait|poster)\b/i.test(p)) {
    return true;
  }

  // "I need / I want / give me" followed by a visual subject.
  if (/^(i need|need|i want|want|give me)\b/i.test(p) &&
      !/\b(help|advice|explain|list|status|story|nickname|name|tell me|about yourself)\b/i.test(p)) {
    return true;
  }

  // Bare visual prompts:
  // "hyper realistic cannabis plant"
  // "dark fantasy frog wizard"
  // "oil painting cyberpunk cat"
  // "cute fat cat in hyrule"
  const visualStyleWords =
    /\b(hyper\s*realistic|photorealistic|realistic|cinematic|anime|manga|oil painting|watercolor|digital art|illustration|poster|portrait|wallpaper|logo|icon|sticker|3d render|render|concept art|fantasy|surreal|gothic|punk|emo|cottagecore|cyberpunk|vaporwave|liminal|hd|ultra hd|4k|8k)\b/i;

  const visualSubjectWords =
    /\b(cat|dog|frog|pepe|girl|woman|man|person|character|creature|monster|plant|flower|tree|forest|castle|city|room|car|robot|machine|dragon|elf|wizard|goblin|demon|angel|portrait|scene|background|landscape|logo|banner|avatar|emote)\b/i;

  const words = p.split(/\s+/).filter(Boolean);

  if (words.length <= 16 && visualStyleWords.test(p) && visualSubjectWords.test(p)) {
    return true;
  }

  return false;
}
'''

seekdeep_classifier = r'''
function seekdeepLooksLikeImagePrompt(text = '') {
  const p = normalizeUserText(text).toLowerCase().trim();
  if (!p) return false;

  if (typeof seekdeepLooksLikeVisionPrompt === 'function' && seekdeepLooksLikeVisionPrompt(p)) return false;

  if (/\b(refine|rewrite|improve|explain|tell me about|list|story|checklist|nickname|nicknames|name ideas?|what is|who is|why|how|status)\b/i.test(p)) {
    return false;
  }

  if (/\b(image prompt|prompt only|describe an image|description only)\b/i.test(p)) return false;

  if (/\b(generate|create|make|draw|render|paint|illustrate|design|show me|show)\b/i.test(p)) return true;

  if (/\b(image|picture|photo|pic|art|artwork|drawing|wallpaper|banner|logo|icon|portrait|poster)\b/i.test(p)) return true;

  if (/^(i need|need|i want|want|give me)\b/i.test(p) &&
      !/\b(help|advice|explain|list|status|story|nickname|name|tell me|about yourself)\b/i.test(p)) {
    return true;
  }

  const visualStyleWords =
    /\b(hyper\s*realistic|photorealistic|realistic|cinematic|anime|manga|oil painting|watercolor|digital art|illustration|poster|portrait|wallpaper|logo|icon|sticker|3d render|render|concept art|fantasy|surreal|gothic|punk|emo|cottagecore|cyberpunk|vaporwave|liminal|hd|ultra hd|4k|8k)\b/i;

  const visualSubjectWords =
    /\b(cat|dog|frog|pepe|girl|woman|man|person|character|creature|monster|plant|flower|tree|forest|castle|city|room|car|robot|machine|dragon|elf|wizard|goblin|demon|angel|portrait|scene|background|landscape|logo|banner|avatar|emote)\b/i;

  const words = p.split(/\s+/).filter(Boolean);

  if (words.length <= 16 && visualStyleWords.test(p) && visualSubjectWords.test(p)) {
    return true;
  }

  return false;
}
'''

text, changed_a = replace_function(text, "isNaturalImagePrompt", image_classifier)
text, changed_b = replace_function(text, "seekdeepLooksLikeImagePrompt", seekdeep_classifier)

if not changed_a and not changed_b:
    raise SystemExit("No known image classifier function found. Need current index.js snippet.")

path.write_text(text, encoding="utf-8")
print(f"[SeekDeep] Patched classifiers: isNaturalImagePrompt={changed_a}, seekdeepLooksLikeImagePrompt={changed_b}")
