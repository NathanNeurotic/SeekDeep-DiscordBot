from pathlib import Path
import sys

if len(sys.argv) != 2:
    raise SystemExit("Usage: patch_raw_unrefined_image_mode.py <index.js>")

path = Path(sys.argv[1])
raw = path.read_bytes()
newline = "\r\n" if b"\r\n" in raw else "\n"
text = raw.decode("utf-8-sig").replace("\r\n", "\n").replace("\r", "\n")

def require_contains(haystack: str, needle: str, label: str):
    if needle not in haystack:
        raise SystemExit(f"Required anchor not found: {label}")

for needle, label in [
    ("async function makeImageResult", "makeImageResult"),
    ("async function seekdeepSendImageWithButtonsMessage", "seekdeepSendImageWithButtonsMessage"),
    ("function seekdeepExtractImagePrompt", "seekdeepExtractImagePrompt"),
    ("function isNaturalImagePrompt", "isNaturalImagePrompt"),
    ("seekdeepEnqueueImageJob(job, runner)", "correct image queue contract"),
]:
    require_contains(text, needle, label)

if "seekdeepMakeImageQueueJobId" in text:
    raise SystemExit("Unsafe old queue helper found: seekdeepMakeImageQueueJobId")
if "job.run" in text:
    raise SystemExit("Unsafe job.run-style queue logic found")

helpers = r"""
// SEEKDEEP_RAW_IMAGE_MODE_START
function seekdeepImageRawModeRequested(prompt = '') {
  const p = normalizeUserText(prompt).toLowerCase().trim();
  return (
    /(^|\s)--?(raw|unrefined|no-refine|norefine)(\s|$)/i.test(p) ||
    /(^|\s)(raw|unrefined)\s+(generate|create|make|draw|paint|sketch|illustrate|render|show)\b/i.test(p) ||
    /(^|\s)(no\s+refine|without\s+refinement|skip\s+refinement)\b/i.test(p)
  );
}

function seekdeepImageGroundingDisabled(prompt = '') {
  const p = normalizeUserText(prompt).toLowerCase().trim();
  return (
    /(^|\s)--?(ungrounded|no-grounding|nogrounding)(\s|$)/i.test(p) ||
    /(^|\s)(no\s+grounding|without\s+grounding|skip\s+grounding)\b/i.test(p)
  );
}

function seekdeepCleanImageModeTokens(prompt = '') {
  let out = normalizeUserText(prompt);

  out = out
    .replace(/(^|\s)--?(raw|unrefined|no-refine|norefine)(?=\s|$)/gi, ' ')
    .replace(/(^|\s)--?(ungrounded|no-grounding|nogrounding)(?=\s|$)/gi, ' ')
    .replace(/\b(no\s+refine|without\s+refinement|skip\s+refinement)\b/gi, ' ')
    .replace(/\b(no\s+grounding|without\s+grounding|skip\s+grounding)\b/gi, ' ')
    .replace(/^\s*(raw|unrefined)\s+(?=(generate|create|make|draw|paint|sketch|illustrate|render|show)\b)/i, '')
    .replace(/\s+/g, ' ')
    .trim();

  return out;
}

function seekdeepImageModeOptionsFromPrompt(prompt = '') {
  return {
    refine: !seekdeepImageRawModeRequested(prompt),
    ground: !seekdeepImageGroundingDisabled(prompt),
    rawRequested: seekdeepImageRawModeRequested(prompt),
    groundingDisabled: seekdeepImageGroundingDisabled(prompt),
    cleanPrompt: seekdeepCleanImageModeTokens(prompt),
  };
}

function seekdeepRefinementStatusLine(enabled = true) {
  return `Refinement: ${enabled ? 'on' : 'off'}`;
}

function seekdeepGroundingStatusLine(result = null, options = {}) {
  if (options?.ground === false) return 'Grounding: off';
  if (result?.grounded) return 'Grounding: on';
  return '';
}
// SEEKDEEP_RAW_IMAGE_MODE_END

"""

if "SEEKDEEP_RAW_IMAGE_MODE_START" not in text:
    pos = text.find("function seekdeepExtractImagePrompt")
    if pos < 0:
        raise SystemExit("Could not locate seekdeepExtractImagePrompt anchor.")
    text = text[:pos] + helpers + "\n" + text[pos:]

# Strip mode tokens at the beginning of extraction.
if "SEEKDEEP_RAW_IMAGE_EXTRACT_CLEAN_START" not in text:
    old = "function seekdeepExtractImagePrompt(text = '') {\n  let t = normalizeUserText(text);\n"
    new = """function seekdeepExtractImagePrompt(text = '') {
  // SEEKDEEP_RAW_IMAGE_EXTRACT_CLEAN_START
  let t = seekdeepCleanImageModeTokens(text);
  // SEEKDEEP_RAW_IMAGE_EXTRACT_CLEAN_END

"""
    if old not in text:
        raise SystemExit("Could not patch seekdeepExtractImagePrompt opening.")
    text = text.replace(old, new, 1)

