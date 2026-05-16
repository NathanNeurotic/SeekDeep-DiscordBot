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

def replace_js_function(src: str, name: str, replacement: str) -> str:
    patterns = [f"function {name}", f"async function {name}"]

    start = -1
    for marker in patterns:
        pos = src.find(marker)
        if pos != -1 and (start == -1 or pos < start):
            start = pos

    if start == -1:
        raise SystemExit(f"Could not find function {name}.")

    brace = src.find("{", start)
    if brace == -1:
        raise SystemExit(f"Could not find opening brace for {name}.")

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
        raise SystemExit(f"Could not find end of function {name}.")

    while end < len(src) and src[end] in " \t\r\n":
        end += 1

    return src[:start].rstrip() + "\n\n" + replacement.rstrip() + "\n\n" + src[end:].lstrip()

new_is_substantive = r'''function isSubstantiveTopic(text) {
  const p = normalizeUserText(text).toLowerCase().trim();
  const words = p.split(/\s+/).filter(Boolean);

  if (words.length < 4) return false;

  if (/^(yes|no|ok|okay|thanks|thank you|lol|lmao|woza|hehe|nice|cool|based|same|again)\b/.test(p)) return false;
  if (/^(you should have looked|look it up|use the internet|search it|google it|try again|redo|fix it)\b/.test(p)) return false;
  if (/^(are you online|are you there|hello|hi|hey|status)\b/.test(p)) return false;

  if (typeof isBotIdentityQuestion === 'function' && isBotIdentityQuestion(p)) return false;

  return true;
}'''

new_build_search = r'''function buildSearchQuery(prompt, key) {
  const cleanPrompt = normalizeUserText(prompt);
  const p = cleanPrompt.toLowerCase().trim();
  const priorTopic = key ? getLastSubstantiveUserTopic(key) : '';

  const followupNeedsPrior =
    priorTopic &&
    (
      isLikelyFollowup(cleanPrompt) ||
      /\b(look it up|search it|google it|use the internet|use web|web search|check online|actually up to date|up to date|current|latest|source|sources|verify|fact check|fact-check|should have looked)\b/i.test(p)
    );

  if (followupNeedsPrior) {
    let query = `${priorTopic} ${cleanPrompt}`;

    query = query
      .replace(/\b(you should have|should have|please|can you|could you|would you|use the internet to|use the internet|use web|web search|look it up|search it|google it|infer|the correct answer|if you don't know)\b/gi, ' ')
      .replace(/\s+/g, ' ')
      .trim();

    return query || priorTopic;
  }

  return cleanPrompt;
}'''

new_should_auto = r'''function shouldAutoSearch(prompt) {
  const p = normalizeUserText(prompt).toLowerCase().trim();

  if (p.length < 4) return false;

  if (typeof isBotIdentityQuestion === 'function' && isBotIdentityQuestion(p)) return false;

  const noSearchPatterns = [
    /^are you online\b/,
    /^are you there\b/,
    /^hello\b/,
    /^hi\b/,
    /^hey\b/,
    /^status\b/,
    /^what can you do\b/,
    /^what are your capabilities\b/,
    /^who are you\b/,
    /^what are you\b/,
    /^tell me about (yourself|you|the bot|plugtalk|seekdeep)\b/,
    /^what would be a .*nickname\b/,
    /^what should i call you\b/,
    /^give me .*nickname\b/,
    /^make up .*name/,
    /^brainstorm\b/,
    /^write\b/,
    /^rewrite\b/,
    /^refine\b/,
    /^improve this prompt\b/,
    /^make this prompt\b/,
    /^give me a prompt\b/,
    /^generate a prompt\b/,
    /^make a joke\b/,
    /^tell me a joke\b/,
  ];

  if (noSearchPatterns.some((re) => re.test(p))) return false;

  const explicitSearch = [
    'look up',
    'look it up',
    'search',
    'google',
    'use the internet',
    'use web',
    'web search',
    'check online',
    'sources',
    'source this',
    'cite',
    'citation',
    'verify',
    'fact check',
    'fact-check',
  ];

  if (explicitSearch.some((hint) => p.includes(hint))) return true;

  const currentInfoHints = [
    'latest',
    'current',
    'currently',
    'today',
    'yesterday',
    'tomorrow',
    'this week',
    'this month',
    'right now',
    'recent',
    'newest',
    'up to date',
    'still true',
    'as of',
    'may 2026',
    '2026',
  ];

  if (currentInfoHints.some((hint) => p.includes(hint))) return true;

  const highChangeTopics = [
    'news',
    'price',
    'prices',
    'cost',
    'release date',
    'released',
    'version',
    'update',
    'patch notes',
    'changelog',
    'schedule',
    'weather',
    'stock',
    'crypto',
    'law',
    'legal',
    'rules',
    'policy',
    'election',
    'president',
    'ceo',
    'rankings',
    'ranking',
    'top vpn',
    'best vpn',
    'best ai',
    'best model',
    'best gpu',
    'driver',
    'windows update',
    'github action',
    'docker',
    'npm',
    'pip',
    'python package',
    'hugging face',
  ];

  if (highChangeTopics.some((hint) => p.includes(hint))) return true;

  // Public/living-figure style questions often need current context.
  if (/^what (is|are|was|were).+\bon about\b/i.test(prompt)) return true;
  if (/^who is [a-z0-9 .'-]{4,}$/i.test(prompt)) return true;
  if (/^what happened (with|to) [a-z0-9 .'-]{4,}$/i.test(prompt)) return true;
  if (/^tell me about [A-Z][A-Za-z0-9 .'-]{3,}$/i.test(prompt)) return true;

  return false;
}'''

text = replace_js_function(text, "isSubstantiveTopic", new_is_substantive)
text = replace_js_function(text, "buildSearchQuery", new_build_search)
text = replace_js_function(text, "shouldAutoSearch", new_should_auto)

# Improve web-system instruction inside buildSystem if anchor exists.
if "When web search context is provided, synthesize it into a normal answer." in text and "Web routing rule: if search was triggered by a follow-up" not in text:
    text = text.replace(
        "'When web search context is provided, synthesize it into a normal answer.',",
        "'When web search context is provided, synthesize it into a normal answer.',\n      'Web routing rule: if search was triggered by a follow-up, answer the underlying prior topic, not the literal follow-up phrase.',",
        1,
    )

required = [
    "function buildSearchQuery",
    "followupNeedsPrior",
    "function shouldAutoSearch",
    "explicitSearch",
    "currentInfoHints",
    "highChangeTopics",
    "top vpn",
]

missing = [item for item in required if item not in text]
if missing:
    raise SystemExit("Patch failed; missing markers: " + ", ".join(missing))

# Sanity checks.
if re.search(r"(?m)^\s*async\s*$", text):
    raise SystemExit("Standalone async line still exists.")

bad_join = re.search(r"\.join\(['\"]\s*\r?\n\s*['\"]\)", text)
if bad_join:
    raise SystemExit("Malformed multiline .join string still exists.")

p.write_text(text, encoding="utf-8")
print("Web inference router v2 patched.")
