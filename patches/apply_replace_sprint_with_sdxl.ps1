# SeekDeep / Seekotics image model replacement: Sana Sprint -> SDXL Base
#
# What this patch does
# - Replaces the fast Sana Sprint image model with SDXL Base.
# - Removes the hardcoded 2-step Sana-only image generation path.
# - Makes image steps configurable again.
# - Sets safer SDXL defaults in .env.
#
# Files patched:
# - index.js
# - local_ai_server.py
# - .env
#
# Required checks:
#   node --check .\index.js
#   .\.venv\Scripts\python.exe -m py_compile .\local_ai_server.py

$ErrorActionPreference = 'Stop'

try {
  [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
} catch {}

function Write-SeekDeepInfo {
  param([string]$Message)
  Write-Host "[SeekDeep patch] $Message" -ForegroundColor Cyan
}

function Write-SeekDeepPass {
  param([string]$Message)
  Write-Host "[PASS] $Message" -ForegroundColor Green
}

function Write-SeekDeepFail {
  param([string]$Message)
  Write-Host "[FAIL] $Message" -ForegroundColor Red
}

function Resolve-SeekDeepRoot {
  $scriptPath = $PSCommandPath
  if (-not $scriptPath) {
    $scriptPath = $MyInvocation.MyCommand.Path
  }

  $scriptDir = $null
  if ($scriptPath) {
    $scriptDir = Split-Path -Parent $scriptPath
  }

  $candidates = New-Object System.Collections.Generic.List[string]

  if ($scriptDir) {
    if ((Split-Path -Leaf $scriptDir) -ieq 'patches') {
      $candidates.Add((Split-Path -Parent $scriptDir))
    }
    $candidates.Add($scriptDir)
  }

  $candidates.Add((Get-Location).Path)
  $candidates.Add((Join-Path $env:USERPROFILE 'SeekDeep-DiscordBot'))

  foreach ($candidate in $candidates) {
    if (-not [string]::IsNullOrWhiteSpace($candidate)) {
      $index = Join-Path $candidate 'index.js'
      $server = Join-Path $candidate 'local_ai_server.py'
      $envFile = Join-Path $candidate '.env'
      if ((Test-Path -LiteralPath $index) -and (Test-Path -LiteralPath $server) -and (Test-Path -LiteralPath $envFile)) {
        return (Resolve-Path -LiteralPath $candidate).Path
      }
    }
  }

  throw 'Could not locate SeekDeep project root. Run this from C:\Users\natha\SeekDeep-DiscordBot or place it in C:\Users\natha\SeekDeep-DiscordBot\patches.'
}

function Invoke-CheckedCommand {
  param(
    [Parameter(Mandatory=$true)][string]$Label,
    [Parameter(Mandatory=$true)][scriptblock]$Command
  )

  Write-SeekDeepInfo "Running $Label"
  & $Command
  if ($LASTEXITCODE -ne 0) {
    throw "$Label failed with exit code $LASTEXITCODE."
  }

  Write-SeekDeepPass "$Label passed"
}

try {
  $projectRoot = Resolve-SeekDeepRoot
  $indexPath = Join-Path $projectRoot 'index.js'
  $serverPath = Join-Path $projectRoot 'local_ai_server.py'
  $envPath = Join-Path $projectRoot '.env'
  $patchesDir = Join-Path $projectRoot 'patches'
  $backupDir = Join-Path $patchesDir 'backups'
  $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'

  New-Item -ItemType Directory -Path $patchesDir -Force | Out-Null
  New-Item -ItemType Directory -Path $backupDir -Force | Out-Null

  Write-SeekDeepInfo "Project root: $projectRoot"

  $indexBackup = Join-Path $backupDir "index.js.replace-sprint-with-sdxl-$stamp.bak"
  $serverBackup = Join-Path $backupDir "local_ai_server.py.replace-sprint-with-sdxl-$stamp.bak"
  $envBackup = Join-Path $backupDir ".env.replace-sprint-with-sdxl-$stamp.bak"

  Copy-Item -LiteralPath $indexPath -Destination $indexBackup -Force
  Copy-Item -LiteralPath $serverPath -Destination $serverBackup -Force
  Copy-Item -LiteralPath $envPath -Destination $envBackup -Force

  Write-SeekDeepPass "Backed up index.js to $indexBackup"
  Write-SeekDeepPass "Backed up local_ai_server.py to $serverBackup"
  Write-SeekDeepPass "Backed up .env to $envBackup"

  $patchPy = @'
from pathlib import Path
import re
import sys

if len(sys.argv) != 4:
    raise SystemExit("Usage: patch_replace_sprint_with_sdxl.py <index.js> <local_ai_server.py> <.env>")

index_path = Path(sys.argv[1])
server_path = Path(sys.argv[2])
env_path = Path(sys.argv[3])

SDXL_MODEL_ID = "stabilityai/stable-diffusion-xl-base-1.0"
SDXL_STEPS = "28"
SDXL_GUIDANCE = "6.5"


def read_text_with_newline(path: Path):
    raw = path.read_bytes()
    newline = "\r\n" if b"\r\n" in raw else "\n"
    text = raw.decode("utf-8-sig")
    text = text.replace("\r\n", "\n").replace("\r", "\n")
    return text, newline


def write_text_with_newline(path: Path, text: str, newline: str):
    out = text if newline == "\n" else text.replace("\n", "\r\n")
    path.write_bytes(out.encode("utf-8"))


def require_contains(haystack: str, needle: str, label: str):
    if needle not in haystack:
        raise SystemExit(f"Required anchor not found: {label}")


index_text, index_nl = read_text_with_newline(index_path)
server_text, server_nl = read_text_with_newline(server_path)
env_text, env_nl = read_text_with_newline(env_path)

# ----- index.js -----
require_contains(index_text, "LOCAL_IMAGE_MODEL_ID", "index.js image model label")
require_contains(index_text, "steps: 2,", "index.js hardcoded image steps")
require_contains(index_text, "guidance_scale: Number(process.env.IMAGE_GUIDANCE_SCALE || 0.0),", "index.js image guidance line")

index_text = index_text.replace(
    "return process.env.LOCAL_IMAGE_MODEL_ID || 'Efficient-Large-Model/Sana_Sprint_1.6B_1024px_diffusers';",
    "return process.env.LOCAL_IMAGE_MODEL_ID || 'stabilityai/stable-diffusion-xl-base-1.0';",
    1,
)
index_text = index_text.replace("steps: 2,", "steps: Number(process.env.IMAGE_STEPS || 28),", 1)
index_text = index_text.replace(
    "guidance_scale: Number(process.env.IMAGE_GUIDANCE_SCALE || 0.0),",
    "guidance_scale: Number(process.env.IMAGE_GUIDANCE_SCALE || 6.5),",
    1,
)

# ----- local_ai_server.py -----
require_contains(server_text, 'IMAGE_MODEL_ID = os.getenv("LOCAL_IMAGE_MODEL_ID", "Efficient-Large-Model/Sana_Sprint_1.6B_1024px_diffusers")', 'server image model default')
require_contains(server_text, 'steps: int = Field(default=2, ge=1, le=50)', 'server ImageRequest default steps')
require_contains(server_text, '"num_inference_steps": 2,', 'server hardcoded 2-step image args')
require_contains(server_text, '"forced_steps": 2,', 'server forced_steps response')

server_text = server_text.replace(
    'IMAGE_MODEL_ID = os.getenv("LOCAL_IMAGE_MODEL_ID", "Efficient-Large-Model/Sana_Sprint_1.6B_1024px_diffusers")',
    'IMAGE_MODEL_ID = os.getenv("LOCAL_IMAGE_MODEL_ID", "stabilityai/stable-diffusion-xl-base-1.0")',
    1,
)
server_text = server_text.replace('steps: int = Field(default=2, ge=1, le=50)', 'steps: int = Field(default=28, ge=1, le=50)', 1)
server_text = server_text.replace(
    '# Image generation - Sana Sprint requires exactly 2 inference steps.',
    '# Image generation - configurable diffusion steps for the current model.',
    1,
)

# Replace the Sana-specific steps block.
old_block = '''    # Sana Sprint SCM pipeline supports exactly 2 steps. Do not use arbitrary steps.
    args = {
        "prompt": req.prompt.strip(),
        "width": width,
        "height": height,
        "num_inference_steps": 2,
        "guidance_scale": float(req.guidance_scale),
    }
'''
new_block = '''    actual_steps = max(1, min(50, int(req.steps)))

    args = {
        "prompt": req.prompt.strip(),
        "width": width,
        "height": height,
        "num_inference_steps": actual_steps,
        "guidance_scale": float(req.guidance_scale),
    }
'''
if old_block not in server_text:
    raise SystemExit('Could not locate Sana-only image args block in local_ai_server.py.')
server_text = server_text.replace(old_block, new_block, 1)
server_text = server_text.replace('"forced_steps": 2,', '"forced_steps": actual_steps,', 1)

# ----- .env -----
require_contains(env_text, 'LOCAL_IMAGE_MODEL_ID=', '.env image model id')
require_contains(env_text, 'IMAGE_STEPS=', '.env image steps')
require_contains(env_text, 'IMAGE_GUIDANCE_SCALE=', '.env image guidance scale')


def set_env_value(text: str, key: str, value: str) -> str:
    pattern = re.compile(rf'^(\s*{re.escape(key)}=).*$' , re.M)
    if pattern.search(text):
        return pattern.sub(rf'\1{value}', text, count=1)
    if not text.endswith('\n'):
        text += '\n'
    return text + f'{key}={value}\n'

env_text = set_env_value(env_text, 'LOCAL_IMAGE_MODEL_ID', SDXL_MODEL_ID)
env_text = set_env_value(env_text, 'IMAGE_STEPS', SDXL_STEPS)
env_text = set_env_value(env_text, 'IMAGE_GUIDANCE_SCALE', SDXL_GUIDANCE)

# Optional status hint comments (only if not already present)
if '# SDXL replacement defaults' not in env_text:
    anchor = 'IMAGE_SEED=-1'
    insert = 'IMAGE_SEED=-1\n# SDXL replacement defaults\n# If the model is not already cached, first startup will fail while offline-only flags remain enabled.\n# Temporarily disable HF_LOCAL_FILES_ONLY / HF_HUB_OFFLINE / TRANSFORMERS_OFFLINE if you need the model to download.\n'
    if anchor in env_text:
        env_text = env_text.replace(anchor, insert, 1)

write_text_with_newline(index_path, index_text, index_nl)
write_text_with_newline(server_path, server_text, server_nl)
write_text_with_newline(env_path, env_text, env_nl)

print('Patched index.js, local_ai_server.py, and .env for SDXL image generation.')
'@

  $patchPyPath = Join-Path $patchesDir 'patch_replace_sprint_with_sdxl.py'
  [System.IO.File]::WriteAllText($patchPyPath, $patchPy, [System.Text.UTF8Encoding]::new($false))
  Write-SeekDeepPass "Wrote UTF-8 patch helper to $patchPyPath"

  Push-Location $projectRoot
  try {
    Write-SeekDeepInfo 'Applying SDXL replacement patch'
    & '.\.venv\Scripts\python.exe' $patchPyPath $indexPath $serverPath $envPath
    if ($LASTEXITCODE -ne 0) {
      throw "Python patch helper failed with exit code $LASTEXITCODE."
    }
    Write-SeekDeepPass 'Applied SDXL replacement patch'

    Invoke-CheckedCommand 'node --check .\index.js' {
      & node --check '.\index.js'
    }

    Invoke-CheckedCommand '.\.venv\Scripts\python.exe -m py_compile .\local_ai_server.py' {
      & '.\.venv\Scripts\python.exe' -m py_compile '.\local_ai_server.py'
    }
  }
  finally {
    Pop-Location
  }

  Write-Host ''
  Write-Host 'SeekDeep image model replacement patch completed successfully.' -ForegroundColor Green
  Write-Host 'Backups:' -ForegroundColor Yellow
  Write-Host $indexBackup -ForegroundColor Yellow
  Write-Host $serverBackup -ForegroundColor Yellow
  Write-Host $envBackup -ForegroundColor Yellow
  Write-Host ''
  Write-Host 'Important:' -ForegroundColor Yellow
  Write-Host '- Your current .env is offline-only. If SDXL is not already cached, first startup will fail until the model is downloaded.' -ForegroundColor Yellow
  Write-Host '- After patching, restart the local AI server and the bot.' -ForegroundColor Yellow
  exit 0
}
catch {
  Write-Host ''
  Write-SeekDeepFail $_.Exception.Message
  Write-Host 'Backups are available here if you need to restore:' -ForegroundColor Yellow
  if ($indexBackup) { Write-Host $indexBackup -ForegroundColor Yellow }
  if ($serverBackup) { Write-Host $serverBackup -ForegroundColor Yellow }
  if ($envBackup) { Write-Host $envBackup -ForegroundColor Yellow }
  exit 1
}
