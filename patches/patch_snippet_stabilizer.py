from pathlib import Path
import re
import sys

if len(sys.argv) != 2:
    raise SystemExit("Usage: patch_snippet_stabilizer.py <index.js>")

path = Path(sys.argv[1])
raw = path.read_bytes()
newline = "\r\n" if b"\r\n" in raw else "\n"
text = raw.decode("utf-8-sig").replace("\r\n", "\n").replace("\r", "\n")

def fail(msg):
    raise SystemExit(msg)

def require(needle, label):
    if needle not in text:
        fail(f"Required anchor not found: {label}")

def find_matching_brace(source, open_brace_index):
    depth = 0
    i = open_brace_index
    in_single = False
    in_double = False
    in_template = False
    in_line_comment = False
    in_block_comment = False
    escaped = False

    while i < len(source):
        ch = source[i]
        nxt = source[i + 1] if i + 1 < len(source) else ""

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
            if not escaped and ch == "\\":
                escaped = True
            elif not escaped and ch == "'":
                in_single = False
            else:
                escaped = False
            i += 1
            continue

        if in_double:
            if not escaped and ch == "\\":
                escaped = True
            elif not escaped and ch == '"':
                in_double = False
            else:
                escaped = False
            i += 1
            continue

        if in_template:
            if not escaped and ch == "\\":
                escaped = True
            elif not escaped and ch == "`":
                in_template = False
            else:
                escaped = False
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
        elif ch == "}":
            depth -= 1
            if depth == 0:
                return i

        i += 1

    fail("Could not find matching closing brace.")

def get_function(source, name):
    starts = [
        source.find(f"async function {name}("),
        source.find(f"function {name}("),
    ]
    start = next((x for x in starts if x >= 0), -1)
    if start < 0:
        return None, -1, -1
    open_brace = source.find("{", start)
    if open_brace < 0:
        fail(f"Could not locate opening brace for {name}.")
    close_brace = find_matching_brace(source, open_brace)
    return source[start:close_brace + 1], start, close_brace + 1

def replace_function(source, name, new_fn):
    _, start, end = get_function(source, name)
    if start < 0:
        fail(f"Could not replace missing function: {name}")
    return source[:start] + new_fn.rstrip() + source[end:]

require("client.on('interactionCreate'", "interaction handler")
require("seekdeepEnqueueImageJob(job, runner)", "queue contract")

if "seekdeepMakeImageQueueJobId" in text:
    fail("Unsafe old queue helper found: seekdeepMakeImageQueueJobId")
if "job.run" in text:
    fail("Unsafe job.run-style queue logic found")

# ----------------------------------------------------------------------
# 1. Strict prompt-choice row state.
#    Do not treat random fields like state.original as "queued".
# ----------------------------------------------------------------------
row_fn, rs, re_ = get_function(text, "seekdeepPendingPromptChoiceRow")
if rs >= 0:
    new_row = r"""function seekdeepPendingPromptChoiceRow(id, disabledOrState = false) {
  const state = typeof disabledOrState === 'object' && disabledOrState
    ? disabledOrState
    : { disabled: Boolean(disabledOrState) };

  const allDisabled = Boolean(state.disabled);
  const originalDone = state.originalQueued === true;
  const refinedDone = state.refinedQueued === true;
  const bothDone = originalDone && refinedDone;

  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`seekdeep:prompt:original:${id}`)
      .setLabel(originalDone ? 'Original Queued' : 'Original')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(allDisabled || originalDone),
    new ButtonBuilder()
      .setCustomId(`seekdeep:prompt:refined:${id}`)
      .setLabel(refinedDone ? 'Refined Queued' : 'Refined')
      .setStyle(ButtonStyle.Primary)
      .setDisabled(allDisabled || refinedDone),
    new ButtonBuilder()
      .setCustomId(`seekdeep:prompt:both:${id}`)
      .setLabel(bothDone ? 'Both Queued' : 'Both')
      .setStyle(ButtonStyle.Success)
      .setDisabled(allDisabled || bothDone),
  );
}"""
    text = text[:rs] + new_row + text[re_:]

