#!/bin/bash
# WebScrcpy — One-click Wi-Fi (plug & play)
# Plug phone in via USB, double-click this file, unplug when told.
cd "$(dirname "$0")"

echo "=================================================="
echo "     WebScrcpy — Connect Phone via Wi-Fi"
echo "=================================================="
echo ""

ADB_BIN=""
for p in "$(which adb 2>/dev/null)" "/opt/homebrew/bin/adb" "/usr/local/bin/adb" "$HOME/Library/Android/sdk/platform-tools/adb"; do
    if [ -n "$p" ] && [ -x "$p" ]; then ADB_BIN="$p"; break; fi
done
if [ -z "$ADB_BIN" ]; then
    echo "❌ adb not found. Install it first:  brew install android-platform-tools"
    read -p "Press [Enter] to exit..."
    exit 1
fi
echo "✅ adb: $ADB_BIN"

echo ""
echo "📱 Plug your phone in via USB now (unlock it, tap 'Allow' if asked)..."
read -p "   Press [Enter] once it's plugged in..."

# Wait for a USB device to appear (up to ~15s)
SERIAL=""
for i in $(seq 1 15); do
    SERIAL=$("$ADB_BIN" devices | awk '$2=="device" && $1 !~ /:/ {print $1; exit}')
    [ -n "$SERIAL" ] && break
    echo "   Waiting for phone... ($i/15)"
    sleep 1
done

if [ -z "$SERIAL" ]; then
    echo ""
    echo "❌ No USB phone detected. Check:"
    echo "   • Cable is a data cable (not charge-only)"
    echo "   • Phone is unlocked and USB debugging is allowed"
    echo "   • 'adb kill-server' then re-plug"
    "$ADB_BIN" kill-server 2>/dev/null
    read -p "Press [Enter] to exit..."
    exit 1
fi

echo "✅ Phone found: $SERIAL"

# Get the phone's Wi-Fi IP
IP=$("$ADB_BIN" -s "$SERIAL" shell ip -f inet addr show wlan0 2>/dev/null | grep -oE '[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+' | head -1)
if [ -z "$IP" ]; then
    echo ""
    echo "❌ Could not read the phone's Wi-Fi IP."
    echo "   Make sure the phone is connected to the same Wi-Fi as this Mac."
    read -p "Press [Enter] to exit..."
    exit 1
fi
echo "✅ Phone Wi-Fi IP: $IP"

# Switch phone to TCP mode and connect
echo "🔄 Switching phone to Wi-Fi mode..."
"$ADB_BIN" -s "$SERIAL" tcpip 5555 >/dev/null 2>&1
sleep 3

echo "🔗 Connecting over Wi-Fi ($IP:5555)..."
if ! "$ADB_BIN" connect "$IP:5555" 2>&1 | grep -qi 'connected'; then
    # Retry once (phone sometimes needs a moment)
    sleep 3
    "$ADB_BIN" connect "$IP:5555" >/dev/null 2>&1
fi

sleep 2
if "$ADB_BIN" devices | grep -q "^$IP:5555.*device$"; then
    echo ""
    echo "=================================================="
    echo "🎉 Wi-Fi connected: $IP:5555"
    echo "✅ You can UNPLUG the USB cable now."
    echo ""
    echo "   Open WebScrcpy and tap your phone to start."
    echo "=================================================="
else
    echo ""
    echo "⚠️  Wi-Fi connect didn't complete. Watch the phone screen"
    echo "   for an 'Allow USB debugging?' prompt, then run this again."
    "$ADB_BIN" devices
fi
read -p "Press [Enter] to close..."
