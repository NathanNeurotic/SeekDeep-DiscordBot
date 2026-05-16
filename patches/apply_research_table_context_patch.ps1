# SeekDeep / Seekotics research + comparison table context patch
#
# Purpose:
# - Improve behavior for web/research requests and multi-turn comparison/table requests.
# - Fix failure pattern shown by user complaint:
#   1. "look for something on the internet" should enter research mode / ask for topic
#   2. laptop comparisons should use web search instead of bluffing
#   3. "tablesheet / compareness" should remember the prior comparison topic
#   4. follow-up model lists should complete the pending table
#   5. insults/frustration should get short recovery, not long persona monologues
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
  Write-Host "[SeekDeep research-table] $Message" -ForegroundColor Cyan
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

  $indexBackup = Join-Path $backupDir "index.js.research-table-context-$stamp.bak"
  Copy-Item -LiteralPath $indexPath -Destination $indexBackup -Force
  Write-Pass "Backed up index.js to $indexBackup"

  $utf8NoBom = [System.Text.UTF8Encoding]::new($false)

  $patchPy = @'
from pathlib import Path
import sys

if len(sys.argv) != 2:
    raise SystemExit("Usage: patch_research_table_context.py <index.js>")

path = Path(sys.argv[1])
raw = path.read_bytes()
newline = "\r\n" if b"\r\n" in raw else "\n"
text = raw.decode("utf-8-sig").replace("\r\n", "\n").replace("\r", "\n")

def require_contains(haystack: str, needle: str, label: str):
    if needle not in haystack:
        raise SystemExit(f"Required anchor not found: {label}")

required = [
    ("async function askChat", "askChat"),
    ("async function searchWeb", "searchWeb"),
    ("async function sendLongMessageReply", "sendLongMessageReply"),
    ("function memoryKeyFrom", "memoryKeyFrom"),
    ("function remember", "remember"),
    ("seekdeepLogRoute('chat', prompt);", "chat route anchor"),
    ("seekdeepEnqueueImageJob(job, runner)", "correct image queue contract"),
    ("post archive", "post archive context"),
]
for needle, label in required:
    require_contains(text, needle, label)

if "seekdeepMakeImageQueueJobId" in text:
    raise SystemExit("Unsafe old queue helper found: seekdeepMakeImageQueueJobId")
if "job.run" in text:
    raise SystemExit("Unsafe job.run-style queue logic found")

