from pathlib import Path

p = Path("index.js")
text = p.read_text(encoding="utf-8")

def remove_js_function(src: str, name: str) -> str:
    patterns = [f"function {name}", f"async function {name}"]
    changed = True

    while changed:
        changed = False
        for marker in patterns:
            start = src.find(marker)
            if start == -1:
                continue

            brace = src.find("{", start)
            if brace == -1:
                continue

            depth = 0
            end = None
            i = brace
            in_string = None
            escape = False
            in_line_comment = False
            in_block_comment = False

            while i < len(src):
                ch = src[i]
                nxt = src[i + 1] if i + 1 < len(src) else ""

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

                if in_string:
                    if escape:
                        escape = False
                    elif ch == "\\":
                        escape = True
                    elif ch == in_string:
                        in_string = None
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

                if ch in ("'", '"', "`"):
                    in_string = ch
                    i += 1
                    continue

                if ch == "{":
                    depth += 1
                elif ch == "}":
                    depth -= 1
                    if depth == 0:
                        end = i + 1
                        break

                i += 1

            if end is None:
                continue

            while end < len(src) and src[end] in " \t\r\n":
                end += 1

            src = src[:start].rstrip() + "\n\n" + src[end:].lstrip()
            changed = True
            break

    return src

behavior_block = r'''
function getRecentContext(key) {
  const entries = (CHANNEL_MEMORY.get(key) || []).slice(-8);
  if (!entries.length) return '';

  return entries
    .map((m) => {
      const clean = String(m.text || '')
        .replace(/\nSources:\n[\s\S]*$/i, '')
        .slice(0, 900);
      return `${m.role === 'assistant' ? 'Assistant' : 'User'}: ${clean}`;
    })
    .join('\n');
}

function isLikelyFollowup(prompt) {
  const p = normalizeUserText(prompt).toLowerCase().trim();
  const words = p.split(/\s+/).filter(Boolean);

  if (!p) return false;
  if (words.length <= 2) return true;

  const explicitNewTopic = [
    /^what would be a .*nickname\b/,
    /^what is a .*nickname\b/,
    /^give me .*nickname\b/,
    /^name yourself\b/,
    /^what should i call you\b/,
    /^what can you do\b/,
    /^who are you\b/,
    /^are you online\b/,
    /^status\b/,
  ];

  if (explicitNewTopic.some((re) => re.test(p))) return false;

  const followupStarts = [
    'their ', 'its ', "it's ", 'it ', 'that ', 'this ', 'those ', 'these ',
    'same ', 'also ', 'again ', 'redo ', 'revise ', 'fix ', 'continue ',
    'what about ', 'how about ', 'you left ', 'you forgot ', 'add ',
    'is this ', 'are these ', 'then ', 'so ', 'use the internet',
    'look it up', 'you should have looked'
  ];

  if (followupStarts.some((s) => p.startsWith(s))) return true;

  const followupPhrases = [
    'you left out',
    'you forgot',
    'as i said',
    'like before',
    'from before',
    'the previous',
    'that answer',
    'this answer',
    'actually up to date',
    'use the internet to infer',
    'infer the correct answer',
    'should have looked it up',
    'looked it up',
    'try again',
  ];

  if (followupPhrases.some((s) => p.includes(s))) return true;

  return words.length <= 10 && /\b(it|that|this|their|they|them|those|these|previous|same)\b/.test(p);
}

function shouldUseMemory(prompt) {
  const p = normalizeUserText(prompt).toLowerCase().trim();
  if (!p) return false;

  const hardNewTopic = [
    /^what would be a .*nickname\b/,
    /^what is a .*nickname\b/,
    /^give me .*nickname\b/,
    /^what should i call you\b/,
    /^who are you\b/,
    /^what can you do\b/,
  ];

  if (hardNewTopic.some((re) => re.test(p))) return false;

  return isLikelyFollowup(p);
}

function isSubstantiveTopic(text) {
  const p = normalizeUserText(text).toLowerCase().trim();
  const words = p.split(/\s+/).filter(Boolean);

  if (words.length < 5) return false;
  if (/^(yes|no|ok|okay|thanks|thank you|lol|lmao|woza|hehe)\b/.test(p)) return false;
  if (/^(you should have looked|look it up|use the internet|try again)\b/.test(p)) return false;

  return true;
}

function getLastSubstantiveUserTopic(key) {
  const entries = CHANNEL_MEMORY.get(key) || [];

  for (let i = entries.length - 1; i >= 0; i--) {
    const item = entries[i];
    if (item.role === 'user' && isSubstantiveTopic(item.text)) {
      return item.text;
    }
  }

  return '';
}

function buildPromptWithMemory(prompt, key) {
  const cleanPrompt = normalizeUserText(prompt);
  const recent = getRecentContext(key);

  if (!recent || !shouldUseMemory(cleanPrompt)) return cleanPrompt;

  return [
    'Recent Discord context is provided only to resolve this follow-up.',
    'Use it only if it is directly relevant to the current user message.',
    'If the current user message has clearly changed topic, ignore old context.',
    'Do not prefix your answer with "SeekDeep:" or "Assistant:".',
    '',
    recent,
    '',
    `Current user message: ${cleanPrompt}`,
  ].join('\n');
}

function buildSearchQuery(prompt, key) {
  const cleanPrompt = normalizeUserText(prompt);
  const priorTopic = getLastSubstantiveUserTopic(key);
  const p = cleanPrompt.toLowerCase();

  const needsPriorTopic =
    priorTopic &&
    (
      isLikelyFollowup(cleanPrompt) ||
      p.includes('look it up') ||
      p.includes('use the internet') ||
      p.includes('actually up to date') ||
      p.includes('should have looked')
    );

  if (needsPriorTopic) {
    return `${priorTopic} ${cleanPrompt}`.replace(/\s+/g, ' ').trim();
  }

  return cleanPrompt;
}

function buildSystem(system = '', useWeb = false) {
  const base = [
    system || '',
    'You are SeekDeep, a local Discord assistant running privately for this server.',
    'Answer the current user message directly. Do not answer a stale previous topic unless the current message is clearly a follow-up.',
    'Do not prefix replies with "SeekDeep:" or "Assistant:".',
    'Do not moralize, lecture, or mention guidelines unless a brief refusal is truly necessary.',
    'Profanity, edgy jokes, adult-industry terminology, and non-graphic adult humor are allowed when no minors, coercion, exploitation, or nonconsensual content is involved.',
    'For allowed adult-adjacent requests, answer normally or steer to a non-graphic version. Do not give generic safety lectures.',
    'Refuse only clearly illegal, exploitative, nonconsensual, minor-related sexual content, direct harm instructions, credential theft, malware, or similar serious misuse.',
    'If the user asks for creative names, be quirky and specific instead of generic.',
  ];

  if (useWeb) {
    base.push(
      'When web search context is provided, synthesize it into a normal answer.',
      'Use the search results as evidence; do not merely list them.',
      'Do not explain what inference means unless the user is asking about inference as a topic.',
      'If a follow-up says to look something up, search the prior substantive topic, not the literal words "look it up".',
      'If search results are weak or irrelevant, say that and answer cautiously.'
    );
  }

  return base.filter(Boolean).join('\n');
}

function shouldAutoSearch(prompt) {
  const p = normalizeUserText(prompt).toLowerCase().trim();

  if (p.length < 4) return false;

  const directNoSearchPatterns = [
    /^are you online\b/,
    /^are you there\b/,
    /^hello\b/,
    /^hi\b/,
    /^hey\b/,
    /^what can you do\b/,
    /^who are you\b/,
    /^status\b/,
    /^what would be a .*nickname\b/,
    /^what should i call you\b/,
  ];

  if (directNoSearchPatterns.some((re) => re.test(p))) return false;

  const searchHints = [
    'latest', 'current', 'today', 'yesterday', 'tomorrow', 'this week',
    'news', 'recent', 'now', 'right now', 'update', 'price', 'release',
    'version', 'schedule', 'weather', 'stock', 'source', 'citation',
    'look up', 'look it up', 'search', 'internet', 'web', 'online', '2026',
    'up to date', 'is this actually'
  ];

  if (searchHints.some((hint) => p.includes(hint))) return true;

  if (/^what (is|are|was|were).+\bon about\b/.test(p)) return true;
  if (/^tell me about [a-z0-9 .'-]{4,}$/i.test(prompt)) return true;
  if (/^who is [a-z0-9 .'-]{4,}$/i.test(prompt)) return true;

  return false;
}

'''