# isNaturalImagePrompt should not miss raw/unrefined-prefixed explicit image prompts.
if "SEEKDEEP_RAW_IMAGE_ROUTE_CLEAN_START" not in text:
    old = "function isNaturalImagePrompt(prompt) {\n  const p = normalizeUserText(prompt).toLowerCase().trim();\n"
    new = """function isNaturalImagePrompt(prompt) {
  // SEEKDEEP_RAW_IMAGE_ROUTE_CLEAN_START
  const p = seekdeepCleanImageModeTokens(prompt).toLowerCase().trim();
  // SEEKDEEP_RAW_IMAGE_ROUTE_CLEAN_END

"""
    if old not in text:
        raise SystemExit("Could not patch isNaturalImagePrompt opening.")
    text = text.replace(old, new, 1)

# Patch send image function to resolve options and clean prompt before context/cooldown/job.
if "SEEKDEEP_RAW_IMAGE_SEND_OPTIONS_START" not in text:
    old = "  const requestStartedAt = seekdeepNowMs();\n"
    new = """  const requestStartedAt = seekdeepNowMs();

  // SEEKDEEP_RAW_IMAGE_SEND_OPTIONS_START
  const seekdeepImageModeOptions = seekdeepImageModeOptionsFromPrompt(prompt);
  prompt = seekdeepImageModeOptions.cleanPrompt || prompt;
  // SEEKDEEP_RAW_IMAGE_SEND_OPTIONS_END

"""
    pos = text.find("async function seekdeepSendImageWithButtonsMessage")
    if pos < 0:
        raise SystemExit("Could not locate seekdeepSendImageWithButtonsMessage.")
    local = text[pos:pos + 1200]
    if old not in local:
        raise SystemExit("Could not locate requestStartedAt in seekdeepSendImageWithButtonsMessage.")
    text = text[:pos] + local.replace(old, new, 1) + text[pos + len(local):]

# If generic context resolution exists, ensure context-cleaned prompt does not lose original options.
# Patch makeImageResult signature and behavior.
if "SEEKDEEP_RAW_IMAGE_MAKE_OPTIONS_START" not in text:
    old_sig = "async function makeImageResult(prompt, width = 1024, height = 1024, seed = null) {\n"
    new_sig = "async function makeImageResult(prompt, width = 1024, height = 1024, seed = null, imageOptions = {}) {\n"
    if old_sig not in text:
        raise SystemExit("Could not patch makeImageResult signature.")
    text = text.replace(old_sig, new_sig, 1)

# Patch the promptInfo line. It may be plain or grounded-patched.
if "SEEKDEEP_RAW_IMAGE_MAKE_OPTIONS_START" not in text:
    old_grounded = """  // SEEKDEEP_IMAGE_WEB_GROUNDING_CALL_START
  const seekdeepGroundedImagePrompt = await seekdeepMaybeGroundImagePrompt(prompt);
  const promptInfo = seekdeepSanitizeObjectImagePromptInfo(seekdeepPrepareImagePrompt(seekdeepGroundedImagePrompt.prompt || prompt));
  // SEEKDEEP_IMAGE_WEB_GROUNDING_CALL_END

"""
    new_grounded = """  // SEEKDEEP_IMAGE_WEB_GROUNDING_CALL_START
  // SEEKDEEP_RAW_IMAGE_MAKE_OPTIONS_START
  const seekdeepImageOptions = {
    refine: imageOptions?.refine !== false,
    ground: imageOptions?.ground !== false,
  };
  const seekdeepGroundedImagePrompt = seekdeepImageOptions.ground
    ? await seekdeepMaybeGroundImagePrompt(prompt)
    : { prompt, grounded: false, searchQuery: '' };

  let promptInfo;
  if (seekdeepImageOptions.refine) {
    promptInfo = seekdeepSanitizeObjectImagePromptInfo(seekdeepPrepareImagePrompt(seekdeepGroundedImagePrompt.prompt || prompt));
  } else {
    const rawPrompt = normalizeUserText(seekdeepGroundedImagePrompt.prompt || prompt).trim();
    promptInfo = {
      originalPrompt: normalizeUserText(prompt).trim(),
      refinedPrompt: rawPrompt,
      generationPrompt: rawPrompt,
      changed: rawPrompt !== normalizeUserText(prompt).trim(),
    };
  }
  // SEEKDEEP_RAW_IMAGE_MAKE_OPTIONS_END
  // SEEKDEEP_IMAGE_WEB_GROUNDING_CALL_END

"""
    old_plain = "  const promptInfo = seekdeepPrepareImagePrompt(prompt);\n"
    new_plain = """  // SEEKDEEP_RAW_IMAGE_MAKE_OPTIONS_START
  const seekdeepImageOptions = {
    refine: imageOptions?.refine !== false,
    ground: imageOptions?.ground !== false,
  };
  const seekdeepGroundedImagePrompt = seekdeepImageOptions.ground && typeof seekdeepMaybeGroundImagePrompt === 'function'
    ? await seekdeepMaybeGroundImagePrompt(prompt)
    : { prompt, grounded: false, searchQuery: '' };

  let promptInfo;
  if (seekdeepImageOptions.refine) {
    const prepared = seekdeepPrepareImagePrompt(seekdeepGroundedImagePrompt.prompt || prompt);
    promptInfo = typeof seekdeepSanitizeObjectImagePromptInfo === 'function'
      ? seekdeepSanitizeObjectImagePromptInfo(prepared)
      : prepared;
  } else {
    const rawPrompt = normalizeUserText(seekdeepGroundedImagePrompt.prompt || prompt).trim();
    promptInfo = {
      originalPrompt: normalizeUserText(prompt).trim(),
      refinedPrompt: rawPrompt,
      generationPrompt: rawPrompt,
      changed: rawPrompt !== normalizeUserText(prompt).trim(),
    };
  }
  // SEEKDEEP_RAW_IMAGE_MAKE_OPTIONS_END

"""
    if old_grounded in text:
        text = text.replace(old_grounded, new_grounded, 1)
    elif old_plain in text:
        text = text.replace(old_plain, new_plain, 1)
    else:
        raise SystemExit("Could not locate promptInfo creation in makeImageResult.")