# ----------------------------------------------------------------------
# 2. Add/replace regenerate mode helper.
# ----------------------------------------------------------------------
regen_helper = r"""function seekdeepRegenerateModeOptions(mode = 'submitted', action = null) {
  const normalized = String(mode || 'submitted').toLowerCase();
  const basePrompt = action?.originalPrompt || action?.prompt || action?.rawPrompt || 'image';
  const base = {
    ground: action?.ground !== false,
    cleanPrompt: basePrompt,
    silentAck: true,
    skipCooldown: true,
  };

  if (normalized === 'original' || normalized === 'raw') {
    return { ...base, refine: false };
  }

  if (normalized === 'refined') {
    return { ...base, refine: true };
  }

  const originallyRaw =
    action?.refine === false ||
    action?.imageModeOptions?.refine === false ||
    action?.refinement === false ||
    action?.refinementMode === 'off' ||
    action?.refinement === 'off';

  return { ...base, refine: !originallyRaw };
}"""

if "function seekdeepRegenerateModeOptions" in text:
    text = replace_function(text, "seekdeepRegenerateModeOptions", regen_helper)
else:
    pos = text.find("async function seekdeepHandleImageButton")
    if pos < 0:
        pos = text.find("client.on('interactionCreate'")
    if pos < 0:
        fail("Could not insert seekdeepRegenerateModeOptions.")
    text = text[:pos] + regen_helper + "\n\n" + text[pos:]

# ----------------------------------------------------------------------
# 3. Ensure image action row has regenerate modes.
# ----------------------------------------------------------------------
action_row_fn, ars, are = get_function(text, "seekdeepImageActionRow")
if ars >= 0:
    new_action_row = r"""function seekdeepImageActionRow(actionId, filePath = '') {
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`seekdeep:regen:original:${actionId}`)
      .setLabel('Original')
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(`seekdeep:regen:refined:${actionId}`)
      .setLabel('Refined')
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId(`seekdeep:regen:both:${actionId}`)
      .setLabel('Both')
      .setStyle(ButtonStyle.Success),
  );

  if (filePath) {
    row.addComponents(
      new ButtonBuilder()
        .setCustomId(`seekdeep:download:${actionId}`)
        .setLabel('Download')
        .setStyle(ButtonStyle.Secondary),
    );
  }

  row.addComponents(
    new ButtonBuilder()
      .setCustomId(`seekdeep:archive:${actionId}`)
      .setLabel('Archive')
      .setStyle(ButtonStyle.Success),
  );

  return row;
}"""
    text = text[:ars] + new_action_row + text[are:]

