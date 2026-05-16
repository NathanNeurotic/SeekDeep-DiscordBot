from pathlib import Path
import sys

if len(sys.argv) != 2:
    raise SystemExit("Usage: patch_raw_reply_force_image.py <index.js>")

path = Path(sys.argv[1])
raw = path.read_bytes()
newline = "\r\n" if b"\r\n" in raw else "\n"
text = raw.decode("utf-8-sig").replace("\r\n", "\n").replace("\r", "\n")
original = text

def must_contain(needle: str, label: str):
    if needle not in text:
        raise SystemExit(f"Required anchor not found: {label}")

must_contain("async function seekdeepSendImageWithButtonsMessage", "message image sender")
must_contain("async function seekdeepSendImageWithButtonsInteraction", "interaction image sender")
must_contain("client.on('messageCreate'", "messageCreate handler")
must_contain("async function seekdeepApplyReplyContextToPrompt", "reply-context helper")
must_contain("function seekdeepImageModeOptionsFromPrompt", "raw image mode helper")

# 1) Preserve raw/unrefined options through the message image path.
text = text.replace(
    "async function seekdeepSendImageWithButtonsMessage(message, prompt, width = 1024, height = 1024, seed = null) {",
    "async function seekdeepSendImageWithButtonsMessage(message, prompt, width = 1024, height = 1024, seed = null, imageModeOptions = null) {"
)

old_msg_options = """  // SEEKDEEP_RAW_IMAGE_SEND_OPTIONS_START
  const seekdeepImageModeOptions = seekdeepImageModeOptionsFromPrompt(prompt);
  prompt = seekdeepImageModeOptions.cleanPrompt || prompt;
  // SEEKDEEP_RAW_IMAGE_SEND_OPTIONS_END
"""
new_msg_options = """  // SEEKDEEP_RAW_IMAGE_SEND_OPTIONS_START
  const seekdeepImageModeOptions = {
    ...(typeof seekdeepImageModeOptionsFromPrompt === 'function' ? seekdeepImageModeOptionsFromPrompt(prompt) : {}),
    ...(imageModeOptions || {}),
  };
  prompt = seekdeepImageModeOptions.cleanPrompt || seekdeepCleanImageModeTokens(prompt) || prompt;
  // SEEKDEEP_RAW_IMAGE_SEND_OPTIONS_END
"""
if old_msg_options in text:
    text = text.replace(old_msg_options, new_msg_options, 1)
elif new_msg_options not in text:
    raise SystemExit("Could not patch message raw-image options block.")

text = text.replace(
    "const result = await makeImageResult(prompt, width, height, seed);",
    "const result = await makeImageResult(prompt, width, height, seed, seekdeepImageModeOptions);"
)

# 2) Preserve raw/unrefined options through the slash-image path too.
text = text.replace(
    "async function seekdeepSendImageWithButtonsInteraction(interaction, prompt, width = 1024, height = 1024, seed = null) {",
    "async function seekdeepSendImageWithButtonsInteraction(interaction, prompt, width = 1024, height = 1024, seed = null, imageModeOptions = null) {"
)

interaction_anchor = """async function seekdeepSendImageWithButtonsInteraction(interaction, prompt, width = 1024, height = 1024, seed = null, imageModeOptions = null) {
  const requestStartedAt = interaction?.__seekdeepRequestStartedAt || seekdeepNowMs();
"""
interaction_insert = """async function seekdeepSendImageWithButtonsInteraction(interaction, prompt, width = 1024, height = 1024, seed = null, imageModeOptions = null) {
  const requestStartedAt = interaction?.__seekdeepRequestStartedAt || seekdeepNowMs();

  // SEEKDEEP_RAW_IMAGE_SEND_OPTIONS_INTERACTION_START
  const seekdeepImageModeOptions = {
    ...(typeof seekdeepImageModeOptionsFromPrompt === 'function' ? seekdeepImageModeOptionsFromPrompt(prompt) : {}),
    ...(imageModeOptions || {}),
  };
  prompt = seekdeepImageModeOptions.cleanPrompt || seekdeepCleanImageModeTokens(prompt) || prompt;
  // SEEKDEEP_RAW_IMAGE_SEND_OPTIONS_INTERACTION_END
"""
if interaction_anchor in text and "SEEKDEEP_RAW_IMAGE_SEND_OPTIONS_INTERACTION_START" not in text:
    text = text.replace(interaction_anchor, interaction_insert, 1)
