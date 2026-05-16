$ErrorActionPreference = "Stop"

$Project = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $Project

Write-Host "`n[SeekDeep] Setup local dependencies" -ForegroundColor Cyan
Write-Host "[SeekDeep] Project: $Project" -ForegroundColor DarkCyan

New-Item -ItemType Directory -Path ".\logs", ".\models", ".\outputs", ".\temp", ".\searxng" -Force | Out-Null

if (!(Test-Path ".\.env") -and (Test-Path ".\.env.default")) {
    Copy-Item ".\.env.default" ".\.env"
    Write-Host "[SeekDeep] Created .env from .env.default." -ForegroundColor Yellow
} else {
    Write-Host "[SeekDeep] Existing .env preserved." -ForegroundColor Green
}

function Test-PythonCandidate {
    param(
        [string]$Exe,
        [string[]]$BaseArgs
    )

    try {
        $args = @()
        if ($BaseArgs) { $args += $BaseArgs }
        $args += @("-c", "import sys; print(sys.executable)")

        $output = & $Exe @args 2>$null
        if ($LASTEXITCODE -eq 0 -and $output) {
            return @{
                Exe = $Exe
                Args = $BaseArgs
                Path = ($output | Select-Object -First 1)
            }
        }
    } catch {
        return $null
    }

    return $null
}

function Find-Python {
    $candidates = @(
        @{ Exe = "py"; Args = @("-3.12") },
        @{ Exe = "py"; Args = @("-3.11") },
        @{ Exe = "py"; Args = @("-3.10") },
        @{ Exe = "py"; Args = @("-3") },
        @{ Exe = "python"; Args = @() },
        @{ Exe = "python3"; Args = @() }
    )

    foreach ($candidate in $candidates) {
        $found = Test-PythonCandidate -Exe $candidate.Exe -BaseArgs $candidate.Args
        if ($found) { return $found }
    }

    return $null
}

$VenvPython = ".\.venv\Scripts\python.exe"

if (!(Test-Path $VenvPython)) {
    $py = Find-Python
    if (!$py) {
        throw "No usable Python was found. Install Python 3.11 or 3.12 from python.org, enable 'Add python.exe to PATH', then rerun option 1."
    }

    Write-Host "[SeekDeep] Using Python: $($py.Path)" -ForegroundColor Green
    Write-Host "[SeekDeep] Creating Python venv..." -ForegroundColor Cyan

    $venvArgs = @()
    if ($py.Args) { $venvArgs += $py.Args }
    $venvArgs += @("-m", "venv", ".venv")

    & $py.Exe @venvArgs
    if ($LASTEXITCODE -ne 0) {
        throw "Python venv creation failed with exit code $LASTEXITCODE."
    }
}

if (!(Test-Path $VenvPython)) {
    throw "Venv creation completed but $VenvPython still does not exist. This usually means Python venv support is broken or blocked."
}

Write-Host "[SeekDeep] Venv Python verified: $VenvPython" -ForegroundColor Green

Write-Host "[SeekDeep] Upgrading pip..." -ForegroundColor Cyan
& $VenvPython -m pip install --upgrade pip setuptools wheel
if ($LASTEXITCODE -ne 0) {
    throw "pip upgrade failed with exit code $LASTEXITCODE."
}

Write-Host "[SeekDeep] Installing Python requirements..." -ForegroundColor Cyan
& $VenvPython -m pip install -r ".\requirements-local.txt"
if ($LASTEXITCODE -ne 0) {
    throw "Python dependency install failed with exit code $LASTEXITCODE."
}

Write-Host "[SeekDeep] Checking Node/npm..." -ForegroundColor Cyan
$npm = Get-Command npm -ErrorAction SilentlyContinue
if (!$npm) {
    throw "npm was not found. Install Node.js LTS from nodejs.org, then rerun option 1."
}

Write-Host "[SeekDeep] Installing Node packages..." -ForegroundColor Cyan
npm install
if ($LASTEXITCODE -ne 0) {
    throw "npm install failed with exit code $LASTEXITCODE."
}

Write-Host "`n[SeekDeep] Setup complete." -ForegroundColor Green
Write-Host "Next: run .\seekdeep_launcher.bat and choose option 8." -ForegroundColor Cyan
