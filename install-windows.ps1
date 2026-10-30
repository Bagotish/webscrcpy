# WebScrcpy Wi-Fi Bridge Installer for Windows (PowerShell)
$Host.UI.RawUI.WindowTitle = "WebScrcpy Wi-Fi Helper (Windows)"

Write-Host "==================================================" -ForegroundColor Cyan
Write-Host "     WebScrcpy Wi-Fi Bridge Installer (Windows)   " -ForegroundColor Cyan
Write-Host "==================================================" -ForegroundColor Cyan
Write-Host ""

# 1. Check for Node.js
$nodeCmd = Get-Command node -ErrorAction SilentlyContinue
if (-not $nodeCmd) {
    Write-Host "[!] Node.js was not found on your PC." -ForegroundColor Yellow
    Write-Host "Node.js is required to run the local Wi-Fi bridge."
    Write-Host "Opening https://nodejs.org in your browser..." -ForegroundColor Green
    Start-Process "https://nodejs.org/en/download"
    Write-Host ""
    Write-Host "Please download and install Node.js (LTS), then run this command again." -ForegroundColor Yellow
    exit 1
}

Write-Host "[*] Node.js detected: $($nodeCmd.Source)" -ForegroundColor Green

# 2. Setup install directory
$installDir = "$env:USERPROFILE\.webscrcpy"
if (-not (Test-Path -Path $installDir)) {
    New-Item -ItemType Directory -Force -Path $installDir | Out-Null
}

# 3. Download latest wifi-bridge.mjs
Write-Host "[*] Downloading latest wifi-bridge.mjs..." -ForegroundColor Cyan
$bridgeFile = "$installDir\wifi-bridge.mjs"
try {
    Invoke-WebRequest -Uri "https://webscrcpy.vercel.app/wifi-bridge.mjs" -OutFile $bridgeFile -UseBasicParsing
} catch {
    Invoke-WebRequest -Uri "https://raw.githubusercontent.com/Bagotish/webscrcpy/main/wifi-bridge.mjs" -OutFile $bridgeFile -UseBasicParsing
}

# 4. Create Windows background startup VBScript
$startupFolder = "$env:APPDATA\Microsoft\Windows\Start Menu\Programs\Startup"
$startupVbs = "$startupFolder\webscrcpy-bridge.vbs"

$vbsContent = @"
Set WshShell = CreateObject("WScript.Shell")
WshShell.CurrentDirectory = "$installDir"
WshShell.Run "node wifi-bridge.mjs", 0, False
"@

Set-Content -Path $startupVbs -Value $vbsContent -Encoding ASCII

# 5. Start the background service immediately
Write-Host "[*] Starting Wi-Fi Bridge in the background..." -ForegroundColor Cyan
Start-Process -FilePath "wscript.exe" -ArgumentList "`"$startupVbs`""

Write-Host ""
Write-Host "==================================================" -ForegroundColor Green
Write-Host "🎉 Success! Wi-Fi Bridge is now running silently!" -ForegroundColor Green
Write-Host "It will automatically start every time Windows boots." -ForegroundColor Green
Write-Host "You can now return to WebScrcpy and connect wirelessly." -ForegroundColor Green
Write-Host "==================================================" -ForegroundColor Green
