from pathlib import Path
from datetime import datetime

path = Path("index.js")
text = path.read_text(encoding="utf-8")

stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
backup = Path(f"index.js.bak-remove-orphan-askchat-fragment-{stamp}")
backup.write_text(text, encoding="utf-8")
print(f"[SeekDeep] Backup written: {backup}")

start_marker = "\n = {}) {\n"
end_marker = "\nasync function askVision"

start = text.find(start_marker)

if start == -1:
    raise SystemExit("Could not find orphan fragment marker: newline + ' = {}) {'")

end = text.find(end_marker, start)

if end == -1:
    raise SystemExit("Could not find askVision after orphan fragment.")

removed = text[start:end]

if "const cleanPrompt = normalizeUserText(prompt);" not in removed:
    raise SystemExit("Safety check failed: orphan block did not look like the duplicated askChat body.")

if "return `${answer}${formatSources(sources)}`.trim();" not in removed:
    raise SystemExit("Safety check failed: orphan block did not contain the duplicated askChat return.")

text = text[:start] + "\n" + text[end:].lstrip()

if "\n = {}) {\n" in text:
    raise SystemExit("Repair failed: orphan marker still exists.")

required = [
    "async function askChat(",
    "async function askVision(",
    "function cleanupAssistantReply(",
    "function hasLoopingOrBrokenReply(",
    "function cleanLoopingReply(",
    "function buildAntiLoopSystem(",
    "async function runLocalChat(",
]

missing = [item for item in required if item not in text]

if missing:
    raise SystemExit("Repair would leave required functions missing: " + ", ".join(missing))

path.write_text(text, encoding="utf-8")

print("[SeekDeep] Removed orphaned askChat fragment.")
print("[SeekDeep] Removed characters:", len(removed))
