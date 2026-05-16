from pathlib import Path
import re
import sys

if len(sys.argv) != 2:
    raise SystemExit("Usage: repair_regenerate_button_cooldown_v2_syntax.py <index.js>")

path = Path(sys.argv[1])
raw = path.read_bytes()
newline = "\r\n" if b"\r\n" in raw else "\n"
text = raw.decode("utf-8-sig")
text = text.replace("\r\n", "\n").replace("\r", "\n")

def require_contains(haystack, needle, label):
    if needle not in haystack:
        raise SystemExit(f"Required anchor not found: {label}")

require_contains(text, "function seekdeepEnqueueImageJob(job, runner)", "correct queue contract")
require_contains(text, "SEEKDEEP_REGENERATE_QUEUE_COOLDOWN_GATE_START", "regenerate queue cooldown gate")
require_contains(text, "seekdeepNotifyRegenerateJobCooldown", "regenerate cooldown notifier")

if "seekdeepMakeImageQueueJobId" in text:
    raise SystemExit("Unsafe old queue helper found: seekdeepMakeImageQueueJobId")
if "job.run" in text:
    raise SystemExit("Unsafe job.run-style queue logic found")

old = "      await seekdeepNotifyRegenerateJobCooldown(job, seekdeepRegenCooldownRemaining);\n      return null;"
new = """      Promise.resolve(seekdeepNotifyRegenerateJobCooldown(job, seekdeepRegenCooldownRemaining))
        .catch((err) => console.warn('Regenerate cooldown notification failed:', err?.message || err));
      return null;"""

count = text.count(old)
if count != 1:
    raise SystemExit(f"Expected exactly one invalid await notification call, found {count}.")

text = text.replace(old, new, 1)

# Guard against this exact invalid await returning.
if "await seekdeepNotifyRegenerateJobCooldown(job, seekdeepRegenCooldownRemaining);" in text:
    raise SystemExit("Invalid await notification call still present after repair.")

require_contains(text, "Promise.resolve(seekdeepNotifyRegenerateJobCooldown(job, seekdeepRegenCooldownRemaining))", "fire-and-forget cooldown notifier")
require_contains(text, "return null;", "cooldown gate still blocks regenerate job")
require_contains(text, "function seekdeepEnqueueImageJob(job, runner)", "queue contract preserved")

out = text if newline == "\n" else text.replace("\n", "\r\n")
path.write_bytes(out.encode("utf-8"))
print("Repaired invalid await inside non-async regenerate queue cooldown gate.")