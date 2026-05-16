# SeekDeep / Seekotics shorten image prompt auto-refinement for Juggernaut / SDXL-family models
#
# Purpose:
# - Reduce prompt bloat so SDXL-family models like Juggernaut XL v9 stop truncating prompts
# - Preserve current routing / queue / cooldown behavior
#
# Files patched:
# - index.js
#
# Workflow guarantees:
# - Backs up index.js first
# - Uses UTF-8-safe patching
# - Runs:
#     node --check .\index.js
#     .\.venv\Scripts\python.exe -m py_compile .\local_ai_server.py

$ErrorActionPreference = "Stop"

try {
  [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
} catch {}

function Write-Info {
  param([string]$Message)
  Write-Host "[SeekDeep refine-shortener] $Message" -ForegroundColor Cyan
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

  $indexBackup = Join-Path $backupDir "index.js.shorten-image-refinement-$stamp.bak"
  Copy-Item -LiteralPath $indexPath -Destination $indexBackup -Force
  Write-Pass "Backed up index.js to $indexBackup"

  $utf8NoBom = [System.Text.UTF8Encoding]::new($false)

  $patchPy = @'
from pathlib import Path
import sys

if len(sys.argv) != 2:
    raise SystemExit("Usage: shorten_image_refinement.py <index.js>")

path = Path(sys.argv[1])
raw = path.read_bytes()
newline = "\r\n" if b"\r\n" in raw else "\n"
text = raw.decode("utf-8-sig").replace("\r\n", "\n").replace("\r", "\n")

def require_contains(haystack: str, needle: str, label: str):
    if needle not in haystack:
        raise SystemExit(f"Required anchor not found: {label}")

replacements = [
    (
        "const SEEKDEEP_IMAGE_PROMPT_MAX_CHARS = Math.max(300, Number(process.env.SEEKDEEP_IMAGE_PROMPT_MAX_CHARS || 900));",
        "const SEEKDEEP_IMAGE_PROMPT_MAX_CHARS = Math.max(240, Number(process.env.SEEKDEEP_IMAGE_PROMPT_MAX_CHARS || 420));",
        "max chars constant"
    ),
    (
        "seekdeepImagePromptAdd(parts, 'clean graphic emblem design, bold readable silhouette, scalable vector-like shapes');",
        "seekdeepImagePromptAdd(parts, 'clean emblem design, bold silhouette, vector-like shapes');",
        "logo refinement"
    ),
    (
        "seekdeepImagePromptAdd(parts, 'balanced centered composition with strong negative space');",
        "seekdeepImagePromptAdd(parts, 'centered composition, strong negative space');",
        "logo composition refinement"
    ),
    (
        "seekdeepImagePromptAdd(parts, 'no random lettering, no fake brand marks, no malformed symbols');",
        "seekdeepImagePromptAdd(parts, 'no random lettering, no fake brand marks');",
        "logo negative refinement"
    ),
    (
        "seekdeepImagePromptAdd(parts, 'polished graphic illustration with a strong focal point');",
        "seekdeepImagePromptAdd(parts, 'graphic illustration, strong focal point');",
        "banner style refinement"
    ),
    (
        "seekdeepImagePromptAdd(parts, 'clear composition, usable negative space, layered background depth');",
        "seekdeepImagePromptAdd(parts, 'clear composition, layered depth');",
        "banner composition refinement"
    ),
    (
        "seekdeepImagePromptAdd(parts, 'natural materials, accurate structure, believable surface detail');",
        "seekdeepImagePromptAdd(parts, 'natural materials, believable surface detail');",
        "realistic detail refinement"
    ),
    (
        "if (!hasLighting) seekdeepImagePromptAdd(parts, 'controlled realistic lighting with clear depth');",
        "if (!hasLighting) seekdeepImagePromptAdd(parts, 'realistic lighting, clear depth');",
        "realistic lighting refinement"
    ),
    (
        "seekdeepImagePromptAdd(parts, 'stylized detailed illustration, strong readable subject, polished composition');",
        "seekdeepImagePromptAdd(parts, 'detailed illustration, readable subject, polished composition');",
        "default style refinement"
    ),
    (
        "if (seekdeepImagePromptHasAny(lower, ['cat', 'dog', 'fox', 'frog', 'animal', 'creature', 'dragon', 'bird', 'horse'])) seekdeepImagePromptAdd(parts, 'coherent animal anatomy, expressive face, natural pose');",
        "if (seekdeepImagePromptHasAny(lower, ['cat', 'dog', 'fox', 'frog', 'animal', 'creature', 'dragon', 'bird', 'horse'])) seekdeepImagePromptAdd(parts, 'coherent animal anatomy, natural pose');",
        "animal refinement"
    ),
    (
        "if (seekdeepImagePromptHasAny(lower, ['girl', 'woman', 'boy', 'man', 'person', 'human', 'elf', 'character', 'portrait'])) seekdeepImagePromptAdd(parts, 'coherent face, natural anatomy, clean hands, readable character design');",
        "if (seekdeepImagePromptHasAny(lower, ['girl', 'woman', 'boy', 'man', 'person', 'human', 'elf', 'character', 'portrait'])) seekdeepImagePromptAdd(parts, 'coherent face, natural anatomy, clean hands');",
        "character refinement"
    ),
    (
        "if (seekdeepImagePromptHasAny(lower, ['plant', 'flower', 'tree', 'forest', 'leaf', 'leaves', 'cannabis', 'marijuana', 'moss', 'fungi'])) seekdeepImagePromptAdd(parts, 'botanical detail, clear leaf structure, organic texture, natural growth pattern');",
        "if (seekdeepImagePromptHasAny(lower, ['plant', 'flower', 'tree', 'forest', 'leaf', 'leaves', 'cannabis', 'marijuana', 'moss', 'fungi'])) seekdeepImagePromptAdd(parts, 'botanical detail, clear leaf structure');",
        "plant refinement"
    ),
    (
        "if (seekdeepImagePromptHasAny(lower, ['hyrule', 'fantasy kingdom', 'castle', 'wizard', 'dungeon', 'forest', 'deku'])) seekdeepImagePromptAdd(parts, 'fantasy adventure atmosphere, detailed environment, whimsical but coherent world design');",
        "if (seekdeepImagePromptHasAny(lower, ['hyrule', 'fantasy kingdom', 'castle', 'wizard', 'dungeon', 'forest', 'deku'])) seekdeepImagePromptAdd(parts, 'fantasy atmosphere, detailed environment');",
        "fantasy refinement"
    ),
    (
        "if (!hasQuality) seekdeepImagePromptAdd(parts, 'high quality, coherent details, clean edges, no muddy artifacts');",
        "if (!hasQuality) seekdeepImagePromptAdd(parts, 'high quality, clean edges, coherent details');",
        "quality refinement"
    ),
    (
        "if (!hasLighting) seekdeepImagePromptAdd(parts, 'intentional lighting, color harmony, clear depth separation');",
        "if (!hasLighting) seekdeepImagePromptAdd(parts, 'intentional lighting, clear depth');",
        "general lighting refinement"
    ),
    (
        "if (!asksText) seekdeepImagePromptAdd(parts, 'no random text, no unreadable letters');",
        "if (!asksText) seekdeepImagePromptAdd(parts, 'no random text');",
        "text avoidance refinement"
    ),
    (
        "seekdeepImagePromptAdd(parts, 'avoid malformed limbs, duplicated faces, distorted eyes, warped anatomy, cluttered composition');",
        "seekdeepImagePromptAdd(parts, 'avoid malformed anatomy, distorted eyes, clutter');",
        "negative refinement"
    ),
]

patch_count = 0
for old, new, label in replacements:
    require_contains(text, old, label)
    text = text.replace(old, new, 1)
    patch_count += 1

# Safety checks to confirm the shortened phrases are now present.
required_new = [
    "const SEEKDEEP_IMAGE_PROMPT_MAX_CHARS = Math.max(240, Number(process.env.SEEKDEEP_IMAGE_PROMPT_MAX_CHARS || 420));",
    "seekdeepImagePromptAdd(parts, 'detailed illustration, readable subject, polished composition');",
    "if (!hasQuality) seekdeepImagePromptAdd(parts, 'high quality, clean edges, coherent details');",
    "if (!hasLighting) seekdeepImagePromptAdd(parts, 'intentional lighting, clear depth');",
    "seekdeepImagePromptAdd(parts, 'avoid malformed anatomy, distorted eyes, clutter');",
]
for needle in required_new:
    require_contains(text, needle, needle)

out = text if newline == "\n" else text.replace("\n", "\r\n")
path.write_bytes(out.encode("utf-8"))
print(f"Patched {patch_count} image prompt refinement lines.")
'@

  $patchPyPath = Join-Path $patchesDir "shorten_image_refinement.py"
  [System.IO.File]::WriteAllText($patchPyPath, $patchPy, $utf8NoBom)

  Push-Location $projectRoot
  try {
    Write-Info "Applying image prompt refinement shortener"
    & ".\.venv\Scripts\python.exe" $patchPyPath $indexPath
    if ($LASTEXITCODE -ne 0) {
      throw "Patch helper failed with exit code $LASTEXITCODE."
    }
    Write-Pass "Applied image prompt refinement shortener"

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
  Write-Pass "Image prompt auto-refinement shortener completed."
  Write-Host "Backup created: $indexBackup" -ForegroundColor Yellow
  Write-Host "Restart the Discord bot before testing." -ForegroundColor Yellow
  Write-Host ""
  Write-Host "Expected result:" -ForegroundColor Cyan
  Write-Host "- shorter refined prompts" -ForegroundColor White
  Write-Host "- less SDXL/Juggernaut truncation" -ForegroundColor White
  Write-Host "- same routing / queue behavior" -ForegroundColor White
  exit 0
} catch {
  Write-Host ""
  Write-Fail $_.Exception.Message
  Write-Host "Backup available:" -ForegroundColor Yellow
  if ($indexBackup) { Write-Host $indexBackup -ForegroundColor Yellow }
  exit 1
}
