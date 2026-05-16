from pathlib import Path
import sys

if len(sys.argv) != 2:
    raise SystemExit("Usage: repair_apostrophe_syntax.py <index.js>")

path = Path(sys.argv[1])
raw = path.read_bytes()
newline = "\r\n" if b"\r\n" in raw else "\n"
text = raw.decode("utf-8-sig").replace("\r\n", "\n").replace("\r", "\n")

before = text

# Repair the exact broken single-quoted JavaScript string.
text = text.replace(
    "const answer = 'Yes. Send the exact thing you want searched or compared. For product specs, generations, prices, or current info, I'll use web search instead of guessing.';",
    "const answer = \"Yes. Send the exact thing you want searched or compared. For product specs, generations, prices, or current info, I'll use web search instead of guessing.\";"
)

# Repair mojibake variant if it exists inside the JS source.
text = text.replace(
    "const answer = 'Yes. Send the exact thing you want searched or compared. For product specs, generations, prices, or current info, IÃ¢â‚¬â„¢ll use web search instead of guessing.';",
    "const answer = \"Yes. Send the exact thing you want searched or compared. For product specs, generations, prices, or current info, I'll use web search instead of guessing.\";"
)

# Repair any escaped/half-repaired variants to one canonical double-quoted line.
text = text.replace(
    "const answer = 'Yes. Send the exact thing you want searched or compared. For product specs, generations, prices, or current info, I\\'ll use web search instead of guessing.';",
    "const answer = \"Yes. Send the exact thing you want searched or compared. For product specs, generations, prices, or current info, I'll use web search instead of guessing.\";"
)

if text == before:
    raise SystemExit("No matching broken apostrophe line was found. Upload current index.js if node --check still fails.")

if "current info, I'll use web search instead of guessing.\"" not in text:
    raise SystemExit("Canonical repaired string not found after patch.")

out = text if newline == "\n" else text.replace("\n", "\r\n")
path.write_bytes(out.encode("utf-8"))
print("Repaired broken apostrophe syntax.")