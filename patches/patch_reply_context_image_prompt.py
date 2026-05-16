from pathlib import Path
import sys
import re

if len(sys.argv) != 2:
    raise SystemExit("Usage: patch_reply_context_image_prompt.py <index.js>")

path = Path(sys.argv[1])
raw = path.read_bytes()
newline = "\r\n" if b"\r\n" in raw else "\n"
text = raw.decode("utf-8-sig").replace("\r\n", "\n").replace("\r", "\n")


def require_contains(haystack: str, needle: str, label: str):
    if needle not in haystack:
        raise SystemExit(f"Required anchor not found: {label}")

for needle, label in [
    ("client.on('messageCreate'", "messageCreate handler"),
    ("seekdeepEnqueueImageJob(job, runner)", "correct image queue contract"),
]:
    require_contains(text, needle, label)

if "seekdeepMakeImageQueueJobId" in text:
    raise SystemExit("Unsafe old queue helper found: seekdeepMakeImageQueueJobId")
if "job.run" in text:
    raise SystemExit("Unsafe job.run-style queue logic found")

helpers = r'''
// SEEKDEEP_REPLY_CONTEXT_IMAGE_PROMPT_START
function seekdeepLooksLikeGenerateOnlyPrompt(prompt = '') {
  const p = normalizeUserText(prompt).toLowerCase().trim();
  if (!p) return true;
  return /^(?:<@!?\d+>\s*)?(?:please\s+)?(?:generate|gen|image|draw|paint|render|create|make|show\s+me)(?:\s+(?:it|that|this|one|something))?\s*[.!?]*$/i.test(p);
}

function seekdeepCleanReplyContextPrompt(prompt = '') {
  let p = normalizeUserText(prompt);
  if (!p) return '';
  p = p.replace(/^\s*<@!?\d+>\s*/g, '');
  p = p.replace(/^\s*(?:@seekotics|@seekdeep)\s*/ig, '');
  p = p.replace(/^\s*(?:please\s+)?(?:generate|gen|image|draw|paint|render|create|make|show\s+me)\b\s*/ig, '');
  p = p.replace(/^\s*(?:for\s+me|of|an\s+image\s+of|a\s+picture\s+of)\b\s*/ig, '');
  p = p.replace(/^\s*[:,-]+\s*/g, '');
  return p.trim();
}

async function seekdeepResolveReplyContextText(message) {
  try {
    const ref = message?.reference;
    if (!ref?.messageId) return '';

    let replied = null;

    if (message?.channel?.messages?.fetch) {
      try {
        replied = await message.channel.messages.fetch(ref.messageId);
      } catch (_) {}
    }

    if (!replied && message?.fetchReference) {
      try {
        replied = await message.fetchReference();
      } catch (_) {}
    }

    if (!replied) return '';

    let replyText = normalizeUserText(replied.content || '');
    if (!replyText && Array.isArray(replied.embeds) && replied.embeds.length) {
      const embedParts = [];
      for (const embed of replied.embeds) {
        if (embed?.title) embedParts.push(embed.title);
        if (embed?.description) embedParts.push(embed.description);
      }
      replyText = normalizeUserText(embedParts.join(' '));
    }

    if (!replyText) return '';
    replyText = replyText.replace(/\s+/g, ' ').trim();
    return replyText;
  } catch (_) {
    return '';
  }
}

async function seekdeepApplyReplyContextToPrompt(message, prompt = '') {
  const original = normalizeUserText(prompt || '');
  const replyText = await seekdeepResolveReplyContextText(message);
  if (!replyText) {
    return {
      prompt: original,
      usedReplyContext: false,
      replyContext: ''
    };
  }

  const cleaned = seekdeepCleanReplyContextPrompt(original);
  const isGenerateOnly = seekdeepLooksLikeGenerateOnlyPrompt(original);

  // If the current message is basically just a trigger, use the replied message verbatim.
  if (isGenerateOnly || !cleaned) {
    return {
      prompt: replyText,
      usedReplyContext: true,
      replyContext: replyText
    };
  }

  // If the current message already contains a real subject, keep it.
  // This patch is intentionally conservative: reply context is used as fallback.
  return {
    prompt: original,
    usedReplyContext: false,
    replyContext: replyText
  };
}
// SEEKDEEP_REPLY_CONTEXT_IMAGE_PROMPT_END
'''

