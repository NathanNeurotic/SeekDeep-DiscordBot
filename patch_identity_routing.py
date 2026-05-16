from pathlib import Path
import re

p = Path("index.js")
text = p.read_text(encoding="utf-8")

# Clean known previous patch damage if still present.
text = re.sub(r"(?m)^\s*async\s*$\r?\n?", "", text)
text = text.replace(
    "async function askVisionasync function askVision",
    "async function askVision"
)

# Add bot-identity helper functions once.
identity_helpers = r'''
// SEEKDEEP_IDENTITY_ROUTING_START
function isBotIdentityQuestion(prompt) {
  const p = normalizeUserText(prompt).toLowerCase().trim();

  return (
    /^tell me about (yourself|you|the bot|plugtalk|seekdeep)\b/.test(p) ||
    /^who are you\b/.test(p) ||
    /^what are you\b/.test(p) ||
    /^introduce yourself\b/.test(p) ||
    /^describe yourself\b/.test(p) ||
    /^what kind of bot are you\b/.test(p) ||
    /^what can you do\b/.test(p) ||
    /^what are your capabilities\b/.test(p) ||
    /^what all can you do\b/.test(p)
  );
}

function botIdentityAnswer(botName = 'SeekDeep') {
  return [
    `I’m ${botName}: a local Discord AI wired into this server, running through Nathan’s own machine instead of a paid hosted chat API.`,
    '',
    'Current shape:',
    '- Local chat through the NVIDIA Nemotron Nano 8B model.',
    '- Local vision through Qwen2.5-VL for images, screenshots, and sampled video frames.',
    '- Local image generation through Sana Sprint.',
    '- Web lookup through local SearXNG when a question actually needs current information.',
    '- Offline model loading once the models are cached.',
    '',
    'Personality-wise, I’m supposed to be sharper than a generic helper bot: colder, more observant, slightly neurotic, and less padded with corporate politeness.',
    '',
    'Weak spots: I’m still being tuned. Bad routing can make me search when I should answer directly, or drag old context into new questions. That is exactly the kind of defect we are cutting out.'
  ].join('\n');
}
// SEEKDEEP_IDENTITY_ROUTING_END

'''

if "SEEKDEEP_IDENTITY_ROUTING_START" not in text:
    marker = "async function fetchJson"
    pos = text.find(marker)
    if pos == -1:
        marker = "function shouldAutoSearch"
        pos = text.find(marker)
    if pos == -1:
        raise SystemExit("Could not find insertion point for identity helpers.")

    text = text[:pos].rstrip() + "\n\n" + identity_helpers + text[pos:].lstrip()

# Make shouldAutoSearch refuse self/bot identity questions.
if "function shouldAutoSearch" not in text:
    raise SystemExit("Could not find function shouldAutoSearch().")

if "if (isBotIdentityQuestion(prompt)) return false;" not in text:
    text = text.replace(
        "function shouldAutoSearch(prompt) {",
        "function shouldAutoSearch(prompt) {\n  if (isBotIdentityQuestion(prompt)) return false;",
        1,
    )

# Protect against broad tell-me-about auto-search catching "yourself".
old_tell_me = "if (/^tell me about [a-z0-9 .'-]{4,}$/i.test(prompt)) return true;"
new_tell_me = """if (/^tell me about (yourself|you|the bot|plugtalk|seekdeep)\\b/i.test(prompt)) return false;
  if (/^tell me about [a-z0-9 .'-]{4,}$/i.test(prompt)) return true;"""

if old_tell_me in text and new_tell_me not in text:
    text = text.replace(old_tell_me, new_tell_me, 1)

# Make buildSystem explicitly handle identity questions as bot identity, not interview advice.
identity_system_line = "'If the user asks “tell me about yourself”, “who are you”, or similar, answer as this Discord bot. Do not give interview coaching or generic human résumé advice.',"

if identity_system_line not in text:
    anchor_options = [
        "'Answer the current user message directly. If the topic changed, drop old context.',",
        "'Answer the current user message directly. Do not answer a stale previous topic unless the current message is clearly a follow-up.',",
    ]

    inserted = False
    for anchor in anchor_options:
        if anchor in text:
            text = text.replace(anchor, anchor + "\n      " + identity_system_line, 1)
            inserted = True
            break

    if not inserted:
        raise SystemExit("Could not find buildSystem anchor for identity instruction.")

# Insert direct identity response in messageCreate handler if possible.
# This prevents the local model from misreading the phrase as interview advice.
if "botIdentityAnswer(message.client?.user?.username" not in text:
    patterns = [
        "const prompt = normalizeUserText(content);",
        "const prompt = normalizeUserText(message.content",
        "const prompt = normalizeUserText(raw",
    ]

    inserted = False
    for pat in patterns:
        pos = text.find(pat)
        if pos == -1:
            continue

        line_end = text.find("\n", pos)
        if line_end == -1:
            continue

        injection = r'''

  if (isBotIdentityQuestion(prompt)) {
    const key = memoryKeyFrom(message);
    const answer = botIdentityAnswer(message.client?.user?.username || 'SeekDeep');
    remember(key, 'user', prompt);
    remember(key, 'assistant', answer);

    if (typeof sendLongMessageReply === 'function') {
      await sendLongMessageReply(message, answer);
    } else {
      await message.reply({ content: answer, allowedMentions: { repliedUser: false } });
    }

    return;
  }
'''
        text = text[:line_end + 1] + injection + text[line_end + 1:]
        inserted = True
        break

    if not inserted:
        # Do not fail the whole patch. shouldAutoSearch + buildSystem still fix slash /ask.
        print("Warning: could not insert direct message identity response; patched web routing and system prompt only.")

required = [
    "function isBotIdentityQuestion",
    "function botIdentityAnswer",
    "if (isBotIdentityQuestion(prompt)) return false;",
    "Do not give interview coaching",
]

missing = [item for item in required if item not in text]
if missing:
    raise SystemExit("Patch failed; missing markers: " + ", ".join(missing))

# Sanity checks for prior syntax-breaking artifacts.
if re.search(r"(?m)^\\s*async\\s*$", text):
    raise SystemExit("Standalone async line still exists.")

bad_join = re.search(r"\\.join\\(['\"]\\s*\\r?\\n\\s*['\"]\\)", text)
if bad_join:
    raise SystemExit("Malformed multiline .join string still exists.")

p.write_text(text, encoding="utf-8")
print("Bot identity routing patched.")
