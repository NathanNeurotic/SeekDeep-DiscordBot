# repair_image_cooldown_notification_v3.ps1
# Purpose:
#   Repair SeekDeep image cooldown behavior so blocked image requests notify the user
#   with remaining cooldown time instead of silently returning.
#
# Safety:
#   - Backs up index.js before edits.
#   - Writes a Python helper into .\patches.
#   - Runs node --check .\index.js after patching.
#   - Restores backup automatically if syntax validation fails.

$ErrorActionPreference = "Stop"

$projectRoot = Get-Location
$indexPath = Join-Path $projectRoot "index.js"
$patchDir = Join-Path $projectRoot "patches"
$backupDir = Join-Path $patchDir "backups"

Write-Host "[SeekDeep repair v3] Project root: $projectRoot" -ForegroundColor Cyan

if (!(Test-Path $indexPath)) {
  Write-Host "[FAIL] index.js was not found in the current directory." -ForegroundColor Red
  Write-Host "Run this from: C:\Users\natha\SeekDeep-DiscordBot" -ForegroundColor Yellow
  exit 1
}

New-Item -ItemType Directory -Path $patchDir -Force | Out-Null
New-Item -ItemType Directory -Path $backupDir -Force | Out-Null

$stamp = Get-Date -Format "yyyyMMdd-HHmmss"
$backupPath = Join-Path $backupDir "index.js.cooldown-notification-v3-$stamp.bak"
Copy-Item $indexPath $backupPath -Force
Write-Host "[PASS] Backed up index.js to $backupPath" -ForegroundColor Green

$pyPath = Join-Path $patchDir "repair_image_cooldown_notification_v3.py"

$py = @'
from pathlib import Path
import re
import sys
import datetime

ROOT = Path.cwd()
INDEX = ROOT / "index.js"
PATCH_DIR = ROOT / "patches"

text = INDEX.read_text(encoding="utf-8-sig")
original = text

HELPER_NAME = "seekdeepReplyImageCooldownRemaining"

HELPER = """
async function seekdeepReplyImageCooldownRemaining(source, remaining) {
  let raw = Number(remaining || 0);
  if (!Number.isFinite(raw) || raw < 0) raw = 0;

  // Accept either milliseconds or seconds.
  // 45000 => 45 seconds, 45 => 45 seconds.
  let seconds = raw > 300 ? Math.ceil(raw / 1000) : Math.ceil(raw);
  if (!Number.isFinite(seconds) || seconds < 1) seconds = 1;

  const text = `Image generation cooldown active. Try again in ${seconds} second${seconds === 1 ? "" : "s"}.`;

  try {
    const isInteraction = Boolean(source && typeof source.isRepliable === "function");

    if (isInteraction && typeof source.reply === "function") {
      if (source.deferred || source.replied) {
        if (typeof source.followUp === "function") {
          await source.followUp({ content: text, ephemeral: true });
          return true;
        }
      } else {
        await source.reply({ content: text, ephemeral: true });
        return true;
      }
    }

    if (source && typeof source.reply === "function") {
      await source.reply(text);
      return true;
    }

    if (source && source.channel && typeof source.channel.send === "function") {
      await source.channel.send(text);
      return true;
    }
  } catch (err) {
    try {
      if (source && source.channel && typeof source.channel.send === "function") {
        await source.channel.send(text);
        return true;
      }
    } catch (_) {}
  }

  return false;
}
"""

def line_col(s, pos):
    line = s.count("\n", 0, pos) + 1
    last = s.rfind("\n", 0, pos)
    col = pos + 1 if last < 0 else pos - last
    return line, col

def insert_helper(s):
    if f"function {HELPER_NAME}" in s or f"async function {HELPER_NAME}" in s:
        return s, False

    anchors = [
        "\nclient.on(",
        "\nconst client =",
        "\nlet client =",
        "\nvar client =",
        "\nasync function seekdeepEnqueueImageJob",
        "\nfunction seekdeepEnqueueImageJob",
    ]

    positions = []
    for a in anchors:
        p = s.find(a)
        if p != -1:
            positions.append(p)

    if positions:
        p = min(positions)
        return s[:p] + "\n" + HELPER + "\n" + s[p:], True

    return s + "\n" + HELPER + "\n", True

