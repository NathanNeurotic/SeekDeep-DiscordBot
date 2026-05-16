from pathlib import Path
import re
import sys

if len(sys.argv) != 2:
    raise SystemExit("Usage: patch_image_prompt_dedupe_bypass.py <index.js>")

path = Path(sys.argv[1])
raw = path.read_bytes()
newline = "\r\n" if b"\r\n" in raw else "\n"
text = raw.decode("utf-8-sig").replace("\r\n", "\n").replace("\r", "\n")

def require_contains(haystack: str, needle: str, label: str):
    if needle not in haystack:
        raise SystemExit(f"Required anchor not found: {label}")

require_contains(text, "function seekdeepIsPromptDedupeExempt", "dedupe exemption function")
require_contains(text, "function seekdeepLooksLikeVisualRequest", "visual request classifier")
require_contains(text, "seekdeepClaimPromptOnce", "prompt dedupe call")
require_contains(text, "seekdeepEnqueueImageJob(job, runner)", "correct queue contract")
require_contains(text, "post archive", "post archive hard-command context")

if "seekdeepMakeImageQueueJobId" in text:
    raise SystemExit("Unsafe old queue helper found: seekdeepMakeImageQueueJobId")
if "job.run" in text:
    raise SystemExit("Unsafe job.run-style queue logic found")

if "SEEKDEEP_IMAGE_PROMPT_DEDUPE_BYPASS_START" not in text:
    anchor = """  if (!p) return false;

"""
    insert = """  if (!p) return false;

  // SEEKDEEP_IMAGE_PROMPT_DEDUPE_BYPASS_START
  // Image requests already have per-user cooldown handling. Do not let the older
  // prompt-level dedupe silently eat valid image-intent messages.
  if (typeof seekdeepLooksLikeVisualRequest === 'function' && seekdeepLooksLikeVisualRequest(p)) return true;
  if (typeof isNaturalImagePrompt === 'function' && isNaturalImagePrompt(p)) return true;
  // SEEKDEEP_IMAGE_PROMPT_DEDUPE_BYPASS_END

"""
    fn_pos = text.find("function seekdeepIsPromptDedupeExempt")
    if fn_pos < 0:
        raise SystemExit("Could not locate seekdeepIsPromptDedupeExempt.")

    local = text[fn_pos:fn_pos + 1500]
    if anchor not in local:
        raise SystemExit("Could not locate insertion anchor inside seekdeepIsPromptDedupeExempt.")

    text = text[:fn_pos] + local.replace(anchor, insert, 1) + text[fn_pos + len(local):]

for needle, label in [
    ("SEEKDEEP_IMAGE_PROMPT_DEDUPE_BYPASS_START", "image dedupe bypass marker"),
    ("seekdeepLooksLikeVisualRequest(p)", "visual request dedupe bypass"),
    ("isNaturalImagePrompt(p)", "natural image prompt dedupe bypass"),
    ("seekdeepClaimPromptOnce", "prompt dedupe call preserved"),
    ("seekdeepEnqueueImageJob(job, runner)", "queue contract preserved"),
]:
    require_contains(text, needle, label)

out = text if newline == "\n" else text.replace("\n", "\r\n")
path.write_bytes(out.encode("utf-8"))
print("Patched image prompt dedupe bypass.")