@echo off
title SeekDeep Discord Bot
cd /d "%~dp0"

echo [SeekDeep] Starting Discord Bot (Node.js)...

if not exist .env (
    echo [ERROR] Configuration file .env not found.
    echo Please copy .env.example to .env and configure your bot credentials first.
    pause
    exit /b 1
)

if not exist node_modules (
    echo [SeekDeep] node_modules not found. Running npm install...
    call npm install
    if errorlevel 1 (
        echo [ERROR] npm install failed.
        pause
        exit /b 1
    )
)

echo [SeekDeep] Running doctor setup diagnostics...
call npm run doctor
if errorlevel 1 (
    echo.
    echo [WARNING] Doctor check failed or raised configuration warnings.
    echo Please verify your credentials and endpoint URLs in .env.
    echo.
    choice /m "[SeekDeep] Would you like to try starting the bot anyway?"
    if errorlevel 2 (
        echo [SeekDeep] Bot startup aborted by user.
        pause
        exit /b 0
    )
)

echo [SeekDeep] Launching bot...
node index.js
if errorlevel 1 (
    echo [ERROR] Bot stopped unexpectedly or failed to start.
    pause
    exit /b 1
)

pause