elif "SEEKDEEP_RAW_IMAGE_SEND_OPTIONS_INTERACTION_START" not in text:
    raise SystemExit("Could not patch interaction raw-image options block.")

slash_old = """      const seed = interaction.options.getInteger('seed');
      remember(key, 'user', `/image ${prompt}`);
      remember(key, 'assistant', `Generated image locally for: ${prompt}`);
      await seekdeepSendImageWithButtonsInteraction(interaction, prompt, width, height, seed ?? null);
"""
slash_new = """      const seed = interaction.options.getInteger('seed');
      const seekdeepImageModeOptions = typeof seekdeepImageModeOptionsFromPrompt === 'function'
        ? seekdeepImageModeOptionsFromPrompt(prompt)
        : { refine: true, ground: true, cleanPrompt: prompt };
      const cleanImagePrompt = seekdeepImageModeOptions.cleanPrompt || prompt;
      remember(key, 'user', `/image ${prompt}`);
      remember(key, 'assistant', `Generated image locally for: ${cleanImagePrompt}`);
      await seekdeepSendImageWithButtonsInteraction(interaction, cleanImagePrompt, width, height, seed ?? null, seekdeepImageModeOptions);
"""
if slash_old in text:
    text = text.replace(slash_old, slash_new, 1)
elif slash_new not in text:
    raise SystemExit("Could not patch /image interaction call path.")

# 3) Ignore placeholder reply-context blobs like GIF / emojis.
reply_placeholder_old = """    if (!replyText) return '';
    replyText = replyText.replace(/\s+/g, ' ').trim();
    return replyText;
"""
reply_placeholder_new = """    if (!replyText) return '';
    replyText = replyText.replace(/\s+/g, ' ').trim();
    if (/^(?:gif|image|photo|picture|pic|emoji|emojis|sticker|video|attachment|file)$/i.test(replyText)) return '';
    return replyText;
"""
if reply_placeholder_old in text:
    text = text.replace(reply_placeholder_old, reply_placeholder_new, 1)
elif reply_placeholder_new not in text:
    raise SystemExit("Could not patch reply-context placeholder filter.")

# 4) Force image route when reply-context was intentionally used for a generate-only message.
msg_prompt_old = """  let prompt = normalizeUserText(stripBotMentions(message.content));

  const seekdeepReplyPromptInfo = await seekdeepApplyReplyContextToPrompt(message, prompt);

  prompt = seekdeepReplyPromptInfo.prompt;
"""
msg_prompt_new = """  let prompt = normalizeUserText(stripBotMentions(message.content));
  const seekdeepPromptBeforeReplyContext = prompt;

  const seekdeepReplyPromptInfo = await seekdeepApplyReplyContextToPrompt(message, prompt);

  prompt = seekdeepReplyPromptInfo.prompt;
  const seekdeepForceImageFromReplyContext = Boolean(
    seekdeepReplyPromptInfo.usedReplyContext &&
    typeof seekdeepLooksLikeGenerateOnlyPrompt === 'function' &&
    seekdeepLooksLikeGenerateOnlyPrompt(seekdeepPromptBeforeReplyContext)
  );
"""
if msg_prompt_old in text:
    text = text.replace(msg_prompt_old, msg_prompt_new, 1)
elif "const seekdeepForceImageFromReplyContext = Boolean(" not in text:
    raise SystemExit("Could not patch reply-context force-image flag.")

