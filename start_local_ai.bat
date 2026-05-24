@echo off
title SeekDeep Local AI Server
cd /d "%~dp0"

echo [SeekDeep] Starting Local AI Server (Python FastAPI)...

if not exist .venv (
    echo [ERROR] Python virtual environment (.venv) not found.
    echo Please run the setup instructions to create .venv and install requirements.
    pause
    exit /b 1
)

echo [SeekDeep] Activating virtual environment...
call .venv\Scripts\activate.bat
if errorlevel 1 (
    echo [ERROR] Failed to activate virtual environment.
    pause
    exit /b 1
)

echo [SeekDeep] Starting FastAPI server...
python local_ai_server.py
if errorlevel 1 (
    echo [ERROR] Local AI Server stopped unexpectedly or failed to start.
    pause
    exit /b 1
)

pause
