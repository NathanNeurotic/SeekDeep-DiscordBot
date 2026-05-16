from pathlib import Path
import re
import sys

if len(sys.argv) != 2:
    raise SystemExit("Usage: patch_image_intent_routing_v2.py <index.js>")

path = Path(sys.argv[1])
raw = path.read_bytes()
newline = "\r\n" if b"\r\n" in raw else "\n"
text = raw.decode("utf-8-sig").replace("\r\n", "\n").replace("\r", "\n")

def require_contains(haystack: str, needle: str, label: str):
    if needle not in haystack:
        raise SystemExit(f"Required anchor not found: {label}")

def find_matching_brace(src, open_index):
    depth = 0
    i = open_index
    in_single = in_double = in_template = False
    in_line_comment = in_block_comment = False
    escape = False

    while i < len(src):
        c = src[i]
        n = src[i + 1] if i + 1 < len(src) else ""

        if in_line_comment:
            if c in "\r\n":
                in_line_comment = False
            i += 1
            continue

        if in_block_comment:
            if c == "*" and n == "/":
                in_block_comment = False
                i += 2
                continue
            i += 1
            continue

        if in_single:
            if escape:
                escape = False
            elif c == "\\":
                escape = True
            elif c == "'":
                in_single = False
            i += 1
            continue

        if in_double:
            if escape:
                escape = False
            elif c == "\\":
                escape = True
            elif c == '"':
                in_double = False
            i += 1
            continue

        if in_template:
            if escape:
                escape = False
            elif c == "\\":
                escape = True
            elif c == "`":
                in_template = False
            i += 1
            continue

        if c == "/" and n == "/":
            in_line_comment = True
            i += 2
            continue

        if c == "/" and n == "*":
            in_block_comment = True
            i += 2
            continue

        if c == "'":
            in_single = True
            i += 1
            continue

        if c == '"':
            in_double = True
            i += 1
            continue

        if c == "`":
            in_template = True
            i += 1
            continue

        if c == "{":
            depth += 1
        elif c == "}":
            depth -= 1
            if depth == 0:
                return i

        i += 1

    raise SystemExit("Could not find matching closing brace.")

def replace_function(src, name, new_func):
    m = re.search(r"function\s+" + re.escape(name) + r"\s*\([^)]*\)\s*\{", src)
    if not m:
        raise SystemExit(f"Could not locate function {name}.")
    open_brace = src.find("{", m.end() - 1)
    close_brace = find_matching_brace(src, open_brace)
    return src[:m.start()] + new_func + src[close_brace + 1:]

require_contains(text, "SEEKDEEP_BROADER_IMAGE_INTENT_ROUTER_START", "v1 broader router marker")
require_contains(text, "function seekdeepLooksLikeTextQuestion", "text question function")
require_contains(text, "function seekdeepLooksLikeVisualRequest", "visual request function")
require_contains(text, "seekdeepEnqueueImageJob(job, runner)", "correct queue contract")
require_contains(text, "post archive", "post archive hard-command context")

if "seekdeepMakeImageQueueJobId" in text:
    raise SystemExit("Unsafe old queue helper found: seekdeepMakeImageQueueJobId")
if "job.run" in text:
    raise SystemExit("Unsafe job.run-style queue logic found")

new_text_question = r"""function seekdeepLooksLikeTextQuestion(prompt = '') {
  const p = String(prompt || '').trim().toLowerCase();
  if (!p) return true;

  // Visual permission / desire phrasing must not be swallowed by chat-question guards.
  if (/^(can|could|would)\s+(i|you|we)\s+(see|get|have|make|create|generate|draw|paint|render|visualize|design)\b/.test(p)) return false;
  if (/^(i\s+want|i'd\s+like|id\s+like|give\s+me|show\s+me|make|create|generate|draw|paint|render|visualize|design)\b/.test(p)) return false;

  return (
    /^(what|who|why|how|when|where|is|are|do|does|did)\b/.test(p) ||
    /\b(explain|summarize|summary|describe in words|tell me about|what is|who is|why is|how do|how to|steps|instructions|guide|advice|compare|difference between|translate|rewrite|proofread|fix this text|code|script|powershell|javascript|python|error|bug|logs?|status|queue status|admin status|cache status|archive status|help|commands)\b/.test(p)
  );
}"""

new_visual_request = r"""function seekdeepLooksLikeVisualRequest(prompt = '') {
  const p = String(prompt || '').trim().toLowerCase();
  if (!p) return false;

  const visualNouns = /\b(image|picture|pic|photo|art|artwork|drawing|illustration|painting|poster|album cover|cover art|banner|wallpaper|logo|icon|emblem|badge|character design|scene|portrait|sticker|thumbnail|concept art|screenshot|visual)\b/i;
  const creationVerbs = /\b(make|create|generate|render|draw|paint|sketch|illustrate|visualize|depict|design|show|give me|turn this into|can i see|could i see|i want|i'd like|id like)\b/i;
  const scenePreps = /\b(of|with|wearing|holding|standing|sitting|smoking|on a|in a|inside|outside|under|over|during|at sunset|at sunrise|at night|in armor|in the style of)\b/i;
  const subjectCues = /\b(pepe|frog|cat|kitten|siamese|dog|dragon|robot|monster|anime|sailor moon|wizard|castle|cathedral|forest|tower|gothic|metal|punk|emo|screamo|hardcore|neon|album|poster|burning|armor|balcony|sunset)\b/i;

  // Explicit visual nouns/verbs override the generic text-question guard.
  if (visualNouns.test(p) && (creationVerbs.test(p) || scenePreps.test(p) || subjectCues.test(p))) return true;
  if (creationVerbs.test(p) && visualNouns.test(p)) return true;
  if (creationVerbs.test(p) && subjectCues.test(p) && scenePreps.test(p)) return true;

  // Natural phrasing without explicit "draw/generate":
  // "Pepe and Sailor Moon smoking on a balcony at sunset"
  // "a gothic tower over a dead forest"
  if (subjectCues.test(p) && scenePreps.test(p) && !seekdeepLooksLikeTextQuestion(p)) return true;

  // Album/poster phrasing commonly means generate a visual even when phrased like "make..."
  if (/\b(make|create|generate|design|give me)\b/.test(p) && /\b(album cover|cover art|poster|banner|wallpaper|logo|emblem|badge)\b/.test(p)) return true;

  // "Can I see..." should be image if it names a concrete visual subject.
  if (/^(can|could)\s+i\s+see\b/.test(p) && subjectCues.test(p)) return true;

  return false;
}"""

text = replace_function(text, "seekdeepLooksLikeTextQuestion", new_text_question)
text = replace_function(text, "seekdeepLooksLikeVisualRequest", new_visual_request)

for needle, label in [
    ("if (/^(can|could|would)\\s+(i|you|we)\\s+(see|get|have|make|create|generate|draw|paint|render|visualize|design)\\b/.test(p)) return false;", "visual permission guard exemption"),
    ("function seekdeepLooksLikeVisualRequest", "visual request function"),
    ("Pepe and Sailor Moon smoking on a balcony at sunset", "comment test case"),
    ("if (/^(can|could)\\s+i\\s+see\\b/.test(p) && subjectCues.test(p)) return true;", "can I see visual route"),
    ("seekdeepEnqueueImageJob(job, runner)", "correct queue contract preserved"),
]:
    require_contains(text, needle, label)

out = text if newline == "\n" else text.replace("\n", "\r\n")
path.write_bytes(out.encode("utf-8"))
print("Patched image intent routing v2.")