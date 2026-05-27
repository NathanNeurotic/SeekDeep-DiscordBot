@echo off
REM SeekDeep emergency recovery wrapper.
REM Double-click this file to fix token-mismatch deadlocks without rebuilding the installer.
REM See scripts\recover.py for what it actually does.

cd /d "%~dp0\.."

set PY=
if exist ".venv\Scripts\python.exe" set PY=.venv\Scripts\python.exe
if "%PY%"=="" (
  where python.exe >nul 2>&1
  if not errorlevel 1 set PY=python.exe
)
if "%PY%"=="" (
  where python3.exe >nul 2>&1
  if not errorlevel 1 set PY=python3.exe
)

if "%PY%"=="" (
  echo ERROR: No Python found. Either install Python 3.10+ or run the manual fallback:
  echo   1. Open .env in Notepad
  echo   2. Delete the value after SEEKDEEP_GUI_TOKEN= so the line reads exactly: SEEKDEEP_GUI_TOKEN=
  echo   3. Save, then restart the SeekDeep sidecar from the tray menu
  echo   4. Hard-refresh the GUI page (Ctrl+F5)
  pause
  exit /b 2
)

"%PY%" "scripts\recover.py"
echo.
pause
