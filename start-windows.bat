@echo off
title WebScrcpy Wi-Fi Helper (Windows)
cd /d "%~dp0"

where node >nul 2>nul
if %ERRORLEVEL% neq 0 (
    echo [!] Node.js was not found on your PC.
    echo Opening https://nodejs.org...
    start https://nodejs.org/en/download
    echo Please install Node.js (LTS), then run this file again.
    pause
    exit /b
)

echo ==================================================
echo         WebScrcpy Wi-Fi Helper (Windows)
echo ==================================================
echo.
echo Options:
echo   [1] Install as background service (Starts automatically on boot, closes terminal - Recommended)
echo   [2] Run in background now (Closes terminal immediately)
echo   [3] Run in this window
echo.
set /p choice="Your choice [1/2/3] (Press Enter for 1): "
if "%choice%"=="" set choice=1

if "%choice%"=="1" (
    echo [*] Setting up background startup task...
    set "STARTUP_VBS=%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\webscrcpy-bridge.vbs"
    (
        echo Set WshShell = CreateObject("WScript.Shell"^)
        echo WshShell.CurrentDirectory = "%~dp0"
        echo WshShell.Run "node wifi-bridge.mjs", 0, False
    ) > "%STARTUP_VBS%"
    
    :: Start it right now in the background!
    wscript "%STARTUP_VBS%"
    echo.
    echo ==================================================
    echo [*] Success! Wi-Fi Bridge is now running in the background.
    echo [*] It will start automatically whenever Windows boots.
    echo [*] Closing this window in 3 seconds...
    echo ==================================================
    timeout /t 3 >nul
    exit /b
)

if "%choice%"=="2" (
    echo [*] Starting Wi-Fi Bridge in the background...
    set "TEMP_VBS=%TEMP%\webscrcpy-temp.vbs"
    (
        echo Set WshShell = CreateObject("WScript.Shell"^)
        echo WshShell.CurrentDirectory = "%~dp0"
        echo WshShell.Run "node wifi-bridge.mjs", 0, False
    ) > "%TEMP_VBS%"
    wscript "%TEMP_VBS%"
    del "%TEMP_VBS%" 2>nul
    echo [*] Bridge is now running silently in the background!
    echo [*] Closing this window in 2 seconds...
    timeout /t 2 >nul
    exit /b
)

echo [*] Starting Wi-Fi Bridge in this window...
node wifi-bridge.mjs
pause
