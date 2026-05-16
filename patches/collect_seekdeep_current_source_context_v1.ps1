$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$ProjectRoot = (Get-Location).Path
$Stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$OutRoot = Join-Path $ProjectRoot ".\diagnostics\seekdeep-current-source-context-$Stamp"
$ZipPath = Join-Path $env:USERPROFILE "Downloads\seekdeep-current-source-context-$Stamp.zip"

if (-not (Test-Path (Join-Path $ProjectRoot 'index.js'))) {
  throw "index.js not found. Run this from C:\Users\natha\SeekDeep-DiscordBot"
}

New-Item -ItemType Directory -Path $OutRoot -Force | Out-Null

$SafeFiles = @(
  'index.js',
  'local_ai_server.py',
  'package.json',
  'package-lock.json',
  'README.md'
)

foreach ($Rel in $SafeFiles) {
  $Src = Join-Path $ProjectRoot $Rel
  if (Test-Path $Src) {
    Copy-Item $Src (Join-Path $OutRoot $Rel) -Force
  }
}

# Do not copy .env or secrets. Record only whether it exists.
$EnvPath = Join-Path $ProjectRoot '.env'
"ProjectRoot: $ProjectRoot" | Set-Content (Join-Path $OutRoot 'diagnostic-summary.txt') -Encoding UTF8
"Timestamp: $Stamp" | Add-Content (Join-Path $OutRoot 'diagnostic-summary.txt') -Encoding UTF8
".env present: $([bool](Test-Path $EnvPath))" | Add-Content (Join-Path $OutRoot 'diagnostic-summary.txt') -Encoding UTF8
"" | Add-Content (Join-Path $OutRoot 'diagnostic-summary.txt') -Encoding UTF8

# Capture validation output without stopping the collector.
try {
  node --check ".\index.js" *> (Join-Path $OutRoot 'node-check-index.txt')
} catch {
  $_ | Out-String | Set-Content (Join-Path $OutRoot 'node-check-index-exception.txt') -Encoding UTF8
}

if ((Test-Path ".\.venv\Scripts\python.exe") -and (Test-Path ".\local_ai_server.py")) {
  try {
    .\.venv\Scripts\python.exe -m py_compile ".\local_ai_server.py" *> (Join-Path $OutRoot 'python-check-local-ai.txt')
  } catch {
    $_ | Out-String | Set-Content (Join-Path $OutRoot 'python-check-local-ai-exception.txt') -Encoding UTF8
  }
}

try {
  git status --short *> (Join-Path $OutRoot 'git-status-short.txt')
  git diff -- index.js local_ai_server.py *> (Join-Path $OutRoot 'git-diff-index-local-ai.txt')
} catch {
  $_ | Out-String | Set-Content (Join-Path $OutRoot 'git-exception.txt') -Encoding UTF8
}

# Function/anchor map for patch planning.
$IndexMap = Join-Path $OutRoot 'index-anchor-map.txt'
$Patterns = @(
  'import .* from',
  "from 'url'",
  'seekdeepPrepareImagePrompt',
  'seekdeepImagePromptHasAny',
  'seekdeepImagePromptAdd',
  "postLocal\('/image'",
  'postLocal\("/image"',
  'seekdeepUtilityPromptKind',
  'isNaturalStatusPrompt',
  'seekdeepSendImageWithButtonsMessage',
  'seekdeepSendImagePromptChoiceMessage',
  'seekdeepExtractImagePrompt',
  'seekdeepImageModeOptionsFromPrompt',
  'messageCreate',
  'client\.on\('
)

foreach ($Pattern in $Patterns) {
  "===== $Pattern =====" | Add-Content $IndexMap -Encoding UTF8
  Select-String -Path ".\index.js" -Pattern $Pattern -CaseSensitive:$false -Context 3,8 |
    ForEach-Object { $_.ToString() } |
    Add-Content $IndexMap -Encoding UTF8
  "" | Add-Content $IndexMap -Encoding UTF8
}

if (Test-Path ".\local_ai_server.py") {
  $PyMap = Join-Path $OutRoot 'local-ai-anchor-map.txt'
  $PyPatterns = @(
    'class .*Request',
    'ImageRequest',
    'BaseModel',
    'seed',
    'negative_prompt',
    '@app\.post\("/image"',
    "@app\.post\('/image'",
    'def .*image',
    'async def .*image',
    'args = \{',
    'pipe\('
  )

  foreach ($Pattern in $PyPatterns) {
    "===== $Pattern =====" | Add-Content $PyMap -Encoding UTF8
    Select-String -Path ".\local_ai_server.py" -Pattern $Pattern -CaseSensitive:$false -Context 3,8 |
      ForEach-Object { $_.ToString() } |
      Add-Content $PyMap -Encoding UTF8
    "" | Add-Content $PyMap -Encoding UTF8
  }
}

# Include the recent patch scripts that are relevant, but not generated caches/models.
$PatchOut = Join-Path $OutRoot 'patches'
New-Item -ItemType Directory -Path $PatchOut -Force | Out-Null
if (Test-Path ".\patches") {
  Get-ChildItem ".\patches" -File |
    Where-Object { $_.Name -match 'image_route_refine|archive|help|pretty|intro|count|coin' } |
    Sort-Object LastWriteTime -Descending |
    Select-Object -First 30 |
    ForEach-Object {
      Copy-Item $_.FullName (Join-Path $PatchOut $_.Name) -Force
    }
}

if (Test-Path $ZipPath) { Remove-Item $ZipPath -Force }
Compress-Archive -Path (Join-Path $OutRoot '*') -DestinationPath $ZipPath -Force

Write-Host ""
Write-Host "Created source context zip:"
Write-Host $ZipPath
Write-Host ""
Write-Host "Upload that zip here. It excludes .env, node_modules, .venv, models, caches, and generated images."
