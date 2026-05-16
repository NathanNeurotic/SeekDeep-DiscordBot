from pathlib import Path
from datetime import datetime

path = Path("index.js")
text = path.read_text(encoding="utf-8")

stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
backup = Path(f"index.js.bak-status-metrics-v2-{stamp}")
backup.write_text(text, encoding="utf-8")
print(f"[SeekDeep] Backup written: {backup}")

def find_function_range(src: str, name: str):
    starts = []
    for prefix in [f"async function {name}", f"function {name}"]:
        pos = src.find(prefix)
        if pos != -1:
            starts.append(pos)

    if not starts:
        return None

    start = min(starts)

    # Find the real function-body opening brace, not a default-parameter object like `= {}`.
    paren = src.find("(", start)
    if paren == -1:
        raise SystemExit(f"Found {name}, but no opening parenthesis.")

    pdepth = 0
    in_string = None
    escape = False
    line_comment = False
    block_comment = False
    sig_end = None

    i = paren
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
            line_comment = True
            i += 2
            continue

        if ch == "/" and nxt == "*":
            block_comment = True
            i += 2
            continue

        if ch in ("'", '"', "`"):
            in_string = ch
            i += 1
            continue

        if ch == "(":
            pdepth += 1
        elif ch == ")":
            pdepth -= 1
            if pdepth == 0:
                sig_end = i
                break

        i += 1

    if sig_end is None:
        raise SystemExit(f"Could not find end of function signature for {name}.")

    brace = src.find("{", sig_end)
    if brace == -1:
        raise SystemExit(f"Found {name}, but no opening brace.")

    depth = 0
    in_string = None
    escape = False
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
            line_comment = True
            i += 2
            continue

        if ch == "/" and nxt == "*":
            block_comment = True
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
                return start, i + 1

        i += 1

    raise SystemExit(f"Could not find closing brace for {name}.")

def replace_function(src: str, name: str, replacement: str):
    rng = find_function_range(src, name)
    if rng is None:
        raise SystemExit(f"Could not find function: {name}")

    start, end = rng
    return src[:start] + replacement.strip() + "\n\n" + src[end:].lstrip()

metrics_helpers = r'''
// SEEKDEEP_STATUS_METRICS_START
const seekdeepBotMetrics = globalThis.__seekdeepBotMetrics || {
  startedAt: Date.now(),
  responsesSinceBoot: 0,
  responsesByModel: {},
};

globalThis.__seekdeepBotMetrics = seekdeepBotMetrics;

function seekdeepTrackBotResponse(modelUsed = 'unknown') {
  const model = String(modelUsed || 'unknown');
  seekdeepBotMetrics.responsesSinceBoot += 1;
  seekdeepBotMetrics.responsesByModel[model] = (seekdeepBotMetrics.responsesByModel[model] || 0) + 1;
}

function seekdeepFormatDuration(ms) {
  const totalSeconds = Math.max(0, Math.floor(Number(ms || 0) / 1000));
  const days = Math.floor(totalSeconds / 86400);
  const hours = Math.floor((totalSeconds % 86400) / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  const parts = [];
  if (days) parts.push(`${days}d`);
  if (hours || parts.length) parts.push(`${hours}h`);
  if (minutes || parts.length) parts.push(`${minutes}m`);
  parts.push(`${seconds}s`);

  return parts.join(' ');
}

function seekdeepCurrentLoadedModelFromHealth(health = {}) {
  const task = String(health.loaded_task || 'none').toLowerCase();

  if (task === 'chat') return health.models?.chat || seekdeepChatModelLabel();
  if (task === 'vision') return health.models?.vision || seekdeepVisionModelLabel();
  if (task === 'image') return health.models?.image || seekdeepImageModelLabel();

  return 'none';
}

function seekdeepFormatResponsesByModel() {
  const entries = Object.entries(seekdeepBotMetrics.responsesByModel || {})
    .sort((a, b) => b[1] - a[1]);

  if (!entries.length) return 'none yet';

  return entries.map(([model, count]) => `${model}: ${count}`).join('\n');
}
// SEEKDEEP_STATUS_METRICS_END
'''