# ----------------------------------------------------------------------
# 4. Repair seekdeepHandleImageButton parser.
# ----------------------------------------------------------------------
handler, hs, he = get_function(text, "seekdeepHandleImageButton")
if hs >= 0:
    # Remove the previous injected parser block if present.
    parser_start = handler.find("  const seekdeepImageButtonParsed =")
    if parser_start >= 0:
        # Cut until first "const action = buttonAction;" after parser, inclusive.
        parser_end_marker = "  const action = buttonAction;"
        parser_end = handler.find(parser_end_marker, parser_start)
        if parser_end >= 0:
            parser_end += len(parser_end_marker)
            # Include trailing semicolon/newline already in marker? Marker includes semicolon.
            while parser_end < len(handler) and handler[parser_end] in " \t\r\n":
                parser_end += 1
            handler = handler[:parser_start] + handler[parser_end:]

    # Remove stale parser residue.
    handler = re.sub(r"\n\s*const\s+match\s*=\s*customId\.match\([\s\S]*?\);\s*", "\n", handler, count=1)
    handler = re.sub(r"\n\s*if\s*\(\s*!\s*match\s*\)\s*return\s+false;\s*", "\n", handler)
    handler = re.sub(r"\n\s*const\s+action\s*=\s*match\[[^\]]+\]\s*===\s*['\"]save['\"]\s*\?\s*['\"]archive['\"]\s*:\s*match\[[^\]]+\]\s*;\s*", "\n", handler)
    handler = re.sub(r"\n\s*const\s+action\s*=\s*match\[[^\]]+\]\s*;\s*", "\n", handler)
    handler = re.sub(r"\n\s*const\s+actionId\s*=\s*match\[[^\]]+\]\s*;\s*", "\n", handler)

    # Remove duplicate simple customId declarations; we will insert exactly one at top.
    handler = re.sub(r"\n\s*const\s+customId\s*=\s*String\([^;]+;\s*", "\n", handler)
    handler = re.sub(r"\n\s*const\s+customId\s*=\s*interaction\.customId\s*;\s*", "\n", handler)

    open_brace = handler.find("{")
    if open_brace < 0:
        fail("Could not find handler open brace.")

    parser = r"""
  const customId = String(interaction?.customId || '');
  const seekdeepImageButtonParsed =
    customId.match(/^seekdeep:(regen):(original|refined|both):(.+)$/) ||
    customId.match(/^seekdeep:(regenerate|download|archive|save):(.+)$/);

  if (!seekdeepImageButtonParsed) return false;

  let buttonAction = seekdeepImageButtonParsed[1];
  let regenMode = 'submitted';
  let actionId = '';

  if (buttonAction === 'regen') {
    regenMode = seekdeepImageButtonParsed[2] || 'submitted';
    actionId = seekdeepImageButtonParsed[3] || '';
    buttonAction = 'regenerate';
  } else {
    actionId = seekdeepImageButtonParsed[2] || '';
  }

  if (buttonAction === 'save') buttonAction = 'archive';
  const action = buttonAction;

"""
    handler = handler[:open_brace + 1] + parser + handler[open_brace + 1:]

    # Replace stale match[] leftovers if any remain.
    handler = handler.replace("match[1]", "buttonAction")
    handler = handler.replace("match[2]", "actionId")
    handler = handler.replace("match[3]", "actionId")

    # Insert both-regenerate support if there is a regenerate branch and support is missing.
    if "regenMode === 'both'" not in handler:
        marker = "if (action === 'regenerate')"
        idx = handler.find(marker)
        if idx >= 0:
            both_block = r"""
  if (action === 'regenerate' && regenMode === 'both') {
    const recordForBoth = actionRecord || record || item || actionData || imageAction || null;
    const basePromptForBoth = recordForBoth?.originalPrompt || recordForBoth?.prompt || recordForBoth?.rawPrompt || 'image';
    const widthForBoth = recordForBoth?.width || 1024;
    const heightForBoth = recordForBoth?.height || 1024;
    const seedForBoth = recordForBoth?.seed ?? null;

    await interaction.reply({
      content: seekdeepAppendResponseFooter('Queued both regenerate versions.\n\nJobs queued:\n1. Original prompt\n2. Refined prompt', {
        startedAt: seekdeepNowMs(),
        modelUsed: seekdeepNoModelLabel(),
      }),
      ephemeral: true,
    });

    const proxyOriginal = typeof seekdeepPromptChoiceProxyMessage === 'function'
      ? seekdeepPromptChoiceProxyMessage(interaction, interaction?.user?.id || '', 'regen-original')
      : { author: { id: interaction?.user?.id || 'unknown' }, channel: interaction?.channel, id: interaction?.id || 'regen-original', reply: async (payload) => interaction?.channel?.send ? interaction.channel.send(payload) : null };

    const proxyRefined = typeof seekdeepPromptChoiceProxyMessage === 'function'
      ? seekdeepPromptChoiceProxyMessage(interaction, interaction?.user?.id || '', 'regen-refined')
      : { author: { id: interaction?.user?.id || 'unknown' }, channel: interaction?.channel, id: `${interaction?.id || 'regen'}:refined`, reply: async (payload) => interaction?.channel?.send ? interaction.channel.send(payload) : null };

    void seekdeepSendImageWithButtonsMessage(proxyOriginal, basePromptForBoth, widthForBoth, heightForBoth, seedForBoth, seekdeepRegenerateModeOptions('original', recordForBoth));
    void seekdeepSendImageWithButtonsMessage(proxyRefined, basePromptForBoth, widthForBoth, heightForBoth, seedForBoth, seekdeepRegenerateModeOptions('refined', recordForBoth));
    return true;
  }

"""
            handler = handler[:idx] + both_block + handler[idx:]

    # Patch the most common single-regenerate call signatures if they exist.
    handler = handler.replace(
        "seekdeepSendImageWithButtonsInteraction(interaction, prompt, width, height, seed)",
        "seekdeepSendImageWithButtonsInteraction(interaction, prompt, width, height, seed, seekdeepRegenerateModeOptions(regenMode, actionRecord || record || item || actionData || imageAction || null))"
    )
    handler = handler.replace(
        "seekdeepSendImageWithButtonsInteraction(interaction, prompt, width, height, seed ?? null)",
        "seekdeepSendImageWithButtonsInteraction(interaction, prompt, width, height, seed ?? null, seekdeepRegenerateModeOptions(regenMode, actionRecord || record || item || actionData || imageAction || null))"
    )

    # Validate handler shape.
    if "const customId = String(interaction?.customId || '');" not in handler:
        fail("customId declaration missing after repair.")
    if handler.find("const customId = String(interaction?.customId || '');") > handler.find("const seekdeepImageButtonParsed ="):
        fail("customId still appears after parser.")
    if len(re.findall(r"\bconst\s+action\s*=", handler)) > 1:
        fail("Duplicate const action remains in seekdeepHandleImageButton.")
    if len(re.findall(r"\bconst\s+customId\s*=", handler)) > 1:
        fail("Duplicate const customId remains in seekdeepHandleImageButton.")
    if re.search(r"\bmatch\s*\[", handler):
        fail("Stale match[...] remains in seekdeepHandleImageButton.")

    text = text[:hs] + handler + text[he:]

