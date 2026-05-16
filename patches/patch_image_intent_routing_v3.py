from pathlib import Path
import re
import sys

if len(sys.argv) != 2:
    raise SystemExit("Usage: patch_image_intent_routing_v3.py <index.js>")

path = Path(sys.argv[1])
raw = path.read_bytes()
newline = "\r\n" if b"\r\n" in raw else "\n"
text = raw.decode("utf-8-sig").replace("\r\n", "\n").replace("\r", "\n")

def require_contains(haystack: str, needle: str, label: str):
    if needle not in haystack:
        raise SystemExit(f"Required anchor not found: {label}")

start_marker = "// SEEKDEEP_BROADER_IMAGE_INTENT_ROUTER_START"
end_marker = "// SEEKDEEP_BROADER_IMAGE_INTENT_ROUTER_END"

require_contains(text, start_marker, "broader image intent router start marker")
require_contains(text, end_marker, "broader image intent router end marker")
require_contains(text, "function isNaturalImagePrompt", "isNaturalImagePrompt")
require_contains(text, "seekdeepEnqueueImageJob(job, runner)", "correct queue contract")
require_contains(text, "post archive", "post archive hard-command context")

if "seekdeepMakeImageQueueJobId" in text:
    raise SystemExit("Unsafe old queue helper found: seekdeepMakeImageQueueJobId")
if "job.run" in text:
    raise SystemExit("Unsafe job.run-style queue logic found")

new_block = r"""// SEEKDEEP_BROADER_IMAGE_INTENT_ROUTER_START
function seekdeepLooksLikeTextQuestion(prompt = '') {
  const p = String(prompt || '').trim().toLowerCase();
  if (!p) return true;

  // Visual permission / desire phrasing must not be swallowed by chat-question guards.
  if (/^(can|could|would)\s+(i|you|we)\s+(see|get|have|make|create|generate|draw|paint|render|visualize|design)\b/.test(p)) return false;
  if (/^(i\s+want|i'd\s+like|id\s+like|give\s+me|show\s+me|make|create|generate|draw|paint|render|visualize|design)\b/.test(p)) return false;

  return (
    /^(what|who|why|how|when|where|is|are|do|does|did)\b/.test(p) ||
    /\b(explain|summarize|summary|describe in words|tell me about|what is|who is|why is|how do|how to|steps|instructions|guide|advice|compare|difference between|translate|rewrite|proofread|fix this text|code|script|powershell|javascript|python|error|bug|logs?|status|queue status|admin status|cache status|archive status|help|commands)\b/.test(p)
  );
}

function seekdeepLooksLikeVisualRequest(prompt = '') {
  const p = String(prompt || '').trim().toLowerCase();
  if (!p) return false;

  const visualNouns = /\b(image|picture|pic|photo|art|artwork|drawing|illustration|painting|poster|album cover|cover art|banner|wallpaper|logo|icon|emblem|badge|character design|scene|portrait|sticker|thumbnail|concept art|screenshot|visual)\b/i;
  const creationVerbs = /\b(make|create|generate|render|draw|paint|sketch|illustrate|visualize|depict|design|show|give me|turn this into|can i see|could i see|i want|i'd like|id like)\b/i;
  const scenePreps = /\b(of|with|wearing|holding|standing|sitting|smoking|on a|in a|inside|outside|under|over|during|at sunset|at sunrise|at night|in armor|in the style of|with a|over a|under a)\b/i;
  const subjectCues = /\b(pepe|frog|cat|kitten|siamese|dog|dragon|robot|monster|anime|sailor moon|wizard|castle|cathedral|forest|tower|gothic|metal|punk|emo|screamo|hardcore|neon|album|poster|burning|armor|balcony|sunset|dead forest)\b/i;

  // Explicit visual nouns/verbs override the generic text-question guard.
  if (visualNouns.test(p) && (creationVerbs.test(p) || scenePreps.test(p) || subjectCues.test(p))) return true;
  if (creationVerbs.test(p) && visualNouns.test(p)) return true;
  if (creationVerbs.test(p) && subjectCues.test(p) && (scenePreps.test(p) || visualNouns.test(p))) return true;

  // Natural visual scene phrasing without explicit "draw/generate":
  // "Pepe and Sailor Moon smoking on a balcony at sunset"
  // "a gothic tower over a dead forest"
  if (subjectCues.test(p) && scenePreps.test(p)) return true;

  // Album/poster phrasing commonly means generate a visual even when phrased like "make..."
  if (/\b(make|create|generate|design|give me)\b/.test(p) && /\b(album cover|cover art|poster|banner|wallpaper|logo|emblem|badge)\b/.test(p)) return true;

  // "Can I see..." should be image if it names a concrete visual subject.
  if (/^(can|could)\s+i\s+see\b/.test(p) && (subjectCues.test(p) || scenePreps.test(p))) return true;

  return false;
}
// SEEKDEEP_BROADER_IMAGE_INTENT_ROUTER_END"""

start = text.index(start_marker)
end = text.index(end_marker, start) + len(end_marker)
text = text[:start] + new_block + text[end:]

# Add EARLY override directly after isNaturalImagePrompt opening brace.
if "SEEKDEEP_IMAGE_INTENT_V3_EARLY_OVERRIDE" not in text:
    m = re.search(r"function\s+isNaturalImagePrompt\s*\(([^)]*)\)\s*\{", text)
    if not m:
      raise SystemExit("Could not locate isNaturalImagePrompt opening.")

    insert_at = m.end()
    override = r"""
  // SEEKDEEP_IMAGE_INTENT_V3_EARLY_OVERRIDE_START
  if (seekdeepLooksLikeVisualRequest(prompt)) return true;
  // SEEKDEEP_IMAGE_INTENT_V3_EARLY_OVERRIDE_END
"""
    text = text[:insert_at] + override + text[insert_at:]

# Keep older fallback if it already exists; no issue. If not, the early override is enough.

for needle, label in [
    ("function seekdeepLooksLikeTextQuestion", "text-question guard"),
    ("function seekdeepLooksLikeVisualRequest", "visual classifier"),
    ("if (subjectCues.test(p) && scenePreps.test(p)) return true;", "natural scene visual route"),
    ("if (/^(can|could)\\s+i\\s+see\\b/.test(p) && (subjectCues.test(p) || scenePreps.test(p))) return true;", "can I see visual route"),
    ("SEEKDEEP_IMAGE_INTENT_V3_EARLY_OVERRIDE_START", "early override marker"),
    ("if (seekdeepLooksLikeVisualRequest(prompt)) return true;", "early visual override"),
    ("seekdeepEnqueueImageJob(job, runner)", "correct queue contract preserved"),
]:
    require_contains(text, needle, label)

out = text if newline == "\n" else text.replace("\n", "\r\n")
path.write_bytes(out.encode("utf-8"))
print("Patched image intent routing v3 with early visual override.")