$ErrorActionPreference = "Stop"
Set-Location "$env:USERPROFILE\SeekDeep-DiscordBot"

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

Set-DotEnvValue "HF_LOCAL_FILES_ONLY" "false"
Set-DotEnvValue "HF_HUB_OFFLINE" "0"
Set-DotEnvValue "TRANSFORMERS_OFFLINE" "0"
Set-DotEnvValue "HF_DATASETS_OFFLINE" "0"

Write-Host "SeekDeep model loading may now complete/check Hugging Face cache online if needed." -ForegroundColor Green
