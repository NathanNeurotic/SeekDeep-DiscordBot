from pathlib import Path
import sys

if len(sys.argv) != 2:
    raise SystemExit("Usage: patch_model_status_route.py <index.js>")

path = Path(sys.argv[1])
raw = path.read_bytes()
newline = "\r\n" if b"\r\n" in raw else "\n"
text = raw.decode("utf-8-sig")
text = text.replace("\r\n", "\n").replace("\r", "\n")

def require_contains(haystack, needle, label):
    if needle not in haystack:
        raise SystemExit(f"Required anchor not found: {label}")

def replace_once(haystack, old, new, label):
    count = haystack.count(old)
    if count != 1:
        raise SystemExit(f"Expected exactly one anchor for {label}, found {count}.")
    return haystack.replace(old, new, 1)

def insert_once_before(haystack, anchor, insertion, label):
    if insertion.strip() in haystack:
        return haystack
    require_contains(haystack, anchor, label)
    return haystack.replace(anchor, insertion + "\n" + anchor, 1)

require_contains(text, "SEEKDEEP_STABILIZED_DISPATCH_HELPERS_START", "stabilized dispatcher marker")
require_contains(text, "function seekdeepUtilityPromptKind(prompt = '')", "utility routing function")
require_contains(text, "async function statusText()", "statusText function")
require_contains(text, "function seekdeepEnqueueImageJob(job, runner)", "correct image queue contract")
if "seekdeepMakeImageQueueJobId" in text:
    raise SystemExit("Unsafe old queue helper found: seekdeepMakeImageQueueJobId")
if "job.run" in text:
    raise SystemExit("Unsafe job.run-style queue logic found")

model_helper = r"""
// SEEKDEEP_MODEL_STATUS_ROUTE_START
function seekdeepIsModelStatusQuestion(prompt = '') {
  const p = normalizeUserText(prompt).toLowerCase().trim();

  if (!p) return false;

  return (
    /^(?:what|which)\s+(?:ai\s+)?model\s+(?:are\s+)?(?:you|u|this|seekdeep|seekotics|the\s+bot)\s+(?:using|running|loaded|on)\??$/.test(p) ||
    /^(?:what|which)\s+(?:ai\s+)?model\s+(?:do|does)\s+(?:you|u|seekdeep|seekotics|the\s+bot)\s+(?:use|run)\??$/.test(p) ||
    /^(?:what|which)\s+(?:ai\s+)?model\s+(?:is|does)\s+(?:seekdeep|seekotics|the\s+bot)\s+(?:using|running|loaded|use)\??$/.test(p) ||
    /^(?:what|which)\s+is\s+(?:your|the\s+bot'?s|seekdeep'?s|seekotics'?)\s+(?:ai\s+)?model\??$/.test(p) ||
    /^(?:what\s+are\s+you\s+running\s+on|what\s+do\s+you\s+run\s+on|what\s+is\s+your\s+backend)\??$/.test(p) ||
    /^(?:current|loaded|active|running)\s+(?:ai\s+)?model(?:\s+status)?\??$/.test(p) ||
    /^(?:model|models|model\s+status|local\s+model\s+status|ai\s+model\s+status)\??$/.test(p) ||
    /^show\s+(?:me\s+)?(?:the\s+)?(?:current|loaded|active|running)?\s*(?:ai\s+)?models?\??$/.test(p)
  );
}
// SEEKDEEP_MODEL_STATUS_ROUTE_END
"""

if "SEEKDEEP_MODEL_STATUS_ROUTE_START" not in text:
    text = insert_once_before(
        text,
        "function seekdeepUtilityPromptKind(prompt = '') {",
        model_helper,
        "model-status helper insertion point",
    )

if "return 'model-status'" not in text:
    old = """function seekdeepUtilityPromptKind(prompt = '') {
  const p = normalizeUserText(prompt).toLowerCase().trim();

  if (!p) return '';

  // Archive dump is a hard command. Keep it out of chat/model routing."""
    new = """function seekdeepUtilityPromptKind(prompt = '') {
  const p = normalizeUserText(prompt).toLowerCase().trim();

  if (!p) return '';

  // Model identity/status is a hard local command. Keep it out of Qwen chat persona routing.
  if (typeof seekdeepIsModelStatusQuestion === 'function' && seekdeepIsModelStatusQuestion(p)) return 'model-status';

  // Archive dump is a hard command. Keep it out of chat/model routing."""
    text = replace_once(text, old, new, "seekdeepUtilityPromptKind model-status route")

