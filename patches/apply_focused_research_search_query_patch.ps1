# SeekDeep / Seekotics focused research search-query patch
#
# Fixes observed issue:
# - Research routing works, but SearXNG results are weak/noisy because askChat searches
#   the entire verbose research prompt instead of a focused query.
# - Sources included irrelevant results like Google reCAPTCHA / SecureDrop / unrelated blogs.
#
# This patch:
# - Adds searchQueryOverride to askChat(...)
# - Adds focused research search query builder
# - Makes research/comparison/table/follow-up/audit calls use focused search queries
# - Filters obvious useless SearXNG results before feeding context to Qwen
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
  Write-Host "[SeekDeep focused-research] $Message" -ForegroundColor Cyan
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

  $indexBackup = Join-Path $backupDir "index.js.focused-research-search-query-$stamp.bak"
  Copy-Item -LiteralPath $indexPath -Destination $indexBackup -Force
  Write-Pass "Backed up index.js to $indexBackup"

  $utf8NoBom = [System.Text.UTF8Encoding]::new($false)

  $patchPy = @'
from pathlib import Path
import re
import sys

if len(sys.argv) != 2:
    raise SystemExit("Usage: patch_focused_research_search_query.py <index.js>")

path = Path(sys.argv[1])
raw = path.read_bytes()
newline = "\r\n" if b"\r\n" in raw else "\n"
text = raw.decode("utf-8-sig").replace("\r\n", "\n").replace("\r", "\n")

def require_contains(haystack: str, needle: str, label: str):
    if needle not in haystack:
        raise SystemExit(f"Required anchor not found: {label}")

for needle, label in [
    ("async function askChat", "askChat"),
    ("async function searchWeb", "searchWeb"),
    ("async function seekdeepHandleResearchTableMessage", "research handler"),
    ("function seekdeepResearchPrompt", "research prompt"),
    ("function seekdeepResearchFollowupPrompt", "research followup prompt"),
    ("seekdeepEnqueueImageJob(job, runner)", "correct image queue contract"),
]:
    require_contains(text, needle, label)

if "seekdeepMakeImageQueueJobId" in text:
    raise SystemExit("Unsafe old queue helper found: seekdeepMakeImageQueueJobId")
if "job.run" in text:
    raise SystemExit("Unsafe job.run-style queue logic found")

# 1. Filter obviously bad SearXNG results.
old = "  const results = Array.isArray(json.results) ? json.results.slice(0, 6) : [];\n"
new = """  const rawResults = Array.isArray(json.results) ? json.results : [];
  const results = rawResults.filter((r) => {
    const title = String(r?.title || '').toLowerCase();
    const url = String(r?.url || '').toLowerCase();
    const snippet = String(r?.content || r?.snippet || '').toLowerCase();

    if (!title && !url && !snippet) return false;
    if (url.includes('google.com/recaptcha') || title.includes('recaptcha')) return false;
    if (title.includes('search anything') && url.includes('google.')) return false;
    if (url.includes('securedrop.org') && !query.toLowerCase().includes('securedrop')) return false;
    if (title.includes('newsarchive') && !query.toLowerCase().includes('newsarchive')) return false;

    return true;
  }).slice(0, 6);
"""
if old in text and "const rawResults = Array.isArray(json.results)" not in text:
    text = text.replace(old, new, 1)

# 2. Add searchQueryOverride option to askChat.
old_sig = "async function askChat(prompt, { web = 'auto', system = '', maxNewTokens = Number(process.env.CHAT_MAX_NEW_TOKENS || 1400), temperature = 0.35, memoryKey = null } = {}) {"
new_sig = "async function askChat(prompt, { web = 'auto', system = '', maxNewTokens = Number(process.env.CHAT_MAX_NEW_TOKENS || 1400), temperature = 0.35, memoryKey = null, searchQueryOverride = '' } = {}) {"
if old_sig in text:
    text = text.replace(old_sig, new_sig, 1)
elif "searchQueryOverride" not in text[text.find("async function askChat"):text.find("async function askVision")]:
    raise SystemExit("Could not patch askChat signature.")

old_query = "  const searchQuery = memoryKey ? buildSearchQuery(cleanPrompt, memoryKey) : cleanPrompt;\n"
new_query = "  const searchQuery = normalizeUserText(searchQueryOverride || (memoryKey ? buildSearchQuery(cleanPrompt, memoryKey) : cleanPrompt));\n"
if old_query in text:
    text = text.replace(old_query, new_query, 1)
elif "searchQueryOverride ||" not in text[text.find("async function askChat"):text.find("async function askVision")]:
    raise SystemExit("Could not patch askChat search query line.")

