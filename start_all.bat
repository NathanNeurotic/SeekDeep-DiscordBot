@echo off
title SeekDeep Bot Launcher
cd /d "%~dp0"

echo [SeekDeep] Launching bot and local AI server in separate windows...

echo [SeekDeep] Spawning start_local_ai.bat...
start "SeekDeep Local AI Server" cmd /c start_local_ai.bat

echo [SeekDeep] Spawning start_bot.bat...
start "SeekDeep Discord Bot" cmd /c start_bot.bat

echo [SeekDeep] Spawned successfully. Check the separate console windows for logs.
