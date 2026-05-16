from pathlib import Path
import re
import sys

if len(sys.argv) != 2:
    raise SystemExit("Usage: repair_research_table_message_hook_v2.py <index.js>")

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

    next_start = src.find("\nfunction ", start + len(marker))
    next_async = src.find("\nasync function ", start + len(marker))
    candidates = [x for x in [next_start, next_async] if x >= 0]
    if not candidates:
        raise SystemExit(f"Could not locate end of function {name}.")

    end = min(candidates)
    return src[:start] + replacement.rstrip() + "\n\n" + src[end + 1:]

require_contains(text, "client.on('messageCreate'", "messageCreate handler")
require_contains(text, "async function seekdeepHandleResearchTableMessage", "research/table handler")
require_contains(text, "seekdeepEnqueueImageJob(job, runner)", "correct image queue contract")
require_contains(text, "post archive", "post archive context")

if "seekdeepMakeImageQueueJobId" in text:
    raise SystemExit("Unsafe old queue helper found: seekdeepMakeImageQueueJobId")
if "job.run" in text:
    raise SystemExit("Unsafe job.run-style queue logic found")

new_vague = r"""function seekdeepIsVagueWebRequest(prompt = '') {
  const p = normalizeUserText(prompt).toLowerCase();
  if (seekdeepLooksLikeSpecificResearchPrompt(p)) return false;

  return (
    /\b(look|search|check|find)\s+(for\s+)?(something|stuff|things?)\s+(for\s+me\s+)?(on|in|with|using)?\s*(the\s+)?(internet|web|online)\b/.test(p) ||
    /\b(can you|could you|would you)\s+(look|search|check|find)\s+(for\s+)?(something|stuff|things?)\b/.test(p) ||
    /\b(use|search|check)\s+(the\s+)?(internet|web|online)\b/.test(p)
  );
}"""

new_comparison = r"""function seekdeepIsComparisonResearchPrompt(prompt = '') {
  const p = normalizeUserText(prompt).toLowerCase();

  if (/\b(difference between|compare|comparison|versus|vs\.?|which is better|amd over intel|intel over amd|why .* over .*)\b/.test(p)) return true;

  if (/\b(lenovo|thinkpad|x1\s*carbon|x1carbon|t14|t14s|x13|p14s|laptop|notebook)\b/.test(p) &&
      /\b(amd|intel|gen\s*\d+|generation|difference|compare|vs\.?|versus|over)\b/.test(p)) return true;

  return false;
}"""

text = replace_function_by_name(text, "seekdeepIsVagueWebRequest", new_vague)
text = replace_function_by_name(text, "seekdeepIsComparisonResearchPrompt", new_comparison)

# Insert into messageCreate specifically, after natural image handling and immediately before fallback chat.
msg_start = text.find("client.on('messageCreate'")
if msg_start < 0:
    raise SystemExit("Could not locate messageCreate handler.")

natural_anchor = "    if (isNaturalImagePrompt(prompt)) {"
natural_pos = text.find(natural_anchor, msg_start)
if natural_pos < 0:
    raise SystemExit("Could not locate natural image block inside messageCreate.")

chat_anchor = "    seekdeepLogRoute('chat', prompt);\n"
chat_pos = text.find(chat_anchor, natural_pos)
if chat_pos < 0:
    raise SystemExit("Could not locate messageCreate chat route after natural image block.")

hook = """    // SEEKDEEP_RESEARCH_TABLE_MESSAGE_HOOK_START
    if (await seekdeepHandleResearchTableMessage(message, prompt, key)) {
      return;
    }
    // SEEKDEEP_RESEARCH_TABLE_MESSAGE_HOOK_END

"""

near = text[max(msg_start, chat_pos - 600):chat_pos]
if "SEEKDEEP_RESEARCH_TABLE_MESSAGE_HOOK_START" not in near:
    text = text[:chat_pos] + hook + text[chat_pos:]

for needle, label in [
    ("SEEKDEEP_RESEARCH_TABLE_CONTEXT_START", "research helper marker"),
    ("async function seekdeepHandleResearchTableMessage", "research handler"),
    ("SEEKDEEP_RESEARCH_TABLE_MESSAGE_HOOK_START", "messageCreate research hook marker"),
    ("if (await seekdeepHandleResearchTableMessage(message, prompt, key))", "messageCreate hook call"),
    ("function seekdeepIsVagueWebRequest", "vague web detector"),
    ("function seekdeepIsComparisonResearchPrompt", "comparison detector"),
    ("web: 'always'", "forced web research"),
    ("seekdeepEnqueueImageJob(job, runner)", "image queue contract preserved"),
]:
    require_contains(text, needle, label)

out = text if newline == "\n" else text.replace("\n", "\r\n")
path.write_bytes(out.encode("utf-8"))
print("Repaired research/table hook in messageCreate with safe string replacement.")