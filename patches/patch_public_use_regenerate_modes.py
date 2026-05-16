from pathlib import Path
import re
import sys

if len(sys.argv) != 2:
    raise SystemExit("Usage: patch_public_use_regenerate_modes.py <index.js>")

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
            if ch == "\n": in_line_comment = False
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
            in_line_comment = True; i += 2; continue
        if ch == "/" and nxt == "*":
            in_block_comment = True; i += 2; continue
        if ch == "'":
            in_single = True; i += 1; continue
        if ch == '"':
            in_double = True; i += 1; continue
        if ch == "`":
            in_template = True; i += 1; continue
        if ch == "{":
            depth += 1
        elif ch == "}":
            depth -= 1
            if depth == 0: return i
        i += 1
    fail("Could not find matching closing brace.")

def get_named_function(source, name_or_signature):
    if name_or_signature.startswith("function ") or name_or_signature.startswith("async function "):
        start = source.find(name_or_signature)
    else:
        start = source.find(f"function {name_or_signature}(")
        if start < 0:
            start = source.find(f"async function {name_or_signature}(")
    if start < 0:
        return None, -1, -1
    brace = source.find("{", start)
    if brace < 0:
        fail(f"Could not locate opening brace for {name_or_signature}")
    end = find_matching_brace(source, brace) + 1
    return source[start:end], start, end

def replace_named_function(source, name_or_signature, new_fn):
    _, start, end = get_named_function(source, name_or_signature)
    if start < 0:
        fail(f"Could not locate function for replacement: {name_or_signature}")
    return source[:start] + new_fn.rstrip() + source[end:]

require("ButtonBuilder", "Discord button builder")
require("ButtonStyle", "Discord button style")
require("client.on('interactionCreate'", "interaction handler")
require("seekdeepEnqueueImageJob(job, runner)", "queue contract")

if "seekdeepMakeImageQueueJobId" in text:
    fail("Unsafe old queue helper found: seekdeepMakeImageQueueJobId")
if "job.run" in text:
    fail("Unsafe job.run-style queue logic found")

# -------------------------------------------------------------------
# 1. Remove accidental command admin default permissions from non-admin commands.
# -------------------------------------------------------------------
# This strips builder-level admin restrictions. Later, runtime code can still guard dangerous commands.
text = re.sub(
    r"\n\s*\.setDefaultMemberPermissions\(\s*(?:PermissionFlagsBits\.)?(?:Administrator|ManageGuild|ManageChannels|ManageMessages)[^)]+\)",
    "",
    text,
)

# Add runtime public/admin helper.
if "function seekdeepIsPrivilegedArchiveCommand" not in text:
    helpers = r"""
function seekdeepIsPrivilegedArchiveCommand(commandName = '') {
  return /^(?:purgearchive|setarchive|archiveconfig|archiveadmin|cleararchive)$/i.test(String(commandName || ''));
}

function seekdeepUserCanRunPrivilegedSeekDeepCommand(interactionOrMessage = {}) {
  const memberPermissions = interactionOrMessage?.memberPermissions || interactionOrMessage?.member?.permissions || null;
  if (!memberPermissions || typeof memberPermissions.has !== 'function') return false;

  try {
    return Boolean(
      memberPermissions.has(PermissionFlagsBits.Administrator) ||
      memberPermissions.has(PermissionFlagsBits.ManageGuild) ||
      memberPermissions.has(PermissionFlagsBits.ManageChannels)
    );
  } catch {
    return false;
  }
}

function seekdeepNormalUsersMayUseCommand(commandName = '') {
  return !seekdeepIsPrivilegedArchiveCommand(commandName);
}
"""
    pos = text.find("client.on('interactionCreate'")
    if pos < 0:
        fail("Could not insert public-use helpers.")
    text = text[:pos] + helpers + "\n" + text[pos:]

