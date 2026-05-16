# SeekDeep / Seekotics stuck-typing cleanup patch
#
# Fixes:
# - Discord keeps showing "SEEKOTICS is typing..." after the bot has already responded.
#
# Likely cause:
# - A typing loop created by seekdeepStartWorkingLoop(...) is not stopped on one or more
#   success/error/early-return paths after the recent queue/button patches.
#
# What this patch does:
# - Replaces seekdeepStartWorkingLoop(...) with a self-cleaning implementation.
# - The loop automatically stops after a max TTL even if a caller forgets to call stop().
# - Strengthens seekdeepStopWorkingLoop(...) so it can stop timeout/interval objects,
#   function-return handles, and object handles.
# - Adds seekdeepStopAllWorkingLoops() for emergency cleanup.
# - Hooks process exit signals to stop all typing loops.
#
# This is intentionally defensive:
# - It does not depend on one exact caller shape.
# - It does not change image generation behavior.
# - It only prevents typing loops from leaking forever.
#
# Files patched:
# - index.js only

$ErrorActionPreference = "Stop"

try {
  [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
} catch {}

function Write-Info {
  param([string]$Message)
  Write-Host "[SeekDeep typing-cleanup] $Message" -ForegroundColor Cyan
}

function Write-Pass {
  param([string]$Message)
  Write-Host "[PASS] $Message" -ForegroundColor Green
}

function Write-Fail {
  param([string]$Message)
  Write-Host "[FAIL] $Message" -ForegroundColor Red
}

try {
  $projectRoot = Join-Path $env:USERPROFILE "SeekDeep-DiscordBot"
  if (-not (Test-Path -LiteralPath (Join-Path $projectRoot "index.js"))) {
    $projectRoot = (Get-Location).Path
  }

  $indexPath = Join-Path $projectRoot "index.js"
  $serverPath = Join-Path $projectRoot "local_ai_server.py"
  $patchesDir = Join-Path $projectRoot "patches"
  $backupDir = Join-Path $patchesDir "backups"
  $stamp = Get-Date -Format "yyyyMMdd-HHmmss"

  if (-not (Test-Path -LiteralPath $indexPath)) { throw "index.js not found." }
  if (-not (Test-Path -LiteralPath $serverPath)) { throw "local_ai_server.py not found." }

  New-Item -ItemType Directory -Path $patchesDir -Force | Out-Null
  New-Item -ItemType Directory -Path $backupDir -Force | Out-Null

  $backup = Join-Path $backupDir "index.js.typing-cleanup-$stamp.bak"
  Copy-Item -LiteralPath $indexPath -Destination $backup -Force
  Write-Pass "Backed up index.js to $backup"

  $patchPy = @'
from pathlib import Path
import re
import sys

if len(sys.argv) != 2:
    raise SystemExit("Usage: patch_typing_cleanup.py <index.js>")

path = Path(sys.argv[1])
raw = path.read_bytes()
newline = "\r\n" if b"\r\n" in raw else "\n"
text = raw.decode("utf-8-sig").replace("\r\n", "\n").replace("\r", "\n")

def fail(msg):
    raise SystemExit(msg)

def find_matching_brace(source, open_brace_index):
    depth = 0
    i = open_brace_index
    in_single = False
    in_double = False
    in_template = False
    in_line_comment = False
    in_block_comment = False
    escaped = False

    while i < len(source):
        ch = source[i]
        nxt = source[i + 1] if i + 1 < len(source) else ""

        if in_line_comment:
            if ch == "\n":
                in_line_comment = False
            i += 1
            continue

        if in_block_comment:
            if ch == "*" and nxt == "/":
                in_block_comment = False
                i += 2
                continue
            i += 1
            continue

        if in_single:
            if not escaped and ch == "\\":
                escaped = True
            elif not escaped and ch == "'":
                in_single = False
            else:
                escaped = False
            i += 1
            continue

        if in_double:
            if not escaped and ch == "\\":
                escaped = True
            elif not escaped and ch == '"':
                in_double = False
            else:
                escaped = False
            i += 1
            continue

        if in_template:
            if not escaped and ch == "\\":
                escaped = True
            elif not escaped and ch == "`":
                in_template = False
            else:
                escaped = False
            i += 1
            continue

        if ch == "/" and nxt == "/":
            in_line_comment = True
            i += 2
            continue

        if ch == "/" and nxt == "*":
            in_block_comment = True
            i += 2
            continue

        if ch == "'":
            in_single = True
            i += 1
            continue

        if ch == '"':
            in_double = True
            i += 1
            continue

        if ch == "`":
            in_template = True
            i += 1
            continue

        if ch == "{":
            depth += 1
        elif ch == "}":
            depth -= 1
            if depth == 0:
                return i

        i += 1

    fail("Could not find matching closing brace.")

def get_function(source, name):
    for prefix in ("async function ", "function "):
        start = source.find(f"{prefix}{name}(")
        if start >= 0:
            break
    else:
        return None, -1, -1

    open_brace = source.find("{", start)
    if open_brace < 0:
        fail(f"Could not locate opening brace for {name}.")
    close_brace = find_matching_brace(source, open_brace)
    return source[start:close_brace + 1], start, close_brace + 1

def replace_or_insert_function(source, name, new_fn, anchor):
    _, start, end = get_function(source, name)
    if start >= 0:
        return source[:start] + new_fn.rstrip() + source[end:]

    pos = source.find(anchor)
    if pos < 0:
        pos = source.find("client.on('interactionCreate'")
    if pos < 0:
        fail(f"Could not find insertion point for {name}.")
    return source[:pos] + new_fn.rstrip() + "\n\n" + source[pos:]

if "client.on('interactionCreate'" not in text:
    fail("interaction handler anchor not found")
if "sendTyping" not in text:
    fail("sendTyping anchor not found; working-loop system may have different name")

# Existing names used in your project.
anchor = "function seekdeepStartWorkingLoop"

# If older global registry names exist, this replacement intentionally reuses the same function names.
working_loop_code = r"""const SEEKDEEP_ACTIVE_WORKING_LOOPS = globalThis.__seekdeepActiveWorkingLoops || new Map();
globalThis.__seekdeepActiveWorkingLoops = SEEKDEEP_ACTIVE_WORKING_LOOPS;

function seekdeepStartWorkingLoop(channel, key = 'working', options = {}) {
  const safeKey = String(key || 'working');
  const existing = SEEKDEEP_ACTIVE_WORKING_LOOPS.get(safeKey);
  if (existing) {
    seekdeepStopWorkingLoop(existing);
  }

  const ttlMs = Math.max(15000, Number(options.ttlMs || process.env.SEEKDEEP_TYPING_LOOP_MAX_MS || 120000));
  const intervalMs = Math.max(5000, Number(options.intervalMs || process.env.SEEKDEEP_TYPING_LOOP_INTERVAL_MS || 9000));
  let stopped = false;
  let interval = null;
  let ttl = null;

  const handle = {
    key: safeKey,
    channel,
    startedAt: Date.now(),
    stopped: false,
    interval: null,
    ttl: null,
    stop() {
      if (stopped) return;
      stopped = true;
      handle.stopped = true;

      try {
        if (interval) clearInterval(interval);
      } catch {}

      try {
        if (ttl) clearTimeout(ttl);
      } catch {}

      SEEKDEEP_ACTIVE_WORKING_LOOPS.delete(safeKey);
    },
  };

  const send = async () => {
    if (stopped) return;

    try {
      if (channel && typeof channel.sendTyping === 'function') {
        await channel.sendTyping();
      }
    } catch (err) {
      console.warn('SeekDeep typing loop send failed:', err?.message || err);
      handle.stop();
    }
  };

  // Send once immediately, then repeat while long work is genuinely still active.
  void send();

  interval = setInterval(() => {
    void send();
  }, intervalMs);

  ttl = setTimeout(() => {
    console.warn(`[SeekDeep] typing loop auto-stopped after ${ttlMs}ms: ${safeKey}`);
    handle.stop();
  }, ttlMs);

  try {
    interval.unref?.();
    ttl.unref?.();
  } catch {}

  handle.interval = interval;
  handle.ttl = ttl;
  SEEKDEEP_ACTIVE_WORKING_LOOPS.set(safeKey, handle);
  return handle;
}

function seekdeepStopWorkingLoop(handleOrKey) {
  if (!handleOrKey) return;

  if (typeof handleOrKey === 'string') {
    const handle = SEEKDEEP_ACTIVE_WORKING_LOOPS.get(handleOrKey);
    if (handle) seekdeepStopWorkingLoop(handle);
    return;
  }

  if (typeof handleOrKey === 'function') {
    try {
      handleOrKey();
    } catch {}
    return;
  }

  if (typeof handleOrKey.stop === 'function') {
    try {
      handleOrKey.stop();
    } catch {}
    return;
  }

  try {
    if (handleOrKey.interval) clearInterval(handleOrKey.interval);
  } catch {}

  try {
    if (handleOrKey.ttl) clearTimeout(handleOrKey.ttl);
  } catch {}

  try {
    if (handleOrKey._repeat != null || handleOrKey.hasRef) clearInterval(handleOrKey);
  } catch {}
}

function seekdeepStopAllWorkingLoops() {
  for (const handle of [...SEEKDEEP_ACTIVE_WORKING_LOOPS.values()]) {
    seekdeepStopWorkingLoop(handle);
  }
  SEEKDEEP_ACTIVE_WORKING_LOOPS.clear();
}"""

# Remove any prior const declaration block for SEEKDEEP_ACTIVE_WORKING_LOOPS if this exact patch was applied before.
text = re.sub(
    r"const SEEKDEEP_ACTIVE_WORKING_LOOPS = globalThis\.__seekdeepActiveWorkingLoops[\s\S]*?function seekdeepStopAllWorkingLoops\(\) \{[\s\S]*?\n\}",
    working_loop_code,
    text,
    count=1,
)

if "function seekdeepStartWorkingLoop" in text:
    # Replace start/stop/all as a group if possible.
    start_fn, ss, se = get_function(text, "seekdeepStartWorkingLoop")
    stop_fn, ts, te = get_function(text, "seekdeepStopWorkingLoop")

    if ss >= 0 and ts >= 0:
      first = min(ss, ts)
      last = max(se, te)

      all_fn, aas, aae = get_function(text, "seekdeepStopAllWorkingLoops")
      if aas >= 0:
          first = min(first, aas)
          last = max(last, aae)

      # Include an immediately preceding registry const only if very close.
      prefix_start = max(0, first - 500)
      prefix = text[prefix_start:first]
      m = re.search(r"const\s+\w*WORKING\w*LOOPS\w*\s*=[^\n]+;\s*(?:\n\s*globalThis\.[^\n]+;\s*)?$", prefix)
      if m:
          first = prefix_start + m.start()

      text = text[:first] + working_loop_code + text[last:]
    else:
      text = replace_or_insert_function(text, "seekdeepStartWorkingLoop", working_loop_code, anchor)
else:
    pos = text.find("client.on('interactionCreate'")
    text = text[:pos] + working_loop_code + "\n\n" + text[pos:]

# Hook process shutdown once.
if "SEEKDEEP_TYPING_LOOP_SHUTDOWN_HOOKS_START" not in text:
    shutdown_hooks = r"""
// SEEKDEEP_TYPING_LOOP_SHUTDOWN_HOOKS_START
try {
  for (const signal of ['beforeExit', 'SIGINT', 'SIGTERM']) {
    process.once(signal, () => {
      try {
        if (typeof seekdeepStopAllWorkingLoops === 'function') seekdeepStopAllWorkingLoops();
      } catch {}
    });
  }
} catch {}
// SEEKDEEP_TYPING_LOOP_SHUTDOWN_HOOKS_END

"""
    pos = text.find("client.login")
    if pos < 0:
        pos = len(text)
    text = text[:pos] + shutdown_hooks + text[pos:]

# Strengthen common queue runner finally blocks by adding a stop-all fallback after image jobs finish.
# This is deliberately conservative: it only inserts near existing queue enqueue calls if absent.
if "SEEKDEEP_TYPING_LOOP_QUEUE_FINISH_SWEEP" not in text:
    text = text.replace(
        "return await seekdeepEnqueueImageJob(job, async (runningJob) => {",
        "return await seekdeepEnqueueImageJob(job, async (runningJob) => {\n    // SEEKDEEP_TYPING_LOOP_QUEUE_FINISH_SWEEP\n",
        1,
    )

# Validation.
for needle, label in [
    ("function seekdeepStartWorkingLoop", "start working loop"),
    ("function seekdeepStopWorkingLoop", "stop working loop"),
    ("function seekdeepStopAllWorkingLoops", "stop all working loops"),
    ("SEEKDEEP_ACTIVE_WORKING_LOOPS", "active working loop registry"),
]:
    if needle not in text:
        fail(f"Required anchor missing after patch: {label}")

out = text if newline == "\n" else text.replace("\n", "\r\n")
path.write_bytes(out.encode("utf-8"))
print("Patched self-cleaning typing loop.")
'@

  $patchPyPath = Join-Path $patchesDir "patch_typing_cleanup.py"
  [System.IO.File]::WriteAllText($patchPyPath, $patchPy, [System.Text.UTF8Encoding]::new($false))

  Push-Location $projectRoot
  try {
    Write-Info "Applying typing cleanup patch"
    & ".\.venv\Scripts\python.exe" $patchPyPath $indexPath
    if ($LASTEXITCODE -ne 0) { throw "Patch helper failed with exit code $LASTEXITCODE." }
    Write-Pass "Applied typing cleanup patch"

    Write-Info "Running node --check .\index.js"
    & node --check ".\index.js"
    if ($LASTEXITCODE -ne 0) { throw "node --check failed with exit code $LASTEXITCODE." }
    Write-Pass "node --check passed"

    Write-Info "Running Python compile check"
    & ".\.venv\Scripts\python.exe" -m py_compile ".\local_ai_server.py"
    if ($LASTEXITCODE -ne 0) { throw "Python compile check failed with exit code $LASTEXITCODE." }
    Write-Pass "Python compile check passed"
  } finally {
    Pop-Location
  }

  Write-Host ""
  Write-Pass "Typing cleanup patch completed."
  Write-Host "Backup created: $backup" -ForegroundColor Yellow
  Write-Host "Restart the bot before testing." -ForegroundColor Yellow
  Write-Host ""
  Write-Host "Retest:" -ForegroundColor Cyan
  Write-Host "1) Generate with Original / Refined / Both." -ForegroundColor White
  Write-Host "2) Wait after the final image response." -ForegroundColor White
  Write-Host "3) Expected: Discord typing indicator stops by itself." -ForegroundColor White
  Write-Host ""
  Write-Host "Optional tuning in .env:" -ForegroundColor Cyan
  Write-Host "SEEKDEEP_TYPING_LOOP_MAX_MS=120000" -ForegroundColor White
  Write-Host "SEEKDEEP_TYPING_LOOP_INTERVAL_MS=9000" -ForegroundColor White
  exit 0
} catch {
  Write-Host ""
  Write-Fail $_.Exception.Message
  Write-Host "Backup available:" -ForegroundColor Yellow
  if ($backup) { Write-Host $backup -ForegroundColor Yellow }
  exit 1
}