# Remove/replace behavior functions.
for fn in [
    "getRecentContext",
    "isLikelyFollowup",
    "shouldUseMemory",
    "isSubstantiveTopic",
    "getLastSubstantiveUserTopic",
    "buildPromptWithMemory",
    "buildSearchQuery",
    "buildSystem",
    "shouldAutoSearch",
]:
    text = remove_js_function(text, fn)

insert_at = text.find("async function fetchJson")
if insert_at == -1:
    raise SystemExit("Could not find async function fetchJson insertion point.")

text = text[:insert_at].rstrip() + "\n\n" + behavior_block + "\n" + text[insert_at:].lstrip()

# Fix older syntax or helper recursion if present.
text = text.replace(
    "async function askVisionasync function askVision",
    "async function askVision"
)

# Remove broken helper versions, insert clean safe helpers.
text = remove_js_function(text, "safeDefer")
text = remove_js_function(text, "safeEditOrReply")

safe_helpers = r'''
async function safeDefer(interaction) {
  try {
    if (!interaction) return false;

    if (typeof interaction.isRepliable === 'function' && !interaction.isRepliable()) {
      return false;
    }

    if (interaction.deferred || interaction.replied) {
      return true;
    }

    await interaction.deferReply();
    return true;
  } catch (err) {
    console.error('Could not defer interaction. It may have expired before acknowledgement:', err);
    return false;
  }
}

async function safeEditOrReply(interaction, payload) {
  try {
    if (!interaction) return null;

    if (interaction.deferred || interaction.replied) {
      return await interaction.editReply(payload);
    }

    return await interaction.reply(payload);
  } catch (err) {
    console.error('Could not send interaction response:', err);
    return null;
  }
}

'''

