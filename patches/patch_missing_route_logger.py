from pathlib import Path
import sys

if len(sys.argv) != 2:
    raise SystemExit("Usage: patch_missing_route_logger.py <index.js>")

path = Path(sys.argv[1])
raw = path.read_bytes()
newline = "\r\n" if b"\r\n" in raw else "\n"
text = raw.decode("utf-8-sig").replace("\r\n", "\n").replace("\r", "\n")

if "seekdeepLogRoute" not in text:
    raise SystemExit("index.js does not reference seekdeepLogRoute; wrong failure state or already changed.")

helpers = r"""function seekdeepNowMs() {
  return Date.now();
}

function seekdeepNoModelLabel() {
  if (typeof SEEKDEEP_NO_MODEL_USED_LABEL !== 'undefined') {
    return SEEKDEEP_NO_MODEL_USED_LABEL;
  }
  return 'local command (no AI model)';
}

function seekdeepLogRoute(route, prompt = '') {
  const safeRoute = String(route || 'unknown').trim() || 'unknown';
  const safePrompt = String(prompt || '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 500);

  try {
    console.log(`[SeekDeep] route=${safeRoute} prompt=${safePrompt}`);
  } catch {}
}
"""

insert_pos = -1

# Prefer inserting before message handlers so all routes see it.
for needle in ["client.on('messageCreate'", 'client.on("messageCreate"', "client.on('interactionCreate'", 'client.on("interactionCreate"']:
    insert_pos = text.find(needle)
    if insert_pos >= 0:
        break

if insert_pos < 0:
    raise SystemExit("Could not find client handler insertion point.")

if "function seekdeepNowMs" not in text:
    text = text[:insert_pos] + helpers + "\n\n" + text[insert_pos:]
else:
    missing = []
    if "function seekdeepNoModelLabel" not in text:
        missing.append(r"""function seekdeepNoModelLabel() {
  if (typeof SEEKDEEP_NO_MODEL_USED_LABEL !== 'undefined') {
    return SEEKDEEP_NO_MODEL_USED_LABEL;
  }
  return 'local command (no AI model)';
}""")
    if "function seekdeepLogRoute" not in text:
        missing.append(r"""function seekdeepLogRoute(route, prompt = '') {
  const safeRoute = String(route || 'unknown').trim() || 'unknown';
  const safePrompt = String(prompt || '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 500);

  try {
    console.log(`[SeekDeep] route=${safeRoute} prompt=${safePrompt}`);
  } catch {}
}""")
    if missing:
        text = text[:insert_pos] + "\n\n".join(missing) + "\n\n" + text[insert_pos:]

for needle, label in [
    ("function seekdeepLogRoute", "route logger"),
    ("function seekdeepNoModelLabel", "no-model helper"),
    ("function seekdeepNowMs", "timestamp helper"),
]:
    if needle not in text:
        raise SystemExit(f"Missing required helper after patch: {label}")

for bad in ["}, target = null) {", "state = {) {", "state = {,"]:
    if bad in text:
        raise SystemExit(f"Malformed code detected after patch: {bad}")

out = text if newline == "\n" else text.replace("\n", "\r\n")
path.write_bytes(out.encode("utf-8"))
print("Patched missing route logger helpers.")