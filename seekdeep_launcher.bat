@echo off
setlocal EnableExtensions EnableDelayedExpansion

title SeekDeep Local Launcher
cd /d "%~dp0"

set "SEARXNG_CONTAINER=seekdeep-searxng"
set "SEARXNG_IMAGE=searxng/searxng:latest"
set "SEARXNG_PORT=8080"
set "LOCAL_AI_PORT=7865"
set "BOT_PID_FILE=logs\bot.pid"
set "AI_PID_FILE=logs\local-ai.pid"

if not exist logs mkdir logs
if not exist searxng mkdir searxng
if not exist models mkdir models
if not exist outputs mkdir outputs
if not exist temp mkdir temp

call :loadEnv

:menu
cls
echo ==========================================
echo          SeekDeep Local Launcher
echo ==========================================
echo.
echo Chat provider : %CHAT_PROVIDER%
echo Image provider: %IMAGE_PROVIDER%
echo Vision provider: %VISION_PROVIDER%
echo Web provider  : %WEB_SEARCH_PROVIDER%
echo Local AI URL  : %LOCAL_AI_BASE_URL%
echo SearXNG URL   : %SEARXNG_BASE_URL%
echo Chat model    : %LOCAL_CHAT_MODEL_ID%
echo Vision model  : %LOCAL_VISION_MODEL_ID%
echo Image model   : %LOCAL_IMAGE_MODEL_ID%
echo Cache path    : %LOCAL_MODEL_CACHE_DIR%
echo.
echo 1. Install/update dependencies
echo 2. Start persistent SearXNG web search
echo 3. Warm/download local model cache
echo 4. Start local AI server
echo 5. Start Discord bot only
echo 6. Check status
echo 7. Stop local stack
echo 8. Clean start full local stack: Docker + SearXNG + AI server + bot
echo 9. Unload local AI models from VRAM
echo 10. Exit
echo.
set "opt="
set /p "opt=Choose an option: "

if "%opt%"=="1" goto install_deps
if "%opt%"=="2" goto start_searxng
if "%opt%"=="3" goto warm_cache
if "%opt%"=="4" goto start_ai
if "%opt%"=="5" goto start_bot
if "%opt%"=="6" goto status
if "%opt%"=="7" goto stop_stack
if "%opt%"=="8" goto start_full
if "%opt%"=="9" goto unload_models
if "%opt%"=="10" goto end

echo Invalid option.
pause
goto menu

:install_deps
cls
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0setup_local.ps1"
pause
goto menu

:start_searxng
cls
call :ensureDocker
if errorlevel 1 goto back_to_menu
call :startSearxngQuiet
pause
goto menu

:warm_cache
cls
call :ensureVenv
if errorlevel 1 goto back_to_menu
call :loadEnv
call :buildWarmupArgs
if defined WARMUP_FEATURES (
    echo Enabled optional feature model warmup: %WARMUP_FEATURES%
)
powershell -NoExit -ExecutionPolicy Bypass -Command "& { Set-Location -LiteralPath '%CD%'; .\.venv\Scripts\Activate.ps1; python warmup_local_cache.py %WARMUP_ARGS% }"
goto menu

:start_ai
cls
call :ensureVenv
if errorlevel 1 goto back_to_menu
call :loadEnv
call :startAiQuiet
pause
goto menu

:start_bot
cls
call :ensureNodeModules
if errorlevel 1 goto back_to_menu
call :loadEnv
call :startBotQuiet
pause
goto menu

:start_full
cls
echo ==========================================
echo CLEAN START FULL LOCAL STACK
echo ==========================================
echo.
call :ensureNodeModules
if errorlevel 1 goto back_to_menu
call :ensureVenv
if errorlevel 1 goto back_to_menu
call :loadEnv

echo Step 1/5: Cleaning stale SeekDeep processes and containers...
call :cleanStaleStack

echo.
echo Step 2/5: Ensuring Docker Desktop is running...
call :ensureDocker
if errorlevel 1 goto back_to_menu

echo Removing stale SeekDeep Docker containers now that Docker is ready...
docker rm -f seekdeep-nim-chat >nul 2>nul
docker rm -f seekdeep-nim-visual >nul 2>nul

echo.
echo Step 3/5: Starting local SearXNG web search...
call :startSearxngQuiet
if errorlevel 1 goto back_to_menu

echo.
echo Step 4/5: Starting local AI server...
call :startAiQuiet
if errorlevel 1 goto back_to_menu

