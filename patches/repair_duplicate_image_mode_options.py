from pathlib import Path
import re
import sys

if len(sys.argv) != 2:
    raise SystemExit("Usage: repair_duplicate_image_mode_options.py <index.js>")

path = Path(sys.argv[1])
raw = path.read_bytes()
newline = "\r\n" if b"\r\n" in raw else "\n"
text = raw.decode("utf-8-sig").replace("\r\n", "\n").replace("\r", "\n")

def require_contains(needle: str, label: str):
    if needle not in text:
        raise SystemExit(f"Required anchor not found: {label}")

def find_function_bounds(src: str, name: str):
    starts = [
        src.find(f"async function {name}("),
        src.find(f"function {name}("),
    ]
    start = min([x for x in starts if x >= 0], default=-1)
    if start < 0:
        raise SystemExit(f"Could not locate function {name}.")
    brace = src.find("{", start)
    if brace < 0:
        raise SystemExit(f"Could not locate opening brace for {name}.")

    depth = 0
    in_str = None
    escape = False
    in_line = False
    in_block = False
    i = brace

    while i < len(src):
        ch = src[i]
        nxt = src[i + 1] if i + 1 < len(src) else ""

        if in_line:
            if ch == "\n":
                in_line = False
            i += 1
            continue

        if in_block:
            if ch == "*" and nxt == "/":
                in_block = False
                i += 2
                continue
            i += 1
            continue

        if in_str:
            if escape:
                escape = False
            elif ch == "\\":
                escape = True
            elif ch == in_str:
                in_str = None
            i += 1
            continue

        if ch == "/" and nxt == "/":
            in_line = True
            i += 2
            continue

        if ch == "/" and nxt == "*":
            in_block = True
            i += 2
            continue

        if ch in ("'", '"', "`"):
            in_str = ch
            i += 1
            continue

        if ch == "{":
            depth += 1
        elif ch == "}":
            depth -= 1
            if depth == 0:
                return start, i + 1
        i += 1

    raise SystemExit(f"Could not locate closing brace for {name}.")

def replace_function_body(src: str, name: str, transform):
    start, end = find_function_bounds(src, name)
    fn = src[start:end]
    new_fn = transform(fn)
    return src[:start] + new_fn + src[end:]

def ensure_signature(fn: str, name: str):
    fn = fn.replace(
        f"async function {name}(message, prompt, width = 1024, height = 1024, seed = null) {{",
        f"async function {name}(message, prompt, width = 1024, height = 1024, seed = null, imageModeOptions = null) {{",
    )
    fn = fn.replace(
        f"async function {name}(interaction, prompt, width = 1024, height = 1024, seed = null) {{",
        f"async function {name}(interaction, prompt, width = 1024, height = 1024, seed = null, imageModeOptions = null) {{",
    )
    return fn

option_block_re = re.compile(
    r"\n[ \t]*// SEEKDEEP_RAW_IMAGE_SEND_OPTIONS(?:_INTERACTION)?_START\n"
    r"[\s\S]*?"
    r"// SEEKDEEP_RAW_IMAGE_SEND_OPTIONS(?:_INTERACTION)?_END\n",
    re.MULTILINE,
)

bare_option_re = re.compile(
    r"\n[ \t]*const seekdeepImageModeOptions\s*=\s*seekdeepImageModeOptionsFromPrompt\(prompt\);\n"
    r"[ \t]*prompt\s*=\s*seekdeepImageModeOptions\.cleanPrompt\s*\|\|\s*prompt;\n",
    re.MULTILINE,
)

def canonical_options_block(indent="  ", interaction=False):
    tag = "_INTERACTION" if interaction else ""
    return f"""
{indent}// SEEKDEEP_RAW_IMAGE_SEND_OPTIONS{tag}_START
{indent}const seekdeepImageModeOptions = {{
{indent}  ...(typeof seekdeepImageModeOptionsFromPrompt === 'function' ? seekdeepImageModeOptionsFromPrompt(prompt) : {{}}),
{indent}  ...(imageModeOptions || {{}}),
{indent}}};
{indent}prompt = seekdeepImageModeOptions.cleanPrompt || seekdeepCleanImageModeTokens(prompt) || prompt;
{indent}// SEEKDEEP_RAW_IMAGE_SEND_OPTIONS{tag}_END
"""

