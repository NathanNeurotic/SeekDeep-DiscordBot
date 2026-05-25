@echo off
setlocal EnableExtensions EnableDelayedExpansion

REM SeekDeep Web-Only Launcher
REM
REM Runs the local AI server + GUI without the Discord bot. Useful if you
REM want SeekDeep as a standalone local AI client (chat / image / vision /
REM memory recall through the browser at http://127.0.0.1:7865/gui/) and
REM don't have / don't want a Discord bot token.
REM
REM What this starts:
REM   - SearXNG (Docker), if available, for /chat web routing
REM   - local_ai_server.py at 127.0.0.1:7865
REM
REM What this does NOT start:
REM   - node index.js (the Discord bot)
REM
REM Once running, open http://127.0.0.1:7865/gui/chat.html in your browser.
REM Type a message to talk to the model. Slash commands:
REM   /image <prompt>    generate an image inline
REM   /vision <prompt>   describe a dropped/pasted image
REM   /remember <fact>   add a persistent fact (memory.html shows all)
REM   /recall            list facts
REM   /forget #N | text | all   remove fact(s)
REM   /route <prompt>    show routing decision (which model would handle it)
REM   /help              command list

title SeekDeep Web Launcher (no Discord)
cd /d "%~dp0"

if not exist .venv\Scripts\python.exe (
    echo [ERROR] No .venv found. Run setup_local.ps1 first to install Python deps.
    pause
    exit /b 1
)

if not exist logs mkdir logs
if not exist models mkdir models
if not exist outputs mkdir outputs
if not exist temp mkdir temp

REM Optional: start SearXNG if Docker is available + container exists.
docker --version >nul 2>&1
if %errorlevel% equ 0 (
    docker start seekdeep-searxng >nul 2>&1
    if %errorlevel% equ 0 (
        echo [ok] SearXNG container started (web search available)
    ) else (
        echo [info] SearXNG not started ^(no container; web search will be offline^)
    )
) else (
    echo [info] Docker not detected ^(web search will be offline^)
)

echo.
echo ==========================================
echo     SeekDeep — Web-Only Mode
echo ==========================================
echo.
echo Starting local AI server on http://127.0.0.1:7865 ...
echo Once it boots, open: http://127.0.0.1:7865/gui/chat.html
echo.
echo Press Ctrl+C to stop the server.
echo.

REM Run the server in the foreground so logs are visible + Ctrl+C works
.venv\Scripts\python.exe local_ai_server.py

endlocal