# If there is a broad admin gate at interaction start, soften it.
# Common patterns: if (!interaction.memberPermissions.has(...Administrator...)) return ...
text = re.sub(
    r"if\s*\(\s*!\s*interaction\.memberPermissions\.has\(\s*PermissionFlagsBits\.Administrator\s*\)\s*\)\s*\{([\s\S]{0,500}?)return;\s*\}",
    "if (seekdeepIsPrivilegedArchiveCommand(interaction.commandName) && !seekdeepUserCanRunPrivilegedSeekDeepCommand(interaction)) {\\1return;\\n  }",
    text,
    count=1,
)

# -------------------------------------------------------------------
# 2. Replace image result button row with Original / Refined / Both / Download / Archive.
# -------------------------------------------------------------------
# Known function from this project line.
row_fn, row_start, row_end = get_named_function(text, "function seekdeepImageActionRow")
if row_start >= 0:
    new_row = r"""function seekdeepImageActionRow(actionId, filePath = '') {
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
    text = text[:row_start] + new_row + text[row_end:]

# -------------------------------------------------------------------
# 3. Add regeneration mode handler helpers.
# -------------------------------------------------------------------
if "function seekdeepRegenerateModeOptions" not in text:
    helper = r"""
function seekdeepRegenerateModeOptions(mode = 'submitted', action = null) {
  const normalized = String(mode || 'submitted').toLowerCase();

  if (normalized === 'original' || normalized === 'raw') {
    return {
      refine: false,
      ground: action?.ground !== false,
      cleanPrompt: action?.originalPrompt || action?.prompt || action?.rawPrompt || 'image',
      silentAck: true,
      skipCooldown: true,
    };
  }

  if (normalized === 'refined') {
    return {
      refine: true,
      ground: action?.ground !== false,
      cleanPrompt: action?.originalPrompt || action?.prompt || action?.rawPrompt || 'image',
      silentAck: true,
      skipCooldown: true,
    };
  }

  // Old "Regenerate" fallback: preserve whatever the result originally used.
  const originallyRaw = action?.refine === false || action?.imageModeOptions?.refine === false || action?.refinement === false;
  return {
    refine: !originallyRaw,
    ground: action?.ground !== false,
    cleanPrompt: action?.originalPrompt || action?.prompt || action?.rawPrompt || 'image',
    silentAck: true,
    skipCooldown: true,
  };
}
"""
    pos = text.find("async function seekdeepHandleImageButton")
    if pos < 0:
        pos = text.find("client.on('interactionCreate'")
    if pos < 0:
        fail("Could not insert regenerate mode helper.")
    text = text[:pos] + helper + "\n" + text[pos:]

# -------------------------------------------------------------------
# 4. Patch image button handler regex and action dispatch where possible.
# -------------------------------------------------------------------
handler_fn, hs, he = get_named_function(text, "async function seekdeepHandleImageButton")
if hs >= 0:
    # Support new IDs without breaking existing old regenerate id.
    handler_fn = handler_fn.replace(
        "seekdeep:regenerate:",
        "seekdeep:regen:"
    )

    # Make regex/action extraction accept regen:original/refined/both and regenerate.
    handler_fn = re.sub(
        r"customId\.match\(/[\^]seekdeep:\\(regenerate\|download\|archive\):\(\.\+\)\$/\)",
        "customId.match(/^seekdeep:(regen):(original|refined|both):(.+)$/) || customId.match(/^seekdeep:(regenerate|download|archive):(.+)$/)",
        handler_fn,
    )

    # If simpler parsing is present, inject robust parser near top.
    if "const seekdeepImageButtonParsed =" not in handler_fn:
        open_brace = handler_fn.find("{")
        insertion = r"""
  const seekdeepImageButtonParsed =
    customId.match(/^seekdeep:(regen):(original|refined|both):(.+)$/) ||
    customId.match(/^seekdeep:(regenerate|download|archive):(.+)$/);

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
"""
        handler_fn = handler_fn[:open_brace + 1] + insertion + handler_fn[open_brace + 1:]

    # Replace common declarations that conflict with injected parser.
    handler_fn = re.sub(r"\n\s*const\s+match\s*=\s*customId\.match\([^\n]+\);\s*", "\n", handler_fn)
    handler_fn = re.sub(r"\n\s*if\s*\(!match\)\s*return\s+false;\s*", "\n", handler_fn)
    handler_fn = re.sub(r"\n\s*const\s+action\s*=\s*match\[[^\]]+\];\s*", "\n  const action = buttonAction;\n", handler_fn, count=1)
    handler_fn = re.sub(r"\n\s*const\s+actionId\s*=\s*match\[[^\]]+\];\s*", "\n", handler_fn)

    # If regeneration calls image sender with no explicit options, pass mode options.
    handler_fn = re.sub(
        r"seekdeepSendImageWithButtonsInteraction\(\s*interaction,\s*([^,\n]+),\s*([^,\n]+),\s*([^,\n]+),\s*([^,\n\)]+)\s*\)",
        r"seekdeepSendImageWithButtonsInteraction(interaction, \1, \2, \3, \4, seekdeepRegenerateModeOptions(regenMode, actionRecord || record || item || actionData || imageAction || null))",
        handler_fn,
    )

    # If regeneration uses message sender, pass mode options.
    handler_fn = re.sub(
        r"seekdeepSendImageWithButtonsMessage\(\s*([^,\n]+),\s*([^,\n]+),\s*([^,\n]+),\s*([^,\n]+),\s*([^,\n\)]+)\s*\)",
        r"seekdeepSendImageWithButtonsMessage(\1, \2, \3, \4, \5, seekdeepRegenerateModeOptions(regenMode, actionRecord || record || item || actionData || imageAction || null))",
        handler_fn,
    )

    # Add explicit both support before normal regenerate branch if detectable.
    if "regenMode === 'both'" not in handler_fn:
        marker = "if (action === 'regenerate')"
        idx = handler_fn.find(marker)
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

    const proxyOriginal = seekdeepPromptChoiceProxyMessage(interaction, interaction?.user?.id || '', 'regen-original');
    const proxyRefined = seekdeepPromptChoiceProxyMessage(interaction, interaction?.user?.id || '', 'regen-refined');

    void seekdeepSendImageWithButtonsMessage(proxyOriginal, basePromptForBoth, widthForBoth, heightForBoth, seedForBoth, seekdeepRegenerateModeOptions('original', recordForBoth));
    void seekdeepSendImageWithButtonsMessage(proxyRefined, basePromptForBoth, widthForBoth, heightForBoth, seedForBoth, seekdeepRegenerateModeOptions('refined', recordForBoth));
    return true;
  }

"""
            handler_fn = handler_fn[:idx] + both_block + handler_fn[idx:]

    text = text[:hs] + handler_fn + text[he:]

# -------------------------------------------------------------------
# 5. Preserve action metadata original/refine mode when result actions are stored.
# -------------------------------------------------------------------
# Add metadata fields to common action record object if they are absent.
text = re.sub(
    r"(prompt:\s*prompt,\s*)",
    r"\1originalPrompt: prompt, ",
    text,
    count=1,
)

# Validation.
for needle, label in [
    ("setLabel('Original')", "Original image action button"),
    ("setLabel('Refined')", "Refined image action button"),
    ("setLabel('Both')", "Both image action button"),
    ("function seekdeepRegenerateModeOptions", "regenerate mode helper"),
    ("function seekdeepNormalUsersMayUseCommand", "public-use helper"),
    ("seekdeepEnqueueImageJob(job, runner)", "queue contract"),
]:
    require(needle, label)

out = text if newline == "\n" else text.replace("\n", "\r\n")
path.write_bytes(out.encode("utf-8"))
print("Patched public command access and regenerate mode options.")