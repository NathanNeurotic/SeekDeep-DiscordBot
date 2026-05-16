from pathlib import Path
import re
import sys

if len(sys.argv) != 2:
    raise SystemExit("Usage: repair_async_async_typo.py <index.js>")

path = Path(sys.argv[1])
raw = path.read_bytes()
newline = "\r\n" if b"\r\n" in raw else "\n"
text = raw.decode("utf-8-sig").replace("\r\n", "\n").replace("\r", "\n")

if "seekdeepEnqueueImageJob(job, runner)" not in text:
    raise SystemExit("Required queue contract not found: seekdeepEnqueueImageJob(job, runner)")

if "seekdeepMakeImageQueueJobId" in text:
    raise SystemExit("Unsafe old queue helper found: seekdeepMakeImageQueueJobId")
if "job.run" in text:
    raise SystemExit("Unsafe job.run-style queue logic found")

before = text

# Repair accidental duplicated async tokens, including multiple spaces.
text = re.sub(r"\basync\s+async\s+function\b", "async function", text)

# Defensive cleanup if a future patch produced more than two.
text = re.sub(r"\basync(?:\s+async)+\s+function\b", "async function", text)

if text == before:
    print("No async async typo found; file may already be repaired.")
else:
    print("Repaired async async function typo.")

if "async async function" in text:
    raise SystemExit("async async function still exists after repair.")

# Confirm the target function exists in valid shape.
if "async function seekdeepApplyReplyContextToPrompt" not in text:
    raise SystemExit("Expected async function seekdeepApplyReplyContextToPrompt not found after repair.")

out = text if newline == "\n" else text.replace("\n", "\r\n")
path.write_bytes(out.encode("utf-8"))