dedupe_start = text.find("function seekdeepIsPromptDedupeExempt")
dedupe_end = text.find("// SEEKDEEP_HARD_COMMAND_DEDUPE_EXEMPT_END", dedupe_start)
if dedupe_start < 0 or dedupe_end < 0:
    raise SystemExit("Could not locate hard-command dedupe exemption block.")

dedupe_block = text[dedupe_start:dedupe_end]
if "seekdeepIsModelStatusQuestion" not in dedupe_block:
    old = "  if (typeof seekdeepUtilityPromptKind === 'function' && seekdeepUtilityPromptKind(p)) return true;\n\n  return /^(?:queue|que)\\s+status\\b/.test(p) ||"
    new = "  if (typeof seekdeepUtilityPromptKind === 'function' && seekdeepUtilityPromptKind(p)) return true;\n  if (typeof seekdeepIsModelStatusQuestion === 'function' && seekdeepIsModelStatusQuestion(p)) return true;\n\n  return /^(?:queue|que)\\s+status\\b/.test(p) ||"
    text = replace_once(text, old, new, "hard-command dedupe model-status exemption")

if "@SEEKOTICS what model are you using?" not in text:
    old = "    '@SEEKOTICS status',\n    '@SEEKOTICS ping',"
    new = "    '@SEEKOTICS status',\n    '@SEEKOTICS what model are you using?',\n    '@SEEKOTICS ping',"
    text = replace_once(text, old, new, "help text model-status line")

if "utilityKind === 'model-status'" not in text:
    old = """    if (utilityKind) {
      seekdeepLogRoute(utilityKind, prompt);
      remember(key, 'user', prompt);
      seekdeepSetResponseModel(message, seekdeepNoModelLabel());"""
    new = """    if (utilityKind === 'model-status') {
      seekdeepLogRoute('model-status', prompt);
      const status = await statusText();
      remember(key, 'user', prompt);
      remember(key, 'assistant', status);
      seekdeepSetResponseModel(message, seekdeepNoModelLabel());
      await sendLongMessageReply(message, asTextBlock(status));
      return;
    }

    if (utilityKind) {
      seekdeepLogRoute(utilityKind, prompt);
      remember(key, 'user', prompt);
      seekdeepSetResponseModel(message, seekdeepNoModelLabel());"""
    text = replace_once(text, old, new, "dispatcher model-status branch")

for needle, label in [
    ("SEEKDEEP_MODEL_STATUS_ROUTE_START", "model-status helper block"),
    ("function seekdeepIsModelStatusQuestion", "model-status detector"),
    ("return 'model-status'", "utility model-status route"),
    ("utilityKind === 'model-status'", "dispatcher model-status branch"),
    ("seekdeepLogRoute('model-status', prompt);", "dispatcher model-status route log"),
    ("const status = await statusText();", "model-status reuses statusText"),
    ("seekdeepSetResponseModel(message, seekdeepNoModelLabel());", "model-status uses no-model label"),
    ("function seekdeepEnqueueImageJob(job, runner)", "correct image queue contract"),
]:
    require_contains(text, needle, label)

post = text.find("utilityKind === 'post-archive'")
model = text.find("utilityKind === 'model-status'")
generic = text.find("if (utilityKind) {", model)
status = text.find("if (isNaturalStatusPrompt(prompt) || isExplicitStatusRequest(prompt))", generic)
chat = text.find("seekdeepLogRoute('chat', prompt);", generic)
if not (post >= 0 and model > post and generic > model and status > generic and chat > status):
    raise SystemExit("Dispatcher order is unsafe. Expected post-archive -> model-status -> generic utility -> status -> chat.")

if "seekdeepMakeImageQueueJobId" in text:
    raise SystemExit("Unsafe old queue helper found after patch: seekdeepMakeImageQueueJobId")
if "job.run" in text:
    raise SystemExit("Unsafe job.run-style queue logic found after patch")

out = text if newline == "\n" else text.replace("\n", "\r\n")
path.write_bytes(out.encode("utf-8"))
print("Patched index.js with hard model-status route.")