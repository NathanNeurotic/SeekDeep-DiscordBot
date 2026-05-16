from pathlib import Path
from datetime import datetime
import re

ROOT = Path(".")
index_path = ROOT / "index.js"
server_path = ROOT / "local_ai_server.py"
env_path = ROOT / ".env"

stamp = datetime.now().strftime("%Y%m%d-%H%M%S")

def backup(path: Path):
    if path.exists():
        b = path.with_name(path.name + f".bak-anti-loop-repair-{stamp}")
        b.write_text(path.read_text(encoding="utf-8"), encoding="utf-8")
        print(f"[backup] {b}")

backup(index_path)
backup(server_path)
backup(env_path)

# ------------------------------------------------------------
# 1. Repair index.js helper functions.
# ------------------------------------------------------------
js = index_path.read_text(encoding="utf-8")

helper = r'''
// SEEKDEEP_ANTI_LOOP_HELPERS_START
function cleanupAssistantReply(value) {
  let text = stripQwenThinkingBlocks(value);
  text = String(text ?? '').replace(/\r\n/g, '\n');

  text = text.replace(/^\s*assistant\s*:\s*/i, '');
  text = text.replace(/^\s*final answer\s*:\s*/i, '');
  text = text.replace(/<\/?think>/gi, '');
  text = text.replace(/\n{3,}/g, '\n\n');

  return text.trim();
}

function seekdeepNormalizeLoopLine(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/^[\s>*#\-\d.)\]]+/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function seekdeepTrimRepeatingTail(text) {
  const raw = String(text || '').trim();
  if (!raw) return '';

  const words = raw.split(/\s+/);
  if (words.length < 48) return raw;

  for (let size = 4; size <= 24; size++) {
    for (let i = 0; i <= words.length - size * 3; i++) {
      const a = words.slice(i, i + size).join(' ').toLowerCase();
      const b = words.slice(i + size, i + size * 2).join(' ').toLowerCase();
      const c = words.slice(i + size * 2, i + size * 3).join(' ').toLowerCase();

      if (a === b && b === c) {
        return words.slice(0, i + size).join(' ').trim() + '\n\n[loop trimmed]';
      }
    }
  }

  return raw;
}

function seekdeepDedupeLines(text) {
  const raw = String(text || '').trim();
  if (!raw) return '';

  const lines = raw.split(/\n+/).map((x) => x.trim()).filter(Boolean);
  if (lines.length < 2) return raw;

  const seen = new Set();
  const kept = [];

  for (const line of lines) {
    const key = seekdeepNormalizeLoopLine(line);

    if (key.length > 12 && seen.has(key)) {
      continue;
    }

    if (key.length > 12) seen.add(key);
    kept.push(line);
  }

  return kept.join('\n').trim();
}

function hasLoopingOrBrokenReply(value) {
  const text = cleanupAssistantReply(value);

  if (!text) return true;
  if (/^\(empty response\)$/i.test(text)) return true;
  if (/^\[seekdeep generated an empty response/i.test(text)) return true;
  if (/\[loop trimmed\]/i.test(text)) return true;

  const normalizedText = seekdeepNormalizeLoopLine(text);

  if (/\b(\w+)(?:\s+\1){8,}\b/i.test(normalizedText)) return true;

  const lines = text
    .split(/\n+/)
    .map((x) => seekdeepNormalizeLoopLine(x))
    .filter((x) => x.length > 10);

  if (lines.length >= 8) {
    const uniqueRatio = new Set(lines).size / lines.length;
    if (uniqueRatio < 0.72) return true;
  }

  const words = normalizedText.split(/\s+/).filter(Boolean);

  if (words.length >= 60) {
    const counts = new Map();

    for (let i = 0; i <= words.length - 6; i++) {
      const key = words.slice(i, i + 6).join(' ');
      const count = (counts.get(key) || 0) + 1;
      counts.set(key, count);

      if (count >= 3) return true;
    }
  }

  return false;
}

function cleanLoopingReply(value) {
  let text = cleanupAssistantReply(value);
  text = seekdeepTrimRepeatingTail(text);
  text = seekdeepDedupeLines(text);
  text = text.replace(/\b(\w{3,})\b(?:[\s,;:.-]+\1\b){2,}/gi, '$1 [repetition trimmed]');
  text = text.replace(/\n{3,}/g, '\n\n').trim();

  return text;
}

function buildAntiLoopSystem(system, useWeb) {
  return [
    buildSystem(system, useWeb),
    '',
    'Anti-loop override:',
    '- Output only the final answer.',
    '- Do not emit <think> tags, hidden reasoning, self-commentary, or scratchpad text.',
    '- Do not repeat lines, sentence openings, list prefixes, phrases, or paragraph structures.',
    '- If a list is requested, every item must be distinct.',
    '- If you begin looping, stop immediately and end the answer cleanly.'
  ].join('\n');
}
// SEEKDEEP_ANTI_LOOP_HELPERS_END
'''

