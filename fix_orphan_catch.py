from pathlib import Path
import re
import subprocess
import sys

p = Path("index.js")

def run_check():
    proc = subprocess.run(
        ["node", "--check", "index.js"],
        text=True,
        capture_output=True,
        shell=False,
    )
    return proc.returncode, proc.stdout, proc.stderr

def show_area(lines, line_no, radius=10):
    start = max(1, line_no - radius)
    end = min(len(lines), line_no + radius)
    for n in range(start, end + 1):
        print(f"{n:5}: {lines[n-1]}")

code, out, err = run_check()

if code == 0:
    print("index.js already passes node --check. No orphan catch repair needed.")
    sys.exit(0)

combined = (out or "") + "\n" + (err or "")
m = re.search(r"index\.js:(\d+)", combined)

if not m:
    print(combined)
    raise SystemExit("Could not find failing line number from node --check output.")

line_no = int(m.group(1))
text = p.read_text(encoding="utf-8")
lines = text.splitlines()

if line_no < 1 or line_no > len(lines):
    print(combined)
    raise SystemExit(f"Reported line {line_no} is outside file length {len(lines)}.")

line = lines[line_no - 1]
print(f"node --check reports syntax error at line {line_no}: {line}")

if not re.match(r"^\s*catch\b", line):
    print("\nNearby source:")
    show_area(lines, line_no)
    print("\nRaw node --check output:")
    print(combined)
    raise SystemExit("Failing line is not a catch line. Refusing to guess.")

# Remove only the failing catch block.
start_idx = line_no - 1
end_idx = start_idx

# Case 1: one-line catch, e.g. catch {} or catch (err) {}
if re.match(r"^\s*catch(?:\s*\([^)]*\))?\s*\{\s*\}\s*$", line):
    end_idx = start_idx
else:
    # Multi-line catch block. Remove from catch line through its matching closing brace.
    joined_after = "\n".join(lines[start_idx:])
    first_brace = joined_after.find("{")
    if first_brace == -1:
        raise SystemExit("Catch line has no opening brace. Refusing to guess.")

    depth = 0
    found = False
    for i in range(start_idx, len(lines)):
        scan = lines[i]
        # This simple scan is okay for catch-repair because we only remove the reported catch block.
        depth += scan.count("{")
        depth -= scan.count("}")
        if i >= start_idx and depth <= 0 and "{" in "\n".join(lines[start_idx:i+1]):
            end_idx = i
            found = True
            break

    if not found:
        raise SystemExit("Could not find end of catch block. Refusing to guess.")

print(f"Removing orphan catch block lines {start_idx + 1}-{end_idx + 1}.")

new_lines = lines[:start_idx] + lines[end_idx + 1:]
p.write_text("\n".join(new_lines) + "\n", encoding="utf-8")

code2, out2, err2 = run_check()

if code2 != 0:
    print("\nnode --check still fails after removing orphan catch. Output:")
    print((out2 or "") + "\n" + (err2 or ""))
    raise SystemExit("index.js still has a syntax issue. Backup was preserved.")

print("index.js now passes node --check.")

# Show repaired area around where the catch used to be.
fixed_lines = p.read_text(encoding="utf-8").splitlines()
print("\nRepaired area:")
show_area(fixed_lines, min(line_no, len(fixed_lines)), radius=8)