# Replace interaction methods before inserting helpers, so helper code is not modified.
text = text.replace("await interaction.deferReply();", "if (!(await safeDefer(interaction))) return;")
text = text.replace("await interaction.editReply(", "await safeEditOrReply(interaction, ")

interaction_at = text.find("client.on('interactionCreate'")
if interaction_at == -1:
    interaction_at = text.find('client.on("interactionCreate"')
if interaction_at == -1:
    raise SystemExit("Could not find interactionCreate insertion point.")

text = text[:interaction_at].rstrip() + "\n\n" + safe_helpers + "\n" + text[interaction_at:].lstrip()

# Update Discord.js ready event if needed.
text = text.replace("client.once('ready', async () => {", "client.once('clientReady', async () => {")
text = text.replace('client.once("ready", async () => {', 'client.once("clientReady", async () => {')

# Verify recursion is gone.
safe_start = text.find("async function safeDefer(interaction)")
safe_end = text.find("async function safeEditOrReply(interaction", safe_start)
if safe_start == -1 or safe_end == -1:
    raise SystemExit("safe helper insertion failed.")
if "await safeDefer(interaction)" in text[safe_start:safe_end]:
    raise SystemExit("Patch failed: safeDefer still calls itself.")

edit_start = safe_end
edit_end = text.find("client.on('interactionCreate'", edit_start)
if edit_end == -1:
    edit_end = text.find('client.on("interactionCreate"', edit_start)
if "await safeEditOrReply(interaction" in text[edit_start:edit_end]:
    raise SystemExit("Patch failed: safeEditOrReply still calls itself.")

required = [
    "function shouldUseMemory",
    "Do not moralize, lecture",
    "non-graphic adult humor are allowed",
    "function buildSearchQuery",
    "async function safeDefer",
]
missing = [x for x in required if x not in text]
if missing:
    raise SystemExit("Patch failed; missing markers: " + ", ".join(missing))

p.write_text(text, encoding="utf-8")
print("index.js behavior routing, context gating, web query routing, and safe interaction helpers patched.")
