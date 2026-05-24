# gui/scripts/install_gui.ps1
# One-shot installer for the SeekDeep GUI static mount.
# Run from the repo root: .\gui\scripts\install_gui.ps1

[CmdletBinding()]
param(
    [switch]$DryRun
)

$ErrorActionPreference = 'Stop'

# Resolve paths relative to this script (script lives at gui/scripts/install_gui.ps1)
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$GuiDir    = Split-Path -Parent $ScriptDir
$RepoRoot  = Split-Path -Parent $GuiDir
$ServerPy  = Join-Path $RepoRoot 'local_ai_server.py'

Write-Host ''
Write-Host '=========================================' -ForegroundColor Cyan
Write-Host '  SeekDeep GUI  installer'                  -ForegroundColor Cyan
Write-Host '=========================================' -ForegroundColor Cyan
Write-Host ''
Write-Host "  Repo root :  $RepoRoot"
Write-Host "  GUI dir   :  $GuiDir"
Write-Host "  Server.py :  $ServerPy"
Write-Host ''

# Sanity checks
if (-not (Test-Path $ServerPy)) {
    Write-Host "[FAIL] local_ai_server.py not found at $ServerPy"  -ForegroundColor Red
    Write-Host "       Run this script from inside the SeekDeep-DiscordBot repo." -ForegroundColor Red
    exit 1
}
Write-Host '[PASS] local_ai_server.py present'                     -ForegroundColor Green

$indexHtml = Join-Path $GuiDir 'index.html'
if (-not (Test-Path $indexHtml)) {
    Write-Host "[FAIL] gui/index.html not found at $indexHtml"     -ForegroundColor Red
    Write-Host "       Make sure you copied the gui/ folder into the repo root." -ForegroundColor Red
    exit 1
}
Write-Host '[PASS] gui/index.html present'                         -ForegroundColor Green

# Check if mount is already present
$serverContent = Get-Content -Raw -Path $ServerPy
if ($serverContent -match 'SeekDeep GUI .{0,5}static mount' -or
    $serverContent -match 'app\.mount\("/gui"') {
    Write-Host '[INFO] Static mount block already present in local_ai_server.py' -ForegroundColor Yellow
    Write-Host '       Skipping patch.' -ForegroundColor Yellow
} else {
    Write-Host '[STEP] Patching local_ai_server.py with /gui static mount...' -ForegroundColor Cyan

    # The mount block to inject
    $mountBlock = @"

# ===== SeekDeep GUI .. static mount =====
from fastapi.staticfiles import StaticFiles as _SeekDeepStaticFiles
import os as _seekdeep_os
_GUI_DIR = _seekdeep_os.path.join(_seekdeep_os.path.dirname(_seekdeep_os.path.abspath(__file__)), 'gui')
if _seekdeep_os.path.isdir(_GUI_DIR):
    app.mount('/gui', _SeekDeepStaticFiles(directory=_GUI_DIR, html=True), name='gui')
    print(f'[SeekDeep] GUI mounted at /gui  ->  {_GUI_DIR}')

"@

    if ($DryRun) {
        Write-Host '       (--DryRun) Would append this block to local_ai_server.py:' -ForegroundColor Yellow
        Write-Host $mountBlock -ForegroundColor DarkGray
    } else {
        # Backup first
        $backup = "$ServerPy.bak"
        Copy-Item $ServerPy $backup -Force
        Write-Host "       Backup written: $backup" -ForegroundColor DarkGray

        # Append the mount block to the end of the file
        Add-Content -Path $ServerPy -Value $mountBlock -Encoding UTF8
        Write-Host '[PASS] Mount block appended to local_ai_server.py' -ForegroundColor Green
    }
}

Write-Host ''
Write-Host '=========================================' -ForegroundColor Cyan
Write-Host '  Next steps'                              -ForegroundColor Cyan
Write-Host '=========================================' -ForegroundColor Cyan
Write-Host ''
Write-Host '  1. Restart the local AI server:'
Write-Host '       .\seekdeep_launcher.bat   (option 8)'
Write-Host ''
Write-Host '  2. Open the GUI in your browser:'
Write-Host '       http://127.0.0.1:7865/gui/'         -ForegroundColor Cyan
Write-Host ''
Write-Host '  3. Verify the Control Center pill reads LIVE (not MOCK):'
Write-Host '       http://127.0.0.1:7865/gui/app.html' -ForegroundColor Cyan
Write-Host ''
Write-Host '  Removal:'
Write-Host '       - Delete the gui/ folder'
Write-Host '       - Restore from local_ai_server.py.bak  (or delete the appended block manually)'
Write-Host ''
Write-Host '[DONE]' -ForegroundColor Green
Write-Host ''
