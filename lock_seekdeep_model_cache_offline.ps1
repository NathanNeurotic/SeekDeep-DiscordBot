$ErrorActionPreference = "Stop"
# Anchor to this script's own folder so it edits the .env of the checkout it
# ships with — not a hardcoded ~/SeekDeep-DiscordBot that may not exist or may
# be a different clone (audit FIX-1). Mirrors setup_local.ps1's own anchoring.
Set-Location -LiteralPath $PSScriptRoot

function Set-DotEnvValue {
    param([string]$Key, [string]$Value)
    $path = ".\.env"
    if (!(Test-Path $path)) { Copy-Item ".\.env.default" ".\.env" -ErrorAction SilentlyContinue }
    if (!(Test-Path $path)) { New-Item -ItemType File -Path $path -Force | Out-Null }
    $lines = @(Get-Content $path -ErrorAction SilentlyContinue)
    $found = $false
    $newLines = foreach ($line in $lines) {
        if ($line -match "^\s*$([regex]::Escape($Key))=") {
            $found = $true
            "$Key=$Value"
        } else {
            $line
        }
    }
    if ($found) { Set-Content $path $newLines -Encoding UTF8 } else { Add-Content $path "$Key=$Value" }
}

Set-DotEnvValue "HF_LOCAL_FILES_ONLY" "true"
Set-DotEnvValue "HF_HUB_OFFLINE" "1"
Set-DotEnvValue "TRANSFORMERS_OFFLINE" "1"
Set-DotEnvValue "HF_DATASETS_OFFLINE" "1"

Write-Host "SeekDeep model loading is now locked to local cached files." -ForegroundColor Green
Write-Host "SearXNG web search remains enabled if Docker/SearXNG are running." -ForegroundColor Green