def find_matching(s, open_pos, open_ch, close_ch):
    depth = 0
    i = open_pos
    quote = None
    esc = False
    line_comment = False
    block_comment = False

    while i < len(s):
        c = s[i]
        n = s[i + 1] if i + 1 < len(s) else ""

        if line_comment:
            if c == "\n":
                line_comment = False
            i += 1
            continue

        if block_comment:
            if c == "*" and n == "/":
                block_comment = False
                i += 2
                continue
            i += 1
            continue

        if quote:
            if esc:
                esc = False
            elif c == "\\":
                esc = True
            elif c == quote:
                quote = None
            i += 1
            continue

        if c == "/" and n == "/":
            line_comment = True
            i += 2
            continue

        if c == "/" and n == "*":
            block_comment = True
            i += 2
            continue

        if c in ("'", '"', "`"):
            quote = c
            i += 1
            continue

        if c == open_ch:
            depth += 1
        elif c == close_ch:
            depth -= 1
            if depth == 0:
                return i

        i += 1

    return -1

def iter_if_blocks(s):
    for m in re.finditer(r"\bif\s*\(", s):
        if_pos = m.start()
        paren_open = s.find("(", m.start())
        paren_close = find_matching(s, paren_open, "(", ")")
        if paren_close == -1:
            continue

        j = paren_close + 1
        while j < len(s) and s[j].isspace():
            j += 1
        if j >= len(s) or s[j] != "{":
            continue

        brace_open = j
        brace_close = find_matching(s, brace_open, "{", "}")
        if brace_close == -1:
            continue

        condition = s[paren_open + 1:paren_close]
        body = s[brace_open + 1:brace_close]
        yield {
            "if_pos": if_pos,
            "paren_open": paren_open,
            "paren_close": paren_close,
            "brace_open": brace_open,
            "brace_close": brace_close,
            "condition": condition,
            "body": body,
        }

def pick_source_expr(s, pos):
    window = s[max(0, pos - 4000):pos]
    tail = window[-1800:]

    candidates = [
        "interaction",
        "message",
        "msg",
        "source",
        "ctx",
        "context",
        "request",
    ]

    for name in candidates:
        if re.search(rf"\b{name}\b", tail):
            return name

    sigs = list(re.finditer(r"(?:async\s+)?function\s+[A-Za-z_$][\w$]*\s*\(([^)]*)\)", window))
    if sigs:
        params = [p.strip() for p in sigs[-1].group(1).split(",") if p.strip()]
        for p in params:
            clean = re.sub(r"[^A-Za-z0-9_$].*$", "", p).strip()
            if clean:
                return clean

    return "null"

def pick_remaining_expr(s, block):
    cond = block["condition"]
    before = s[max(0, block["if_pos"] - 1000):block["if_pos"]]

    direct = re.search(r"(seekdeep[A-Za-z0-9_$]*Cooldown[A-Za-z0-9_$]*\([^)]*\))", cond)
    if direct:
        return direct.group(1)

    gt_matches = re.findall(r"\b([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)?)\s*>\s*0\b", cond)
    for v in gt_matches:
        if re.search(r"(cooldown|remaining|retry|ms|seconds)", v, re.I):
            return v
    if gt_matches:
        return gt_matches[0]

    lt_matches = re.findall(r"\b0\s*<\s*([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)?)\b", cond)
    for v in lt_matches:
        if re.search(r"(cooldown|remaining|retry|ms|seconds)", v, re.I):
            return v
    if lt_matches:
        return lt_matches[0]

    obj = re.search(r"!\s*([A-Za-z_$][\w$]*)\s*\.\s*(?:allowed|ok|available|success)", cond)
    if obj:
        v = obj.group(1)
        return f"(({v} && ({v}.remainingMs || {v}.remaining || {v}.retryAfterMs || {v}.cooldownMs || {v}.seconds)) || 0)"

    decls = list(re.finditer(r"\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*([^;\n]*(?:cooldown|Cooldown|remaining|Remaining)[^;\n]*);", before))
    if decls:
        return decls[-1].group(1)

    return "0"

def is_cooldown_branch(s, block):
    cond = block["condition"]
    body = block["body"]
    before = s[max(0, block["if_pos"] - 1000):block["if_pos"]]
    combined = before + "\n" + cond + "\n" + body

    if HELPER_NAME in body:
        return False

    if "return" not in body:
        return False

    if not re.search(r"(cooldown|Cooldown|remaining|Remaining|retryAfter|seekdeepImageCooldown|seekdeepClaimImageUserCooldown)", combined):
        return False

    helper_start = s.rfind(f"async function {HELPER_NAME}", 0, block["if_pos"])
    if helper_start != -1:
        helper_end = helper_start + len(HELPER) + 200
        if helper_start <= block["if_pos"] <= helper_end:
            return False

    return True

