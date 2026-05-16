from pathlib import Path
import re
import sys

if len(sys.argv) != 3:
    raise SystemExit("Usage: repair_refined_prompt_duplicate_helpers.py <index.js> <local_ai_server.py>")

index_path = Path(sys.argv[1])
server_path = Path(sys.argv[2])

raw = index_path.read_bytes()
newline = "\r\n" if b"\r\n" in raw else "\n"
text = raw.decode("utf-8-sig").replace("\r\n", "\n").replace("\r", "\n")

server_raw = server_path.read_bytes()
server_text = server_raw.decode("utf-8-sig").replace("\r\n", "\n").replace("\r", "\n")

def require_contains(haystack, needle, label):
    if needle not in haystack:
        raise SystemExit(f"Required marker missing: {label}")

require_contains(text, "function seekdeepEnqueueImageJob(job, runner)", "correct queue contract")
require_contains(text, "SEEKDEEP_VISIBLE_REFINED_PROMPT_FROM_BACKEND_START", "backend refined prompt helper block")
require_contains(text, "SEEKDEEP_VISIBLE_REFINED_PROMPT_FROM_BACKEND_END", "backend refined prompt helper block end")
require_contains(server_text, '"refined_prompt"', "local_ai_server.py refined_prompt return")
require_contains(server_text, '"original_prompt"', "local_ai_server.py original_prompt return")

if "seekdeepMakeImageQueueJobId" in text:
    raise SystemExit("Unsafe old queue helper found: seekdeepMakeImageQueueJobId")
if "job.run" in text:
    raise SystemExit("Unsafe job.run-style queue logic found")

extract_only_block = r"""// SEEKDEEP_VISIBLE_REFINED_PROMPT_FROM_BACKEND_START
function seekdeepExtractRefinedPrompt(...candidates) {
  for (const candidate of candidates) {
    if (!candidate || typeof candidate !== 'object') continue;

    const values = [
      candidate.refined_prompt,
      candidate.refinedPrompt,
      candidate.original_refined_prompt,
      candidate.originalRefinedPrompt,
      candidate.used_prompt,
      candidate.usedPrompt,
    ];

    for (const value of values) {
      const text = String(value || '').trim();
      if (text) return text;
    }
  }

  return '';
}
// SEEKDEEP_VISIBLE_REFINED_PROMPT_FROM_BACKEND_END"""

pattern = re.compile(
    r"// SEEKDEEP_VISIBLE_REFINED_PROMPT_FROM_BACKEND_START.*?// SEEKDEEP_VISIBLE_REFINED_PROMPT_FROM_BACKEND_END",
    re.S,
)

text, count = pattern.subn(extract_only_block, text, count=1)
if count != 1:
    raise SystemExit(f"Expected to replace exactly one backend refined prompt helper block, replaced {count}.")

# There should now be only one global declaration of each of these names.
clip_count = len(re.findall(r"\bfunction\s+seekdeepClipForDiscord\s*\(", text))
line_count = len(re.findall(r"\bfunction\s+seekdeepRefinedPromptLine\s*\(", text))
extract_count = len(re.findall(r"\bfunction\s+seekdeepExtractRefinedPrompt\s*\(", text))

if clip_count != 1:
    raise SystemExit(f"Expected exactly one seekdeepClipForDiscord declaration after repair, found {clip_count}.")
if line_count != 1:
    raise SystemExit(f"Expected exactly one seekdeepRefinedPromptLine declaration after repair, found {line_count}.")
if extract_count != 1:
    raise SystemExit(f"Expected exactly one seekdeepExtractRefinedPrompt declaration after repair, found {extract_count}.")

require_contains(text, "seekdeepRefinedPromptLine(prompt, seekdeepExtractRefinedPrompt(", "final image message refined prompt line")
require_contains(text, "function seekdeepEnqueueImageJob(job, runner)", "correct queue contract after repair")

out = text if newline == "\n" else text.replace("\n", "\r\n")
index_path.write_bytes(out.encode("utf-8"))

print("Repaired duplicate refined prompt helper declarations in index.js.")