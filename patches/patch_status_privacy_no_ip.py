from pathlib import Path
import re
import sys

if len(sys.argv) != 2:
    raise SystemExit("Usage: patch_status_privacy_no_ip.py <index.js>")

path = Path(sys.argv[1])
raw = path.read_bytes()
newline = "\r\n" if b"\r\n" in raw else "\n"
text = raw.decode("utf-8-sig").replace("\r\n", "\n").replace("\r", "\n")

def fail(msg):
    raise SystemExit(msg)

def require(needle, label):
    if needle not in text:
        fail(f"Required anchor not found: {label}")

for needle, label in [
    ("async function statusText()", "statusText function"),
    ("fetchJson(`${LOCAL_AI_BASE_URL}/health`)", "internal health fetch"),
    ("seekdeepEnqueueImageJob(job, runner)", "queue contract"),
]:
    require(needle, label)

if "seekdeepMakeImageQueueJobId" in text:
    fail("Unsafe old queue helper found: seekdeepMakeImageQueueJobId")
if "job.run" in text:
    fail("Unsafe job.run-style queue logic found")

# Insert sanitizer near status metrics helpers.
if "function seekdeepRedactStatusConnectionInfo" not in text:
    helper = r"""
function seekdeepRedactStatusConnectionInfo(value = '') {
  return String(value || '')
    // Full local/private URLs with optional paths.
    .replace(/\bhttps?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\]|10(?:\.\d{1,3}){3}|192\.168(?:\.\d{1,3}){2}|172\.(?:1[6-9]|2\d|3[0-1])(?:\.\d{1,3}){2})(?::\d{1,5})?(?:\/[^\s]*)?/gi, 'local service')
    // Bare local/private host:port.
    .replace(/\b(?:localhost|127\.0\.0\.1|0\.0\.0\.0|10(?:\.\d{1,3}){3}|192\.168(?:\.\d{1,3}){2}|172\.(?:1[6-9]|2\d|3[0-1])(?:\.\d{1,3}){2}):\d{1,5}\b/gi, 'local service')
    // Any leftover explicit loopback labels.
    .replace(/\b(?:127\.0\.0\.1|0\.0\.0\.0|localhost|\[::1\])\b/gi, 'local service');
}

"""
    anchor = "function seekdeepCurrentLoadedModelFromHealth(health = {}) {"
    pos = text.find(anchor)
    if pos < 0:
        fail("Could not locate status helper insertion anchor.")
    text = text[:pos] + helper + text[pos:]

# Remove the explicit Endpoint line from statusText().
text = text.replace("    `Endpoint: ${LOCAL_AI_BASE_URL}`,\n", "")

# Wrap statusText's final joined text with the sanitizer.
# Exact shape in known-good file:
#   return [
#     ...
#   ].join('\n');
if "return seekdeepRedactStatusConnectionInfo([\n    'Local AI server status'," not in text:
    old = "  return [\n    'Local AI server status',"
    new = "  return seekdeepRedactStatusConnectionInfo([\n    'Local AI server status',"
    if old not in text:
        fail("Could not locate statusText return array start.")
    text = text.replace(old, new, 1)

    old_end = "    `Offline model loading: ${health.offline_model_loading ? 'YES' : 'NO'}`,\n  ].join('\\n');\n}"
    new_end = "    `Offline model loading: ${health.offline_model_loading ? 'YES' : 'NO'}`,\n  ].join('\\n'));\n}"
    if old_end not in text:
        fail("Could not locate statusText return array end.")
    text = text.replace(old_end, new_end, 1)

# Validation: statusText body should not contain the Endpoint line anymore.
status_start = text.find("async function statusText()")
status_end = text.find("\n}\n\n// SEEKDEEP_BATCH1_UTILITY_START", status_start)
if status_start < 0 or status_end < 0:
    fail("Could not isolate statusText after patch.")
status_body = text[status_start:status_end]

if "Endpoint:" in status_body:
    fail("Endpoint line still exists in statusText.")
if "LOCAL_AI_BASE_URL}`" in status_body:
    fail("LOCAL_AI_BASE_URL is still directly displayed in statusText.")
if "seekdeepRedactStatusConnectionInfo" not in status_body:
    fail("statusText is not wrapped with connection-info sanitizer.")

for needle, label in [
    ("function seekdeepRedactStatusConnectionInfo", "status connection sanitizer"),
    ("return seekdeepRedactStatusConnectionInfo([", "sanitized status return"),
    ("fetchJson(`${LOCAL_AI_BASE_URL}/health`)", "internal health fetch preserved"),
    ("seekdeepEnqueueImageJob(job, runner)", "queue contract preserved"),
]:
    require(needle, label)

out = text if newline == "\n" else text.replace("\n", "\r\n")
path.write_bytes(out.encode("utf-8"))
print("Patched status output to remove/redact IP and endpoint information.")