def repair_sender_function(fn: str, name: str):
    is_interaction = name.endswith("Interaction")
    fn = ensure_signature(fn, name)

    # Remove all existing marked option blocks and bare old option blocks.
    blocks = list(option_block_re.finditer(fn))
    if blocks:
        # Keep location of first block; remove all, then insert one canonical block there.
        first_start = blocks[0].start()
        fn_without = option_block_re.sub("\n", fn)
        # Recompute closest insertion point after requestStartedAt.
        anchor = "  const requestStartedAt = "
        pos = fn_without.find(anchor)
        if pos < 0:
            raise SystemExit(f"Could not locate requestStartedAt in {name}.")
        line_end = fn_without.find("\n", pos)
        insert_at = line_end + 1
        fn = fn_without[:insert_at] + canonical_options_block("  ", is_interaction) + fn_without[insert_at:]
    else:
        fn = bare_option_re.sub("\n", fn)
        anchor = "  const requestStartedAt = "
        pos = fn.find(anchor)
        if pos < 0:
            raise SystemExit(f"Could not locate requestStartedAt in {name}.")
        line_end = fn.find("\n", pos)
        insert_at = line_end + 1
        fn = fn[:insert_at] + canonical_options_block("  ", is_interaction) + fn[insert_at:]

    # Ensure any makeImageResult call in the function receives options.
    fn = fn.replace(
        "const result = await makeImageResult(prompt, width, height, seed);",
        "const result = await makeImageResult(prompt, width, height, seed, seekdeepImageModeOptions);",
    )

    # Validation: exactly one local const declaration in this function.
    count = fn.count("const seekdeepImageModeOptions =")
    if count != 1:
        raise SystemExit(f"{name} has {count} seekdeepImageModeOptions declarations after repair; expected 1.")

    if "makeImageResult(prompt, width, height, seed, seekdeepImageModeOptions)" not in fn:
        raise SystemExit(f"{name} does not pass seekdeepImageModeOptions to makeImageResult.")

    return fn

for needle, label in [
    ("async function seekdeepSendImageWithButtonsMessage", "message image sender"),
    ("async function seekdeepSendImageWithButtonsInteraction", "interaction image sender"),
    ("function seekdeepImageModeOptionsFromPrompt", "image mode parser"),
    ("seekdeepEnqueueImageJob(job, runner)", "queue contract"),
]:
    require_contains(needle, label)

if "seekdeepMakeImageQueueJobId" in text:
    raise SystemExit("Unsafe old queue helper found: seekdeepMakeImageQueueJobId")
if "job.run" in text:
    raise SystemExit("Unsafe job.run-style queue logic found")

text = replace_function_body(text, "seekdeepSendImageWithButtonsMessage", lambda fn: repair_sender_function(fn, "seekdeepSendImageWithButtonsMessage"))
text = replace_function_body(text, "seekdeepSendImageWithButtonsInteraction", lambda fn: repair_sender_function(fn, "seekdeepSendImageWithButtonsInteraction"))

# Ensure message route passes image mode options into the sender.
old_dispatch = """      const imagePrompt = (typeof seekdeepExtractImagePrompt === 'function' ? seekdeepExtractImagePrompt(prompt) : prompt) || prompt;
      seekdeepLogRoute('image', imagePrompt);
      remember(key, 'user', `[natural-image] ${prompt}`);
      remember(key, 'assistant', `Queued image locally for: ${imagePrompt}`);
      await seekdeepSendImageWithButtonsMessage(message, imagePrompt, 1024, 1024, null);
"""
new_dispatch = """      const seekdeepMessageImageModeOptions = typeof seekdeepImageModeOptionsFromPrompt === 'function'
        ? seekdeepImageModeOptionsFromPrompt(prompt)
        : { refine: true, ground: true, cleanPrompt: prompt };
      const imagePrompt = (typeof seekdeepExtractImagePrompt === 'function' ? seekdeepExtractImagePrompt(prompt) : prompt) || seekdeepMessageImageModeOptions.cleanPrompt || prompt;
      seekdeepLogRoute('image', imagePrompt);
      remember(key, 'user', `[natural-image] ${prompt}`);
      remember(key, 'assistant', `Queued image locally for: ${imagePrompt}`);
      await seekdeepSendImageWithButtonsMessage(message, imagePrompt, 1024, 1024, null, seekdeepMessageImageModeOptions);
"""
if old_dispatch in text:
    text = text.replace(old_dispatch, new_dispatch, 1)
