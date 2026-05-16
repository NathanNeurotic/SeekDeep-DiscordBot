from pathlib import Path
import re

index_path = Path("index.js")
server_path = Path("local_ai_server.py")

index = index_path.read_text(encoding="utf-8")
server = server_path.read_text(encoding="utf-8")

# Clean known old damage if present.
index = re.sub(r"(?m)^\s*async\s*$\r?\n?", "", index)
index = index.replace(
    "async function askVisionasync function askVision",
    "async function askVision"
)

# -----------------------------
# 1) Server single-flight lock.
# -----------------------------
server = re.sub(
    r"(?ms)\n*# SEEKDEEP_SINGLEFLIGHT_MIDDLEWARE_START.*?# SEEKDEEP_SINGLEFLIGHT_MIDDLEWARE_END\n*",
    "\n\n",
    server,
)

singleflight_block = r'''
# SEEKDEEP_SINGLEFLIGHT_MIDDLEWARE_START
# Serialize heavyweight local model requests. FastAPI can accept overlapping
# requests, but this project keeps one active local model/task in VRAM at a time.
# Without this, two Discord events can race-load the same model twice.
import asyncio as _seekdeep_asyncio

_SEEKDEEP_MODEL_REQUEST_LOCK = _seekdeep_asyncio.Lock()
_SEEKDEEP_LOCKED_PATHS = {"/chat", "/vision", "/image", "/unload"}

@app.middleware("http")
async def seekdeep_singleflight_middleware(request, call_next):
    if request.url.path in _SEEKDEEP_LOCKED_PATHS:
        async with _SEEKDEEP_MODEL_REQUEST_LOCK:
            return await call_next(request)
    return await call_next(request)
# SEEKDEEP_SINGLEFLIGHT_MIDDLEWARE_END


'''

if "SEEKDEEP_SINGLEFLIGHT_MIDDLEWARE_START" not in server:
    route_pos = server.find("@app.")
    if route_pos == -1:
        raise SystemExit("Could not find first @app route/middleware insertion point in local_ai_server.py.")
    if "app = FastAPI" not in server[:route_pos]:
        raise SystemExit("Could not confirm app = FastAPI before first @app route.")
    server = server[:route_pos].rstrip() + "\n\n" + singleflight_block + server[route_pos:].lstrip()

# -----------------------------
# JS helpers.
# -----------------------------
index = re.sub(
    r"(?ms)\n*// SEEKDEEP_TYPING_DEDUPE_START.*?// SEEKDEEP_TYPING_DEDUPE_END\n*",
    "\n\n",
    index,
)

helpers = r'''
// SEEKDEEP_TYPING_DEDUPE_START
const SEEKDEEP_EVENT_TTL_MS = Number(process.env.SEEKDEEP_EVENT_TTL_MS || 120000);
const SEEKDEEP_PROMPT_TTL_MS = Number(process.env.SEEKDEEP_PROMPT_TTL_MS || 30000);
const SEEKDEEP_TYPING_INTERVAL_MS = Number(process.env.SEEKDEEP_TYPING_INTERVAL_MS || 8000);
const SEEKDEEP_TYPING_MAX_MS = Number(process.env.SEEKDEEP_TYPING_MAX_MS || 600000);

const seekdeepSeenEvents = new Map();
const seekdeepSeenPrompts = new Map();

function seekdeepNow() {
  return Date.now();
}

function seekdeepSweepMap(map, now = seekdeepNow()) {
  for (const [key, expires] of map.entries()) {
    if (expires <= now) map.delete(key);
  }
}

function seekdeepClaimOnce(map, key, ttlMs) {
  const now = seekdeepNow();
  seekdeepSweepMap(map, now);

  if (map.has(key) && map.get(key) > now) {
    return false;
  }

  map.set(key, now + ttlMs);
  return true;
}

function seekdeepClaimEventOnce(key, ttlMs = SEEKDEEP_EVENT_TTL_MS) {
  return seekdeepClaimOnce(seekdeepSeenEvents, key, ttlMs);
}

function seekdeepNormalizePromptForDedupe(prompt) {
  return String(prompt || '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 500);
}

function seekdeepClaimPromptOnce(kind, userId, channelId, prompt, ttlMs = SEEKDEEP_PROMPT_TTL_MS) {
  const normalized = seekdeepNormalizePromptForDedupe(prompt);
  if (!normalized) return true;

  const key = `${kind}:${userId || 'unknown'}:${channelId || 'unknown'}:${normalized}`;
  return seekdeepClaimOnce(seekdeepSeenPrompts, key, ttlMs);
}

function startSeekDeepTypingLoop(channel, label = 'request') {
  let stopped = false;
  let interval = null;
  let hardStop = null;

  const tick = async () => {
    if (stopped) return;

    try {
      if (channel && typeof channel.sendTyping === 'function') {
        await channel.sendTyping();
      }
    } catch (err) {
      console.error(`Typing indicator failed for ${label}:`, err?.message || err);
    }
  };

  tick();

  interval = setInterval(tick, SEEKDEEP_TYPING_INTERVAL_MS);
  hardStop = setTimeout(() => {
    stop();
  }, SEEKDEEP_TYPING_MAX_MS);

  function stop() {
    if (stopped) return;
    stopped = true;

    if (interval) {
      clearInterval(interval);
      interval = null;
    }

    if (hardStop) {
      clearTimeout(hardStop);
      hardStop = null;
    }
  }

  return { stop };
}
// SEEKDEEP_TYPING_DEDUPE_END

'''

# Insert helpers before first Discord event handler.
insert_pos = index.find("client.on('interactionCreate'")
if insert_pos == -1:
    insert_pos = index.find('client.on("interactionCreate"')