helper = r"""
// SEEKDEEP_RESEARCH_TABLE_CONTEXT_START
const SEEKDEEP_PENDING_RESEARCH_TASKS = new Map();

function seekdeepResearchNow() {
  return Date.now();
}

function seekdeepGetPendingResearchTask(key) {
  const item = SEEKDEEP_PENDING_RESEARCH_TASKS.get(key);
  if (!item) return null;
  const ttlMs = Number(process.env.SEEKDEEP_RESEARCH_PENDING_TTL_MS || 15 * 60 * 1000);
  if ((seekdeepResearchNow() - Number(item.at || 0)) > ttlMs) {
    SEEKDEEP_PENDING_RESEARCH_TASKS.delete(key);
    return null;
  }
  return item;
}

function seekdeepSetPendingResearchTask(key, value = {}) {
  if (!key) return;
  SEEKDEEP_PENDING_RESEARCH_TASKS.set(key, {
    ...value,
    at: seekdeepResearchNow(),
  });
}

function seekdeepClearPendingResearchTask(key) {
  if (!key) return;
  SEEKDEEP_PENDING_RESEARCH_TASKS.delete(key);
}

function seekdeepIsFrustrationPrompt(prompt = '') {
  const p = normalizeUserText(prompt).toLowerCase();
  return /\b(fuck you|dumb ai|stupid ai|stupid bot|useless|clanker|you suck|garbage bot|trash bot|wrong again|that was wrong)\b/.test(p);
}

function seekdeepIsVagueWebRequest(prompt = '') {
  const p = normalizeUserText(prompt).toLowerCase();
  return (
    /\b(can you|could you|would you)?\s*(look|search|check|find)\s+(for\s+)?(something|stuff|things?)\s+(for me\s+)?(on|in|with|using)?\s*(the\s+)?(internet|web|online)\b/.test(p) ||
    /\b(use|search|check)\s+(the\s+)?(internet|web|online)\b/.test(p)
  ) && !seekdeepLooksLikeSpecificResearchPrompt(p);
}

function seekdeepLooksLikeSpecificResearchPrompt(prompt = '') {
  const p = normalizeUserText(prompt).toLowerCase();
  if (p.length < 8) return false;
  return /\b(compare|comparison|difference|versus|vs\.?|which|best|better|laptop|thinkpad|lenovo|x1 carbon|t14|amd|intel|price|specs?|review|current|latest|source|sources)\b/.test(p);
}

function seekdeepIsComparisonResearchPrompt(prompt = '') {
  const p = normalizeUserText(prompt).toLowerCase();
  return (
    /\b(difference between|compare|comparison|versus|vs\.?|which is better|amd over intel|intel over amd|why .* over .*)\b/.test(p) ||
    (/\b(lenovo|thinkpad|x1 carbon|t14|t14s|x13|laptop|notebook)\b/.test(p) && /\b(amd|intel|gen\s*\d+|generation|difference|compare|vs\.?|versus)\b/.test(p))
  );
}

function seekdeepIsTableRequestPrompt(prompt = '') {
  const p = normalizeUserText(prompt).toLowerCase();
  return /\b(table|tablesheet|spreadsheet|comparison table|compare table|chart|matrix|with compareness|compareness)\b/.test(p);
}

function seekdeepLooksLikeComparisonItemsFollowup(prompt = '') {
  const p = normalizeUserText(prompt).toLowerCase();
  if (p.length < 3) return false;
  if (seekdeepIsTableRequestPrompt(p) || seekdeepIsComparisonResearchPrompt(p)) return true;

  const hasModelish =
    /\b(t14|t14s|x1\s*carbon|x1carbon|x13|p14s|thinkpad|lenovo|latitude|elitebook|amd|intel|ryzen|core\s*i[3579]|gen\s*\d+|generation\s*\d+)\b/.test(p);

  const hasSeparatorOrGen = /\b(gen|generation|amd|intel|\/|,|;|\+|vs\.?|versus)\b/.test(p);

  return hasModelish && hasSeparatorOrGen;
}

function seekdeepCleanResearchTopic(prompt = '') {
  let p = normalizeUserText(prompt);

  p = p
    .replace(/^\s*(can you|could you|would you|please)\s+/i, '')
    .replace(/^\s*(create|make|give me|build)\s+(a\s+)?(table|tablesheet|spreadsheet|comparison table|chart|matrix)\s*(of|for|with)?\s*/i, '')
    .replace(/\b(with\s+compareness|compareness)\b/gi, 'comparison')
    .replace(/\s+/g, ' ')
    .trim();

  return p || normalizeUserText(prompt);
}

function seekdeepResearchSystem(mode = 'research') {
  const base = [
    'You are SeekDeep research mode for Discord.',
    'Be direct, correct, and willing to say when search results are insufficient.',
    'Use web/search context when provided. Do not bluff current product specs, prices, release details, or generation availability.',
    'When correcting a prior mistake, say so briefly and then give the corrected answer.',
    'No persona monologues. No filler. No roleplay.',
  ];

  if (mode === 'table') {
    base.push(
      'The user wants a comparison table.',
      'Produce a compact Markdown table first, then short buying guidance.',
      'For laptop comparisons, include CPU/platform, performance, battery/efficiency, weight/build, ports, RAM/storage, display options, thermals/noise, upgradeability, and best fit when the information is available.',
      'If exact specs vary by configuration, say "varies by config" instead of pretending one spec applies to every unit.'
    );
  } else {
    base.push(
      'For comparisons, organize by practical decision criteria.',
      'For product/spec questions, prefer sourced current facts and caveats over confident unsourced claims.'
    );
  }

  return base.join('\n');
}

function seekdeepResearchPrompt(topic = '', mode = 'research', prior = null) {
  const cleanTopic = seekdeepCleanResearchTopic(topic);
  if (mode === 'table') {
    return [
      'Create a comparison table for this request.',
      prior?.topic ? `Prior topic: ${prior.topic}` : '',
      `Current requested scope/items: ${cleanTopic}`,
      '',
      'If the current requested scope is a follow-up fragment, combine it with the prior topic.',
      'Answer in Markdown. Start with the table. Keep it useful for a buyer deciding what to choose.',
    ].filter(Boolean).join('\n');
  }

  return [
    'Research and answer this request using available web/search context.',
    `Request: ${cleanTopic}`,
    '',
    'If this is a product comparison, identify the concrete models/generations involved and avoid hallucinating unavailable variants.',
  ].join('\n');
}

async function seekdeepHandleResearchTableMessage(message, prompt, key) {
  const p = normalizeUserText(prompt);
  const lower = p.toLowerCase();
  const pending = seekdeepGetPendingResearchTask(key);

  if (seekdeepIsFrustrationPrompt(p)) {
    seekdeepLogRoute('frustration-recovery', prompt);
    const recovery = 'Fair. I gave a bad answer. Send the exact thing you want compared or searched and I’ll correct it with sources.';
    remember(key, 'user', prompt);
    remember(key, 'assistant', recovery);
    seekdeepSetResponseModel(message, seekdeepNoModelLabel());
    await sendLongMessageReply(message, recovery);
    return true;
  }

  if (seekdeepIsVagueWebRequest(p)) {
    seekdeepLogRoute('research-topic-needed', prompt);
    const answer = 'Yes. Send the exact thing you want searched or compared. For product specs, generations, prices, or current info, I’ll use web search instead of guessing.';
    seekdeepSetPendingResearchTask(key, { kind: 'research-topic-needed', topic: '', sourcePrompt: p });
    remember(key, 'user', prompt);
    remember(key, 'assistant', answer);
    seekdeepSetResponseModel(message, seekdeepNoModelLabel());
    await sendLongMessageReply(message, answer);
    return true;
  }

  if (seekdeepIsTableRequestPrompt(p) && !seekdeepLooksLikeComparisonItemsFollowup(p)) {
    seekdeepLogRoute('research-table-request', prompt);
    if (pending?.topic) {
      const tablePrompt = seekdeepResearchPrompt(pending.topic, 'table', pending);
      const answer = await askChat(tablePrompt, {
        web: 'always',
        memoryKey: key,
        system: seekdeepResearchSystem('table'),
        maxNewTokens: Number(process.env.SEEKDEEP_RESEARCH_TABLE_MAX_TOKENS || 1800),
        temperature: 0.2,
      });

      remember(key, 'user', prompt);
      remember(key, 'assistant', answer);
      seekdeepSetResponseModel(message, seekdeepChatModelLabel());
      await sendLongMessageReply(message, answer);
      seekdeepSetPendingResearchTask(key, { kind: 'table', topic: pending.topic, lastAnswer: answer });
      return true;
    }

    const answer = 'Yes. Send the exact items/models you want compared, and I’ll make a table with sourced specs instead of guessing.';
    seekdeepSetPendingResearchTask(key, { kind: 'table-awaiting-items', topic: '', sourcePrompt: p });
    remember(key, 'user', prompt);
    remember(key, 'assistant', answer);
    seekdeepSetResponseModel(message, seekdeepNoModelLabel());
    await sendLongMessageReply(message, answer);
    return true;
  }

  if (pending && (pending.kind === 'table-awaiting-items' || pending.kind === 'research-topic-needed' || pending.kind === 'table') && seekdeepLooksLikeComparisonItemsFollowup(p)) {
    seekdeepLogRoute('research-table-followup', prompt);
    const mergedTopic = [pending.topic, p].filter(Boolean).join(' ').trim() || p;
    const tablePrompt = seekdeepResearchPrompt(mergedTopic, 'table', pending);

    const answer = await askChat(tablePrompt, {
      web: 'always',
      memoryKey: key,
      system: seekdeepResearchSystem('table'),
      maxNewTokens: Number(process.env.SEEKDEEP_RESEARCH_TABLE_MAX_TOKENS || 2200),
      temperature: 0.2,
    });

    remember(key, 'user', prompt);
    remember(key, 'assistant', answer);
    seekdeepSetResponseModel(message, seekdeepChatModelLabel());
    await sendLongMessageReply(message, answer);
    seekdeepSetPendingResearchTask(key, { kind: 'table', topic: mergedTopic, lastAnswer: answer });
    return true;
  }

  if (seekdeepIsComparisonResearchPrompt(p)) {
    seekdeepLogRoute('research-comparison', prompt);
    const topic = seekdeepCleanResearchTopic(p);
    const answer = await askChat(seekdeepResearchPrompt(topic, 'research', pending), {
      web: 'always',
      memoryKey: key,
      system: seekdeepResearchSystem('research'),
      maxNewTokens: Number(process.env.SEEKDEEP_RESEARCH_MAX_TOKENS || 1800),
      temperature: 0.22,
    });

    remember(key, 'user', prompt);
    remember(key, 'assistant', answer);
    seekdeepSetResponseModel(message, seekdeepChatModelLabel());
    await sendLongMessageReply(message, answer);
    seekdeepSetPendingResearchTask(key, { kind: 'comparison', topic, lastAnswer: answer });
    return true;
  }

  return false;
}
// SEEKDEEP_RESEARCH_TABLE_CONTEXT_END
"""

