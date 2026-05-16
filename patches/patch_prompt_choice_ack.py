from pathlib import Path
import re
import sys

if len(sys.argv) != 2:
    raise SystemExit("Usage: patch_prompt_choice_ack.py <index.js>")

path = Path(sys.argv[1])
raw = path.read_bytes()
newline = "\r\n" if b"\r\n" in raw else "\n"
text = raw.decode("utf-8-sig").replace("\r\n", "\n").replace("\r", "\n")


def fail(msg):
    raise SystemExit(msg)


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
    m = re.search(r"async function\s+" + re.escape(name) + r"\s*\([^)]*\)\s*\{", source)
    if not m:
        return None, -1, -1
    start = m.start()
    open_brace = m.end() - 1
    close = find_matching_brace(source, open_brace)
    return source[start:close + 1], start, close + 1


if "async function seekdeepHandlePromptChoiceButton" not in text:
    fail("seekdeepHandlePromptChoiceButton not found.")

replacement = r"""async function seekdeepHandlePromptChoiceButton(interaction) {
  const customId = String(interaction?.customId || '');
  const match = customId.match(/^seekdeep:prompt:(original|refined|both):(.+)$/);
  if (!match) return false;

  if (!interaction.deferred && !interaction.replied) {
    try {
      await interaction.deferUpdate();
    } catch (err) {
      console.warn('Prompt choice deferUpdate failed:', err?.message || err);
    }
  }

  const action = match[1];
  const id = match[2];

  if (typeof seekdeepLogRoute === 'function') {
    seekdeepLogRoute(`image-choice-${action}`, id);
  }

  seekdeepSweepPendingImagePrompts();
  const state = SEEKDEEP_PENDING_IMAGE_PROMPTS.get(id) || null;
  const startedAt = seekdeepNowMs();

  const editChoiceMessage = async (payload) => {
    try {
      if (interaction?.message && typeof interaction.message.edit === 'function') {
        await interaction.message.edit(payload);
        return true;
      }
    } catch (err) {
      console.warn('Prompt choice message edit failed:', err?.message || err);
    }

    try {
      if (interaction?.deferred || interaction?.replied) {
        await interaction.editReply(payload);
        return true;
      }
    } catch (err) {
      console.warn('Prompt choice editReply fallback failed:', err?.message || err);
    }

    return false;
  };

  const privateNotice = async (content) => {
    try {
      await interaction.followUp({
        content,
        ephemeral: true,
      });
    } catch (err) {
      console.warn('Prompt choice followUp failed:', err?.message || err);
    }
  };

  if (!state) {
    const expiredText = [
      'Prompt choice expired before a version was selected.',
      'Run the image request again to reopen Original / Refined / Both.',
    ].join('\n');

    await editChoiceMessage({
      content: seekdeepAppendResponseFooter(expiredText, {
        startedAt,
        modelUsed: seekdeepNoModelLabel(),
      }),
      components: [],
    });

    return true;
  }

  if (state.requesterId && interaction?.user?.id !== state.requesterId) {
    await privateNotice('Only the requester can use these image prompt buttons.');
    return true;
  }

  const basePrompt = state.originalPrompt || state.rawPrompt || 'image';
  const width = state.width || 1024;
  const height = state.height || 1024;
  const seed = state.seed ?? null;
  const groundingOn = state.ground !== false;
  const groundingLine = groundingOn ? 'Grounding: on' : 'Grounding: off';

  const needsOriginal = (action === 'original' || action === 'both') && !state.originalQueued;
  const needsRefined = (action === 'refined' || action === 'both') && !state.refinedQueued;

  if (!needsOriginal && !needsRefined) {
    await privateNotice('That version has already been queued for this prompt.');
    return true;
  }

  state.originalQueued = Boolean(state.originalQueued || needsOriginal);
  state.refinedQueued = Boolean(state.refinedQueued || needsRefined);
  state.lastSelectedAt = Date.now();
  SEEKDEEP_PENDING_IMAGE_PROMPTS.set(id, state);

  const queuedLines = [];
  if (needsOriginal) queuedLines.push('Original prompt');
  if (needsRefined) queuedLines.push('Refined prompt');

  const allQueued = Boolean(state.originalQueued && state.refinedQueued);
  const selectionSummary = [
    needsOriginal && needsRefined ? 'Queued both:' : needsOriginal ? 'Queued original.' : 'Queued refined.',
    needsOriginal && needsRefined ? 'â€¢ Original' : '',
    needsOriginal && needsRefined ? 'â€¢ Refined' : '',
    '',
    groundingLine,
    needsOriginal && !needsRefined ? 'Refinement: off' : '',
    needsRefined && !needsOriginal ? 'Refinement: on' : '',
    `Queued Jobs: ${queuedLines.length}`,
    '',
    allQueued ? 'Both versions have now been queued.' : 'You can still choose the remaining version from this prompt.',
  ].filter(Boolean).join('\n');

  if (allQueued) {
    SEEKDEEP_PENDING_IMAGE_PROMPTS.delete(id);
  }

  await editChoiceMessage({
    content: seekdeepAppendResponseFooter(selectionSummary, {
      startedAt,
      modelUsed: seekdeepNoModelLabel(),
    }),
    components: allQueued ? [] : [seekdeepPendingPromptChoiceRow(id, state)],
  });

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
      console.warn(`Prompt choice generation failed (${routeName}):`, err?.stack || err?.message || err);
    }
  };

  if (needsOriginal) {
    const originalProxy = seekdeepPromptChoiceProxyMessage(interaction, state.requesterId, 'original');
    void runQueuedSelection(
      originalProxy,
      basePrompt,
      {
        refine: false,
        ground: groundingOn,
        cleanPrompt: basePrompt,
        skipCooldown: true,
        silentAck: true,
      },
      'image-choice-original'
    );
  }

  if (needsRefined) {
    const refinedProxy = seekdeepPromptChoiceProxyMessage(interaction, state.requesterId, 'refined');
    void runQueuedSelection(
      refinedProxy,
      basePrompt,
      {
        refine: true,
        ground: groundingOn,
        cleanPrompt: basePrompt,
        skipCooldown: true,
        silentAck: true,
      },
      'image-choice-refined'
    );
  }

  return true;
}"""

_fn, start, end = get_function(text, "seekdeepHandlePromptChoiceButton")
if start < 0:
    fail("Could not locate seekdeepHandlePromptChoiceButton block.")

text = text[:start] + replacement + text[end:]

for needle, label in [
    ("await interaction.deferUpdate();", "early deferUpdate"),
    ("interaction.message.edit", "message edit acknowledgement"),
    ("void runQueuedSelection", "async queue fire"),
    ("Queued both:", "compact queued both"),
    ("image-choice-original", "original route"),
    ("image-choice-refined", "refined route"),
]:
    if needle not in text:
        fail(f"Missing required patch element: {label}")

for bad in ["}, target = null) {", "state = {) {", "state = {,"]:
    if bad in text:
        fail(f"Malformed code detected after patch: {bad}")

out = text if newline == "\n" else text.replace("\n", "\r\n")
path.write_bytes(out.encode("utf-8"))
print("Patched prompt-choice button ACK handling.")