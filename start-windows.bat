@echo off
title WebScrcpy Wi-Fi Helper
echo ==================================================
echo         WebScrcpy Wi-Fi Helper (Windows)
echo ==================================================

cd /d "%~dp0"

where node >nul 2>nul
if %ERRORLEVEL% neq 0 (
    echo [!] Node.js was not found on your PC.
    echo Opening https://nodejs.org...
    start https://nodejs.org/en/download
    echo Please install Node.js, then run this file again.
    pause
    exit /b
)

echo [*] Starting Wi-Fi Bridge...
echo [*] Keep this window open while using Wi-Fi mode in WebScrcpy.
echo.
node wifi-bridge.mjs
pause