if "SEEKDEEP_RESEARCH_TABLE_CONTEXT_START" not in text:
    anchor = "// SEEKDEEP_HARD_COMMAND_DEDUPE_EXEMPT_START"
    require_contains(text, anchor, "hard command dedupe anchor")
    text = text.replace(anchor, helper + "\n" + anchor, 1)

hook = """    if (await seekdeepHandleResearchTableMessage(message, prompt, key)) {
      return;
    }

"""
if "seekdeepHandleResearchTableMessage(message, prompt, key)" not in text:
    chat_anchor = "    seekdeepLogRoute('chat', prompt);\n"
    require_contains(text, chat_anchor, "chat route hook anchor")
    text = text.replace(chat_anchor, hook + chat_anchor, 1)

for needle, label in [
    ("SEEKDEEP_RESEARCH_TABLE_CONTEXT_START", "research helper marker"),
    ("async function seekdeepHandleResearchTableMessage", "research handler"),
    ("seekdeepIsVagueWebRequest", "vague web handler"),
    ("seekdeepIsComparisonResearchPrompt", "comparison detector"),
    ("seekdeepIsTableRequestPrompt", "table detector"),
    ("seekdeepLooksLikeComparisonItemsFollowup", "followup detector"),
    ("web: 'always'", "forced web research"),
    ("seekdeepHandleResearchTableMessage(message, prompt, key)", "message route hook"),
    ("seekdeepEnqueueImageJob(job, runner)", "image queue contract preserved"),
]:
    require_contains(text, needle, label)