start_marker = "// SEEKDEEP_STATUS_METRICS_START"
end_marker = "// SEEKDEEP_STATUS_METRICS_END"

if start_marker in text:
    start = text.find(start_marker)
    end = text.find(end_marker, start)
    if end == -1:
        raise SystemExit("Found status metrics start marker but no end marker.")
    end += len(end_marker)
    text = text[:start] + metrics_helpers.strip() + "\n\n" + text[end:].lstrip()
    print("[SeekDeep] Replaced existing status metrics helpers.")
else:
    anchor = "// SEEKDEEP_RESPONSE_FOOTER_END"
    pos = text.find(anchor)
    if pos == -1:
        raise SystemExit("Could not find response footer end marker for metrics insertion.")
    pos += len(anchor)
    text = text[:pos] + "\n\n" + metrics_helpers.strip() + text[pos:]
    print("[SeekDeep] Inserted status metrics helpers.")

append_footer = r'''
function seekdeepAppendResponseFooter(content, meta = {}) {
  const body = String(content ?? '').trim();

  if (/Time to Generate:\s*\d+(?:\.\d+)?\s*seconds\s*\nModel Used:/i.test(body)) {
    return body;
  }

  const modelUsed = meta.modelUsed || SEEKDEEP_NO_MODEL_USED_LABEL;

  if (typeof seekdeepTrackBotResponse === 'function') {
    seekdeepTrackBotResponse(modelUsed);
  }

  const footer = seekdeepResponseFooter({
    ...meta,
    modelUsed,
  });

  return body ? `${body}\n\n${footer}` : footer;
}
'''

text = replace_function(text, "seekdeepAppendResponseFooter", append_footer)
print("[SeekDeep] Replaced seekdeepAppendResponseFooter with metrics tracking.")

status_text = r'''
async function statusText() {
  const health = await fetchJson(`${LOCAL_AI_BASE_URL}/health`);
  const loadedTask = health.loaded_task || 'none';
  const currentLoadedModel = seekdeepCurrentLoadedModelFromHealth(health);
  const botUptime = seekdeepFormatDuration(Date.now() - seekdeepBotMetrics.startedAt);
  const responsesByModel = seekdeepFormatResponsesByModel();

  return [
    'Local AI server status',
    '',
    `Endpoint: ${LOCAL_AI_BASE_URL}`,
    `Health: ${health.status}`,
    `Device: ${health.device}`,
    `CUDA: ${health.cuda_available ? 'YES' : 'NO'}`,
    `Loaded task: ${loadedTask}`,
    `Current Loaded Model: ${currentLoadedModel}`,
    `Keep mode: ${health.keep_mode}`,
    '',
    'Bot runtime:',
    `Bot Uptime: ${botUptime}`,
    `Responses Since Last Reboot: ${seekdeepBotMetrics.responsesSinceBoot}`,
    '',
    'Responses By Model:',
    responsesByModel,
    '',
    'Configured local models:',
    `Chat: ${health.models?.chat}`,
    `Vision: ${health.models?.vision}`,
    `Image: ${health.models?.image}`,
    `Offline model loading: ${health.offline_model_loading ? 'YES' : 'NO'}`,
  ].join('\n');
}
'''

text = replace_function(text, "statusText", status_text)
print("[SeekDeep] Replaced statusText.")

required = [
    "const seekdeepBotMetrics =",
    "function seekdeepTrackBotResponse(",
    "function seekdeepCurrentLoadedModelFromHealth(",
    "function seekdeepFormatResponsesByModel(",
    "function seekdeepAppendResponseFooter(",
    "async function statusText(",
    "Current Loaded Model:",
    "Responses Since Last Reboot:",
]

missing = [item for item in required if item not in text]
if missing:
    raise SystemExit("Patch failed. Missing: " + ", ".join(missing))

path.write_text(text, encoding="utf-8")
print("[SeekDeep] Status metrics v2 patch written.")
