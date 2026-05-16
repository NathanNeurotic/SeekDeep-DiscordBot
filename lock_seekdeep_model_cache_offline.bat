@echo off
REM SeekDeep: lock Hugging Face model loading to local cache.
REM Runs the PowerShell script with ExecutionPolicy Bypass so it works from cmd,
REM double-click, or restricted shells.
pushd "%~dp0"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File ".\lock_seekdeep_model_cache_offline.ps1"
set EC=%ERRORLEVEL%
popd
if not "%EC%"=="0" (
  echo.
  echo Lock script exited with code %EC%.
  echo See message above for details.
)
echo.
pause
exit /b %EC%