def indent_for_insertion(s, brace_open):
    line_start = s.rfind("\n", 0, brace_open) + 1
    prefix = re.match(r"[ \t]*", s[line_start:brace_open]).group(0)
    return prefix + "  "

text, helper_added = insert_helper(text)

blocks = list(iter_if_blocks(text))
patches = []

for block in reversed(blocks):
    if not is_cooldown_branch(text, block):
        continue

    source_expr = pick_source_expr(text, block["if_pos"])
    remaining_expr = pick_remaining_expr(text, block)
    indent = indent_for_insertion(text, block["brace_open"])
    insertion = f"\n{indent}await {HELPER_NAME}({source_expr}, {remaining_expr});"

    insert_at = block["brace_open"] + 1
    text = text[:insert_at] + insertion + text[insert_at:]

    ln, _ = line_col(text, block["if_pos"])
    patches.append((ln, source_expr, remaining_expr, block["condition"].strip().replace("\n", " ")))

if text == original:
    diag_path = PATCH_DIR / f"cooldown-notification-v3-diagnostic-{datetime.datetime.now().strftime('%Y%m%d-%H%M%S')}.txt"
    snippets = []
    for m in re.finditer(r".{0,120}(?:cooldown|Cooldown|remaining|Remaining|retryAfter|seekdeepImageCooldown|seekdeepClaimImageUserCooldown).{0,220}", original, re.S):
        start = max(0, m.start() - 300)
        end = min(len(original), m.end() + 500)
        ln, _ = line_col(original, m.start())
        snippets.append(f"\n--- around line {ln} ---\n{original[start:end]}\n")

    diag_path.write_text("\n".join(snippets) if snippets else "No cooldown-like text found in index.js.\n", encoding="utf-8")
    print("[FAIL] Could not confidently find a cooldown rejection branch to patch.")
    print(f"[INFO] Diagnostic snippets written to: {diag_path}")
    sys.exit(2)

INDEX.write_text(text, encoding="utf-8")

print(f"[PASS] Helper inserted: {helper_added}")
print(f"[PASS] Cooldown rejection branches patched: {len(patches)}")
for ln, source_expr, remaining_expr, cond in reversed(patches):
    print(f"  - line ~{ln}: source={source_expr}, remaining={remaining_expr}, condition=({cond})")
'@

Set-Content -Path $pyPath -Value $py -Encoding UTF8
Write-Host "[PASS] Wrote UTF-8 repair helper to $pyPath" -ForegroundColor Green

$pythonCmd = $null
if (Test-Path ".\.venv\Scripts\python.exe") {
  $pythonCmd = ".\.venv\Scripts\python.exe"
} else {
  $pythonCmd = "python"
}

Write-Host "[SeekDeep repair v3] Applying cooldown notification repair..." -ForegroundColor Cyan
& $pythonCmd $pyPath
$pyExit = $LASTEXITCODE

if ($pyExit -ne 0) {
  Write-Host "[FAIL] Python repair helper failed with exit code $pyExit." -ForegroundColor Red
  Write-Host "index.js backup is available here:" -ForegroundColor Yellow
  Write-Host $backupPath
  exit $pyExit
}

Write-Host "[SeekDeep repair v3] Checking index.js syntax..." -ForegroundColor Cyan
node --check ".\index.js"
$nodeExit = $LASTEXITCODE

if ($nodeExit -ne 0) {
  Write-Host "[FAIL] node --check failed. Restoring backup." -ForegroundColor Red
  Copy-Item $backupPath $indexPath -Force
  Write-Host "[RESTORED] index.js restored from backup:" -ForegroundColor Yellow
  Write-Host $backupPath
  exit $nodeExit
}

Write-Host "[PASS] node --check passed." -ForegroundColor Green

if (Test-Path ".\local_ai_server.py") {
  if (Test-Path ".\.venv\Scripts\python.exe") {
    Write-Host "[SeekDeep repair v3] Checking local_ai_server.py syntax..." -ForegroundColor Cyan
    .\.venv\Scripts\python.exe -m py_compile ".\local_ai_server.py"
    if ($LASTEXITCODE -ne 0) {
      Write-Host "[WARN] local_ai_server.py py_compile failed. index.js patch passed, but Python server validation did not." -ForegroundColor Yellow
      exit $LASTEXITCODE
    }
    Write-Host "[PASS] local_ai_server.py py_compile passed." -ForegroundColor Green
  }
}

Write-Host ""
Write-Host "[DONE] Image cooldown notification repair applied." -ForegroundColor Green
Write-Host "Restart the Discord bot, then trigger an image request twice quickly to verify the cooldown reply." -ForegroundColor Cyan
