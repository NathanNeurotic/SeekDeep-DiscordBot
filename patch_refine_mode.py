from pathlib import Path
import re

p = Path("index.js")
text = p.read_text(encoding="utf-8")

# Clean known previous patch damage.
text = re.sub(r"(?m)^\s*async\s*$\r?\n?", "", text)
text = text.replace(
    "async function askVisionasync function askVision",
    "async function askVision"
)

def remove_js_function(src: str, name: str) -> str:
    patterns = [f"async function {name}", f"function {name}"]
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

def replace_js_block(src: str, start_phrase: str, replacement: str) -> str:
    start = src.find(start_phrase)
    if start == -1:
        raise SystemExit(f"Could not find block start: {start_phrase}")

    brace = src.find("{", start)
    if brace == -1:
        raise SystemExit("Could not find opening brace for block.")

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
        raise SystemExit("Could not find block end.")

    return src[:start] + replacement.rstrip() + src[end:]

# Remove old/re-run helper blocks and conflicting helpers.
text = re.sub(
    r"(?ms)\n*// SEEKDEEP_REFINE_MODE_START.*?// SEEKDEEP_REFINE_MODE_END\n*",
    "\n\n",
    text,
)

for fn in [
    "refineExplicitlyRequestsWeb",
    "detectTargetCharacters",
    "maxTokensForRefine",
    "buildRefineUserPrompt",
    "stripRefineSources",
    "sentenceKey",
    "removeRepeatedSentences",
    "cleanupRefinedPrompt",
    "hasRefineRepetitionIssue",
    "splitDiscordText",
    "sendLongInteractionReply",
]:
    text = remove_js_function(text, fn)

# Remove duplicate REFINE_SYSTEM_PROMPT if it exists outside the marker block.
text = re.sub(
    r"(?ms)\n*const REFINE_SYSTEM_PROMPT\s*=\s*\[.*?\]\.join\('\\n'\);\n*",
    "\n",
    text,
)

refine_helpers = r'''
// SEEKDEEP_REFINE_MODE_START
const REFINE_SYSTEM_PROMPT = [
  'You are SeekDeep dedicated prompt-refinement mode.',
  'Return only the rewritten prompt unless the user explicitly asks for notes.',
  'Preserve the user subject, mood, details, constraints, negatives, intended use, and requested length.',
  'Expand with concrete, distinct, prompt-useful detail instead of filler.',
  'Do not repeat sentences, paragraph structures, or near-identical ideas.',
  'Do not pad with generic phrases such as "magic and wonder", "tranquility and peace", or similar filler loops.',
  'Do not turn the prompt into an article, sales pitch, essay, or travel brochure unless asked.',
  'Do not add citations, sources, links, or web context unless the user explicitly requested research or factual accuracy.',
  'If a target length is requested, reach it through distinct categories: setting, atmosphere, lighting, palette, texture, foreground, midground, background, composition, motion, sensory details, style, constraints, and negative prompt details.',
  'Every paragraph must introduce new information.',
  'Before finalizing, remove duplicated sentences and repeated phrasing.',
].join('\n');

function refineExplicitlyRequestsWeb(prompt) {
  return /\b(research|look up|lookup|web|internet|current|latest|today|2026|cite|citation|sources|fact[- ]?check|historically accurate|real[- ]world accurate)\b/i.test(String(prompt || ''));
}

function detectTargetCharacters(prompt) {
  const text = String(prompt || '');
  const matches = [...text.matchAll(/(\d{1,3}(?:,\d{3})+|\d{3,6})\s*(?:characters|character|chars|char)\b/gi)];
  if (!matches.length) return 0;

  const raw = matches[matches.length - 1][1].replace(/,/g, '');
  const value = Number(raw);

  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(value, 12000));
}

function maxTokensForRefine(prompt) {
  const target = detectTargetCharacters(prompt);
  const configured = Number(process.env.REFINE_MAX_NEW_TOKENS || 0);

  if (configured > 0) return Math.max(500, Math.min(configured, 4096));
  if (target >= 1000) return Math.max(900, Math.min(Math.ceil(target / 2.4) + 400, 4096));

  return 1400;
}

function buildRefineUserPrompt(prompt, key = null) {
  const clean = normalizeUserText(prompt);
  const target = detectTargetCharacters(clean);
  const recent = key && shouldUseMemory(clean) ? getRecentContext(key) : '';

  const parts = [
    'Rewrite and improve the following prompt.',
    'The output must be a finished prompt the user can copy and use directly.',
    'Do not include analysis, sources, commentary, or a title unless the user requested that.',
    'Preserve all concrete details already present.',
    'Add new detail by category, not by repeating the same idea.',
    'Avoid repetition aggressively.',
  ];

  if (target) {
    parts.push(`Target length: approximately ${target.toLocaleString()} characters. Do not meet this by looping or repeating phrases.`);
  }

  if (recent) {
    parts.push('', 'Recent context for resolving this refinement only:', recent);
  }

  parts.push('', 'Original prompt/request:', clean);
  return parts.join('\n');
}

function stripRefineSources(text) {
  return String(text || '').replace(/\n\s*Sources:\s*\n[\s\S]*$/i, '').trim();
}

function sentenceKey(sentence) {
  return String(sentence || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function removeRepeatedSentences(text) {
  const raw = String(text || '').trim();
  if (!raw) return '';

  const pieces = raw.split(/(?<=[.!?])\s+/);
  const seen = new Set();
  const kept = [];

  for (const piece of pieces) {
    const trimmed = piece.trim();
    if (!trimmed) continue;

    const key = sentenceKey(trimmed);
    if (key.length > 24 && seen.has(key)) continue;
    if (key.length > 24) seen.add(key);

    kept.push(trimmed);
  }

  return kept.join(' ').replace(/\n{3,}/g, '\n\n').trim();
}

function cleanupRefinedPrompt(text) {
  let out = stripRefineSources(text);

  out = out.replace(/^\s*(refined prompt|improved prompt|rewritten prompt)\s*:\s*/i, '');
  out = out.replace(/^\s*```(?:text|prompt|markdown)?\s*/i, '');
  out = out.replace(/\s*```\s*$/i, '');
  out = removeRepeatedSentences(out);

  return out.trim();
}

function hasRefineRepetitionIssue(text) {
  const words = String(text || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(Boolean);

  if (words.length < 80) return false;

  const counts = new Map();

  for (let i = 0; i <= words.length - 5; i++) {
    const key = words.slice(i, i + 5).join(' ');
    counts.set(key, (counts.get(key) || 0) + 1);

    if (counts.get(key) >= 4) return true;
  }

  const sentences = String(text || '')
    .split(/(?<=[.!?])\s+/)
    .map(sentenceKey)
    .filter((s) => s.length > 24);

  const unique = new Set(sentences);
  return sentences.length >= 6 && unique.size / sentences.length < 0.72;
}

function splitDiscordText(value, limit = MAX_DISCORD_CHARS) {
  const raw = String(value ?? '').replace(/\r\n/g, '\n').trimEnd();
  if (!raw) return [''];

  const chunks = [];
  let remaining = raw;

  while (remaining.length > limit) {
    let cut = -1;

    for (const token of ['\n\n', '\n', '. ', '; ', ', ', ' ']) {
      const pos = remaining.lastIndexOf(token, limit);

      if (pos >= Math.floor(limit * 0.45)) {
        cut = pos + (token.trim() ? token.length : 0);
        break;
      }
    }

    if (cut < Math.floor(limit * 0.45)) cut = limit;

    chunks.push(remaining.slice(0, cut).trimEnd());
    remaining = remaining.slice(cut).trimStart();
  }

  if (remaining) chunks.push(remaining);
  return chunks.length ? chunks : [''];
}

async function sendLongInteractionReply(interaction, content) {
  const chunks = splitDiscordText(content);
  let previous = null;

  for (let i = 0; i < chunks.length; i++) {
    const payload = {
      content: chunks[i],
      allowedMentions: { repliedUser: false },
    };

    if (i === 0) {
      previous = await safeEditOrReply(interaction, payload);

      if (!previous && typeof interaction.fetchReply === 'function') {
        previous = await interaction.fetchReply().catch(() => null);
      }

      continue;
    }

    if (previous && typeof previous.reply === 'function') {
      previous = await previous.reply(payload);
    } else if (interaction.channel && typeof interaction.channel.send === 'function') {
      previous = await interaction.channel.send(payload);
    } else {
      console.error('Could not send follow-up chunk; no previous message or channel is available.');
      break;
    }
  }

  return previous;
}
// SEEKDEEP_REFINE_MODE_END
'''

