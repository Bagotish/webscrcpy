#!/bin/bash
# WebScrcpy — connect your phone over Wi-Fi, one command, no downloads.
#
#   curl -fsSL https://webscrcpy.vercel.app/connect-wifi.sh | bash
#
# Works with a USB cable (classic handoff) or with no cable at all when
# Android's Wireless Debugging is already on (found over mDNS).
set -u

# When piped into bash, stdin is the script itself, so prompts must read the
# terminal directly or they would silently consume the remaining code.
TTY_IN=""
if [ -t 0 ]; then
    TTY_IN=/dev/stdin
elif [ -c /dev/tty ] && { : < /dev/tty; } 2>/dev/null; then
    TTY_IN=/dev/tty
fi
say() { printf '%s\n' "$*"; }
ask() {
    printf '%s' "$1"
    if [ -n "$TTY_IN" ]; then read -r _ <"$TTY_IN" 2>/dev/null || true; fi
    printf '\n'
}

say "=================================================="
say "     WebScrcpy — Connect Phone over Wi-Fi"
say "=================================================="
say ""

# ---------------------------------------------------------------- find adb
ADB_BIN=""
for p in "$(command -v adb 2>/dev/null)" \
         "/opt/homebrew/bin/adb" \
         "/usr/local/bin/adb" \
         "$HOME/homebrew/bin/adb" \
         "$HOME/Library/Android/sdk/platform-tools/adb" \
         "$HOME/Android/Sdk/platform-tools/adb"; do
    if [ -n "$p" ] && [ -x "$p" ]; then ADB_BIN="$p"; break; fi
done

if [ -z "$ADB_BIN" ]; then
    say "❌ adb was not found."
    say ""
    say "Install it, then run this command again:"
    say "   brew install android-platform-tools"
    exit 1
fi
say "✅ adb: $ADB_BIN"
say ""

# ------------------------------------------------- wireless debugging (no cable)
# Android 11+ advertises _adb-tls-connect._tcp over mDNS. If the phone is
# already reachable that way, we can connect without any cable.
#
# `adb mdns services` returns instantly with an empty list (it does not wait
# for discovery), so prefer the local helper, which runs a real mDNS browse.
find_mdns_phone() {
    local target=""
    if command -v curl >/dev/null 2>&1; then
        target=$(curl -fsS --max-time 8 "http://127.0.0.1:8765/devices?refresh=1" 2>/dev/null \
            | tr '}' '\n' \
            | grep -o '"host":"[^"]*","port":[0-9]*' \
            | head -1 \
            | sed -E 's/.*"host":"([^"]*)","port":([0-9]+).*/\1:\2/')
    fi
    if [ -z "$target" ]; then
        target=$("$ADB_BIN" mdns services 2>/dev/null \
            | awk '/_adb-tls-connect\._tcp|_adb\._tcp/ {print $3; exit}')
    fi
    printf '%s' "$target"
}

say "🔍 Looking for a phone already on Wi-Fi…"
MDNS_TARGET=""
for i in 1 2 3; do
    MDNS_TARGET=$(find_mdns_phone)
    [ -n "$MDNS_TARGET" ] && break
    printf '   scanning… (%s/3)\r' "$i"
    sleep 1
done
say ""
if [ -n "$MDNS_TARGET" ]; then
    say "✅ Found phone advertising at $MDNS_TARGET"
    "$ADB_BIN" connect "$MDNS_TARGET" >/dev/null 2>&1
    if "$ADB_BIN" devices | grep -q "^${MDNS_TARGET%% *}.*device"; then
        say ""
        say "=================================================="
        say "🎉 Wi-Fi connected: $MDNS_TARGET"
        say "   Open WebScrcpy and tap your phone."
        say "=================================================="
        "$ADB_BIN" kill-server >/dev/null 2>&1
        exit 0
    fi
    say "   Not authorized yet — falling back to USB."
fi

# ---------------------------------------------------------------- USB handoff
say ""
say "📱 Plug your phone in with a USB cable"
say "   (unlock it, and tap 'Allow' if the phone asks)."
ask "   Press [Enter] once it is plugged in..."

SERIAL=""
for i in $(seq 1 20); do
    SERIAL=$("$ADB_BIN" devices | awk '$2=="device" && $1 !~ /:/ {print $1; exit}')
    [ -n "$SERIAL" ] && break
    printf '   waiting for phone… (%s/20)\r' "$i"
    sleep 1
done
say ""

if [ -z "$SERIAL" ]; then
    say "❌ No USB phone detected."
    say ""
    say "   • Use a data cable, not a charge-only one"
    say "   • Unlock the phone and allow USB debugging"
    say "   • Try: adb kill-server, then re-plug"
    "$ADB_BIN" kill-server >/dev/null 2>&1
    exit 1
fi
say "✅ Phone found: $SERIAL"

IP=$("$ADB_BIN" -s "$SERIAL" shell ip -f inet addr show wlan0 2>/dev/null \
     | grep -oE '([0-9]{1,3}\.){3}[0-9]{1,3}' | head -1)
if [ -z "$IP" ]; then
    IP=$("$ADB_BIN" -s "$SERIAL" shell ip -4 route get 1.1.1.1 2>/dev/null \
         | grep -oE '([0-9]{1,3}\.){3}[0-9]{1,3}' | head -1)
fi
if [ -z "$IP" ]; then
    say ""
    say "❌ Could not read the phone's Wi-Fi address."
    say "   Make sure the phone is on the same Wi-Fi network as this computer."
    "$ADB_BIN" kill-server >/dev/null 2>&1
    exit 1
fi
say "✅ Phone Wi-Fi address: $IP"

say "🔄 Switching the phone to Wi-Fi mode…"
"$ADB_BIN" -s "$SERIAL" tcpip 5555 >/dev/null 2>&1
sleep 3

say "🔗 Connecting to $IP:5555…"
"$ADB_BIN" connect "$IP:5555" >/dev/null 2>&1
sleep 2
if ! "$ADB_BIN" devices | grep -q "^$IP:5555.*device"; then
    sleep 3
    "$ADB_BIN" connect "$IP:5555" >/dev/null 2>&1
    sleep 2
fi

if "$ADB_BIN" devices | grep -q "^$IP:5555.*device"; then
    say ""
    say "=================================================="
    say "🎉 Wi-Fi connected: $IP:5555"
    say "✅ You can UNPLUG the USB cable now."
    say ""
    say "   Open WebScrcpy and tap your phone under Nearby."
    say "=================================================="
else
    say ""
    say "⚠️  The Wi-Fi connection did not complete."
    say "   Watch the phone screen for an 'Allow USB debugging?' prompt,"
    say "   then run this command again."
    "$ADB_BIN" devices
fi

# Release the USB device so the browser (WebUSB) can claim it.
"$ADB_BIN" kill-server >/dev/null 2>&1
