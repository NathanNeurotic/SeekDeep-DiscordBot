# SeekDeep / Seekotics ThinkPad research guardrails patch
#
# Fixes observed issue:
# - Research routing and follow-up routing now work, but Qwen still invents or drifts:
#   - claimed / audited "newer X1 Carbon AMD/Ryzen" despite the user premise "no X1 Carbon AMD"
#   - kept weak/noisy sources such as YouTube/Reddit/NanoReview as if they were solid spec evidence
#   - generalized across broad Gen ranges instead of admitting exact generation/config uncertainty
#
# This patch:
# - Adds ThinkPad-specific source filtering/scoring in searchWeb(...)
# - Prioritizes Lenovo PSREF / Lenovo / Notebookcheck / XDA / LaptopMedia style sources
# - Downranks Reddit/YouTube/NanoReview/LaptopDecision for spec claims
# - Adds hard research-system guardrails:
#     no X1 Carbon AMD/Ryzen claims
#     no unrelated model drift like X230, T11/T12/T13 unless user asked
#     separate "source says" from "general buyer guidance"
# - Adds ThinkPad-specific prompt instructions to research/follow-up/audit prompts
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
  Write-Host "[SeekDeep ThinkPad-guardrails] $Message" -ForegroundColor Cyan
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

  $indexBackup = Join-Path $backupDir "index.js.thinkpad-research-guardrails-$stamp.bak"
  Copy-Item -LiteralPath $indexPath -Destination $indexBackup -Force
  Write-Pass "Backed up index.js to $indexBackup"

  $utf8NoBom = [System.Text.UTF8Encoding]::new($false)

  $patchPy = @'
from pathlib import Path
import sys

if len(sys.argv) != 2:
    raise SystemExit("Usage: patch_thinkpad_research_guardrails.py <index.js>")

path = Path(sys.argv[1])
raw = path.read_bytes()
newline = "\r\n" if b"\r\n" in raw else "\n"
text = raw.decode("utf-8-sig").replace("\r\n", "\n").replace("\r", "\n")

def require_contains(haystack: str, needle: str, label: str):
    if needle not in haystack:
        raise SystemExit(f"Required anchor not found: {label}")

for needle, label in [
    ("async function searchWeb", "searchWeb"),
    ("function seekdeepResearchSystem", "research system"),
    ("function seekdeepResearchPrompt", "research prompt"),
    ("function seekdeepResearchFollowupPrompt", "research follow-up prompt"),
    ("function seekdeepBuildFocusedResearchSearchQuery", "focused research query helper"),
    ("seekdeepEnqueueImageJob(job, runner)", "correct image queue contract"),
]:
    require_contains(text, needle, label)

if "seekdeepMakeImageQueueJobId" in text:
    raise SystemExit("Unsafe old queue helper found: seekdeepMakeImageQueueJobId")
if "job.run" in text:
    raise SystemExit("Unsafe job.run-style queue logic found")

# Add ThinkPad-aware source scoring helpers before searchWeb.
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

  if (url.includes('psref.lenovo.com')) score += 10;
  if (url.includes('lenovo.com') && !url.includes('forums.lenovo.com')) score += 7;
  if (url.includes('notebookcheck.net')) score += 6;
  if (url.includes('laptopmedia.com')) score += 5;
  if (url.includes('xda-developers.com')) score += 4;
  if (url.includes('nanoreview.net')) score += 2;
  if (url.includes('laptopdecision.com')) score += 1;

  if (url.includes('reddit.com')) score -= 3;
  if (url.includes('youtube.com') || url.includes('youtu.be')) score -= 3;
  if (url.includes('quora.com')) score -= 5;
  if (url.includes('google.com/recaptcha')) score -= 99;

  // If the query asks for X1 Carbon and T14, prefer sources that mention both.
  if ((q.includes('x1 carbon') || q.includes('x1carbon')) && q.includes('t14')) {
    if (!(hay.includes('x1 carbon') || hay.includes('x1carbon'))) score -= 4;
    if (!/\bt14\b/.test(hay)) score -= 4;
  }

  return score;
}
"""

if "function seekdeepThinkPadSourceScore" not in text:
    anchor = "async function searchWeb(query) {"
    pos = text.find(anchor)
    if pos < 0:
        raise SystemExit("Could not locate searchWeb anchor.")
    text = text[:pos] + helpers + "\n" + text[pos:]

# Patch searchWeb result filtering block if current focused-search patch exists.
old = """  const sources = results.map((r, i) => ({
    index: i + 1,
    title: r.title || 'Untitled',
    url: r.url || '',
    snippet: r.content || r.snippet || '',
  })).filter((r) => r.url || r.snippet || r.title);
"""
new = """  const rankedResults = seekdeepIsThinkPadResearchQuery(query)
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
  })).filter((r) => r.url || r.snippet || r.title);
