# SeekDeep / Seekotics research answer audit + scope discipline patch
#
# Fixes observed issue:
# - Research routing works, but generated content drifted:
#     X1 Carbon/T14 comparison follow-up introduced "X230" and "T13"
#     even though the user asked about X1 Carbon and T14.
# - "audit" routed to normal chat instead of auditing the previous research answer.
#
# This patch:
# - Treats "audit", "fact check", "check that answer", etc. as research follow-ups
#   when a pending research context exists.
# - Adds a research-audit follow-up mode.
# - Strengthens prompts so Qwen must preserve the exact comparison scope and must not
#   introduce unrelated models/generations.
# - Adds explicit source-quality cautions for weak search results.
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
  Write-Host "[SeekDeep research-audit] $Message" -ForegroundColor Cyan
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

  $indexBackup = Join-Path $backupDir "index.js.research-audit-scope-discipline-$stamp.bak"
  Copy-Item -LiteralPath $indexPath -Destination $indexBackup -Force
  Write-Pass "Backed up index.js to $indexBackup"

  $utf8NoBom = [System.Text.UTF8Encoding]::new($false)

  $patchPy = @'
from pathlib import Path
import sys

if len(sys.argv) != 2:
    raise SystemExit("Usage: patch_research_audit_scope.py <index.js>")

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

    next_positions = []
    for marker2 in ["\nfunction ", "\nasync function ", "\n// SEEKDEEP_"]:
        pos = src.find(marker2, start + len(marker))
        if pos >= 0:
            next_positions.append(pos)

    if not next_positions:
        raise SystemExit(f"Could not locate end of function {name}.")

    end = min(next_positions)
    return src[:start] + replacement.rstrip() + "\n\n" + src[end + 1:]

for needle, label in [
    ("function seekdeepIsResearchFollowupPrompt", "research follow-up detector"),
    ("function seekdeepResearchFollowupMode", "research follow-up mode"),
    ("function seekdeepResearchFollowupPrompt", "research follow-up prompt"),
    ("function seekdeepResearchPrompt", "research prompt"),
    ("function seekdeepResearchSystem", "research system"),
    ("async function seekdeepHandleResearchTableMessage", "research handler"),
    ("seekdeepEnqueueImageJob(job, runner)", "correct image queue contract"),
]:
    require_contains(text, needle, label)

if "seekdeepMakeImageQueueJobId" in text:
    raise SystemExit("Unsafe old queue helper found: seekdeepMakeImageQueueJobId")
if "job.run" in text:
    raise SystemExit("Unsafe job.run-style queue logic found")

new_followup_detector = r"""function seekdeepIsResearchFollowupPrompt(prompt = '') {
  const p = normalizeUserText(prompt).toLowerCase();
  if (!p) return false;

  return (
    /\b(pros?\s*\/\s*cons?|pros and cons|advantages?|disadvantages?|downsides?|upsides?|strengths?|weaknesses?)\b/.test(p) ||
    /\b(of each|each one|each model|each laptop|for each|both of them|those|these|that comparison|the comparison)\b/.test(p) ||
    /\b(can you|could you|would you|please)?\s*(give|make|create|show|list|break down)\s+(me\s+)?(a\s+)?(pros?\s*\/\s*cons?|pros and cons|summary|recommendation|winner|ranking|table|chart)\b/.test(p) ||
    /^(audit|fact\s*check|fact-check|check that|check the answer|verify that|verify the answer|review that|review the answer|was that right|is that right|source audit|sources audit)\b/.test(p)
  );
}"""

new_followup_mode = r"""function seekdeepResearchFollowupMode(prompt = '') {
  const p = normalizeUserText(prompt).toLowerCase();
  if (/^(audit|fact\s*check|fact-check|check that|check the answer|verify that|verify the answer|review that|review the answer|was that right|is that right|source audit|sources audit)\b/.test(p)) return 'audit';
  if (/\b(pros?\s*\/\s*cons?|pros and cons|advantages?|disadvantages?|downsides?|upsides?|strengths?|weaknesses?)\b/.test(p)) return 'proscons';
  if (/\b(table|chart|matrix|spreadsheet|tablesheet)\b/.test(p)) return 'table';
  if (/\b(winner|which one|which should|recommend|recommendation|ranking|rank)\b/.test(p)) return 'recommendation';
  return 'followup';
}"""