marker = "const MAX_DISCORD_CHARS = Number(process.env.MAX_DISCORD_CHARS || 1900);"
if marker not in text:
    raise SystemExit("Could not find MAX_DISCORD_CHARS marker.")

text = text.replace(marker, marker + "\n" + refine_helpers, 1)

new_refine_block = r'''if (interaction.commandName === 'refine') {
      if (!(await safeDefer(interaction))) return;

      const prompt = normalizeUserText(interaction.options.getString('prompt', true));
      const key = memoryKeyFrom(interaction);
      const refineInput = buildRefineUserPrompt(prompt, key);
      const web = refineExplicitlyRequestsWeb(prompt) ? 'always' : 'off';
      const maxNewTokens = maxTokensForRefine(prompt);
      const temperature = Number(process.env.REFINE_TEMPERATURE || 0.72);

      let answer = await askChat(refineInput, {
        web,
        system: REFINE_SYSTEM_PROMPT,
        maxNewTokens,
        temperature,
        memoryKey: null,
      });

      answer = cleanupRefinedPrompt(answer);

      if (hasRefineRepetitionIssue(answer)) {
        const retryInput = [
          refineInput,
          '',
          'The previous draft repeated itself. Regenerate once. Every sentence must add new information. Do not reuse paragraph structures or repeated mystical/filler phrasing.',
        ].join('\n');

        answer = await askChat(retryInput, {
          web: 'off',
          system: REFINE_SYSTEM_PROMPT,
          maxNewTokens,
          temperature: Math.max(temperature, 0.8),
          memoryKey: null,
        });

        answer = cleanupRefinedPrompt(answer);
      }

      remember(key, 'user', prompt);
      remember(key, 'assistant', answer);
      await sendLongInteractionReply(interaction, answer);
      return;
    }'''

text = replace_js_block(text, "if (interaction.commandName === 'refine')", new_refine_block)

# Verify no known syntax-corrupting artifacts remain.
if re.search(r"(?m)^\s*async\s*$", text):
    raise SystemExit("Standalone async line still exists.")

bad_join = re.search(r"\.join\(['\"]\s*\r?\n\s*['\"]\)", text)
if bad_join:
    raise SystemExit("Malformed multiline .join string still exists.")

required = [
    "REFINE_SYSTEM_PROMPT",
    "buildRefineUserPrompt",
    "cleanupRefinedPrompt",
    "hasRefineRepetitionIssue",
    "sendLongInteractionReply",
    "Every paragraph must introduce new information",
    "await sendLongInteractionReply(interaction, answer);",
]
missing = [x for x in required if x not in text]
if missing:
    raise SystemExit("Patch failed; missing markers: " + ", ".join(missing))

p.write_text(text, encoding="utf-8")
print("SeekDeep /refine mode patched.")
