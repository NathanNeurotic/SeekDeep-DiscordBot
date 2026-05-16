from pathlib import Path
import sys

if len(sys.argv) != 2:
    raise SystemExit("Usage: patch_style_aware_image_refinement.py <index.js>")

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
block = text[start:end]


def replace_one_of(src: str, options, replacement: str, label: str) -> str:
    for old in options:
        if old in src:
            return src.replace(old, replacement, 1)
    raise SystemExit(f"Required anchor not found: {label}")

# Shift default style away from generic clean illustration.
block = replace_one_of(
    block,
    [
        "seekdeepImagePromptAdd(parts, 'detailed illustration, readable subject, polished composition');",
        "seekdeepImagePromptAdd(parts, 'stylized detailed illustration, strong readable subject, polished composition');",
    ],
    "seekdeepImagePromptAdd(parts, 'painterly illustration, readable subject, moody composition');",
    "default style refinement"
)

# Make poster / album-art branch more aligned to underground / emo artwork.
block = replace_one_of(
    block,
    [
        "if (!hasStyle) seekdeepImagePromptAdd(parts, 'graphic illustration, strong focal point');",
        "if (!hasStyle) seekdeepImagePromptAdd(parts, 'polished graphic illustration with a strong focal point');",
    ],
    "if (!hasStyle) seekdeepImagePromptAdd(parts, 'oil-painted poster art, gritty focal point, moody composition');",
    "poster style refinement"
)

block = replace_one_of(
    block,
    [
        "if (!hasComposition) seekdeepImagePromptAdd(parts, 'clear composition, layered depth');",
        "if (!hasComposition) seekdeepImagePromptAdd(parts, 'clear composition, usable negative space, layered background depth');",
    ],
    "if (!hasComposition) seekdeepImagePromptAdd(parts, 'bold poster composition, layered depth');",
    "poster composition refinement"
)

# Remove overly broad fantasy trigger from generic forest prompts.
block = replace_one_of(
    block,
    [
        "if (seekdeepImagePromptHasAny(lower, ['hyrule', 'fantasy kingdom', 'castle', 'wizard', 'dungeon', 'forest', 'deku'])) seekdeepImagePromptAdd(parts, 'fantasy atmosphere, detailed environment');",
        "if (seekdeepImagePromptHasAny(lower, ['hyrule', 'fantasy kingdom', 'castle', 'wizard', 'dungeon', 'forest', 'deku'])) seekdeepImagePromptAdd(parts, 'fantasy adventure atmosphere, detailed environment, whimsical but coherent world design');",
    ],
    "if (seekdeepImagePromptHasAny(lower, ['hyrule', 'fantasy kingdom', 'castle', 'wizard', 'dungeon', 'deku'])) seekdeepImagePromptAdd(parts, 'fantasy atmosphere, detailed environment');",
    "fantasy trigger refinement"
)

# Add a compact style hook for metal / emo / hardcore / poster-ish prompts.
metal_anchor_options = [
    "if (seekdeepImagePromptHasAny(lower, ['plant', 'flower', 'tree', 'forest', 'leaf', 'leaves', 'cannabis', 'marijuana', 'moss', 'fungi'])) seekdeepImagePromptAdd(parts, 'botanical detail, clear leaf structure');",
    "if (seekdeepImagePromptHasAny(lower, ['plant', 'flower', 'tree', 'forest', 'leaf', 'leaves', 'cannabis', 'marijuana', 'moss', 'fungi'])) seekdeepImagePromptAdd(parts, 'botanical detail, clear leaf structure, organic texture, natural growth pattern');",
]
metal_insert = (
    "if (seekdeepImagePromptHasAny(lower, ['plant', 'flower', 'tree', 'forest', 'leaf', 'leaves', 'cannabis', 'marijuana', 'moss', 'fungi'])) seekdeepImagePromptAdd(parts, 'botanical detail, clear leaf structure');\n"
    "  if (seekdeepImagePromptHasAny(lower, ['metal', 'rock', 'emo', 'screamo', 'hardcore', 'punk', 'album cover', 'album art', 'cover art', 'poster'])) seekdeepImagePromptAdd(parts, 'emo hardcore atmosphere, underground energy');"
)
block = replace_one_of(block, metal_anchor_options, metal_insert, "metal style insert")

# Add mood for smoking prompts, without making every prompt dark.
smoke_anchor_options = [
    "if (seekdeepImagePromptHasAny(lower, ['hyrule', 'fantasy kingdom', 'castle', 'wizard', 'dungeon', 'deku'])) seekdeepImagePromptAdd(parts, 'fantasy atmosphere, detailed environment');",
]
smoke_insert = (
    "if (seekdeepImagePromptHasAny(lower, ['hyrule', 'fantasy kingdom', 'castle', 'wizard', 'dungeon', 'deku'])) seekdeepImagePromptAdd(parts, 'fantasy atmosphere, detailed environment');\n"
    "  if (seekdeepImagePromptHasAny(lower, ['smoking', 'smokin', 'smoke', 'spliff', 'blunt', 'joint', 'cigarette'])) seekdeepImagePromptAdd(parts, 'rebellious mood, moody atmosphere');"
)
block = replace_one_of(block, smoke_anchor_options, smoke_insert, "smoking mood insert")

# Keep this short and avoid re-bloating the tail.
# We intentionally keep the existing short quality / lighting / negative cleanup lines.

required_checks = [
    "seekdeepImagePromptAdd(parts, 'painterly illustration, readable subject, moody composition');",
    "seekdeepImagePromptAdd(parts, 'oil-painted poster art, gritty focal point, moody composition');",
    "seekdeepImagePromptAdd(parts, 'bold poster composition, layered depth');",
    "if (seekdeepImagePromptHasAny(lower, ['metal', 'rock', 'emo', 'screamo', 'hardcore', 'punk', 'album cover', 'album art', 'cover art', 'poster'])) seekdeepImagePromptAdd(parts, 'emo hardcore atmosphere, underground energy');",
    "if (seekdeepImagePromptHasAny(lower, ['smoking', 'smokin', 'smoke', 'spliff', 'blunt', 'joint', 'cigarette'])) seekdeepImagePromptAdd(parts, 'rebellious mood, moody atmosphere');",
    "if (seekdeepImagePromptHasAny(lower, ['hyrule', 'fantasy kingdom', 'castle', 'wizard', 'dungeon', 'deku'])) seekdeepImagePromptAdd(parts, 'fantasy atmosphere, detailed environment');",
]
for needle in required_checks:
    if needle not in block:
        raise SystemExit(f"Post-patch verification failed: {needle}")

text = text[:start] + block + text[end:]
out = text if newline == "\n" else text.replace("\n", "\r\n")
path.write_bytes(out.encode("utf-8"))
print("Patched style-aware image refinement block.")