new_followup_prompt = r"""function seekdeepResearchFollowupPrompt(prompt = '', pending = null) {
  const clean = normalizeUserText(prompt);
  const topic = normalizeUserText(pending?.topic || '');
  const lastAnswer = normalizeUserText(pending?.lastAnswer || '').slice(0, 3500);
  const mode = seekdeepResearchFollowupMode(clean);

  const scopeRules = [
    'Scope discipline:',
    '- Preserve the exact prior comparison topic/items.',
    '- Do not introduce unrelated models or generations.',
    '- If the prior topic says X1 Carbon and T14, do not switch to X230, T13, T14s, Framework, or unrelated models unless explicitly asked.',
    '- If the prior topic is broad, say that exact specs vary by generation/configuration.',
    '- If sources are weak/unrelated, say that plainly.',
  ].join('\n');

  if (mode === 'audit') {
    return [
      'Audit the previous research/comparison answer.',
      topic ? `Previous topic/items: ${topic}` : '',
      lastAnswer ? `Previous answer to audit:\n${lastAnswer}` : '',
      '',
      scopeRules,
      '',
      'Output:',
      '1. List any likely wrong, unsupported, or overconfident claims.',
      '2. List source-quality problems.',
      '3. Give a corrected concise answer if possible.',
      '4. If more exact model generations are needed, ask for them.',
    ].filter(Boolean).join('\n');
  }

  if (mode === 'proscons') {
    return [
      'Continue the previous research/comparison task.',
      topic ? `Previous topic/items: ${topic}` : '',
      `User follow-up: ${clean}`,
      '',
      scopeRules,
      '',
      'Provide a pros/cons list for each item/model in the previous comparison.',
      'Use concise bullets. If exact specs vary by configuration, say so.',
      'Do not invent details that are not supported by the search/context.',
    ].filter(Boolean).join('\n');
  }

  if (mode === 'recommendation') {
    return [
      'Continue the previous research/comparison task.',
      topic ? `Previous topic/items: ${topic}` : '',
      `User follow-up: ${clean}`,
      '',
      scopeRules,
      '',
      'Give a practical recommendation with clear criteria and caveats.',
      'Do not invent details that are not supported by the search/context.',
    ].filter(Boolean).join('\n');
  }

  return [
    'Continue the previous research/comparison task.',
    topic ? `Previous topic/items: ${topic}` : '',
    `User follow-up: ${clean}`,
    '',
    scopeRules,
    '',
    'Resolve the follow-up using the previous topic and available web/search context.',
    'Do not answer as a generic list detached from the prior comparison.',
  ].filter(Boolean).join('\n');
}"""

text = replace_function_by_name(text, "seekdeepIsResearchFollowupPrompt", new_followup_detector)
text = replace_function_by_name(text, "seekdeepResearchFollowupMode", new_followup_mode)
text = replace_function_by_name(text, "seekdeepResearchFollowupPrompt", new_followup_prompt)

# Strengthen research system by adding scope/source discipline if not already present.
if "Never introduce unrelated model names" not in text:
    text = text.replace(
        "'Use web/search context when provided. Do not bluff current product specs, prices, release details, or generation availability.',",
        "'Use web/search context when provided. Do not bluff current product specs, prices, release details, or generation availability.',\n"
        "    'Never introduce unrelated model names or generations. Preserve the user\\'s requested comparison scope.',\n"
        "    'If sources are low quality, irrelevant, or not about the exact requested model/generation, say that plainly.',",
        1
    )

# Strengthen research prompt if the previous patch did not already.
if "Do not change the requested comparison scope" not in text:
    text = text.replace(
        "'If this is a laptop/product comparison, search for official manufacturer specs, PSREF/spec sheets, reputable reviews, and concrete generation/model names.',",
        "'If this is a laptop/product comparison, search for official manufacturer specs, PSREF/spec sheets, reputable reviews, and concrete generation/model names.',\n"
        "      'Do not change the requested comparison scope. Do not introduce unrelated models or generations.',",
        1
    )

for needle, label in [
    ("return 'audit';", "audit mode"),
    ("Previous answer to audit", "audit prompt includes previous answer"),
    ("Scope discipline:", "scope discipline prompt"),
    ("Do not introduce unrelated models or generations.", "unrelated model guard"),
    ("Never introduce unrelated model names or generations.", "system-level scope guard"),
    ("seekdeepEnqueueImageJob(job, runner)", "image queue contract preserved"),
]:
    require_contains(text, needle, label)

out = text if newline == "\n" else text.replace("\n", "\r\n")
path.write_bytes(out.encode("utf-8"))
print("Patched research audit and scope discipline.")
'@

  $patchPyPath = Join-Path $patchesDir "patch_research_audit_scope.py"
  [System.IO.File]::WriteAllText($patchPyPath, $patchPy, $utf8NoBom)

  Push-Location $projectRoot
  try {
    Write-Info "Applying research audit/scope patch"
    & ".\.venv\Scripts\python.exe" $patchPyPath $indexPath
    if ($LASTEXITCODE -ne 0) {
      throw "Patch helper failed with exit code $LASTEXITCODE."
    }
    Write-Pass "Applied research audit/scope patch"

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
  Write-Pass "Research audit/scope patch completed."
  Write-Host "Backup created: $indexBackup" -ForegroundColor Yellow
  Write-Host "Restart the Discord bot before testing." -ForegroundColor Yellow
  Write-Host ""
  Write-Host "Retest:" -ForegroundColor Cyan
  Write-Host "@SEEKOTICS Difference between Lenovo X1 Carbon and T14 also why T14 AMD over Intel since there is no X1 Carbon AMD" -ForegroundColor White
  Write-Host "@SEEKOTICS give me a pros/cons list of each" -ForegroundColor White
  Write-Host "@SEEKOTICS audit" -ForegroundColor White
  exit 0
} catch {
  Write-Host ""
  Write-Fail $_.Exception.Message
  Write-Host "Backup available:" -ForegroundColor Yellow
  if ($indexBackup) { Write-Host $indexBackup -ForegroundColor Yellow }
  exit 1
}
