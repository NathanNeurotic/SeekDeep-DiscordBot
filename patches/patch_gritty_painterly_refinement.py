from pathlib import Path
import re
import sys

if len(sys.argv) != 2:
    raise SystemExit("Usage: patch_gritty_painterly_refinement.py <index.js>")

path = Path(sys.argv[1])
raw = path.read_bytes()
newline = "\r\n" if b"\r\n" in raw else "\n"
text = raw.decode("utf-8-sig").replace("\r\n", "\n").replace("\r", "\n")

start_marker = "// SEEKDEEP_IMAGE_PROMPT_REFINEMENT_START"
end_marker = "// SEEKDEEP_IMAGE_PROMPT_REFINEMENT_END"

if start_marker not in text or end_marker not in text:
    raise SystemExit("Could not locate image prompt refinement block markers.")

start = text.index(start_marker)
end = text.index(end_marker, start)
existing = text[start:end]

# Sanity check so we do not patch an unexpected region.
for anchor in [
    "function seekdeepImagePromptHasAny(lower, words)",
    "function seekdeepPrepareImagePrompt(prompt = '')",
    "SEEKDEEP_IMAGE_PROMPT_MAX_CHARS",
]:
    if anchor not in existing:
        raise SystemExit(f"Expected anchor missing from refinement block: {anchor}")

