from pathlib import Path
import re
import sys

if len(sys.argv) != 2:
    raise SystemExit("Usage: repair_research_table_message_hook.py <index.js>")

path = Path(sys.argv[1])
raw = path.read_bytes()
newline = "\r\n" if b"\r\n" in raw else "\n"
text = raw.decode("utf-8-sig").replace("\r\n", "\n").replace("\r", "\n")

def require_contains(haystack: str, needle: str, label: str):
    if needle not in haystack:
        raise SystemExit(f"Required anchor not found: {label}")

require_contains(text, "client.on('messageCreate'", "messageCreate handler")
require_contains(text, "async function seekdeepHandleResearchTableMessage", "research/table handler")
require_contains(text, "seekdeepEnqueueImageJob(job, runner)", "correct image queue contract")
require_contains(text, "post archive", "post archive context")

if "seekdeepMakeImageQueueJobId" in text:
    raise SystemExit("Unsafe old queue helper found: seekdeepMakeImageQueueJobId")
if "job.run" in text:
    raise SystemExit("Unsafe job.run-style queue logic found")

# Patch helper detection to catch "in the internet" and laptop comparisons more reliably.
text = re.sub(
    r"function seekdeepIsVagueWebRequest\(prompt = ''\) \{[\s\S]*?\n\}",
    r"""function seekdeepIsVagueWebRequest(prompt = '') {
  const p = normalizeUserText(prompt).toLowerCase();
  if (seekdeepLooksLikeSpecificResearchPrompt(p)) return false;

  return (
    /\b(look|search|check|find)\s+(for\s+)?(something|stuff|things?)\s+(for\s+me\s+)?(on|in|with|using)?\s*(the\s+)?(internet|web|online)\b/.test(p) ||
    /\b(can you|could you|would you)\s+(look|search|check|find)\s+(for\s+)?(something|stuff|things?)\b/.test(p) ||
    /\b(use|search|check)\s+(the\s+)?(internet|web|online)\b/.test(p)
  );
}""",
    text,
    count=1,
)

text = re.sub(
    r"function seekdeepIsComparisonResearchPrompt\(prompt = ''\) \{[\s\S]*?\n\}",
    r"""function seekdeepIsComparisonResearchPrompt(prompt = '') {
  const p = normalizeUserText(prompt).toLowerCase();

  if (/\b(difference between|compare|comparison|versus|vs\.?|which is better|amd over intel|intel over amd|why .* over .*)\b/.test(p)) return true;

  if (/\b(lenovo|thinkpad|x1\s*carbon|x1carbon|t14|t14s|x13|p14s|laptop|notebook)\b/.test(p) &&
      /\b(amd|intel|gen\s*\d+|generation|difference|compare|vs\.?|versus|over)\b/.test(p)) return true;

  return false;
}""",
    text,
    count=1,
)

# Insert into messageCreate specifically.
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

# Remove any old misplaced hooks outside messageCreate is not strictly necessary, but avoid duplicate hook at this exact spot.
near = text[max(msg_start, chat_pos - 500):chat_pos]
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
print("Repaired research/table hook in messageCreate.")