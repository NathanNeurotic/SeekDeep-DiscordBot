from pathlib import Path
import re
import sys

if len(sys.argv) != 2:
    raise SystemExit("Usage: patch_prompt_choice_ux_repair.py <index.js>")

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
                i += 1
                continue
            if not escaped and ch == "'":
                in_single = False
            escaped = False
            i += 1
            continue

        if in_double:
            if not escaped and ch == "\\":
                escaped = True
                i += 1
                continue
            if not escaped and ch == '"':
                in_double = False
            escaped = False
            i += 1
            continue

        if in_template:
            if not escaped and ch == "\\":
                escaped = True
                i += 1
                continue
            if not escaped and ch == "`":
                in_template = False
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

def replace_named_function(source, signature, new_block):
    start = source.find(signature)
    if start < 0:
        fail(f"Could not locate function: {signature}")
    brace_open = source.find("{", start)
    if brace_open < 0:
        fail(f"Could not locate opening brace for: {signature}")
    brace_close = find_matching_brace(source, brace_open)
    return source[:start] + new_block.rstrip() + source[brace_close + 1:]

def get_named_function(source, signature):
    start = source.find(signature)
    if start < 0:
        fail(f"Could not locate function: {signature}")
    brace_open = source.find("{", start)
    if brace_open < 0:
        fail(f"Could not locate opening brace for: {signature}")
    brace_close = find_matching_brace(source, brace_open)
    return source[start:brace_close + 1], start, brace_close + 1

for needle, label in [
    ("function seekdeepPendingPromptChoiceRow", "prompt-choice row"),
    ("async function seekdeepHandlePromptChoiceButton", "prompt-choice handler"),
    ("async function seekdeepSendImageWithButtonsMessage", "message image sender"),
    ("async function seekdeepSendImageWithButtonsInteraction", "interaction image sender"),
    ("function seekdeepRememberPendingImagePrompt", "pending prompt storage"),
    ("seekdeepEnqueueImageJob(job, runner)", "image queue contract"),
]:
    require(needle, label)

if "seekdeepMakeImageQueueJobId" in text:
    fail("Unsafe old queue helper found: seekdeepMakeImageQueueJobId")
if "job.run" in text:
    fail("Unsafe job.run-style queue logic found")

# ----------------------------------------------------------------------
# 1. Prompt-choice row: Original / Refined / Both, no Cancel.
# ----------------------------------------------------------------------
new_row = r"""function seekdeepPendingPromptChoiceRow(id, disabled = false) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`seekdeep:prompt:original:${id}`)
      .setLabel('Original')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(disabled),
    new ButtonBuilder()
      .setCustomId(`seekdeep:prompt:refined:${id}`)
      .setLabel('Refined')
      .setStyle(ButtonStyle.Primary)
      .setDisabled(disabled),
    new ButtonBuilder()
      .setCustomId(`seekdeep:prompt:both:${id}`)
      .setLabel('Both')
      .setStyle(ButtonStyle.Success)
      .setDisabled(disabled),
  );
}"""
text = replace_named_function(text, "function seekdeepPendingPromptChoiceRow(id, disabled = false)", new_row)

# ----------------------------------------------------------------------
# 2. Proxy message helper for queued jobs started from button interactions.
# ----------------------------------------------------------------------
if "function seekdeepPromptChoiceProxyMessage(" not in text:
    _, _, insert_at = get_named_function(text, "function seekdeepRememberPendingImagePrompt(state)")
    helper = r"""

function seekdeepPromptChoiceProxyMessage(interaction, requesterId = '', suffix = '') {
  const fallbackId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const baseId = interaction?.message?.id || interaction?.id || 'prompt-choice';
  const uniqueId = suffix ? `${baseId}:${suffix}:${fallbackId}` : `${baseId}:${fallbackId}`;

  return {
    author: { id: requesterId || interaction?.user?.id || 'unknown' },
    channel: interaction?.channel || null,
    id: uniqueId,
    reply: async (payload) => {
      if (interaction?.channel && typeof interaction.channel.send === 'function') {
        return await interaction.channel.send(payload);
      }
      return null;
    },
  };
}
"""
    text = text[:insert_at] + helper + text[insert_at:]

