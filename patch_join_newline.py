from pathlib import Path
import re

p = Path("index.js")
text = p.read_text(encoding="utf-8")

# Remove leftover standalone async lines if present.
text = re.sub(r"(?m)^\s*async\s*$\r?\n?", "", text)

# Fix bad JS string literals produced by a previous patch:
#   ].join('
#   ')
# into:
#   ].join('\n')
text = re.sub(r"\.join\('\r?\n'\)", r".join('\\n')", text)
text = re.sub(r'\.join\("\r?\n"\)', r'.join("\\n")', text)

# Also fix variants with whitespace around the newline inside the quotes.
text = re.sub(r"\.join\('\s*\r?\n\s*'\)", r".join('\\n')", text)
text = re.sub(r'\.join\("\s*\r?\n\s*"\)', r'.join("\\n")', text)

# Fix the exact common broken multi-line form around arrays.
text = text.replace("].join('\n')", "].join('\\n')")

p.write_text(text, encoding="utf-8")

# Check the specific broken pattern is gone.
bad = re.search(r"\.join\(['\"]\s*\r?\n\s*['\"]\)", text)
if bad:
    raise SystemExit("Malformed multiline .join string still exists.")

print("Malformed .join newline syntax repaired.")