echo.
echo Step 5/5: Starting Discord bot...
call :startBotQuiet
if errorlevel 1 goto back_to_menu

echo.
echo Full local stack launch sequence complete.
echo Discord commands: /ask, /refine, /image, /vision, /status
echo.
pause
goto menu

:status
cls
call :loadEnv
echo ==== Local AI server ====
curl --silent "%LOCAL_AI_BASE_URL%/health"
echo.
echo.
echo ==== SearXNG ====
curl --silent "http://127.0.0.1:%SEARXNG_PORT%/search?q=seekdeep^&format=json" | powershell -NoProfile -Command "$input | Select-Object -First 1"
echo.
echo.
echo ==== Docker containers ====
docker ps -a --format "table {{.Names}}	{{.Image}}	{{.Status}}	{{.Ports}}" 2>nul
echo.
echo ==== PID files ====
if exist "%AI_PID_FILE%" (echo Local AI PID: & type "%AI_PID_FILE%") else echo Local AI PID: none
if exist "%BOT_PID_FILE%" (echo Bot PID: & type "%BOT_PID_FILE%") else echo Bot PID: none
echo.
pause
goto menu

:stop_stack
cls
call :cleanStaleStack
echo Done.
pause
goto menu

:unload_models
cls
call :loadEnv
curl --silent -X POST "%LOCAL_AI_BASE_URL%/unload"
echo.
pause
goto menu

:loadEnv
if exist .env (
    for /f "usebackq tokens=1,* delims==" %%A in (".env") do (
        if not "%%A"=="" (
            set "KEY=%%A"
            if not "!KEY:~0,1!"=="#" set "%%A=%%B"
        )
    )
)
if "%CHAT_PROVIDER%"=="" set "CHAT_PROVIDER=nvidia-local"
if "%IMAGE_PROVIDER%"=="" set "IMAGE_PROVIDER=nvidia-local"
if "%VISION_PROVIDER%"=="" set "VISION_PROVIDER=nvidia-local"
if "%WEB_SEARCH_PROVIDER%"=="" set "WEB_SEARCH_PROVIDER=searxng"
if "%LOCAL_AI_BASE_URL%"=="" set "LOCAL_AI_BASE_URL=http://127.0.0.1:%LOCAL_AI_PORT%"
if "%SEARXNG_BASE_URL%"=="" set "SEARXNG_BASE_URL=http://127.0.0.1:%SEARXNG_PORT%"
REM DEAD-3: fallbacks must match .env.default's canonical IDs. setup copies
REM .env.default first so these almost never apply, but a maintainer reading
REM the launcher should see the real stack, not stale Nemotron/Sana IDs.
if "%LOCAL_CHAT_MODEL_ID%"=="" set "LOCAL_CHAT_MODEL_ID=meta-llama/Llama-3.1-8B-Instruct"
if "%LOCAL_VISION_MODEL_ID%"=="" set "LOCAL_VISION_MODEL_ID=Qwen/Qwen2.5-VL-3B-Instruct"
if "%LOCAL_IMAGE_MODEL_ID%"=="" set "LOCAL_IMAGE_MODEL_ID=Lykon/dreamshaper-xl-1-0"
if "%LOCAL_MODEL_CACHE_DIR%"=="" set "LOCAL_MODEL_CACHE_DIR=./models/huggingface"
exit /b 0

:buildWarmupArgs
set "WARMUP_ARGS="
set "WARMUP_FEATURES="
call :appendWarmupFeature "%SEEKDEEP_FEATURE_INSTRUCT_PIX2PIX%" "instruct-pix2pix"
call :appendWarmupFeature "%SEEKDEEP_FEATURE_INPAINT%" "inpaint-clipseg"
if defined WARMUP_FEATURES set "WARMUP_ARGS=--include-enabled-features"
exit /b 0

:appendWarmupFeature
call :isTruthy "%~1"
if errorlevel 1 exit /b 0
if defined WARMUP_FEATURES (
    set "WARMUP_FEATURES=!WARMUP_FEATURES!, %~2"
) else (
    set "WARMUP_FEATURES=%~2"
)
exit /b 0

:isTruthy
set "SEEKDEEP_BOOL=%~1"
if /I "%SEEKDEEP_BOOL%"=="1" exit /b 0
if /I "%SEEKDEEP_BOOL%"=="true" exit /b 0
if /I "%SEEKDEEP_BOOL%"=="yes" exit /b 0
if /I "%SEEKDEEP_BOOL%"=="on" exit /b 0
exit /b 1