# ----------------------------------------------------------------------
# 3. Add skipCooldown support to image senders.
#    This makes Both count as one user action while still queueing two jobs.
# ----------------------------------------------------------------------
def patch_sender_skip_cooldown(source, signature):
    fn, start, end = get_named_function(source, signature)

    if "const seekdeepSkipImageCooldown = Boolean(seekdeepImageModeOptions.skipCooldown);" not in fn:
        old = "  prompt = seekdeepImageModeOptions.cleanPrompt || seekdeepCleanImageModeTokens(prompt) || prompt;\n"
        new = "  prompt = seekdeepImageModeOptions.cleanPrompt || seekdeepCleanImageModeTokens(prompt) || prompt;\n  const seekdeepSkipImageCooldown = Boolean(seekdeepImageModeOptions.skipCooldown);\n"
        if old not in fn:
            fail(f"Could not insert skipCooldown into {signature}")
        fn = fn.replace(old, new, 1)

    if "if (!seekdeepSkipImageCooldown && cooldown > 0) {" not in fn:
        if "  if (cooldown > 0) {" not in fn:
            fail(f"Could not patch cooldown gate in {signature}")
        fn = fn.replace("  if (cooldown > 0) {", "  if (!seekdeepSkipImageCooldown && cooldown > 0) {", 1)

    if "if (!seekdeepSkipImageCooldown) seekdeepRememberImageCooldown(userId);" not in fn:
        if "  seekdeepRememberImageCooldown(userId);" not in fn:
            fail(f"Could not patch cooldown remember in {signature}")
        fn = fn.replace("  seekdeepRememberImageCooldown(userId);", "  if (!seekdeepSkipImageCooldown) seekdeepRememberImageCooldown(userId);", 1)

    return source[:start] + fn + source[end:]

text = patch_sender_skip_cooldown(
    text,
    "async function seekdeepSendImageWithButtonsMessage(message, prompt, width = 1024, height = 1024, seed = null, imageModeOptions = null)"
)
text = patch_sender_skip_cooldown(
    text,
    "async function seekdeepSendImageWithButtonsInteraction(interaction, prompt, width = 1024, height = 1024, seed = null, imageModeOptions = null)"
)

