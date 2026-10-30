@echo off
title WebScrcpy Wi-Fi Helper
echo ==================================================
echo         WebScrcpy Wi-Fi Helper (Windows)
echo ==================================================

where node >nul 2>nul
if %ERRORLEVEL% neq 0 (
    echo [!] Node.js tidak dijumpai di komputer anda.
    echo Membuka https://nodejs.org...
    start https://nodejs.org/en/download
    echo Sila pasang Node.js, kemudian buka semula fail ini.
    pause
    exit /b
)

echo [*] Memulakan Wi-Fi Bridge...
echo [*] Jangan tutup tetingkap ini semasa menggunakan Wi-Fi di webscrcpy.
echo.
node wifi-bridge.mjs
pause
