# SeekDeep / Seekotics ThinkPad research guardrails patch v2
#
# Fixes failure from apply_thinkpad_research_guardrails_patch.ps1:
#   Required anchor not found: research prompt guardrail injection
#
# Cause:
# - The prior patch expected one exact line shape inside seekdeepResearchPrompt(...).
# - Your current index.js has already been patched several times, so that exact anchor changed.
#
# v2 strategy:
# - Do not fail if one optional prompt-injection anchor is missing.
# - Add the important guardrails through:
#   1. source ranking/filtering
#   2. focused search query improvement
#   3. system-level research instructions
#   4. safe function-level guardrail helper insertion where possible
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
  Write-Host "[SeekDeep ThinkPad-guardrails-v2] $Message" -ForegroundColor Cyan
}

function Write-Pass {
  param([string]$Message)
  Write-Host "[PASS] $Message" -ForegroundColor Green
}

function Write-Warn {
  param([string]$Message)
  Write-Host "[WARN] $Message" -ForegroundColor Yellow
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

  $indexBackup = Join-Path $backupDir "index.js.thinkpad-research-guardrails-v2-$stamp.bak"
  Copy-Item -LiteralPath $indexPath -Destination $indexBackup -Force
  Write-Pass "Backed up index.js to $indexBackup"

  $utf8NoBom = [System.Text.UTF8Encoding]::new($false)

  $patchPy = @'
from pathlib import Path
import sys

if len(sys.argv) != 2:
    raise SystemExit("Usage: patch_thinkpad_research_guardrails_v2.py <index.js>")

path = Path(sys.argv[1])
raw = path.read_bytes()
newline = "\r\n" if b"\r\n" in raw else "\n"
text = raw.decode("utf-8-sig").replace("\r\n", "\n").replace("\r", "\n")

def require_contains(haystack: str, needle: str, label: str):
    if needle not in haystack:
        raise SystemExit(f"Required anchor not found: {label}")

def warn(msg: str):
    print(f"[WARN] {msg}")

for needle, label in [
    ("async function searchWeb", "searchWeb"),
    ("function seekdeepResearchSystem", "research system"),
    ("function seekdeepBuildFocusedResearchSearchQuery", "focused research query helper"),
    ("seekdeepEnqueueImageJob(job, runner)", "correct image queue contract"),
]:
    require_contains(text, needle, label)

if "seekdeepMakeImageQueueJobId" in text:
    raise SystemExit("Unsafe old queue helper found: seekdeepMakeImageQueueJobId")
if "job.run" in text:
    raise SystemExit("Unsafe job.run-style queue logic found")

# 1. ThinkPad-aware source scoring helpers.
helpers = r"""
function seekdeepIsThinkPadResearchQuery(query = '') {
  return /\b(thinkpad|lenovo|x1\s*carbon|x1carbon|t14|t14s)\b/i.test(String(query || ''));
}

function seekdeepThinkPadSourceScore(result = {}, query = '') {
  const title = String(result?.title || '').toLowerCase();
  const url = String(result?.url || '').toLowerCase();
  const snippet = String(result?.content || result?.snippet || '').toLowerCase();
  const hay = `${title} ${url} ${snippet}`;
  const q = String(query || '').toLowerCase();

  let score = 0;

  if (hay.includes('thinkpad')) score += 3;
  if (hay.includes('x1 carbon') || hay.includes('x1carbon')) score += 3;
  if (/\bt14\b/.test(hay)) score += 3;
  if (hay.includes('amd') || hay.includes('ryzen')) score += 1;
  if (hay.includes('intel') || hay.includes('core')) score += 1;

  if (url.includes('psref.lenovo.com')) score += 12;
  if (url.includes('support.lenovo.com')) score += 9;
  if (url.includes('lenovo.com') && !url.includes('forums.lenovo.com')) score += 8;
  if (url.includes('notebookcheck.net')) score += 6;
  if (url.includes('laptopmedia.com')) score += 5;
  if (url.includes('xda-developers.com')) score += 4;
  if (url.includes('nanoreview.net')) score += 2;
  if (url.includes('laptopdecision.com')) score += 1;

  if (url.includes('reddit.com')) score -= 3;
  if (url.includes('youtube.com') || url.includes('youtu.be')) score -= 3;
  if (url.includes('quora.com')) score -= 5;
  if (url.includes('google.com/recaptcha')) score -= 99;

  if ((q.includes('x1 carbon') || q.includes('x1carbon')) && q.includes('t14')) {
    if (!(hay.includes('x1 carbon') || hay.includes('x1carbon'))) score -= 4;
    if (!/\bt14\b/.test(hay)) score -= 4;
  }

  return score;
}

function seekdeepThinkPadResearchGuardrails(topic = '') {
  const p = normalizeUserText(topic).toLowerCase();
  if (!/\b(thinkpad|lenovo|x1\s*carbon|x1carbon|t14|t14s)\b/.test(p)) return '';

  return [
    'ThinkPad-specific guardrails:',
    '- Preserve the requested scope: X1 Carbon and T14 only, unless the user explicitly asks for T14s, X230, T-series broadly, or another model.',
    '- Do not mention T11, T12, T13, X230, T14s, Framework, or unrelated models as compared items unless the user asked.',
    '- Do not claim an official X1 Carbon AMD/Ryzen option. If discussing why there is no X1 Carbon AMD, treat that as the user premise unless a supplied official Lenovo source proves otherwise.',
    '- Do not claim AMD is always cooler, faster, or longer-lasting. Say it depends on generation/configuration unless sourced directly.',
    '- Separate sourced facts from buyer guidance.',
    '- Prefer Lenovo PSREF/manufacturer data for specs; use Reddit/YouTube only as anecdotal buyer sentiment, not spec proof.',
  ].join('\n');
}

"""

if "function seekdeepThinkPadSourceScore" not in text:
    pos = text.find("async function searchWeb(query) {")
    if pos < 0:
        raise SystemExit("Could not locate searchWeb anchor.")
    text = text[:pos] + helpers + "\n" + text[pos:]

# 2. Patch source ranking around sources creation. Use range replacement so exact prior patches do not matter.
if "const rankedResults = seekdeepIsThinkPadResearchQuery(query)" not in text:
    start = text.find("  const sources = results.map((r, i) => ({")
    end_anchor = "\n\n  const context = sources.map((r) => {"
    if start >= 0:
        end = text.find(end_anchor, start)
        if end >= 0:
            replacement = """  const rankedResults = seekdeepIsThinkPadResearchQuery(query)
    ? results
        .map((r) => ({ ...r, __seekdeepScore: seekdeepThinkPadSourceScore(r, query) }))
        .filter((r) => r.__seekdeepScore > -2)
        .sort((a, b) => b.__seekdeepScore - a.__seekdeepScore)
        .slice(0, 6)
    : results;

  const sources = rankedResults.map((r, i) => ({
    index: i + 1,
    title: r.title || 'Untitled',
    url: r.url || '',
    snippet: r.content || r.snippet || '',
  })).filter((r) => r.url || r.snippet || r.title);"""
            text = text[:start] + replacement + text[end:]
        else:
            warn("Could not locate context anchor after sources block; skipped ranked source replacement.")
    else:
        warn("Could not locate sources block; skipped ranked source replacement.")

# 3. Strengthen focused ThinkPad search terms.
if "site:psref.lenovo.com OR site:support.lenovo.com" not in text:
    old = "terms.push('Lenovo PSREF specifications review comparison');"
    new = "terms.push('Lenovo PSREF specifications review comparison site:psref.lenovo.com OR site:support.lenovo.com OR site:notebookcheck.net OR site:xda-developers.com');"
    if old in text:
        text = text.replace(old, new, 1)
    else:
        warn("Could not locate simple focused-query terms.push anchor; skipped query-term expansion.")

# 4. Add system-level guardrails. This is the important fallback if prompt-function injection anchors differ.
if "For ThinkPad research, do not claim official X1 Carbon AMD/Ryzen availability" not in text:
    guard_lines = (
        "    'For ThinkPad research, do not claim official X1 Carbon AMD/Ryzen availability unless an official Lenovo source in context proves it.',\n"
        "    'For ThinkPad research, do not introduce unrelated model names or generations such as X230, T11, T12, T13, T14s, or Framework unless the user explicitly asked.',\n"
        "    'For ThinkPad research, Reddit/YouTube are anecdotal only. Do not use them as proof for specifications or official availability.',\n"
    )

    anchor = "  const base = [];\n"
    if anchor in text:
        text = text.replace(anchor, anchor + "\n" + guard_lines, 1)
    else:
        warn("Could not locate research-system base anchor; skipped system-level ThinkPad guard insertion.")

# 5. Opportunistically inject guardrail helper into prompt builders only when obvious anchors exist.
if "seekdeepThinkPadResearchGuardrails(cleanTopic)" not in text:
    anchor = "`Request: ${cleanTopic}`,\n      '',"
    if anchor in text:
        text = text.replace(anchor, "`Request: ${cleanTopic}`,\n      seekdeepThinkPadResearchGuardrails(cleanTopic),\n      '',", 1)
    else:
        warn("Could not locate research prompt cleanTopic anchor; system guardrails still applied.")

if "const thinkPadRules = seekdeepThinkPadResearchGuardrails(topic);" not in text:
    anchor = "const mode = seekdeepResearchFollowupMode(clean);\n"
    if anchor in text:
        text = text.replace(anchor, anchor + "  const thinkPadRules = seekdeepThinkPadResearchGuardrails(topic);\n", 1)

        # Add thinkPadRules after scopeRules where common anchors exist.
        for old in [
            "scopeRules,\n      '',\n      'Output:'",
            "scopeRules,\n      '',\n      'Provide a pros/cons list",
            "scopeRules,\n      '',\n      'Give a practical recommendation",
            "scopeRules,\n      '',\n      'Resolve the follow-up",
        ]:
            if old in text:
                text = text.replace(old, old.replace("scopeRules,\n      ''", "scopeRules,\n      thinkPadRules,\n      ''"), 1)
    else:
        warn("Could not locate followup mode anchor; system guardrails still applied.")

for needle, label in [
    ("function seekdeepThinkPadSourceScore", "ThinkPad source scoring helper"),
    ("function seekdeepThinkPadResearchGuardrails", "ThinkPad guardrails helper"),
    ("Do not claim an official X1 Carbon AMD/Ryzen option", "X1 Carbon AMD guardrail"),
    ("For ThinkPad research, do not claim official X1 Carbon AMD/Ryzen availability", "system guardrail"),
    ("seekdeepEnqueueImageJob(job, runner)", "image queue contract preserved"),
]:
    require_contains(text, needle, label)

# Source ranking is valuable but not guaranteed if the live file changed radically.
if "const rankedResults = seekdeepIsThinkPadResearchQuery(query)" not in text:
    warn("Ranked source replacement was not applied. Guardrails still applied, but source quality may remain noisy.")

out = text if newline == "\n" else text.replace("\n", "\r\n")
path.write_bytes(out.encode("utf-8"))
print("Patched ThinkPad research guardrails v2.")
'@

  $patchPyPath = Join-Path $patchesDir "patch_thinkpad_research_guardrails_v2.py"
  [System.IO.File]::WriteAllText($patchPyPath, $patchPy, $utf8NoBom)

  Push-Location $projectRoot
  try {
    Write-Info "Applying ThinkPad research guardrails patch v2"
    & ".\.venv\Scripts\python.exe" $patchPyPath $indexPath
    if ($LASTEXITCODE -ne 0) {
      throw "Patch helper failed with exit code $LASTEXITCODE."
    }
    Write-Pass "Applied ThinkPad research guardrails patch v2"

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
  Write-Pass "ThinkPad research guardrails v2 completed."
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
