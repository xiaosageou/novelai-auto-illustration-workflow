@echo off
title NovelAI Illustrator Launcher
cls
echo ==========================================================
echo       NovelAI Illustrator Startup Script
echo ==========================================================
echo.
echo Starting frontend and backend services...
echo.

rem 1. Start Server on port 5001 from the root directory
rem This ensures process.cwd() points to the workspace root D:\antigravity\nai
rem where projects/ and illustrator_config.json reside.
echo [1/2] Starting backend server (Node.js) on port 5001...
echo      Backend terminal logs: %~dp0logs\server-YYYY-MM-DD.log
start "NovelAI Illustrator - Server" cmd /k "cd /d %~dp0 && set PORT=5001 && node server/index.js"

rem Wait 2 seconds
timeout /t 2 /nobreak > nul

rem 2. Start Client
echo [2/2] Starting frontend client (React/Vite)...
start "NovelAI Illustrator - Client" cmd /k "cd /d %~dp0client && npm run dev"

echo.
echo ==========================================================
echo * Services started successfully!
echo Backend: http://localhost:5001
echo Frontend: http://localhost:5173
echo ==========================================================
echo.
pause