if "SEEKDEEP_REPLY_CONTEXT_IMAGE_PROMPT_START" not in text:
    insert_anchor = "client.on('messageCreate'"
    pos = text.find(insert_anchor)
    if pos < 0:
        raise SystemExit("Could not locate messageCreate anchor for helper insertion.")
    text = text[:pos] + helpers + "\n" + text[pos:]

# Find messageCreate body area.
msg_pos = text.find("client.on('messageCreate'")
if msg_pos < 0:
    raise SystemExit("Could not locate messageCreate handler.")

# Insert reply-context resolution shortly after prompt is normalized/assigned.
if "seekdeepApplyReplyContextToPrompt(message, prompt)" not in text[msg_pos:msg_pos + 30000]:
    candidate_patterns = [
        r"(?P<indent>\s*)prompt\s*=\s*normalizeUserText\(prompt\);\n",
        r"(?P<indent>\s*)let prompt\s*=\s*normalizeUserText\([^\n]*\);\n",
        r"(?P<indent>\s*)const prompt\s*=\s*normalizeUserText\([^\n]*\);\n",
        r"(?P<indent>\s*)let prompt\s*=\s*[^\n]+;\n",
        r"(?P<indent>\s*)const prompt\s*=\s*[^\n]+;\n",
    ]
    patched = False
    search_region = text[msg_pos: msg_pos + 40000]
    for pat in candidate_patterns:
        m = re.search(pat, search_region)
        if not m:
            continue
        start = msg_pos + m.start()
        end = msg_pos + m.end()
        block = m.group(0)
        indent = m.group('indent')
        inject = (
            block +
            f"{indent}const seekdeepReplyPromptInfo = await seekdeepApplyReplyContextToPrompt(message, prompt);\n" +
            f"{indent}prompt = seekdeepReplyPromptInfo.prompt;\n" +
            f"{indent}if (seekdeepReplyPromptInfo.usedReplyContext) {{\n" +
            f"{indent}  console.log(`[SeekDeep] reply-context image prompt:\\n  reply: ${{seekdeepReplyPromptInfo.replyContext}}\\n  final: ${{prompt}}`);\n" +
            f"{indent}}}\n"
        )
        text = text[:start] + inject + text[end:]
        patched = True
        break
    if not patched:
        raise SystemExit("Could not locate prompt initialization inside messageCreate.")

# Improve generic image follow-up handling so a replied message like "Predator spyro"
# can flow through when the trigger message is only "generate".
if "function seekdeepIsGenericImageFollowupPrompt" in text:
    fn_start = text.find("function seekdeepIsGenericImageFollowupPrompt")
    snippet = text[fn_start: fn_start + 2500]
    if "seekdeepLooksLikeGenerateOnlyPrompt" not in snippet:
        # replace the first simple return false guard or the normalize line conservatively.
        snippet_new = snippet
        snippet_new = snippet_new.replace(
            "  const p = normalizeUserText(prompt).toLowerCase().trim();\n",
            "  const p = normalizeUserText(prompt).toLowerCase().trim();\n  if (seekdeepLooksLikeGenerateOnlyPrompt(p)) return true;\n",
            1,
        )
        if snippet_new == snippet:
            snippet_new = snippet_new.replace(
                "  if (!p) return false;\n",
                "  if (!p) return false;\n  if (seekdeepLooksLikeGenerateOnlyPrompt(p)) return true;\n",
                1,
            )
        text = text[:fn_start] + snippet_new + text[fn_start + len(snippet):]

# Validate important pieces.
for needle, label in [
    ("function seekdeepLooksLikeGenerateOnlyPrompt", "generate-only helper"),
    ("async function seekdeepResolveReplyContextText", "reply fetch helper"),
    ("async function seekdeepApplyReplyContextToPrompt", "reply apply helper"),
    ("seekdeepApplyReplyContextToPrompt(message, prompt)", "messageCreate reply-context hookup"),
    ("seekdeepEnqueueImageJob(job, runner)", "queue contract preserved"),
]:
    require_contains(text, needle, label)

out = text if newline == "\n" else text.replace("\n", "\r\n")
path.write_bytes(out.encode("utf-8"))
print("Patched reply-context image prompt handling.")