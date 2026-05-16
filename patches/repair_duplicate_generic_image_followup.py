from pathlib import Path
import re
import sys

if len(sys.argv) != 2:
    raise SystemExit("Usage: repair_duplicate_generic_image_followup.py <index.js>")

path = Path(sys.argv[1])
raw = path.read_bytes()
newline = "\r\n" if b"\r\n" in raw else "\n"
text = raw.decode("utf-8-sig").replace("\r\n", "\n").replace("\r", "\n")

def require_contains(haystack: str, needle: str, label: str):
    if needle not in haystack:
        raise SystemExit(f"Required anchor not found: {label}")

for needle, label in [
    ("function seekdeepIsGenericImageFollowupPrompt", "generic image follow-up helper"),
    ("seekdeepEnqueueImageJob(job, runner)", "correct image queue contract"),
]:
    require_contains(text, needle, label)

if "seekdeepMakeImageQueueJobId" in text:
    raise SystemExit("Unsafe old queue helper found: seekdeepMakeImageQueueJobId")
if "job.run" in text:
    raise SystemExit("Unsafe job.run-style queue logic found")

canonical = r"""function seekdeepIsGenericImageFollowupPrompt(prompt = '') {
  const p = normalizeUserText(prompt).toLowerCase().trim();
  return /^(generate|create|make|draw|paint|sketch|illustrate|render|show)(\s+me)?(?:\s+(an?\s+)?(image|picture|pic|art|drawing|illustration|it|that|this))?$/i.test(p);
}"""

pattern = re.compile(r"function\s+seekdeepIsGenericImageFollowupPrompt\s*\(\s*prompt\s*=\s*''\s*\)\s*\{[\s\S]*?\n\}", re.MULTILINE)
matches = list(pattern.finditer(text))

if len(matches) < 2:
    # If there is only one, still normalize it to the canonical version.
    if len(matches) == 1:
        m = matches[0]
        text = text[:m.start()] + canonical + text[m.end():]
    else:
        raise SystemExit("No seekdeepIsGenericImageFollowupPrompt function matched the repair pattern.")
else:
    pieces = []
    last = 0
    for i, m in enumerate(matches):
        pieces.append(text[last:m.start()])
        if i == 0:
            pieces.append(canonical)
        else:
            # Drop duplicate function declaration. Preserve spacing lightly.
            pieces.append("")
        last = m.end()
    pieces.append(text[last:])
    text = "".join(pieces)

# Clean up excess blank lines caused by removing duplicate helper.
text = re.sub(r"\n{4,}", "\n\n\n", text)

# Verify exactly one declaration remains.
count = text.count("function seekdeepIsGenericImageFollowupPrompt")
if count != 1:
    raise SystemExit(f"Expected exactly one seekdeepIsGenericImageFollowupPrompt declaration, found {count}.")

for needle, label in [
    ("function seekdeepIsGenericImageFollowupPrompt", "canonical helper remains"),
    ("(?:\\s+(an?\\s+)?(image|picture|pic|art|drawing|illustration|it|that|this))?", "bare generate optional target support"),
    ("seekdeepEnqueueImageJob(job, runner)", "queue contract preserved"),
]:
    require_contains(text, needle, label)

out = text if newline == "\n" else text.replace("\n", "\r\n")
path.write_bytes(out.encode("utf-8"))
print("Repaired duplicate seekdeepIsGenericImageFollowupPrompt declaration.")