if insert_pos == -1:
    insert_pos = index.find("client.on('messageCreate'")
if insert_pos == -1:
    insert_pos = index.find('client.on("messageCreate"')
if insert_pos == -1:
    raise SystemExit("Could not find Discord event handler insertion point in index.js.")

index = index[:insert_pos].rstrip() + "\n\n" + helpers + index[insert_pos:].lstrip()

# Utility to find event handler function body.
def find_event_handler(src: str, event_name: str):
    candidates = [
        f"client.on('{event_name}'",
        f'client.on("{event_name}"',
        f"client.once('{event_name}'",
        f'client.once("{event_name}"',
    ]

    start = -1
    for c in candidates:
        pos = src.find(c)
        if pos != -1:
            start = pos
            break

    if start == -1:
        return None

    brace = src.find("{", start)
    if brace == -1:
        return None

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
        return None

    return start, brace, end

# Add event ID dedupe to interactionCreate.
bounds = find_event_handler(index, "interactionCreate")
if bounds and "SEEKDEEP_INTERACTION_EVENT_DEDUPE" not in index[bounds[0]:bounds[2]]:
    start, brace, end = bounds
    injection = r'''
  // SEEKDEEP_INTERACTION_EVENT_DEDUPE
  if (interaction?.id && !seekdeepClaimEventOnce(`interaction:${interaction.id}`)) {
    console.warn(`Duplicate Discord interaction suppressed: ${interaction.id}`);
    return;
  }

'''
    index = index[:brace + 1] + injection + index[brace + 1:]

# Add event ID dedupe to messageCreate.
bounds = find_event_handler(index, "messageCreate")
if bounds and "SEEKDEEP_MESSAGE_EVENT_DEDUPE" not in index[bounds[0]:bounds[2]]:
    start, brace, end = bounds
    injection = r'''
  // SEEKDEEP_MESSAGE_EVENT_DEDUPE
  if (message?.id && !seekdeepClaimEventOnce(`message:${message.id}`)) {
    console.warn(`Duplicate Discord message event suppressed: ${message.id}`);
    return;
  }

'''
    index = index[:brace + 1] + injection + index[brace + 1:]

# Recompute after insertion and add prompt-level dedupe + typing loop after prompt normalization inside message handler.
bounds = find_event_handler(index, "messageCreate")
if bounds:
    start, brace, end = bounds
    handler = index[start:end]

    if "SEEKDEEP_MESSAGE_PROMPT_DEDUPE_AND_TYPING" not in handler:
        m = re.search(r"(?m)^(\s*const\s+prompt\s*=\s*normalizeUserText\([^\n]+;\s*)$", handler)
        if m:
            injection = r'''
  // SEEKDEEP_MESSAGE_PROMPT_DEDUPE_AND_TYPING
  if (!seekdeepClaimPromptOnce('message', message.author?.id || 'unknown', message.channel?.id || 'unknown', prompt)) {
    console.warn(`Duplicate prompt suppressed from ${message.author?.id || 'unknown'} in ${message.channel?.id || 'unknown'}`);
    return;
  }

  const _seekdeepTypingLoop = startSeekDeepTypingLoop(message.channel, `message:${message.id}`);
  try {
    message.__seekdeepTypingLoop = _seekdeepTypingLoop;
  } catch {}

'''
            abs_pos = start + m.end()
            index = index[:abs_pos] + injection + index[abs_pos:]
        else:
            print("Warning: could not find prompt normalization inside messageCreate; event dedupe still applied, typing loop not inserted.")

# Stop typing loop when message reply is finally sent.
sig = "async function sendLongMessageReply(message, content) {"
if sig in index and "SEEKDEEP_STOP_TYPING_ON_MESSAGE_REPLY" not in index:
    index = index.replace(
        sig,
        sig + r'''
  // SEEKDEEP_STOP_TYPING_ON_MESSAGE_REPLY
  if (message && message.__seekdeepTypingLoop) {
    try { message.__seekdeepTypingLoop.stop(); } catch {}
    try { message.__seekdeepTypingLoop = null; } catch {}
  }
''',
        1,
    )
else:
    print("Warning: could not patch sendLongMessageReply typing-stop hook or it was already patched.")

# Sanity checks.
required_index = [
    "SEEKDEEP_TYPING_DEDUPE_START",
    "startSeekDeepTypingLoop",
    "seekdeepClaimPromptOnce",
    "SEEKDEEP_MESSAGE_EVENT_DEDUPE",
    "SEEKDEEP_INTERACTION_EVENT_DEDUPE",
]

missing_index = [x for x in required_index if x not in index]
if missing_index:
    raise SystemExit("index.js patch failed; missing markers: " + ", ".join(missing_index))

required_server = [
    "SEEKDEEP_SINGLEFLIGHT_MIDDLEWARE_START",
    "_SEEKDEEP_MODEL_REQUEST_LOCK",
    '"/chat"',
    '"/vision"',
    '"/image"',
]

missing_server = [x for x in required_server if x not in server]
if missing_server:
    raise SystemExit("local_ai_server.py patch failed; missing markers: " + ", ".join(missing_server))

if re.search(r"(?m)^\s*async\s*$", index):
    raise SystemExit("Standalone async line exists in index.js after patch.")

if "askVisionasync" in index:
    raise SystemExit("askVisionasync corruption exists in index.js after patch.")

bad_join = re.search(r"\.join\(['\"]\s*\r?\n\s*['\"]\)", index)
if bad_join:
    raise SystemExit("Malformed multiline .join string exists in index.js after patch.")

index_path.write_text(index, encoding="utf-8")
server_path.write_text(server, encoding="utf-8")

print("Typing loop, duplicate suppression, and server single-flight lock applied.")
