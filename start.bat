@echo off
title NovelAI Illustrator Launcher
cls
echo ==========================================================
echo       NovelAI Illustrator Startup Script
echo ==========================================================
echo.
echo Starting backend and frontend in one window...
echo All logs will stay in this console.
echo Backend:  http://localhost:5001
echo Frontend: http://localhost:5173
echo.

call :EnsureDependencies "%~dp0server" "Server"
if errorlevel 1 goto :fail

call :EnsureDependencies "%~dp0client" "Client"
if errorlevel 1 goto :fail

rem 1. Start Server on port 5001 from the root directory
rem This ensures process.cwd() points to the workspace root D:\antigravity\nai
rem where projects/ and illustrator_config.json reside.
echo [1/2] Starting backend server (Node.js) on port 5001...
start /b "" cmd /c "cd /d %~dp0 && set PORT=5001 && node server/index.js"

rem Give the backend a moment to print its startup banner
timeout /t 2 /nobreak > nul

rem 2. Start Client in the same foreground window
echo [2/2] Starting frontend client (React/Vite)...
cd /d %~dp0client && npm run dev -- --host 127.0.0.1
goto :eof

:EnsureDependencies
set "TARGET_DIR=%~1"
set "TARGET_NAME=%~2"
if not exist "%TARGET_DIR%\node_modules" (
  echo [%TARGET_NAME%] dependencies missing, installing...
  pushd "%TARGET_DIR%" || exit /b 1
  call npm install
  if errorlevel 1 (
    echo [%TARGET_NAME%] dependency installation failed.
    popd
    exit /b 1
  )
  popd
)
exit /b 0

:fail
echo.
echo Startup failed. Fix the error above, then run start.bat again.
pause