:ensureDocker
docker version >nul 2>nul
if not errorlevel 1 exit /b 0

echo Docker is not responding. Attempting to start Docker Desktop...
call :startDockerDesktop
if errorlevel 1 exit /b 1
call :waitDocker 120
if errorlevel 1 exit /b 1
exit /b 0

:startDockerDesktop
if exist "C:\Program Files\Docker\Docker\Docker Desktop.exe" (
    echo Starting Docker Desktop from standard install path...
    start "" "C:\Program Files\Docker\Docker\Docker Desktop.exe"
    exit /b 0
)
if exist "C:\Program Files\Docker\Docker\frontend\Docker Desktop.exe" (
    echo Starting Docker Desktop from frontend path...
    start "" "C:\Program Files\Docker\Docker\frontend\Docker Desktop.exe"
    exit /b 0
)
if exist "C:\Program Files\Docker\Docker\resources\Docker desktop.exe" (
    echo Starting Docker Desktop from resources path...
    start "" "C:\Program Files\Docker\Docker\resources\Docker desktop.exe"
    exit /b 0
)
echo Docker Desktop executable was not found.
exit /b 1

:waitDocker
set /a DOCKER_WAIT_MAX=%~1
set /a DOCKER_WAIT_COUNT=0
:wait_docker_loop
docker version >nul 2>nul
if not errorlevel 1 (
    echo Docker is ready.
    exit /b 0
)
set /a DOCKER_WAIT_COUNT+=1
echo Waiting for Docker Desktop ... attempt !DOCKER_WAIT_COUNT!/!DOCKER_WAIT_MAX!
if !DOCKER_WAIT_COUNT! GEQ !DOCKER_WAIT_MAX! (
    echo Timed out waiting for Docker Desktop.
    exit /b 1
)
timeout /t 3 >nul
goto wait_docker_loop

:ensureVenv
if exist ".venv\Scripts\python.exe" exit /b 0
echo Missing Python virtual environment. Run option 1 first.
pause
exit /b 1

:ensureNodeModules
if exist "node_modules" exit /b 0
echo Missing node_modules. Run option 1 first.
pause
exit /b 1

:startSearxngQuiet
call :ensureDocker
if errorlevel 1 exit /b 1
docker rm -f %SEARXNG_CONTAINER% >nul 2>nul
echo Starting SearXNG with JSON enabled...
docker run -d --name %SEARXNG_CONTAINER% --restart unless-stopped -p %SEARXNG_PORT%:8080 -e BASE_URL=http://localhost:%SEARXNG_PORT%/ -e INSTANCE_NAME=SeekDeep -v "%CD%\searxng:/etc/searxng:rw" %SEARXNG_IMAGE%
if errorlevel 1 exit /b 1
call :waitHttp "http://127.0.0.1:%SEARXNG_PORT%/" 45
exit /b %ERRORLEVEL%

:startAiQuiet
call :isHttpReady "%LOCAL_AI_BASE_URL%/health"
if not errorlevel 1 (
    echo Local AI server is already healthy at %LOCAL_AI_BASE_URL%.
    exit /b 0
)
call :cleanStaleAiOnly
if errorlevel 1 exit /b 1
if exist "%AI_PID_FILE%" del "%AI_PID_FILE%" >nul 2>nul
echo Starting local AI server (supervised, auto-restarts on crash/wedge) in a new PowerShell window...
start "SeekDeep Local AI Server" powershell -NoExit -ExecutionPolicy Bypass -File "%CD%\scripts\run-ai-server.ps1"
call :waitHttp "%LOCAL_AI_BASE_URL%/health" 90
exit /b %ERRORLEVEL%

:startBotQuiet
call :cleanStaleBotOnly
if errorlevel 1 exit /b 1
if exist "%BOT_PID_FILE%" del "%BOT_PID_FILE%" >nul 2>nul
echo Starting Discord bot in a new PowerShell window...
start "SeekDeep Discord Bot" powershell -NoExit -ExecutionPolicy Bypass -Command "& { Set-Location -LiteralPath '%CD%'; $PID | Set-Content -Path '.\logs\bot.pid'; node '%CD%\index.js' }"
exit /b 0

:isHttpReady
set "READY_URL=%~1"
curl --silent --fail "%READY_URL%" >nul 2>nul
if errorlevel 1 exit /b 1
exit /b 0