if "SEEKDEEP_ANTI_LOOP_HELPERS_START" in js:
    start = js.find("// SEEKDEEP_ANTI_LOOP_HELPERS_START")
    end = js.find("// SEEKDEEP_ANTI_LOOP_HELPERS_END", start)
    if end == -1:
        raise SystemExit("Found anti-loop helper start marker but no end marker.")
    end += len("// SEEKDEEP_ANTI_LOOP_HELPERS_END")
    js = js[:start] + helper.strip() + js[end:]
    print("[index] Replaced existing anti-loop helpers.")
elif "function cleanupAssistantReply(" not in js:
    anchors = [
        "async function runLocalChat(",
        "async function askChat(",
        "async function sendLongMessageReply(",
    ]

    inserted = False
    for anchor in anchors:
        pos = js.find(anchor)
        if pos != -1:
            js = js[:pos] + helper.strip() + "\n\n" + js[pos:]
            print(f"[index] Inserted anti-loop helpers before {anchor}")
            inserted = True
            break

    if not inserted:
        raise SystemExit("Could not find a safe insertion point for anti-loop helpers.")
else:
    print("[index] cleanupAssistantReply already exists.")

# Ensure sendLongMessageReply uses cleanup, not only think-strip.
js = js.replace(
    "content = stripQwenThinkingBlocks(content);",
    "content = cleanLoopingReply(content);"
)

# ------------------------------------------------------------
# 2. Ensure askChat has retry wrapper if previous patch failed.
# ------------------------------------------------------------
def find_function_range(src: str, name: str):
    needle = f"async function {name}"
    start = src.find(needle)
    if start == -1:
        return None

    brace = src.find("{", start)
    if brace == -1:
        raise SystemExit(f"Could not find opening brace for {name}")

    depth = 0
    in_str = None
    esc = False
    line_comment = False
    block_comment = False

    i = brace
    while i < len(src):
        ch = src[i]
        nxt = src[i + 1] if i + 1 < len(src) else ""

        if line_comment:
            if ch == "\n":
                line_comment = False
            i += 1
            continue

        if block_comment:
            if ch == "*" and nxt == "/":
                block_comment = False
                i += 2
                continue
            i += 1
            continue

        if in_str:
            if esc:
                esc = False
            elif ch == "\\":
                esc = True
            elif ch == in_str:
                in_str = None
            i += 1
            continue

        if ch == "/" and nxt == "/":
            line_comment = True
            i += 2
            continue

        if ch == "/" and nxt == "*":
            block_comment = True
            i += 2
            continue

        if ch in ("'", '"', "`"):
            in_str = ch
            i += 1
            continue

        if ch == "{":
            depth += 1
        elif ch == "}":
            depth -= 1
            if depth == 0:
                return start, i + 1

        i += 1

    raise SystemExit(f"Could not find closing brace for {name}")

run_local = r'''
async function runLocalChat(prompt, systemText, context, maxNewTokens, temperature) {
  const response = await postLocal('/chat', {
    prompt,
    system: systemText,
    context,
    max_new_tokens: maxNewTokens,
    temperature,
  });

  return cleanLoopingReply(response.text || '');
}
'''

ask_chat = r'''
async function askChat(prompt, { web = 'auto', system = '', maxNewTokens = Number(process.env.CHAT_MAX_NEW_TOKENS || 1400), temperature = 0.35, memoryKey = null } = {}) {
  const cleanPrompt = normalizeUserText(prompt);
  const promptForModel = memoryKey ? buildPromptWithMemory(cleanPrompt, memoryKey) : cleanPrompt;
  const searchQuery = memoryKey ? buildSearchQuery(cleanPrompt, memoryKey) : cleanPrompt;

  let context = '';
  let sources = [];

  const useWeb = web === 'always' || (web === 'auto' && shouldAutoSearch(cleanPrompt));
  if (useWeb) {
    try {
      const search = await searchWeb(searchQuery);
      context = search.context;
      sources = search.sources;
    } catch (err) {
      if (web === 'always') {
        context = `Web search was requested, but SearXNG failed: ${err.message}`;
      }
    }
  }

  let answer = await runLocalChat(
    promptForModel,
    buildSystem(system, useWeb),
    context,
    maxNewTokens,
    temperature
  );

  if (hasLoopingOrBrokenReply(answer)) {
    const retryPrompt = [
      promptForModel,
      '',
      'Important: provide only the final answer. No hidden reasoning. No repetition. Every sentence must add new information.'
    ].join('\n');

    answer = await runLocalChat(
      retryPrompt,
      buildAntiLoopSystem(system, useWeb),
      context,
      Math.min(maxNewTokens, 900),
      Number(process.env.CHAT_ANTI_LOOP_TEMPERATURE || 0.2)
    );
  }

  answer = cleanLoopingReply(answer);

  if (hasLoopingOrBrokenReply(answer)) {
    answer = 'I hit a generation loop and discarded it. Ask again with tighter wording and I should behave.';
  }

  return `${answer}${formatSources(sources)}`.trim();
}
'''