# Pass image options from queue runner to makeImageResult.
if "makeImageResult(prompt, width, height, seed, seekdeepImageModeOptions)" not in text:
    old = "const result = await makeImageResult(prompt, width, height, seed);"
    new = "const result = await makeImageResult(prompt, width, height, seed, seekdeepImageModeOptions);"
    if old not in text:
        raise SystemExit("Could not patch makeImageResult call in image queue runner.")
    text = text.replace(old, new, 1)

# Add refinement/grounding status lines into final content.
if "seekdeepRefinementStatusLine(result?.refinementEnabled !== false)" not in text:
    old = """        seekdeepRefinedPromptLine(prompt, seekdeepExtractRefinedPrompt(typeof result !== 'undefined' ? result : undefined, typeof imageResult !== 'undefined' ? imageResult : undefined, typeof data !== 'undefined' ? data : undefined, typeof payload !== 'undefined' ? payload : undefined, typeof normalized !== 'undefined' ? normalized : undefined)),
        seekdeepRefinedPromptLine(prompt, typeof refinedPrompt !== 'undefined' ? refinedPrompt : (typeof imagePrompt !== 'undefined' ? imagePrompt : '')),
        `Queue Wait: ${seekdeepImageQueueWaitSeconds(runningJob)} seconds`,"""
    new = """        seekdeepRefinedPromptLine(prompt, seekdeepExtractRefinedPrompt(typeof result !== 'undefined' ? result : undefined, typeof imageResult !== 'undefined' ? imageResult : undefined, typeof data !== 'undefined' ? data : undefined, typeof payload !== 'undefined' ? payload : undefined, typeof normalized !== 'undefined' ? normalized : undefined)),
        seekdeepRefinedPromptLine(prompt, typeof refinedPrompt !== 'undefined' ? refinedPrompt : (typeof imagePrompt !== 'undefined' ? imagePrompt : '')),
        seekdeepGroundingStatusLine(result?.grounding, result?.imageOptions),
        seekdeepRefinementStatusLine(result?.refinementEnabled !== false),
        `Queue Wait: ${seekdeepImageQueueWaitSeconds(runningJob)} seconds`,"""
    if old in text:
        text = text.replace(old, new, 1)
    else:
        # Non-fatal but important.
        raise SystemExit("Could not locate final image content lines to add refinement status.")

# Return metadata from makeImageResult.
if "refinementEnabled: promptInfo.refinementEnabled !== false" not in text:
    old = """    generationPrompt: promptInfo.generationPrompt,
    promptRefined: promptInfo.changed,
    width,"""
    new = """    generationPrompt: promptInfo.generationPrompt,
    promptRefined: promptInfo.changed,
    refinementEnabled: seekdeepImageOptions.refine,
    grounding: seekdeepGroundedImagePrompt,
    imageOptions: seekdeepImageOptions,
    width,"""
    if old not in text:
        raise SystemExit("Could not patch makeImageResult return metadata.")
    text = text.replace(old, new, 1)

for needle, label in [
    ("SEEKDEEP_RAW_IMAGE_MODE_START", "raw mode helpers"),
    ("SEEKDEEP_RAW_IMAGE_EXTRACT_CLEAN_START", "extract clean hook"),
    ("SEEKDEEP_RAW_IMAGE_ROUTE_CLEAN_START", "route clean hook"),
    ("SEEKDEEP_RAW_IMAGE_SEND_OPTIONS_START", "send options hook"),
    ("SEEKDEEP_RAW_IMAGE_MAKE_OPTIONS_START", "make options hook"),
    ("makeImageResult(prompt, width, height, seed, seekdeepImageModeOptions)", "image options passed to makeImageResult"),
    ("Refinement: ${enabled ? 'on' : 'off'}", "refinement status line"),
    ("refinementEnabled: seekdeepImageOptions.refine", "refinement metadata"),
    ("seekdeepEnqueueImageJob(job, runner)", "queue contract preserved"),
]:
    require_contains(text, needle, label)

out = text if newline == "\n" else text.replace("\n", "\r\n")
path.write_bytes(out.encode("utf-8"))
print("Patched raw/unrefined image mode.")