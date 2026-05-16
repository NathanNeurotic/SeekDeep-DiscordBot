from pathlib import Path
import re
import sys

if len(sys.argv) != 2:
    raise SystemExit("Usage: repair_const_prompt_assignment.py <index.js>")

path = Path(sys.argv[1])
raw = path.read_bytes()
newline = "\r\n" if b"\r\n" in raw else "\n"
text = raw.decode("utf-8-sig").replace("\r\n", "\n").replace("\r", "\n")

def require_contains(haystack: str, needle: str, label: str):
    if needle not in haystack:
        raise SystemExit(f"Required anchor not found: {label}")

for needle, label in [
    ("client.on('messageCreate'", "messageCreate handler"),
    ("seekdeepApplyReplyContextToPrompt(message, prompt)", "reply-context patch hook"),
    ("prompt = seekdeepReplyPromptInfo.prompt;", "assignment that needs mutable prompt"),
    ("seekdeepEnqueueImageJob(job, runner)", "correct image queue contract"),
]:
    require_contains(text, needle, label)

if "seekdeepMakeImageQueueJobId" in text:
    raise SystemExit("Unsafe old queue helper found: seekdeepMakeImageQueueJobId")
if "job.run" in text:
    raise SystemExit("Unsafe job.run-style queue logic found")

msg_start = text.find("client.on('messageCreate'")
if msg_start < 0:
    raise SystemExit("Could not locate messageCreate handler.")

hook_pos = text.find("seekdeepApplyReplyContextToPrompt(message, prompt)", msg_start)
if hook_pos < 0:
    raise SystemExit("Could not locate reply-context hook inside messageCreate.")

# Search backwards from the reply-context hook to find the prompt declaration in the same handler.
prefix_start = max(msg_start, hook_pos - 6000)
prefix = text[prefix_start:hook_pos]

patterns = [
    r"(?m)^(?P<indent>\s*)const\s+prompt\s*=\s*normalizeUserText\([^\n]*\);\s*$",
    r"(?m)^(?P<indent>\s*)const\s+prompt\s*=\s*seekdeepCleanImageModeTokens\([^\n]*\);\s*$",
    r"(?m)^(?P<indent>\s*)const\s+prompt\s*=\s*[^\n]+;\s*$",
]

match = None
for pat in patterns:
    matches = list(re.finditer(pat, prefix))
    if matches:
        match = matches[-1]
        break

if not match:
    # Maybe it was already repaired.
    if re.search(r"(?m)^\s*let\s+prompt\s*=", prefix):
        print("Prompt declaration is already mutable; no const prompt assignment repair needed.")
        out = text if newline == "\n" else text.replace("\n", "\r\n")
        path.write_bytes(out.encode("utf-8"))
        raise SystemExit(0)
    raise SystemExit("Could not find const prompt declaration before reply-context assignment.")

absolute_start = prefix_start + match.start()
absolute_end = prefix_start + match.end()
line = text[absolute_start:absolute_end]

if "const prompt" not in line:
    raise SystemExit("Matched prompt declaration does not contain const prompt.")

new_line = line.replace("const prompt", "let prompt", 1)
text = text[:absolute_start] + new_line + text[absolute_end:]

# Verify the prompt declaration before the hook is now let.
new_prefix = text[prefix_start:hook_pos + 300]
if "prompt = seekdeepReplyPromptInfo.prompt;" not in new_prefix:
    raise SystemExit("Reply-context assignment not found after repair.")
if re.search(r"(?m)^\s*const\s+prompt\s*=", new_prefix):
    raise SystemExit("A const prompt declaration still exists near the reply-context hook.")
if not re.search(r"(?m)^\s*let\s+prompt\s*=", new_prefix):
    raise SystemExit("Could not verify mutable let prompt declaration near the reply-context hook.")

out = text if newline == "\n" else text.replace("\n", "\r\n")
path.write_bytes(out.encode("utf-8"))
print("Repaired const prompt declaration to let prompt.")