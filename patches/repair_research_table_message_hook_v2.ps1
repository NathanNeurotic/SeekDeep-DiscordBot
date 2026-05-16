# SeekDeep / Seekotics research/table message-route hook repair v2
#
# Fixes failure from repair_research_table_message_hook.ps1:
#   re.PatternError: bad escape \s
#
# Cause:
# - Python re.sub replacement string contained JavaScript regex backslashes.
#
# Repair:
# - Uses plain string slicing/replacement instead of re.sub replacement templates.
# - Inserts the research/table handler specifically inside messageCreate before normal chat.
# - Slightly broadens web/comparison detection.
#
# Files patched:
# - index.js
#
# Workflow guarantees:
# - Backs up index.js first
# - UTF-8-safe patching
# - Does not touch image queue/cooldown/model code
# - Preserves queue contract:
#     seekdeepEnqueueImageJob(job, runner)
# - Runs:
#     node --check .\index.js
#     .\.venv\Scripts\python.exe -m py_compile .\local_ai_server.py

$ErrorActionPreference = "Stop"

try {
  [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
} catch {}

function Write-Info {
  param([string]$Message)
  Write-Host "[SeekDeep research-hook-repair-v2] $Message" -ForegroundColor Cyan
}

function Write-Pass {
  param([string]$Message)
  Write-Host "[PASS] $Message" -ForegroundColor Green
}

function Write-Fail {
  param([string]$Message)
  Write-Host "[FAIL] $Message" -ForegroundColor Red
}

function Invoke-CheckedCommand {
  param(
    [Parameter(Mandatory=$true)][string]$Label,
    [Parameter(Mandatory=$true)][scriptblock]$Command
  )

  Write-Info "Running $Label"
  & $Command
  if ($LASTEXITCODE -ne 0) {
    throw "$Label failed with exit code $LASTEXITCODE."
  }
  Write-Pass "$Label passed"
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

  Write-Info "Project root: $projectRoot"

  $indexBackup = Join-Path $backupDir "index.js.research-table-message-hook-repair-v2-$stamp.bak"
  Copy-Item -LiteralPath $indexPath -Destination $indexBackup -Force
  Write-Pass "Backed up index.js to $indexBackup"

  $utf8NoBom = [System.Text.UTF8Encoding]::new($false)

  $patchPy = @'
from pathlib import Path
import re
import sys

if len(sys.argv) != 2:
    raise SystemExit("Usage: repair_research_table_message_hook_v2.py <index.js>")

path = Path(sys.argv[1])
raw = path.read_bytes()
newline = "\r\n" if b"\r\n" in raw else "\n"
text = raw.decode("utf-8-sig").replace("\r\n", "\n").replace("\r", "\n")

def require_contains(haystack: str, needle: str, label: str):
    if needle not in haystack:
        raise SystemExit(f"Required anchor not found: {label}")

def replace_function_by_name(src: str, name: str, replacement: str) -> str:
    marker = f"function {name}("
    start = src.find(marker)
    if start < 0:
        raise SystemExit(f"Could not locate function {name}.")

    next_start = src.find("\nfunction ", start + len(marker))
    next_async = src.find("\nasync function ", start + len(marker))
    candidates = [x for x in [next_start, next_async] if x >= 0]
    if not candidates:
        raise SystemExit(f"Could not locate end of function {name}.")

    end = min(candidates)
    return src[:start] + replacement.rstrip() + "\n\n" + src[end + 1:]

require_contains(text, "client.on('messageCreate'", "messageCreate handler")
require_contains(text, "async function seekdeepHandleResearchTableMessage", "research/table handler")
require_contains(text, "seekdeepEnqueueImageJob(job, runner)", "correct image queue contract")
require_contains(text, "post archive", "post archive context")

if "seekdeepMakeImageQueueJobId" in text:
    raise SystemExit("Unsafe old queue helper found: seekdeepMakeImageQueueJobId")
if "job.run" in text:
    raise SystemExit("Unsafe job.run-style queue logic found")

new_vague = r"""function seekdeepIsVagueWebRequest(prompt = '') {
  const p = normalizeUserText(prompt).toLowerCase();
  if (seekdeepLooksLikeSpecificResearchPrompt(p)) return false;

  return (
    /\b(look|search|check|find)\s+(for\s+)?(something|stuff|things?)\s+(for\s+me\s+)?(on|in|with|using)?\s*(the\s+)?(internet|web|online)\b/.test(p) ||
    /\b(can you|could you|would you)\s+(look|search|check|find)\s+(for\s+)?(something|stuff|things?)\b/.test(p) ||
    /\b(use|search|check)\s+(the\s+)?(internet|web|online)\b/.test(p)
  );
}"""

new_comparison = r"""function seekdeepIsComparisonResearchPrompt(prompt = '') {
  const p = normalizeUserText(prompt).toLowerCase();

  if (/\b(difference between|compare|comparison|versus|vs\.?|which is better|amd over intel|intel over amd|why .* over .*)\b/.test(p)) return true;

  if (/\b(lenovo|thinkpad|x1\s*carbon|x1carbon|t14|t14s|x13|p14s|laptop|notebook)\b/.test(p) &&
      /\b(amd|intel|gen\s*\d+|generation|difference|compare|vs\.?|versus|over)\b/.test(p)) return true;

  return false;
}"""

text = replace_function_by_name(text, "seekdeepIsVagueWebRequest", new_vague)
text = replace_function_by_name(text, "seekdeepIsComparisonResearchPrompt", new_comparison)

# Insert into messageCreate specifically, after natural image handling and immediately before fallback chat.
msg_start = text.find("client.on('messageCreate'")
if msg_start < 0:
    raise SystemExit("Could not locate messageCreate handler.")

natural_anchor = "    if (isNaturalImagePrompt(prompt)) {"
natural_pos = text.find(natural_anchor, msg_start)
if natural_pos < 0:
    raise SystemExit("Could not locate natural image block inside messageCreate.")

chat_anchor = "    seekdeepLogRoute('chat', prompt);\n"
chat_pos = text.find(chat_anchor, natural_pos)
if chat_pos < 0:
    raise SystemExit("Could not locate messageCreate chat route after natural image block.")

hook = """    // SEEKDEEP_RESEARCH_TABLE_MESSAGE_HOOK_START
    if (await seekdeepHandleResearchTableMessage(message, prompt, key)) {
      return;
    }
    // SEEKDEEP_RESEARCH_TABLE_MESSAGE_HOOK_END

"""

near = text[max(msg_start, chat_pos - 600):chat_pos]
if "SEEKDEEP_RESEARCH_TABLE_MESSAGE_HOOK_START" not in near:
    text = text[:chat_pos] + hook + text[chat_pos:]

for needle, label in [
    ("SEEKDEEP_RESEARCH_TABLE_CONTEXT_START", "research helper marker"),
    ("async function seekdeepHandleResearchTableMessage", "research handler"),
    ("SEEKDEEP_RESEARCH_TABLE_MESSAGE_HOOK_START", "messageCreate research hook marker"),
    ("if (await seekdeepHandleResearchTableMessage(message, prompt, key))", "messageCreate hook call"),
    ("function seekdeepIsVagueWebRequest", "vague web detector"),
    ("function seekdeepIsComparisonResearchPrompt", "comparison detector"),
    ("web: 'always'", "forced web research"),
    ("seekdeepEnqueueImageJob(job, runner)", "image queue contract preserved"),
]:
    require_contains(text, needle, label)

out = text if newline == "\n" else text.replace("\n", "\r\n")
path.write_bytes(out.encode("utf-8"))
print("Repaired research/table hook in messageCreate with safe string replacement.")
'@

  $patchPyPath = Join-Path $patchesDir "repair_research_table_message_hook_v2.py"
  [System.IO.File]::WriteAllText($patchPyPath, $patchPy, $utf8NoBom)

  Push-Location $projectRoot
  try {
    Write-Info "Applying research/table message hook repair v2"
    & ".\.venv\Scripts\python.exe" $patchPyPath $indexPath
    if ($LASTEXITCODE -ne 0) {
      throw "Patch helper failed with exit code $LASTEXITCODE."
    }
    Write-Pass "Applied research/table message hook repair v2"

    Invoke-CheckedCommand "node --check .\index.js" {
      & node --check ".\index.js"
    }

    Invoke-CheckedCommand ".\.venv\Scripts\python.exe -m py_compile .\local_ai_server.py" {
      & ".\.venv\Scripts\python.exe" -m py_compile ".\local_ai_server.py"
    }
  } finally {
    Pop-Location
  }

  Write-Host ""
  Write-Pass "Research/table message hook repair v2 completed."
  Write-Host "Backup created: $indexBackup" -ForegroundColor Yellow
  Write-Host "Restart the Discord bot before testing." -ForegroundColor Yellow
  Write-Host ""
  Write-Host "Retest:" -ForegroundColor Cyan
  Write-Host "@SEEKOTICS Can you look for something for me in the internet" -ForegroundColor White
  Write-Host "@SEEKOTICS Difference between Lenovo X1 Carbon and T14 also why T14 AMD over Intel since there is no X1 Carbon AMD" -ForegroundColor White
  exit 0
} catch {
  Write-Host ""
  Write-Fail $_.Exception.Message
  Write-Host "Backup available:" -ForegroundColor Yellow
  if ($indexBackup) { Write-Host $indexBackup -ForegroundColor Yellow }
  exit 1
}