replacement = r'''// SEEKDEEP_IMAGE_PROMPT_REFINEMENT_START
const SEEKDEEP_IMAGE_PROMPT_REFINEMENT_ENABLED = !/^(0|false|off|no)$/i.test(String(process.env.SEEKDEEP_IMAGE_PROMPT_REFINEMENT || 'true'));
const SEEKDEEP_IMAGE_PROMPT_REFINEMENT_LOG = /^(1|true|on|yes)$/i.test(String(process.env.SEEKDEEP_IMAGE_PROMPT_REFINEMENT_LOG || 'true'));
const SEEKDEEP_IMAGE_PROMPT_MAX_CHARS = Math.max(260, Number(process.env.SEEKDEEP_IMAGE_PROMPT_MAX_CHARS || 460));

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
  const hasStyle = /\b(hyper\s*realistic|photorealistic|realistic|cinematic|anime|manga|comic|oil painting|oil-painted|watercolor|pixel art|3d|render|illustration|illustrated|stylized|painterly|graphic|vector|logo|icon|poster|album art|wallpaper|sketch|low poly|claymation|stop motion|emo|screamo|hardcore|punk|grunge|zine)\b/i.test(originalPrompt);
  const hasQuality = /\b(high quality|detailed|sharp|clean|polished|professional|masterpiece|ultra detailed|high detail|hd|4k|8k|coherent|clear)\b/i.test(originalPrompt);
  const hasLighting = /\b(lighting|lit|glow|shadow|sunset|sunrise|moonlight|neon|ambient|dramatic light|soft light|studio light|rim light|backlit|dusk|twilight)\b/i.test(originalPrompt);
  const hasComposition = /\b(composition|centered|off center|wide shot|close up|portrait|landscape|symmetrical|asymmetrical|negative space|foreground|background|depth|poster layout|editorial)\b/i.test(originalPrompt);
  const asksText = /\b(text|words|lettering|title|caption|says|saying|sign|label|typography|font)\b/i.test(originalPrompt);

  if (seekdeepImagePromptHasAny(lower, ['logo', 'icon', 'emblem', 'badge'])) {
    if (!hasStyle) seekdeepImagePromptAdd(parts, 'gritty emblem design, bold silhouette');
    if (!hasComposition) seekdeepImagePromptAdd(parts, 'centered composition, strong negative space');
    seekdeepImagePromptAdd(parts, 'no random lettering, no fake brand marks');
  } else if (seekdeepImagePromptHasAny(lower, ['banner', 'wallpaper', 'cover art', 'album art', 'poster', 'album cover', 'metal', 'rock', 'emo', 'screamo', 'hardcore', 'punk'])) {
    if (!hasStyle) seekdeepImagePromptAdd(parts, 'oil-painted poster art, gritty brushwork, underground energy');
    if (!hasComposition) seekdeepImagePromptAdd(parts, 'bold poster composition, dramatic focal point, layered depth');
  } else if (/\b(hyper\s*realistic|photorealistic|realistic|photo)\b/i.test(originalPrompt)) {
    seekdeepImagePromptAdd(parts, 'natural materials, believable structure');
    if (!hasLighting) seekdeepImagePromptAdd(parts, 'cinematic realistic lighting, clear depth');
  } else if (!hasStyle) {
    seekdeepImagePromptAdd(parts, 'painterly illustration, moody composition, expressive brushwork');
  }

  if (seekdeepImagePromptHasAny(lower, ['pepe', 'frog', 'toad', 'cat', 'dog', 'fox', 'animal', 'creature', 'dragon', 'bird', 'horse'])) {
    seekdeepImagePromptAdd(parts, 'expressive subject, coherent anatomy');
  }

  if (seekdeepImagePromptHasAny(lower, ['sailor moon', 'usagi', 'girl', 'woman', 'boy', 'man', 'person', 'human', 'elf', 'character', 'portrait'])) {
    seekdeepImagePromptAdd(parts, 'coherent face, natural anatomy, clean hands');
  }

  if (seekdeepImagePromptHasAny(lower, ['plant', 'flower', 'tree', 'forest', 'leaf', 'leaves', 'cannabis', 'marijuana', 'moss', 'fungi'])) {
    seekdeepImagePromptAdd(parts, 'botanical detail, silhouette foliage');
  }

  if (seekdeepImagePromptHasAny(lower, ['hyrule', 'fantasy kingdom', 'castle', 'wizard', 'dungeon', 'deku'])) {
    seekdeepImagePromptAdd(parts, 'fantasy atmosphere, detailed environment');
  }

  if (seekdeepImagePromptHasAny(lower, ['smoking', 'smokin', 'smoke', 'spliff', 'blunt', 'joint', 'cigarette'])) {
    seekdeepImagePromptAdd(parts, 'rebellious mood, drifting smoke');
  }

  if (seekdeepImagePromptHasAny(lower, ['sunset', 'sunrise', 'dusk', 'twilight', 'neon', 'night', 'moonlight', 'balcony', 'city lights', 'bar lights'])) {
    seekdeepImagePromptAdd(parts, 'dramatic lighting, strong atmosphere');
  }

  if (!hasQuality) seekdeepImagePromptAdd(parts, 'high quality, coherent details');
  if (!asksText) seekdeepImagePromptAdd(parts, 'no random text');
  seekdeepImagePromptAdd(parts, 'avoid smooth 3d render, plastic skin, generic stock look');
  seekdeepImagePromptAdd(parts, 'avoid malformed anatomy, distorted eyes, clutter');

  let refinedPrompt = parts.join(', ').replace(/\s+/g, ' ').trim();
  if (refinedPrompt.length > SEEKDEEP_IMAGE_PROMPT_MAX_CHARS) refinedPrompt = refinedPrompt.slice(0, SEEKDEEP_IMAGE_PROMPT_MAX_CHARS).replace(/[,;:\s]+$/g, '').trim();
  return { originalPrompt, refinedPrompt, generationPrompt: refinedPrompt, changed: refinedPrompt !== originalPrompt };
}
'''

text = text[:start] + replacement + text[end:]

# Post-patch verification.
checks = [
    "oil-painted poster art, gritty brushwork, underground energy",
    "painterly illustration, moody composition, expressive brushwork",
    "avoid smooth 3d render, plastic skin, generic stock look",
    "rebellious mood, drifting smoke",
    "const SEEKDEEP_IMAGE_PROMPT_MAX_CHARS = Math.max(260, Number(process.env.SEEKDEEP_IMAGE_PROMPT_MAX_CHARS || 460));",
]
for needle in checks:
    if needle not in text:
        raise SystemExit(f"Post-patch verification failed: {needle}")

out = text if newline == "\n" else text.replace("\n", "\r\n")
path.write_bytes(out.encode("utf-8"))
print("Patched image refinement block for grittier painterly style.")