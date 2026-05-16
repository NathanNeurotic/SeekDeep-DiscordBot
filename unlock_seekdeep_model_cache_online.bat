@echo off
REM SeekDeep: unlock Hugging Face model loading to allow online downloads.
REM Runs the PowerShell script with ExecutionPolicy Bypass so it works from cmd,
REM double-click, or restricted shells.
pushd "%~dp0"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File ".\unlock_seekdeep_model_cache_online.ps1"
set EC=%ERRORLEVEL%
popd
if not "%EC%"=="0" (
  echo.
  echo Unlock script exited with code %EC%.
  echo See message above for details.
)
echo.
pause
exit /b %EC%