# ----------------------------------------------------------------------
# 4. Replace prompt-choice button handler.
# ----------------------------------------------------------------------
new_handler = r"""async function seekdeepHandlePromptChoiceButton(interaction) {
  const customId = String(interaction?.customId || '');
  const match = customId.match(/^seekdeep:prompt:(original|refined|both):(.+)$/);
  if (!match) return false;

  const action = match[1];
  const id = match[2];
  seekdeepSweepPendingImagePrompts();
  const state = SEEKDEEP_PENDING_IMAGE_PROMPTS.get(id) || null;
  const startedAt = seekdeepNowMs();

  if (!state) {
    const expiredText = [
      'Prompt choice expired before a version was selected.',
      'Run the image request again to reopen Original / Refined / Both.',
    ].join('\n');

    try {
      await interaction.update({
        content: seekdeepAppendResponseFooter(expiredText, {
          startedAt,
          modelUsed: seekdeepNoModelLabel(),
        }),
        components: [],
      });
    } catch (err) {
      // Avoid spamming public channels with expired-click messages.
      try {
        if (!interaction?.replied && !interaction?.deferred) {
          await interaction.reply({
            content: seekdeepAppendResponseFooter(expiredText, {
              startedAt,
              modelUsed: seekdeepNoModelLabel(),
            }),
            ephemeral: true,
          });
        }
      } catch {}
    }

    return true;
  }

  if (state.requesterId && interaction?.user?.id !== state.requesterId) {
    await interaction.reply({
      content: 'Only the requester can use these image prompt buttons.',
      ephemeral: true,
    });
    return true;
  }

  SEEKDEEP_PENDING_IMAGE_PROMPTS.delete(id);

  const basePrompt = state.originalPrompt || state.rawPrompt || 'image';
  const width = state.width || 1024;
  const height = state.height || 1024;
  const seed = state.seed ?? null;
  const groundingOn = state.ground !== false;
  const groundingLine = groundingOn ? 'Grounding: on' : 'Grounding: off';

  let selectionSummary = '';
  if (action === 'original') {
    selectionSummary = [
      'Queued original prompt.',
      '',
      groundingLine,
      'Refinement: off',
      'Queued Jobs: 1',
    ].join('\n');
  } else if (action === 'refined') {
    selectionSummary = [
      'Queued refined prompt.',
      '',
      groundingLine,
      'Refinement: on',
      'Queued Jobs: 1',
    ].join('\n');
  } else {
    selectionSummary = [
      'Queued both prompt versions.',
      '',
      groundingLine,
      'Jobs queued:',
      '1. Original prompt',
      '2. Refined prompt',
    ].join('\n');
  }

  try {
    await interaction.update({
      content: seekdeepAppendResponseFooter(selectionSummary, {
        startedAt,
        modelUsed: seekdeepNoModelLabel(),
      }),
      components: [],
    });
  } catch (err) {
    try {
      await interaction.reply({
        content: seekdeepAppendResponseFooter(selectionSummary, {
          startedAt,
          modelUsed: seekdeepNoModelLabel(),
        }),
        ephemeral: true,
      });
    } catch {}
  }

  const runQueuedSelection = async (messageProxy, selectionPrompt, selectionOptions, routeName) => {
    try {
      if (typeof seekdeepLogRoute === 'function') {
        seekdeepLogRoute(routeName, selectionPrompt);
      }

      await seekdeepSendImageWithButtonsMessage(
        messageProxy,
        selectionPrompt,
        width,
        height,
        seed,
        selectionOptions,
      );
    } catch (err) {
      console.warn(`Prompt choice generation failed (${routeName}):`, err?.message || err);
    }
  };

  if (action === 'both') {
    const originalProxy = seekdeepPromptChoiceProxyMessage(interaction, state.requesterId, 'original');
    const refinedProxy = seekdeepPromptChoiceProxyMessage(interaction, state.requesterId, 'refined');

    const originalOptions = {
      refine: false,
      ground: groundingOn,
      cleanPrompt: basePrompt,
      skipCooldown: false,
    };

    const refinedOptions = {
      refine: true,
      ground: groundingOn,
      cleanPrompt: basePrompt,
      skipCooldown: true,
    };

    void runQueuedSelection(originalProxy, basePrompt, originalOptions, 'image-choice-original');
    void runQueuedSelection(refinedProxy, basePrompt, refinedOptions, 'image-choice-refined');
    return true;
  }

  const messageProxy = seekdeepPromptChoiceProxyMessage(interaction, state.requesterId, action);
  const selectionOptions = action === 'original'
    ? {
        refine: false,
        ground: groundingOn,
        cleanPrompt: basePrompt,
        skipCooldown: false,
      }
    : {
        refine: true,
        ground: groundingOn,
        cleanPrompt: basePrompt,
        skipCooldown: false,
      };

  void runQueuedSelection(
    messageProxy,
    basePrompt,
    selectionOptions,
    action === 'original' ? 'image-choice-original' : 'image-choice-refined'
  );

  return true;
}"""
text = replace_named_function(text, "async function seekdeepHandlePromptChoiceButton(interaction)", new_handler)

# ----------------------------------------------------------------------
# 5. Update existing prompt-choice copy, if the earlier patch left old labels.
# ----------------------------------------------------------------------
text = text.replace("Choose a version before queueing.", "Choose Original, Refined, or Both before queueing.")
text = text.replace("That prompt choice expired. Run the image request again.", "Prompt choice expired before a version was selected.\nRun the image request again to reopen Original / Refined / Both.")

# ----------------------------------------------------------------------
# 6. Validation.
# ----------------------------------------------------------------------
for needle, label in [
    ("setLabel('Original')", "Original button"),
    ("setLabel('Refined')", "Refined button"),
    ("setLabel('Both')", "Both button"),
    ("function seekdeepPromptChoiceProxyMessage(", "prompt-choice proxy helper"),
    ("skipCooldown", "skip cooldown support"),
    ("original|refined|both", "new prompt-choice regex"),
    ("Queued both prompt versions.", "Both queue summary"),
    ("components: []", "buttons vanish after selection/expiry"),
    ("Prompt choice expired before a version was selected.", "improved expiry text"),
    ("seekdeepEnqueueImageJob(job, runner)", "queue contract preserved"),
]:
    require(needle, label)

if "setLabel('Cancel')" in text or 'setLabel("Cancel")' in text:
    fail("Cancel button still exists after patch.")
if "seekdeep:prompt:cancel" in text:
    fail("Cancel customId still exists after patch.")
if "Generate Raw" in text or "Generate Refined" in text:
    fail("Old Generate Raw / Generate Refined labels still exist after patch.")

out = text if newline == "\n" else text.replace("\n", "\r\n")
path.write_bytes(out.encode("utf-8"))
print("Patched prompt choice UX: Original / Refined / Both, no Cancel, vanish-after-click, cleaner expiry.")