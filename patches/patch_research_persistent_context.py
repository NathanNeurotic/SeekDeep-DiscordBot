from pathlib import Path
import sys

if len(sys.argv) != 2:
    raise SystemExit("Usage: patch_research_persistent_context.py <index.js>")

path = Path(sys.argv[1])
raw = path.read_bytes()
newline = "\r\n" if b"\r\n" in raw else "\n"
text = raw.decode("utf-8-sig").replace("\r\n", "\n").replace("\r", "\n")

def require_contains(haystack: str, needle: str, label: str):
    if needle not in haystack:
        raise SystemExit(f"Required anchor not found: {label}")

def replace_function_by_name(src: str, name: str, replacement: str) -> str:
    marker = f"function {name}("
    start = src.find(marker)
    if start < 0:
        raise SystemExit(f"Could not locate function {name}.")

    next_positions = []
    for marker2 in ["\nfunction ", "\nasync function ", "\n// SEEKDEEP_"]:
        pos = src.find(marker2, start + len(marker))
        if pos >= 0:
            next_positions.append(pos)

    if not next_positions:
        raise SystemExit(f"Could not locate end of function {name}.")

    end = min(next_positions)
    return src[:start] + replacement.rstrip() + "\n\n" + src[end + 1:]

def insert_before(src: str, anchor: str, insert: str, label: str) -> str:
    if insert.strip() in src:
        return src
    pos = src.find(anchor)
    if pos < 0:
        raise SystemExit(f"Could not locate insertion anchor: {label}")
    return src[:pos] + insert + src[pos:]

for needle, label in [
    ("const SEEKDEEP_PENDING_RESEARCH_TASKS = new Map();", "pending research map"),
    ("function seekdeepGetPendingResearchTask", "get pending function"),
    ("function seekdeepSetPendingResearchTask", "set pending function"),
    ("function seekdeepClearPendingResearchTask", "clear pending function"),
    ("function seekdeepIsResearchFollowupPrompt", "research follow-up detector"),
    ("async function seekdeepHandleResearchTableMessage", "research handler"),
    ("seekdeepEnqueueImageJob(job, runner)", "correct image queue contract"),
]:
    require_contains(text, needle, label)

if "seekdeepMakeImageQueueJobId" in text:
    raise SystemExit("Unsafe old queue helper found: seekdeepMakeImageQueueJobId")
if "job.run" in text:
    raise SystemExit("Unsafe job.run-style queue logic found")

persist_helpers = r"""
const SEEKDEEP_RESEARCH_PENDING_PATH = path.join(__dirname, 'patches', 'seekdeep_research_pending.json');
let SEEKDEEP_RESEARCH_PENDING_LOADED = false;

function seekdeepLoadPendingResearchTasks() {
  if (SEEKDEEP_RESEARCH_PENDING_LOADED) return;
  SEEKDEEP_RESEARCH_PENDING_LOADED = true;

  try {
    if (!fs.existsSync(SEEKDEEP_RESEARCH_PENDING_PATH)) return;
    const raw = fs.readFileSync(SEEKDEEP_RESEARCH_PENDING_PATH, 'utf8');
    const parsed = JSON.parse(raw || '{}');
    if (!parsed || typeof parsed !== 'object') return;

    for (const [key, value] of Object.entries(parsed)) {
      if (key && value && typeof value === 'object') SEEKDEEP_PENDING_RESEARCH_TASKS.set(key, value);
    }
  } catch (err) {
    console.warn(`[SeekDeep] could not load pending research context: ${err.message}`);
  }
}

function seekdeepSavePendingResearchTasks() {
  try {
    fs.mkdirSync(path.dirname(SEEKDEEP_RESEARCH_PENDING_PATH), { recursive: true });
    const obj = Object.fromEntries(SEEKDEEP_PENDING_RESEARCH_TASKS.entries());
    fs.writeFileSync(SEEKDEEP_RESEARCH_PENDING_PATH, JSON.stringify(obj, null, 2), 'utf8');
  } catch (err) {
    console.warn(`[SeekDeep] could not save pending research context: ${err.message}`);
  }
}

"""