if "async function runLocalChat(" not in js:
    rng = find_function_range(js, "askChat")
    if rng is None:
        raise SystemExit("Could not find askChat.")
    start, _ = rng
    js = js[:start] + run_local.strip() + "\n\n" + js[start:]
    print("[index] Added runLocalChat.")
else:
    print("[index] runLocalChat already exists.")

rng = find_function_range(js, "askChat")
if rng is None:
    raise SystemExit("Could not find askChat for replacement.")
start, end = rng
js = js[:start] + ask_chat.strip() + "\n\n" + js[end:]
print("[index] Replaced askChat with anti-loop retry wrapper.")

required_js = [
    "function cleanupAssistantReply(",
    "function hasLoopingOrBrokenReply(",
    "function cleanLoopingReply(",
    "function buildAntiLoopSystem(",
    "async function runLocalChat(",
    "async function askChat(",
]

missing = [x for x in required_js if x not in js]
if missing:
    raise SystemExit("index.js still missing: " + ", ".join(missing))

index_path.write_text(js, encoding="utf-8")

# ------------------------------------------------------------
# 3. Patch local_ai_server.py flexibly.
# ------------------------------------------------------------
server = server_path.read_text(encoding="utf-8")

# Apply enable_thinking=False if possible.
if "enable_thinking=False" not in server:
    old = "chat_tokenizer.apply_chat_template(messages, tokenize=False, add_generation_prompt=True)"
    new = """chat_tokenizer.apply_chat_template(
                messages,
                tokenize=False,
                add_generation_prompt=True,
                enable_thinking=False,
            )"""
    if old in server:
        server = server.replace(old, new, 1)
        print("[server] Added enable_thinking=False.")
    else:
        print("[server] Could not find compact apply_chat_template call; leaving as-is.")
else:
    print("[server] enable_thinking=False already present.")

# Insert generation anti-loop kwargs into the first chat gen_kwargs block.
if '"repetition_penalty"' not in server:
    idx = server.find("gen_kwargs = {")
    if idx == -1:
        raise SystemExit("Could not find gen_kwargs = { in local_ai_server.py")

    brace = server.find("{", idx)
    depth = 0
    end = None

    for i in range(brace, len(server)):
        ch = server[i]
        if ch == "{":
            depth += 1
        elif ch == "}":
            depth -= 1
            if depth == 0:
                end = i
                break

    if end is None:
        raise SystemExit("Could not find end of gen_kwargs dict.")

    block = server[idx:end]
    insert = '''        "repetition_penalty": max(float(os.getenv("CHAT_REPETITION_PENALTY", "1.08")), 1.0),
        "no_repeat_ngram_size": max(int(os.getenv("CHAT_NO_REPEAT_NGRAM_SIZE", "6")), 0),
        "use_cache": True,
'''

    # Put it before pad_token_id if present, otherwise before closing brace.
    pad = block.find('"pad_token_id"')
    if pad != -1:
        block = block[:pad] + insert + block[pad:]
        server = server[:idx] + block + server[end:]
    else:
        server = server[:end] + insert + server[end:]

    print("[server] Added repetition_penalty/no_repeat_ngram_size/use_cache.")
else:
    print("[server] repetition controls already present.")

required_server = [
    "repetition_penalty",
    "no_repeat_ngram_size",
]

missing_server = [x for x in required_server if x not in server]
if missing_server:
    raise SystemExit("local_ai_server.py still missing: " + ", ".join(missing_server))

server_path.write_text(server, encoding="utf-8")

# ------------------------------------------------------------
# 4. Patch .env defaults.
# ------------------------------------------------------------
def set_env_value(text: str, key: str, value: str) -> str:
    pattern = re.compile(rf"(?m)^{re.escape(key)}=.*$")
    if pattern.search(text):
        return pattern.sub(f"{key}={value}", text)

    if text and not text.endswith("\n"):
        text += "\n"

    return text + f"{key}={value}\n"

env = env_path.read_text(encoding="utf-8") if env_path.exists() else ""
env = set_env_value(env, "CHAT_REPETITION_PENALTY", "1.08")
env = set_env_value(env, "CHAT_NO_REPEAT_NGRAM_SIZE", "6")
env = set_env_value(env, "CHAT_ANTI_LOOP_TEMPERATURE", "0.20")
env_path.write_text(env, encoding="utf-8")

print("[done] Anti-loop repair patch written.")
