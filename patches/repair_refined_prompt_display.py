from pathlib import Path
import re
import sys

if len(sys.argv) != 2:
    raise SystemExit("Usage: repair_refined_prompt_display.py <index.js>")

path = Path(sys.argv[1])
raw = path.read_bytes()
newline = "\r\n" if b"\r\n" in raw else "\n"
text = raw.decode("utf-8-sig").replace("\r\n", "\n").replace("\r", "\n")

def require_contains(haystack, needle, label):
    if needle not in haystack:
        raise SystemExit(f"Required anchor not found: {label}")

require_contains(text, "function seekdeepRefinedPromptLine", "refined prompt line helper")
require_contains(text, "function seekdeepExtractRefinedPrompt", "refined prompt extractor helper")
require_contains(text, "async function makeImageResult", "makeImageResult")
require_contains(text, "refinedPrompt: promptInfo.refinedPrompt", "makeImageResult refinedPrompt return")
require_contains(text, "Regenerated locally:", "regenerated image output")
require_contains(text, "Generated locally:", "generated image output")

patched = 0

# Patch generated image branches that currently lack a refined prompt line.
patterns = [
    (
        "`Generated locally: ${prompt}`,\n        `Queue Wait:",
        "`Generated locally: ${prompt}`,\n        seekdeepRefinedPromptLine(prompt, seekdeepExtractRefinedPrompt(result, normalized)),\n        `Queue Wait:",
    ),
    (
        "`Regenerated locally: ${prompt}`,\n        `Queue Wait:",
        "`Regenerated locally: ${prompt}`,\n        seekdeepRefinedPromptLine(prompt, seekdeepExtractRefinedPrompt(result, normalized)),\n        `Queue Wait:",
    ),
    (
        "`Regenerated locally: ${state.prompt}`,\n              `Queue Wait:",
        "`Regenerated locally: ${state.prompt}`,\n              seekdeepRefinedPromptLine(state.prompt, seekdeepExtractRefinedPrompt(result, normalized)),\n              `Queue Wait:",
    ),
    (
        "`Generated locally: ${state.prompt}`,\n              `Queue Wait:",
        "`Generated locally: ${state.prompt}`,\n              seekdeepRefinedPromptLine(state.prompt, seekdeepExtractRefinedPrompt(result, normalized)),\n              `Queue Wait:",
    ),
]

for old, new in patterns:
    count = text.count(old)
    if count:
        text = text.replace(old, new)
        patched += count

# Extra robust fallback: patch any generated/regenerated array item immediately followed by Queue Wait
# if it does not already have seekdeepRefinedPromptLine in between.
def patch_missing_refined(match):
    global patched
    first = match.group(1)
    queue = match.group(2)
    middle = match.group(3)
    if "seekdeepRefinedPromptLine" in middle:
        return match.group(0)

    prompt_expr = "prompt"
    if "${state.prompt}" in first:
        prompt_expr = "state.prompt"

    indent_match = re.match(r"(\s*)", queue)
    indent = indent_match.group(1) if indent_match else "        "
    patched += 1
    return first + "\n" + indent + f"seekdeepRefinedPromptLine({prompt_expr}, seekdeepExtractRefinedPrompt(result, normalized))," + "\n" + queue

regex = re.compile(
    r"(`(?:Generated|Regenerated) locally: \$\{(?:state\.)?prompt\}`,)"
    r"(?P<middle>\n(?:\s*(?!`Queue Wait:).*\n){0,5}?)"
    r"(\s*`Queue Wait:)",
    re.M,
)

# The named group makes manual function above awkward; use a simpler loop.
out = []
last = 0
for m in regex.finditer(text):
    first = m.group(1)
    middle = m.group("middle")
    queue = m.group(3)
    if "seekdeepRefinedPromptLine" in middle:
        continue
    prompt_expr = "state.prompt" if "${state.prompt}" in first else "prompt"
    indent = re.match(r"(\s*)", queue).group(1)
    replacement = first + middle + indent + f"seekdeepRefinedPromptLine({prompt_expr}, seekdeepExtractRefinedPrompt(result, normalized)),\n" + queue
    out.append(text[last:m.start()])
    out.append(replacement)
    last = m.end()
    patched += 1

if out:
    out.append(text[last:])
    text = "".join(out)

if patched < 1:
    raise SystemExit("No missing refined prompt display branch was patched. It may already be patched or the live file shape changed.")

# Confirm the specific known button-regenerate channel-send branch is patched if present.
if "`Regenerated locally: ${state.prompt}`" in text:
    idx = text.find("`Regenerated locally: ${state.prompt}`")
    nearby = text[idx:idx + 500]
    if "seekdeepRefinedPromptLine(state.prompt" not in nearby:
        raise SystemExit("Regenerate button output still lacks refined prompt line after patch.")

if "`Generated locally: ${prompt}`" in text:
    # At least one branch can already be patched, this is just a soft structural check.
    pass

require_contains(text, "seekdeepRefinedPromptLine(state.prompt, seekdeepExtractRefinedPrompt(result, normalized))", "button regenerate refined prompt line")
require_contains(text, "seekdeepRefinedPromptLine(prompt, seekdeepExtractRefinedPrompt(result, normalized))", "prompt refined prompt line")

out_text = text if newline == "\n" else text.replace("\n", "\r\n")
path.write_bytes(out_text.encode("utf-8"))
print(f"Patched {patched} missing refined prompt display branch(es).")