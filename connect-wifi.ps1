# WebScrcpy — connect your phone over Wi-Fi, one command, no downloads.
#
#   powershell -ExecutionPolicy Bypass -c "irm https://webscrcpy.vercel.app/connect-wifi.ps1 | iex"
#
# Works with a USB cable (classic handoff) or with no cable at all when
# Android's Wireless Debugging is already on (found over mDNS via adb).

$ErrorActionPreference = 'Continue'

function Say($text) { Write-Host $text }
function Say-OK($text) { Write-Host $text -ForegroundColor Green }
function Say-Warn($text) { Write-Host $text -ForegroundColor Yellow }
function Say-Err($text) { Write-Host $text -ForegroundColor Red }

Say "=================================================="
Say "     WebScrcpy - Connect Phone over Wi-Fi"
Say "=================================================="
Say ""

# ---------------------------------------------------------------- find adb
$adb = $null
$candidates = @(
    (Get-Command adb -ErrorAction SilentlyContinue).Source,
    "$env:LOCALAPPDATA\Android\Sdk\platform-tools\adb.exe",
    "$env:USERPROFILE\AppData\Local\Android\Sdk\platform-tools\adb.exe",
    "$env:ProgramFiles\Android\platform-tools\adb.exe",
    "${env:ProgramFiles(x86)}\Android\platform-tools\adb.exe",
    "C:\Android\platform-tools\adb.exe"
) | Where-Object { $_ -and (Test-Path $_) }

foreach ($candidate in $candidates) {
    try {
        & $candidate version *> $null
        if ($LASTEXITCODE -eq 0) { $adb = $candidate; break }
    } catch {}
}

if (-not $adb) {
    Say-Err "adb was not found."
    Say ""
    Say "Install it, then run this command again. Easiest options:"
    Say "   winget install Google.PlatformTools"
    Say "   or download: https://developer.android.com/tools/releases/platform-tools"
    exit 1
}
Say-OK "adb: $adb"
Say ""

# ------------------------------------------------- wireless debugging (no cable)
Say "Looking for a phone already on Wi-Fi..."
$mdnsTarget = $null
for ($i = 1; $i -le 6; $i++) {
    try {
        $lines = & $adb mdns services 2>$null
        foreach ($line in $lines) {
            # Columns: <instance>  _adb-tls-connect._tcp  <host:port>
            if ($line -match '(_adb-tls-connect\._tcp|_adb\._tcp)\s+(\S+)') {
                $mdnsTarget = $Matches[2]
                break
            }
        }
    } catch {}
    if ($mdnsTarget) { break }
    Write-Host "   scanning... ($i/6)" -NoNewline
    Write-Host "`r" -NoNewline
    Start-Sleep -Seconds 2
}
Say ""

if ($mdnsTarget) {
    Say-OK "Found phone advertising at $mdnsTarget"
    & $adb connect $mdnsTarget *> $null
    Start-Sleep -Seconds 2
    $devices = & $adb devices 2>$null
    $serial = ($mdnsTarget -split ':')[0]
    if ($devices -match [regex]::Escape($mdnsTarget) -and $devices -match 'device$') {
        Say ""
        Say "=================================================="
        Say-OK "Wi-Fi connected: $mdnsTarget"
        Say "   Open WebScrcpy and tap your phone."
        Say "=================================================="
        & $adb kill-server *> $null
        exit 0
    }
    Say-Warn "   Not authorized yet - falling back to USB."
}

# ---------------------------------------------------------------- USB handoff
Say ""
Say "Plug your phone in with a USB cable"
Say "   (unlock it, and tap 'Allow' if the phone asks)."
Read-Host "   Press [Enter] once it is plugged in" | Out-Null

$serial = $null
for ($i = 1; $i -le 20; $i++) {
    $line = (& $adb devices 2>$null | Select-String -Pattern '^(\S+)\s+device$' | Select-Object -First 1)
    if ($line) {
        $serial = $line.Matches[0].Groups[1].Value
        if ($serial -notmatch ':') { break }
        $serial = $null
    }
    Write-Host "   waiting for phone... ($i/20)" -NoNewline
    Write-Host "`r" -NoNewline
    Start-Sleep -Seconds 1
}
Say ""

if (-not $serial) {
    Say-Err "No USB phone detected."
    Say ""
    Say "   - Use a data cable, not a charge-only one"
    Say "   - Unlock the phone and allow USB debugging"
    Say "   - Try: adb kill-server, then re-plug"
    & $adb kill-server *> $null
    exit 1
}
Say-OK "Phone found: $serial"

# Read the phone's Wi-Fi address (wlan0 first, then the default route).
$ip = $null
$addrOut = & $adb -s $serial shell ip -f inet addr show wlan0 2>$null
if ($addrOut -match '(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})') { $ip = $Matches[1] }
if (-not $ip) {
    $routeOut = & $adb -s $serial shell ip -4 route get 1.1.1.1 2>$null
    if ($routeOut -match '(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})') { $ip = $Matches[1] }
}
if (-not $ip) {
    Say ""
    Say-Err "Could not read the phone's Wi-Fi address."
    Say "   Make sure the phone is on the same Wi-Fi network as this PC."
    & $adb kill-server *> $null
    exit 1
}
Say-OK "Phone Wi-Fi address: $ip"

Say "Switching the phone to Wi-Fi mode..."
& $adb -s $serial tcpip 5555 *> $null
Start-Sleep -Seconds 3

Say "Connecting to ${ip}:5555..."
& $adb connect "${ip}:5555" *> $null
Start-Sleep -Seconds 2
$check = & $adb devices 2>$null
if (-not ($check -match [regex]::Escape("${ip}:5555") -and $check -match 'device$')) {
    Start-Sleep -Seconds 3
    & $adb connect "${ip}:5555" *> $null
    Start-Sleep -Seconds 2
    $check = & $adb devices 2>$null
}

if ($check -match [regex]::Escape("${ip}:5555")) {
    Say ""
    Say "=================================================="
    Say-OK "Wi-Fi connected: ${ip}:5555"
    Say-OK "You can UNPLUG the USB cable now."
    Say ""
    Say "   Open WebScrcpy and tap your phone under Nearby."
    Say "=================================================="
} else {
    Say ""
    Say-Warn "The Wi-Fi connection did not complete."
    Say "   Watch the phone screen for an 'Allow USB debugging?' prompt,"
    Say "   then run this command again."
    & $adb devices
}

# Release the USB device so the browser (WebUSB) can claim it.
& $adb kill-server *> $null
