@echo off
REM AI Networking Academy - local start (Windows 10/11).
REM First run downloads a portable Node.js into .tools\ and builds the site. Close the window to stop.
REM Options: start-academy.bat -Port 8750   ^|   start-academy.bat -Rebuild
setlocal
cd /d "%~dp0"
title AI Networking Academy
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\start.ps1" %*
if errorlevel 1 pause