route_old = "if (!seekdeepShouldKeepPromptAsChatBeforeImage(prompt) && ((typeof seekdeepIsGenericImageFollowupPrompt === 'function' && seekdeepIsGenericImageFollowupPrompt(prompt)) || (typeof seekdeepLooksLikeShortNamedVisualSubject === 'function' && seekdeepLooksLikeShortNamedVisualSubject(prompt)) || isNaturalImagePrompt(prompt))) {"
route_new = "if (seekdeepForceImageFromReplyContext || (!seekdeepShouldKeepPromptAsChatBeforeImage(prompt) && ((typeof seekdeepIsGenericImageFollowupPrompt === 'function' && seekdeepIsGenericImageFollowupPrompt(prompt)) || (typeof seekdeepLooksLikeShortNamedVisualSubject === 'function' && seekdeepLooksLikeShortNamedVisualSubject(prompt)) || isNaturalImagePrompt(prompt)))) {"
if route_old in text:
    text = text.replace(route_old, route_new, 1)
elif route_new not in text:
    raise SystemExit("Could not patch force-image route condition.")

message_image_old = """      const imagePrompt = (typeof seekdeepExtractImagePrompt === 'function' ? seekdeepExtractImagePrompt(prompt) : prompt) || prompt;
      seekdeepLogRoute('image', imagePrompt);
      remember(key, 'user', `[natural-image] ${prompt}`);
      remember(key, 'assistant', `Queued image locally for: ${imagePrompt}`);
      await seekdeepSendImageWithButtonsMessage(message, imagePrompt, 1024, 1024, null);
"""
message_image_new = """      const seekdeepMessageImageModeOptions = typeof seekdeepImageModeOptionsFromPrompt === 'function'
        ? seekdeepImageModeOptionsFromPrompt(prompt)
        : { refine: true, ground: true, cleanPrompt: prompt };
      const imagePrompt = (typeof seekdeepExtractImagePrompt === 'function' ? seekdeepExtractImagePrompt(prompt) : prompt) || seekdeepMessageImageModeOptions.cleanPrompt || prompt;
      seekdeepLogRoute('image', imagePrompt);
      remember(key, 'user', `[natural-image] ${prompt}`);
      remember(key, 'assistant', `Queued image locally for: ${imagePrompt}`);
      await seekdeepSendImageWithButtonsMessage(message, imagePrompt, 1024, 1024, null, seekdeepMessageImageModeOptions);
"""
if message_image_old in text:
    text = text.replace(message_image_old, message_image_new, 1)
elif "await seekdeepSendImageWithButtonsMessage(message, imagePrompt, 1024, 1024, null, seekdeepMessageImageModeOptions);" not in text:
    raise SystemExit("Could not patch message image dispatch call.")

if text == original:
    raise SystemExit("No changes were applied; file shape may already differ from the expected checkpoint.")

# Final validation anchors.
for needle, label in [
    ("seekdeepForceImageFromReplyContext", "reply force-image flag"),
    ("seekdeepSendImageWithButtonsMessage(message, imagePrompt, 1024, 1024, null, seekdeepMessageImageModeOptions);", "message image dispatch with options"),
    ("seekdeepSendImageWithButtonsInteraction(interaction, cleanImagePrompt, width, height, seed ?? null, seekdeepImageModeOptions);", "interaction image dispatch with options"),
    ("await makeImageResult(prompt, width, height, seed, seekdeepImageModeOptions);", "makeImageResult with options"),
    ("/^(?:gif|image|photo|picture|pic|emoji|emojis|sticker|video|attachment|file)$/i.test(replyText)", "placeholder reply filter"),
]:
    if needle not in text:
        raise SystemExit(f"Validation failed: missing {label}")

out = text if newline == "\n" else text.replace("\n", "\r\n")
path.write_bytes(out.encode("utf-8"))
print("Patched raw/unrefined carry-through, reply-context force-image routing, and placeholder reply filtering.")