# 3. Add focused research query helper.
helper = r"""
function seekdeepBuildFocusedResearchSearchQuery(topic = '', mode = 'research') {
  const raw = normalizeUserText(topic);
  const p = raw.toLowerCase();

  if (/\b(lenovo|thinkpad|x1\s*carbon|x1carbon|t14|t14s)\b/.test(p)) {
    const terms = [];

    if (/\bx1\s*carbon|x1carbon\b/.test(p)) terms.push('"ThinkPad X1 Carbon"');
    if (/\bt14\b/.test(p)) terms.push('"ThinkPad T14"');
    if (/\bt14s\b/.test(p)) terms.push('"ThinkPad T14s"');
    if (/\bgen\s*2|generation\s*2\b/.test(p)) terms.push('"Gen 2"');
    if (/\bgen\s*3|generation\s*3\b/.test(p)) terms.push('"Gen 3"');
    if (/\bgen\s*9|generation\s*9\b/.test(p)) terms.push('"Gen 9"');
    if (/\bgen\s*10|generation\s*10\b/.test(p)) terms.push('"Gen 10"');
    if (/\bamd|ryzen\b/.test(p)) terms.push('AMD Ryzen');
    if (/\bintel|core\b/.test(p)) terms.push('Intel Core');

    terms.push('Lenovo PSREF specifications review comparison');

    return terms.join(' ');
  }

  let q = raw
    .replace(/\b(create|make|give me|show me|list|break down|pros and cons|pros\/cons|audit|fact check|verify|table|tablesheet|comparison table|chart|matrix)\b/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  if (mode === 'audit') q += ' specifications sources fact check';
  if (mode === 'table') q += ' specs comparison';
  if (mode === 'proscons') q += ' pros cons review comparison';

  return q.trim() || raw;
}

"""

if "function seekdeepBuildFocusedResearchSearchQuery" not in text:
    anchor = "function seekdeepResearchSystem"
    pos = text.find(anchor)
    if pos < 0:
        raise SystemExit("Could not locate seekdeepResearchSystem anchor.")
    text = text[:pos] + helper + text[pos:]

# 4. Add searchQueryOverride to research askChat calls when absent.
# Conservative replacements around known call sites.
text = text.replace(
    "        temperature: 0.2,\n      });",
    "        temperature: 0.2,\n        searchQueryOverride: seekdeepBuildFocusedResearchSearchQuery(pending.topic, 'table'),\n      });",
    1
)

text = text.replace(
    "      temperature: 0.2,\n    });\n\n    remember(key, 'user', prompt);",
    "      temperature: 0.2,\n      searchQueryOverride: seekdeepBuildFocusedResearchSearchQuery(pending.topic, seekdeepResearchFollowupMode(p)),\n    });\n\n    remember(key, 'user', prompt);",
    1
)

text = text.replace(
    "      temperature: 0.2,\n    });\n\n    remember(key, 'user', prompt);",
    "      temperature: 0.2,\n      searchQueryOverride: seekdeepBuildFocusedResearchSearchQuery(mergedTopic, 'table'),\n    });\n\n    remember(key, 'user', prompt);",
    1
)

text = text.replace(
    "      temperature: 0.22,\n    });\n\n    remember(key, 'user', prompt);",
    "      temperature: 0.22,\n      searchQueryOverride: seekdeepBuildFocusedResearchSearchQuery(topic, 'research'),\n    });\n\n    remember(key, 'user', prompt);",
    1
)

# If an audit/followup call exists and did not receive override because formatting differed, insert by local anchor.
if "searchQueryOverride: seekdeepBuildFocusedResearchSearchQuery(pending.topic, seekdeepResearchFollowupMode(p))" not in text:
    anchor = "system: seekdeepResearchSystem(seekdeepResearchFollowupMode(p) === 'table' ? 'table' : 'research'),\n      maxNewTokens: Number(process.env.SEEKDEEP_RESEARCH_FOLLOWUP_MAX_TOKENS || 1800),\n      temperature: 0.2,\n"
    if anchor in text:
        text = text.replace(anchor, anchor + "      searchQueryOverride: seekdeepBuildFocusedResearchSearchQuery(pending.topic, seekdeepResearchFollowupMode(p)),\n", 1)

# 5. Strengthen source instruction to reject bad source sets.
if "Reject or down-rank irrelevant search results" not in text:
    text = text.replace(
        "'If sources are low quality, irrelevant, or not about the exact requested model/generation, say that plainly.',",
        "'If sources are low quality, irrelevant, or not about the exact requested model/generation, say that plainly.',\n"
        "    'Reject or down-rank irrelevant search results such as reCAPTCHA pages, unrelated PDFs, generic search landing pages, Reddit-only evidence, or unrelated model generations.',",
        1
    )

for needle, label in [
    ("searchQueryOverride", "askChat search query override"),
    ("function seekdeepBuildFocusedResearchSearchQuery", "focused research query helper"),
    ("Lenovo PSREF specifications review comparison", "ThinkPad focused query terms"),
    ("const rawResults = Array.isArray(json.results)", "search result filtering"),
    ("Reject or down-rank irrelevant search results", "bad source guard"),
    ("seekdeepEnqueueImageJob(job, runner)", "image queue contract preserved"),
]:
    require_contains(text, needle, label)

out = text if newline == "\n" else text.replace("\n", "\r\n")
path.write_bytes(out.encode("utf-8"))
print("Patched focused research search queries and result filtering.")
'@

  $patchPyPath = Join-Path $patchesDir "patch_focused_research_search_query.py"
  [System.IO.File]::WriteAllText($patchPyPath, $patchPy, $utf8NoBom)

  Push-Location $projectRoot
  try {
    Write-Info "Applying focused research search-query patch"
    & ".\.venv\Scripts\python.exe" $patchPyPath $indexPath
    if ($LASTEXITCODE -ne 0) {
      throw "Patch helper failed with exit code $LASTEXITCODE."
    }
    Write-Pass "Applied focused research search-query patch"

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
  Write-Pass "Focused research search-query patch completed."
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
