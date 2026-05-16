<#
SeekDeep repair patch: restore pending research task helpers.

Fixes:
- ReferenceError: seekdeepGetPendingResearchTask is not defined
- Defines bounded in-memory pending research state helpers used by seekdeepHandleResearchTableMessage.

Safety:
- Creates timestamped backup before edits.
- Uses a single stable anchor.
- Idempotent: exits cleanly if this patch is already present.
- Runs node --check .\index.js.
- Runs Python compile check for .\local_ai_server.py when the venv exists.
- Restores backup automatically on failure.
#>

$ErrorActionPreference = 'Stop'

function Write-Step([string]$Message) {
  Write-Host "[SeekDeep patch] $Message"
}

function Fail-And-Restore([string]$Message) {
  Write-Host ""
  Write-Host "[SeekDeep patch] FAILED: $Message" -ForegroundColor Red
  if ($script:BackupPath -and (Test-Path $script:BackupPath) -and (Test-Path $script:IndexPath)) {
    Copy-Item $script:BackupPath $script:IndexPath -Force
    Write-Host "[SeekDeep patch] Restored backup: $script:BackupPath" -ForegroundColor Yellow
  }
  exit 1
}

try {
  $ProjectRoot = (Get-Location).Path
  $script:IndexPath = Join-Path $ProjectRoot 'index.js'

  if (!(Test-Path $script:IndexPath)) {
    throw "index.js not found. Run this from C:\Users\natha\SeekDeep-DiscordBot."
  }

  $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
  $backupDir = Join-Path $ProjectRoot 'backups'
  New-Item -ItemType Directory -Path $backupDir -Force | Out-Null
  $script:BackupPath = Join-Path $backupDir "index.before-research-pending-helpers.$stamp.js"

  Copy-Item $script:IndexPath $script:BackupPath -Force
  Write-Step "Backup created: $script:BackupPath"

  $text = Get-Content -LiteralPath $script:IndexPath -Raw -Encoding UTF8

  if ($text -match 'SEEKDEEP_PENDING_RESEARCH_TASKS_PATCH_START') {
    Write-Step "Patch marker already present. No edit needed."
  } else {
    if ($text -notmatch 'function\s+seekdeepHandleResearchTableMessage\s*\(') {
      Fail-And-Restore "Expected research table handler was not found. Aborting instead of patching unknown file shape."
    }

    if ($text -match 'function\s+seekdeepGetPendingResearchTask\s*\(' -or $text -match 'function\s+seekdeepSetPendingResearchTask\s*\(') {
      Fail-And-Restore "A pending research helper already exists but without this patch marker. Aborting to avoid duplicate declarations."
    }

    $anchor = "function seekdeepResearchPrompt("
    $anchorIndex = $text.IndexOf($anchor)
    if ($anchorIndex -lt 0) {
      Fail-And-Restore "Stable insertion anchor not found: $anchor"
    }

    $insert = @'
// SEEKDEEP_PENDING_RESEARCH_TASKS_PATCH_START
// In-memory follow-up context for research/table conversations.
// This intentionally stays local and bounded: it prevents the research handler from
// crashing on archive/status commands while still allowing short follow-up prompts
// like "make a table" or "pros and cons" to reference the prior research answer.
const seekdeepPendingResearchTasks = new Map();
const SEEKDEEP_PENDING_RESEARCH_TASK_TTL_MS = Math.max(
  60 * 1000,
  Number(process.env.SEEKDEEP_PENDING_RESEARCH_TASK_TTL_MS || 45 * 60 * 1000)
);

function seekdeepPendingResearchTaskKey(key = '') {
  const clean = String(key || '').trim();
  return clean || 'global';
}

function seekdeepPrunePendingResearchTasks(now = Date.now()) {
  for (const [taskKey, task] of seekdeepPendingResearchTasks.entries()) {
    const expiresAt = Number(task?.expiresAt || 0);
    if (expiresAt > 0 && expiresAt <= now) {
      seekdeepPendingResearchTasks.delete(taskKey);
    }
  }
}

function seekdeepGetPendingResearchTask(key = '') {
  seekdeepPrunePendingResearchTasks();
  const taskKey = seekdeepPendingResearchTaskKey(key);
  const task = seekdeepPendingResearchTasks.get(taskKey) || null;
  if (!task) return null;

  const expiresAt = Number(task.expiresAt || 0);
  if (expiresAt > 0 && expiresAt <= Date.now()) {
    seekdeepPendingResearchTasks.delete(taskKey);
    return null;
  }

  return task;
}

function seekdeepSetPendingResearchTask(key = '', task = null) {
  seekdeepPrunePendingResearchTasks();
  const taskKey = seekdeepPendingResearchTaskKey(key);

  if (!task || typeof task !== 'object') {
    seekdeepPendingResearchTasks.delete(taskKey);
    return null;
  }

  const now = Date.now();
  const stored = {
    ...task,
    updatedAt: now,
    expiresAt: now + SEEKDEEP_PENDING_RESEARCH_TASK_TTL_MS,
  };

  seekdeepPendingResearchTasks.set(taskKey, stored);
  return stored;
}
// SEEKDEEP_PENDING_RESEARCH_TASKS_PATCH_END

'@

    $text = $text.Insert($anchorIndex, $insert)
    Set-Content -LiteralPath $script:IndexPath -Value $text -Encoding UTF8
    Write-Step "Inserted pending research task helpers."
  }

  $updated = Get-Content -LiteralPath $script:IndexPath -Raw -Encoding UTF8
  foreach ($required in @(
    'const seekdeepPendingResearchTasks = new Map();',
    'function seekdeepGetPendingResearchTask',
    'function seekdeepSetPendingResearchTask'
  )) {
    if ($updated -notlike "*$required*") {
      Fail-And-Restore "Post-patch verification failed. Missing: $required"
    }
  }

  Write-Step "Running node syntax check..."
  Push-Location $ProjectRoot
  try {
    node --check .\index.js
    if ($LASTEXITCODE -ne 0) {
      Fail-And-Restore "node --check failed."
    }
  } finally {
    Pop-Location
  }

  $python = Join-Path $ProjectRoot '.venv\Scripts\python.exe'
  $server = Join-Path $ProjectRoot 'local_ai_server.py'
  if ((Test-Path $python) -and (Test-Path $server)) {
    Write-Step "Running Python compile check..."
    Push-Location $ProjectRoot
    try {
      & $python -m py_compile .\local_ai_server.py
      if ($LASTEXITCODE -ne 0) {
        Fail-And-Restore "Python compile check failed."
      }
    } finally {
      Pop-Location
    }
  } else {
    Write-Step "Python compile check skipped; venv or local_ai_server.py not found."
  }

  Write-Host ""
  Write-Host "[SeekDeep patch] SUCCESS" -ForegroundColor Green
  Write-Host "Fixed missing pending research helper functions. Restart the bot and retry:"
  Write-Host "  @SeekDeep archive @NathanNeurotic"
  Write-Host "Then test a normal research follow-up later, such as:"
  Write-Host "  make a table"
  exit 0
}
catch {
  Fail-And-Restore $_.Exception.Message
}