# ----------------------------------------------------------------------
# 5. Preserve action metadata where possible.
# ----------------------------------------------------------------------
if "originalPrompt: prompt" not in text:
    text = text.replace("prompt: prompt,", "prompt: prompt,\n    originalPrompt: prompt,", 1)

# ----------------------------------------------------------------------
# 6. Path privacy hardening helper if present.
# ----------------------------------------------------------------------
if "function seekdeepRedactArchivePathForDiscord" in text:
    redactor = r"""function seekdeepRedactArchivePathForDiscord(value = '') {
  return String(value || '')
    .replace(/[A-Z]:\\[^\n\r`]+/gi, '[local archive path hidden]')
    .replace(/\/(?:home|Users|mnt|var|tmp)\/[^\n\r`]+/gi, '[local archive path hidden]');
}"""
    text = replace_function(text, "seekdeepRedactArchivePathForDiscord", redactor)

# ----------------------------------------------------------------------
# Validation.
# ----------------------------------------------------------------------
for needle, label in [
    ("function seekdeepRegenerateModeOptions", "regenerate helper"),
    ("seekdeepEnqueueImageJob(job, runner)", "queue contract"),
]:
    require(needle, label)

if "function seekdeepImageActionRow" in text:
    for needle, label in [
        ("setLabel('Original')", "Original button"),
        ("setLabel('Refined')", "Refined button"),
        ("setLabel('Both')", "Both button"),
    ]:
        require(needle, label)

if "Cannot access 'customId' before initialization" in text:
    fail("Error text itself found in source unexpectedly.")

out = text if newline == "\n" else text.replace("\n", "\r\n")
path.write_bytes(out.encode("utf-8"))
print("Applied snippet stabilizer repairs.")