"""
if old in text and "const rankedResults = seekdeepIsThinkPadResearchQuery(query)" not in text:
    text = text.replace(old, new, 1)

# Strengthen focused query for ThinkPad sources.
if "site:psref.lenovo.com OR site:support.lenovo.com" not in text:
    text = text.replace(
        "terms.push('Lenovo PSREF specifications review comparison');",
        "terms.push('Lenovo PSREF specifications review comparison site:psref.lenovo.com OR site:support.lenovo.com OR site:notebookcheck.net OR site:xda-developers.com');",
        1
    )

# Add ThinkPad-specific prompt helper.
prompt_helper = r"""
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
  ].join('\\n');
}
"""

if "function seekdeepThinkPadResearchGuardrails" not in text:
    anchor = "function seekdeepResearchPrompt"
    pos = text.find(anchor)
    if pos < 0:
        raise SystemExit("Could not locate seekdeepResearchPrompt anchor.")
    text = text[:pos] + prompt_helper + "\n" + text[pos:]

# Inject guardrails into research prompt and follow-up prompt outputs.
if "seekdeepThinkPadResearchGuardrails(cleanTopic)" not in text:
    text = text.replace(
        "`Request: ${cleanTopic}`,\n      '',",
        "`Request: ${cleanTopic}`,\n      seekdeepThinkPadResearchGuardrails(cleanTopic),\n      '',",
        1
    )

if "seekdeepThinkPadResearchGuardrails(topic)" not in text:
    text = text.replace(
        "const mode = seekdeepResearchFollowupMode(clean);\n\n  const scopeRules = [",
        "const mode = seekdeepResearchFollowupMode(clean);\n  const thinkPadRules = seekdeepThinkPadResearchGuardrails(topic);\n\n  const scopeRules = [",
        1
    )
    text = text.replace(
        "scopeRules,\n      '',\n      'Output:',",
        "scopeRules,\n      thinkPadRules,\n      '',\n      'Output:',",
        1
    )
    text = text.replace(
        "scopeRules,\n      '',\n      'Provide a pros/cons list",
        "scopeRules,\n      thinkPadRules,\n      '',\n      'Provide a pros/cons list",
        1
    )
    text = text.replace(
        "scopeRules,\n      '',\n      'Give a practical recommendation",
        "scopeRules,\n      thinkPadRules,\n      '',\n      'Give a practical recommendation",
        1
    )
    text = text.replace(
        "scopeRules,\n      '',\n      'Resolve the follow-up",
        "scopeRules,\n      thinkPadRules,\n      '',\n      'Resolve the follow-up",
        1
    )

# Strengthen system-level guard if present.
if "Do not claim official X1 Carbon AMD/Ryzen availability" not in text:
    text = text.replace(
        "'Reject or down-rank irrelevant search results such as reCAPTCHA pages, unrelated PDFs, generic search landing pages, Reddit-only evidence, or unrelated model generations.',",
        "'Reject or down-rank irrelevant search results such as reCAPTCHA pages, unrelated PDFs, generic search landing pages, Reddit-only evidence, or unrelated model generations.',\n"
        "    'For ThinkPad research, do not claim official X1 Carbon AMD/Ryzen availability unless an official Lenovo source in context proves it.',",
        1
    )

for needle, label in [
    ("function seekdeepThinkPadSourceScore", "ThinkPad source scoring"),
    ("const rankedResults = seekdeepIsThinkPadResearchQuery(query)", "ranked source filtering"),
    ("function seekdeepThinkPadResearchGuardrails", "ThinkPad prompt guardrails"),
    ("Do not claim an official X1 Carbon AMD/Ryzen option", "X1 Carbon AMD guardrail"),
    ("site:psref.lenovo.com OR site:support.lenovo.com", "focused ThinkPad source query"),
    ("seekdeepThinkPadResearchGuardrails(cleanTopic)", "research prompt guardrail injection"),
    ("seekdeepThinkPadResearchGuardrails(topic)", "follow-up prompt guardrail injection"),
    ("seekdeepEnqueueImageJob(job, runner)", "image queue contract preserved"),
]:
    require_contains(text, needle, label)

out = text if newline == "\n" else text.replace("\n", "\r\n")
path.write_bytes(out.encode("utf-8"))
print("Patched ThinkPad research guardrails and source ranking.")
'@

  $patchPyPath = Join-Path $patchesDir "patch_thinkpad_research_guardrails.py"
  [System.IO.File]::WriteAllText($patchPyPath, $patchPy, $utf8NoBom)

  Push-Location $projectRoot
  try {
    Write-Info "Applying ThinkPad research guardrails patch"
    & ".\.venv\Scripts\python.exe" $patchPyPath $indexPath
    if ($LASTEXITCODE -ne 0) {
      throw "Patch helper failed with exit code $LASTEXITCODE."
    }
    Write-Pass "Applied ThinkPad research guardrails patch"

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
  Write-Pass "ThinkPad research guardrails patch completed."
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