out = text if newline == "\n" else text.replace("\n", "\r\n")
path.write_bytes(out.encode("utf-8"))
print("Patched research/table context helpers and message hook.")
'@

  $patchPyPath = Join-Path $patchesDir "patch_research_table_context.py"
  [System.IO.File]::WriteAllText($patchPyPath, $patchPy, $utf8NoBom)

  Push-Location $projectRoot
  try {
    Write-Info "Applying research/table context patch"
    & ".\.venv\Scripts\python.exe" $patchPyPath $indexPath
    if ($LASTEXITCODE -ne 0) {
      throw "Patch helper failed with exit code $LASTEXITCODE."
    }
    Write-Pass "Applied research/table context patch"

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
  Write-Pass "Research/table context patch completed."
  Write-Host "Backup created: $indexBackup" -ForegroundColor Yellow
  Write-Host "Restart the Discord bot before testing." -ForegroundColor Yellow
  Write-Host ""
  Write-Host "Retest sequence:" -ForegroundColor Cyan
  Write-Host "@SEEKOTICS Can you look for something for me in the internet" -ForegroundColor White
  Write-Host "@SEEKOTICS Difference between Lenovo X1 Carbon and T14 also why T14 AMD over Intel since there is no X1 Carbon AMD" -ForegroundColor White
  Write-Host "@SEEKOTICS Can you create a tablesheet? With compareness" -ForegroundColor White
  Write-Host "@SEEKOTICS T14 gen 2/3 amd/intel, X1 Carbon gen 9/10" -ForegroundColor White
  exit 0
} catch {
  Write-Host ""
  Write-Fail $_.Exception.Message
  Write-Host "Backup available:" -ForegroundColor Yellow
  if ($indexBackup) { Write-Host $indexBackup -ForegroundColor Yellow }
  exit 1
}
