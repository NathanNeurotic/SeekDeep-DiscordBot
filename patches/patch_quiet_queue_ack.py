from pathlib import Path
import re
import sys

if len(sys.argv) != 2:
    raise SystemExit("Usage: patch_quiet_queue_ack.py <index.js>")

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

def get_named_function(source, signature):
    start = source.find(signature)
    if start < 0:
        fail(f"Could not locate function: {signature}")
    brace_open = source.find("{", start)
    if brace_open < 0:
        fail(f"Could not locate opening brace for: {signature}")
    brace_close = find_matching_brace(source, brace_open)
    return source[start:brace_close + 1], start, brace_close + 1

def replace_named_function(source, signature, fn):
    _, start, end = get_named_function(source, signature)
    return source[:start] + fn.rstrip() + source[end:]

for needle, label in [
    ("async function seekdeepSendImageWithButtonsMessage", "message image sender"),
    ("async function seekdeepSendImageWithButtonsInteraction", "interaction image sender"),
    ("async function seekdeepHandlePromptChoiceButton", "prompt-choice handler"),
    ("seekdeepEnqueueImageJob(job, runner)", "queue contract"),
]:
    require(needle, label)

if "seekdeepMakeImageQueueJobId" in text:
    fail("Unsafe old queue helper found: seekdeepMakeImageQueueJobId")
if "job.run" in text:
    fail("Unsafe job.run-style queue logic found")

# ---------------------------------------------------------------------
# 1. Add suppressQueueAck support to the normal message image sender.
# ---------------------------------------------------------------------
msg_sig = "async function seekdeepSendImageWithButtonsMessage(message, prompt, width = 1024, height = 1024, seed = null, imageModeOptions = null)"
msg_fn, _, _ = get_named_function(text, msg_sig)

if "const seekdeepSuppressQueueAck = Boolean(seekdeepImageModeOptions.silentAck || seekdeepImageModeOptions.suppressQueueAck);" not in msg_fn:
    anchor = "  const seekdeepSkipImageCooldown = Boolean(seekdeepImageModeOptions.skipCooldown);\n"
    if anchor not in msg_fn:
        fail("Could not locate skipCooldown anchor in message image sender.")
    msg_fn = msg_fn.replace(
        anchor,
        anchor + "  const seekdeepSuppressQueueAck = Boolean(seekdeepImageModeOptions.silentAck || seekdeepImageModeOptions.suppressQueueAck);\n",
        1,
    )

if "if (!seekdeepSuppressQueueAck) {" not in msg_fn:
    old = """  const startNotice = seekdeepImageQueueAckText(job, position);

  try {
    await message.reply({
      content: seekdeepAppendResponseFooter(startNotice, {
        startedAt: job.enqueuedAt || requestStartedAt,
        modelUsed: seekdeepNoModelLabel(),
      }),
      allowedMentions: { repliedUser: false },
    });
  } catch (err) {
    console.warn('Could not send image queue acknowledgement; falling back to channel.send:', err?.message || err);

    try {
      if (message?.channel && typeof message.channel.send === 'function') {
        await message.channel.send({
          content: seekdeepAppendResponseFooter(startNotice, {
            startedAt: job.enqueuedAt || requestStartedAt,
            modelUsed: seekdeepNoModelLabel(),
          }),
          allowedMentions: { repliedUser: false },
        });
      }
    } catch (fallbackErr) {
      console.warn('Could not send fallback image queue acknowledgement:', fallbackErr?.message || fallbackErr);
    }
  }
"""
    new = """  const startNotice = seekdeepImageQueueAckText(job, position);

  if (!seekdeepSuppressQueueAck) {
    try {
      await message.reply({
        content: seekdeepAppendResponseFooter(startNotice, {
          startedAt: job.enqueuedAt || requestStartedAt,
          modelUsed: seekdeepNoModelLabel(),
        }),
        allowedMentions: { repliedUser: false },
      });
    } catch (err) {
      console.warn('Could not send image queue acknowledgement; falling back to channel.send:', err?.message || err);

      try {
        if (message?.channel && typeof message.channel.send === 'function') {
          await message.channel.send({
            content: seekdeepAppendResponseFooter(startNotice, {
              startedAt: job.enqueuedAt || requestStartedAt,
              modelUsed: seekdeepNoModelLabel(),
            }),
            allowedMentions: { repliedUser: false },
          });
        }
      } catch (fallbackErr) {
        console.warn('Could not send fallback image queue acknowledgement:', fallbackErr?.message || fallbackErr);
      }
    }
  }
"""
    if old not in msg_fn:
        fail("Could not patch message queue acknowledgement block.")
    msg_fn = msg_fn.replace(old, new, 1)

