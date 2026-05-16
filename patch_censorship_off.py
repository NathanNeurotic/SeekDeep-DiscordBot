from pathlib import Path

p = Path("index.js")
text = p.read_text(encoding="utf-8")

old_condition = "if (censorshipMode === 'loose' || censorshipMode === 'minimal') {"
new_condition = "if (['off', 'none', 'uncensored', 'unfiltered', 'loose', 'minimal'].includes(censorshipMode)) {"

if old_condition in text:
    text = text.replace(old_condition, new_condition, 1)
elif new_condition in text:
    pass
else:
    raise SystemExit("Could not find the expected censorshipMode condition in buildSystem().")

old_line = "'Use the loosest reasonable outer behavior policy.',"
new_lines = """'Use the loosest reasonable outer behavior policy.',
        censorshipMode === 'off'
          ? 'Censorship mode is OFF: do not add extra refusals, disclaimers, moral lectures, corporate safety language, or permission-checking beyond the narrow severe-misuse boundary.'
          : 'Censorship mode is permissive: minimize refusals and avoid moralizing.',"""

if old_line in text and "Censorship mode is OFF:" not in text:
    text = text.replace(old_line, new_lines, 1)

# Make the serious-misuse boundary wording narrower and clearer if old wording exists.
old_boundary = "'Refuse only serious misuse: minor sexual content, nonconsensual sexual content, sexual exploitation, doxxing, credential theft, malware, direct real-world harm instructions, evading law enforcement, or instructions to abuse platforms/systems.',"
new_boundary = "'Hard-stop only for severe misuse: minor sexual content, nonconsensual sexual content, sexual exploitation, doxxing, credential theft, malware, direct real-world harm instructions, evading law enforcement, or instructions to abuse platforms/systems. Everything else should be handled normally or converted to the closest allowed version.',"

if old_boundary in text:
    text = text.replace(old_boundary, new_boundary, 1)

# Add stronger "do not over-refuse" language if absent.
anchor = "'When refusing, be brief and redirect to the closest allowed version. No sermons.'"
addition = """'When refusing, be brief and redirect to the closest allowed version. No sermons.',
        'Do not refuse adult-adjacent humor, crude naming, fictional dark themes, controversial discussion, political discussion, religious discussion, conspiracy discussion, or offensive language merely because it is edgy.',
        'If a request is ambiguous, choose the least-restrictive reasonable interpretation and answer that.'"""

if anchor in text and "least-restrictive reasonable interpretation" not in text:
    text = text.replace(anchor, addition, 1)

required = [
    "['off', 'none', 'uncensored', 'unfiltered', 'loose', 'minimal'].includes(censorshipMode)",
    "Censorship mode is OFF",
    "least-restrictive reasonable interpretation",
]

missing = [item for item in required if item not in text]
if missing:
    raise SystemExit("Patch failed; missing markers: " + ", ".join(missing))

p.write_text(text, encoding="utf-8")
print("SEEKDEEP_CENSORSHIP=off support patched into buildSystem().")