:waitHttp
set "WAIT_URL=%~1"
set /a WAIT_MAX=%~2
set /a WAIT_COUNT=0
:wait_loop
curl --silent --fail "%WAIT_URL%" >nul 2>nul
if not errorlevel 1 (
    echo Ready: %WAIT_URL%
    exit /b 0
)
set /a WAIT_COUNT+=1
echo Waiting for %WAIT_URL% ... attempt !WAIT_COUNT!/!WAIT_MAX!
if !WAIT_COUNT! GEQ !WAIT_MAX! (
    echo Timed out waiting for %WAIT_URL%
    exit /b 1
)
timeout /t 2 >nul
goto wait_loop

:stopPid
set "PID_FILE=%~1"
set "LABEL=%~2"
if not exist "%PID_FILE%" (
    echo %LABEL%: no PID file.
    exit /b 0
)
set /p TARGET_PID=<"%PID_FILE%"
if "%TARGET_PID%"=="" (
    del "%PID_FILE%" >nul 2>nul
    echo %LABEL%: empty PID file removed.
    exit /b 0
)
echo Stopping %LABEL% PID %TARGET_PID%...
powershell -NoProfile -Command "Stop-Process -Id %TARGET_PID% -Force -ErrorAction SilentlyContinue"
del "%PID_FILE%" >nul 2>nul
exit /b 0

:cleanStaleBotOnly
echo Stopping existing SeekDeep Discord bot processes...
call :stopPid "%BOT_PID_FILE%" "Discord bot"
powershell -NoProfile -ExecutionPolicy Bypass -Command "$root=(Resolve-Path '.').Path; $self=$PID; Get-CimInstance Win32_Process | Where-Object { ($_.ProcessId -ne $self) -and ((($_.Name -in @('cmd.exe','powershell.exe','pwsh.exe')) -and ($_.CommandLine -like '*index.js*') -and ($_.CommandLine -like ('*' + $root + '*'))) -or (($_.Name -eq 'node.exe') -and ($_.CommandLine -like '*index.js*'))) } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }"
if exist "%BOT_PID_FILE%" del "%BOT_PID_FILE%" >nul 2>nul
exit /b 0

:cleanStaleAiOnly
echo Stopping existing SeekDeep local AI server processes...
call :stopPid "%AI_PID_FILE%" "Local AI server"
powershell -NoProfile -ExecutionPolicy Bypass -Command "$root=(Resolve-Path '.').Path; $self=$PID; Get-CimInstance Win32_Process | Where-Object { ($_.ProcessId -ne $self) -and ((($_.Name -in @('cmd.exe','powershell.exe','pwsh.exe')) -and ($_.CommandLine -like '*local_ai_server.py*') -and ($_.CommandLine -like ('*' + $root + '*'))) -or (($_.Name -in @('python.exe','python3.exe')) -and ($_.CommandLine -like '*local_ai_server.py*'))) } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }"
if exist "%AI_PID_FILE%" del "%AI_PID_FILE%" >nul 2>nul
exit /b 0

:cleanStaleStack
echo Stopping PID-file tracked processes...
call :stopPid "%BOT_PID_FILE%" "Discord bot"
call :stopPid "%AI_PID_FILE%" "Local AI server"
echo Stopping any leftover Node/Python processes launched from this project...
powershell -NoProfile -ExecutionPolicy Bypass -Command "$root=(Resolve-Path '.').Path; Get-CimInstance Win32_Process | Where-Object { ($_.Name -in @('node.exe','python.exe','python3.exe','uvicorn.exe')) -and ($_.CommandLine -like ('*' + $root + '*')) } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }"
echo Freeing local AI port %LOCAL_AI_PORT% if still occupied...
powershell -NoProfile -ExecutionPolicy Bypass -Command "Get-NetTCPConnection -LocalPort %LOCAL_AI_PORT% -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess -Unique | ForEach-Object { Stop-Process -Id $_ -Force -ErrorAction SilentlyContinue }"
if exist "%BOT_PID_FILE%" del "%BOT_PID_FILE%" >nul 2>nul
if exist "%AI_PID_FILE%" del "%AI_PID_FILE%" >nul 2>nul
docker version >nul 2>nul
if not errorlevel 1 (
    echo Removing old SeekDeep Docker containers...
    docker rm -f %SEARXNG_CONTAINER% >nul 2>nul
    docker rm -f seekdeep-nim-chat >nul 2>nul
    docker rm -f seekdeep-nim-visual >nul 2>nul
)
exit /b 0

:back_to_menu
echo Returning to menu...
pause
goto menu

:end
exit /b 0
