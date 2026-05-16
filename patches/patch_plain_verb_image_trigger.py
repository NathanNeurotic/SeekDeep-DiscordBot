from pathlib import Path
import sys

if len(sys.argv) != 2:
    raise SystemExit("Usage: patch_plain_verb_image_trigger.py <index.js>")

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

require_contains(text, "SEEKDEEP_STABILIZED_DISPATCH_HELPERS_START", "stabilized dispatcher marker")
require_contains(text, "function seekdeepHasExplicitImageRequest(p = '')", "explicit image request detector")
require_contains(text, "function seekdeepEnqueueImageJob(job, runner)", "correct image queue contract")
require_contains(text, "function isNaturalImagePrompt(prompt)", "natural image route detector")

if "seekdeepMakeImageQueueJobId" in text:
    raise SystemExit("Unsafe old queue helper found: seekdeepMakeImageQueueJobId")
if "job.run" in text:
    raise SystemExit("Unsafe job.run-style queue logic found")

if "SEEKDEEP_PLAIN_VERB_IMAGE_TRIGGER_START" not in text:
    old = "  if (/\\b(?:draw|sketch|paint|illustrate)\\s+(?:an?\\s+|some\\s+)?\\S+/i.test(text) && seekdeepHasVisualSubjectWords(text)) {\n    return true;\n  }\n\n  return false;\n}"
    new = """  if (/\\b(?:draw|sketch|paint|illustrate)\\s+(?:an?\\s+|some\\s+)?\\S+/i.test(text) && seekdeepHasVisualSubjectWords(text)) {\n    return true;\n  }\n\n  // SEEKDEEP_PLAIN_VERB_IMAGE_TRIGGER_START\n  // Accept direct imperative art requests even when the user does not include\n  // the word \"image\" and even when the subject is a proper noun the visual\n  // subject detector may not recognize yet.\n  // Examples:\n  //   illustrate sailor moon smokin a spliffy with tattoos\n  //   draw a frog wizard\n  //   sketch haunted armor in the rain\n  //   paint a neon skyline\n  if (/^(?:draw|sketch|paint|illustrate|render)\\s+(?:me\\s+)?(?:an?\\s+|some\\s+)?\\S+/i.test(text) && !/\\b(?:image prompt|prompt only|description only)\\b/i.test(text)) {\n    return true;\n  }\n  // SEEKDEEP_PLAIN_VERB_IMAGE_TRIGGER_END\n\n  return false;\n}"""
    text = replace_once(text, old, new, "plain-verb image trigger insertion")

if "@SEEKOTICS illustrate a neon frog wizard" not in text:
    target = "    '@SEEKOTICS /image red dragon',\n"
    if target in text:
        text = text.replace(target, target + "    '@SEEKOTICS illustrate a neon frog wizard',\n", 1)

for needle, label in [
    ("SEEKDEEP_PLAIN_VERB_IMAGE_TRIGGER_START", "plain-verb trigger marker"),
    ("function seekdeepHasExplicitImageRequest(p = '')", "explicit image request detector"),
    ("function isNaturalImagePrompt(prompt)", "natural image route detector"),
    ("function seekdeepEnqueueImageJob(job, runner)", "correct image queue contract"),
]:
    require_contains(text, needle, label)

out = text if newline == "\n" else text.replace("\n", "\r\n")
path.write_bytes(out.encode("utf-8"))
print("Patched index.js with plain-verb image trigger support.")