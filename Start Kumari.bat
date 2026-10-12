@echo off
title Kumari
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js is not installed. Opening the download page...
  start https://nodejs.org
  pause
  exit /b 1
)
node scripts\start.mjs
echo.
echo Kumari stopped. Press any key to close.
pause >nul