text = replace_named_function(text, msg_sig, msg_fn)

# ---------------------------------------------------------------------
# 2. Add suppressQueueAck support to slash/interaction image sender.
# ---------------------------------------------------------------------
int_sig = "async function seekdeepSendImageWithButtonsInteraction(interaction, prompt, width = 1024, height = 1024, seed = null, imageModeOptions = null)"
int_fn, _, _ = get_named_function(text, int_sig)

if "const seekdeepSuppressQueueAck = Boolean(seekdeepImageModeOptions.silentAck || seekdeepImageModeOptions.suppressQueueAck);" not in int_fn:
    anchor = "  const seekdeepSkipImageCooldown = Boolean(seekdeepImageModeOptions.skipCooldown);\n"
    if anchor not in int_fn:
        fail("Could not locate skipCooldown anchor in interaction image sender.")
    int_fn = int_fn.replace(
        anchor,
        anchor + "  const seekdeepSuppressQueueAck = Boolean(seekdeepImageModeOptions.silentAck || seekdeepImageModeOptions.suppressQueueAck);\n",
        1,
    )

if "if (!seekdeepSuppressQueueAck) {" not in int_fn:
    old = """  await safeEditOrReply(interaction, {
    content: seekdeepAppendResponseFooter(seekdeepImageQueueAckText(job, position), {
      startedAt: job.enqueuedAt || requestStartedAt,
      modelUsed: seekdeepNoModelLabel(),
    }),
    allowedMentions: { repliedUser: false },
  });
"""
    new = """  if (!seekdeepSuppressQueueAck) {
    await safeEditOrReply(interaction, {
      content: seekdeepAppendResponseFooter(seekdeepImageQueueAckText(job, position), {
        startedAt: job.enqueuedAt || requestStartedAt,
        modelUsed: seekdeepNoModelLabel(),
      }),
      allowedMentions: { repliedUser: false },
    });
  }
"""
    if old not in int_fn:
        fail("Could not patch interaction queue acknowledgement block.")
    int_fn = int_fn.replace(old, new, 1)

text = replace_named_function(text, int_sig, int_fn)

# ---------------------------------------------------------------------
# 3. Prompt-choice jobs should be quiet and skip cooldown.
# ---------------------------------------------------------------------
handler_sig = "async function seekdeepHandlePromptChoiceButton(interaction)"
handler_fn, _, _ = get_named_function(text, handler_sig)

# Add silentAck to every existing prompt-choice selection options object that already has skipCooldown.
handler_fn = re.sub(
    r"(skipCooldown:\s*true,\n)(\s*})",
    r"\1        silentAck: true,\n\2",
    handler_fn,
)

# If indentation differs, normalize any missing silentAck after skipCooldown:true.
handler_fn = handler_fn.replace("skipCooldown: true,\n      },", "skipCooldown: true,\n        silentAck: true,\n      },")
handler_fn = handler_fn.replace("skipCooldown: true,\n    };", "skipCooldown: true,\n      silentAck: true,\n    };")

if "silentAck: true" not in handler_fn:
    fail("Could not add silentAck: true to prompt-choice selection options.")

text = replace_named_function(text, handler_sig, handler_fn)

# ---------------------------------------------------------------------
# 4. Validation.
# ---------------------------------------------------------------------
for signature in (msg_sig, int_sig):
    fn, _, _ = get_named_function(text, signature)
    if "const seekdeepSuppressQueueAck = Boolean(seekdeepImageModeOptions.silentAck || seekdeepImageModeOptions.suppressQueueAck);" not in fn:
        fail(f"Missing suppressQueueAck variable in {signature}")
    if "if (!seekdeepSuppressQueueAck) {" not in fn:
        fail(f"Queue acknowledgement is not gated in {signature}")

handler_fn, _, _ = get_named_function(text, handler_sig)
if "silentAck: true" not in handler_fn:
    fail("Prompt-choice handler does not set silentAck.")

for needle, label in [
    ("seekdeepEnqueueImageJob(job, runner)", "queue contract"),
    ("silentAck: true", "quiet prompt-choice options"),
    ("seekdeepSuppressQueueAck", "queue acknowledgement suppression"),
]:
    require(needle, label)

out = text if newline == "\n" else text.replace("\n", "\r\n")
path.write_bytes(out.encode("utf-8"))
print("Patched quiet queue acknowledgements for prompt-choice jobs.")