elif "await seekdeepSendImageWithButtonsMessage(message, imagePrompt, 1024, 1024, null, seekdeepMessageImageModeOptions);" not in text:
    raise SystemExit("Could not patch message route dispatch options.")

# Ensure reply-context force-image flag exists and route condition uses it.
if "const seekdeepForceImageFromReplyContext = Boolean(" not in text:
    old_prompt = """  let prompt = normalizeUserText(stripBotMentions(message.content));

  const seekdeepReplyPromptInfo = await seekdeepApplyReplyContextToPrompt(message, prompt);

  prompt = seekdeepReplyPromptInfo.prompt;
"""
    new_prompt = """  let prompt = normalizeUserText(stripBotMentions(message.content));
  const seekdeepPromptBeforeReplyContext = prompt;

  const seekdeepReplyPromptInfo = await seekdeepApplyReplyContextToPrompt(message, prompt);

  prompt = seekdeepReplyPromptInfo.prompt;
  const seekdeepForceImageFromReplyContext = Boolean(
    seekdeepReplyPromptInfo.usedReplyContext &&
    typeof seekdeepLooksLikeGenerateOnlyPrompt === 'function' &&
    seekdeepLooksLikeGenerateOnlyPrompt(seekdeepPromptBeforeReplyContext)
  );
"""
    if old_prompt in text:
        text = text.replace(old_prompt, new_prompt, 1)
    else:
        raise SystemExit("Could not insert reply-context force-image flag.")

if "seekdeepForceImageFromReplyContext ||" not in text:
    route_old = "if (!seekdeepShouldKeepPromptAsChatBeforeImage(prompt) && ((typeof seekdeepIsGenericImageFollowupPrompt === 'function' && seekdeepIsGenericImageFollowupPrompt(prompt)) || (typeof seekdeepLooksLikeShortNamedVisualSubject === 'function' && seekdeepLooksLikeShortNamedVisualSubject(prompt)) || isNaturalImagePrompt(prompt))) {"
    route_new = "if (seekdeepForceImageFromReplyContext || (!seekdeepShouldKeepPromptAsChatBeforeImage(prompt) && ((typeof seekdeepIsGenericImageFollowupPrompt === 'function' && seekdeepIsGenericImageFollowupPrompt(prompt)) || (typeof seekdeepLooksLikeShortNamedVisualSubject === 'function' && seekdeepLooksLikeShortNamedVisualSubject(prompt)) || isNaturalImagePrompt(prompt)))) {"
    if route_old in text:
        text = text.replace(route_old, route_new, 1)
    else:
        raise SystemExit("Could not patch force-image route condition.")

# Ignore placeholder reply context.
old_placeholder = """    if (!replyText) return '';
    replyText = replyText.replace(/\s+/g, ' ').trim();
    return replyText;
"""
new_placeholder = """    if (!replyText) return '';
    replyText = replyText.replace(/\s+/g, ' ').trim();
    if (/^(?:gif|image|photo|picture|pic|emoji|emojis|sticker|video|attachment|file)$/i.test(replyText)) return '';
    return replyText;
"""
if old_placeholder in text:
    text = text.replace(old_placeholder, new_placeholder, 1)

# Avoid the specific prior broken state.
for name in ("seekdeepSendImageWithButtonsMessage", "seekdeepSendImageWithButtonsInteraction"):
    start, end = find_function_bounds(text, name)
    fn = text[start:end]
    count = fn.count("const seekdeepImageModeOptions =")
    if count != 1:
        raise SystemExit(f"Validation failed: {name} contains {count} seekdeepImageModeOptions declarations.")
    if "makeImageResult(prompt, width, height, seed, seekdeepImageModeOptions)" not in fn:
        raise SystemExit(f"Validation failed: {name} does not pass seekdeepImageModeOptions.")

for needle, label in [
    ("seekdeepForceImageFromReplyContext", "reply-context force image"),
    ("await seekdeepSendImageWithButtonsMessage(message, imagePrompt, 1024, 1024, null, seekdeepMessageImageModeOptions);", "message route passes image mode options"),
    ("seekdeepEnqueueImageJob(job, runner)", "queue contract preserved"),
]:
    require_contains(needle, label)

out = text if newline == "\n" else text.replace("\n", "\r\n")
path.write_bytes(out.encode("utf-8"))
print("Repaired duplicate image-mode options and preserved raw/reply routing fixes.")