if "SEEKDEEP_RESEARCH_PENDING_PATH" not in text:
    text = insert_before(text, "function seekdeepResearchNow()", persist_helpers, "research now function")

new_get = r"""function seekdeepGetPendingResearchTask(key) {
  seekdeepLoadPendingResearchTasks();

  const item = SEEKDEEP_PENDING_RESEARCH_TASKS.get(key);
  if (!item) return null;
  const ttlMs = Number(process.env.SEEKDEEP_RESEARCH_PENDING_TTL_MS || 60 * 60 * 1000);
  if ((seekdeepResearchNow() - Number(item.at || 0)) > ttlMs) {
    SEEKDEEP_PENDING_RESEARCH_TASKS.delete(key);
    seekdeepSavePendingResearchTasks();
    return null;
  }
  return item;
}"""

new_set = r"""function seekdeepSetPendingResearchTask(key, value = {}) {
  seekdeepLoadPendingResearchTasks();

  if (!key) return;
  SEEKDEEP_PENDING_RESEARCH_TASKS.set(key, {
    ...value,
    at: seekdeepResearchNow(),
  });
  seekdeepSavePendingResearchTasks();
}"""

new_clear = r"""function seekdeepClearPendingResearchTask(key) {
  seekdeepLoadPendingResearchTasks();

  if (!key) return;
  SEEKDEEP_PENDING_RESEARCH_TASKS.delete(key);
  seekdeepSavePendingResearchTasks();
}"""

text = replace_function_by_name(text, "seekdeepGetPendingResearchTask", new_get)
text = replace_function_by_name(text, "seekdeepSetPendingResearchTask", new_set)
text = replace_function_by_name(text, "seekdeepClearPendingResearchTask", new_clear)

# Add missing-context guard after pending is defined.
anchor = """  if (pending?.topic && seekdeepIsResearchFollowupPrompt(p)) {
"""
missing_context = r"""  if (!pending?.topic && seekdeepIsResearchFollowupPrompt(p)) {
    seekdeepLogRoute('research-followup-missing-context', prompt);
    const answer = 'Pros/cons of what exactly? Send the models/items again, and I will compare them instead of guessing.';
    remember(key, 'user', prompt);
    remember(key, 'assistant', answer);
    seekdeepSetResponseModel(message, seekdeepNoModelLabel());
    await sendLongMessageReply(message, answer);
    return true;
  }

"""
if "research-followup-missing-context" not in text:
    text = insert_before(text, anchor, missing_context, "pending follow-up branch")

# Ensure fs is available. Most SeekDeep builds already import fs, but patch if missing.
if "from 'fs'" not in text and 'from "fs"' not in text:
    import_anchor = "import path from 'path';"
    if import_anchor in text:
        text = text.replace(import_anchor, "import fs from 'fs';\n" + import_anchor, 1)
    else:
        raise SystemExit("Could not verify fs import or insert fs import.")

for needle, label in [
    ("SEEKDEEP_RESEARCH_PENDING_PATH", "pending JSON path"),
    ("seekdeepLoadPendingResearchTasks", "pending load helper"),
    ("seekdeepSavePendingResearchTasks", "pending save helper"),
    ("seekdeepSavePendingResearchTasks();", "pending save calls"),
    ("research-followup-missing-context", "missing context guard"),
    ("Pros/cons of what exactly?", "missing context local response"),
    ("seekdeepEnqueueImageJob(job, runner)", "image queue contract preserved"),
]:
    require_contains(text, needle, label)

out = text if newline == "\n" else text.replace("\n", "\r\n")
path.write_bytes(out.encode("utf-8"))
print("Patched persistent research context and missing-context guard.")