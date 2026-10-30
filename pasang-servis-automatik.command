#!/bin/bash
set -e

DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" >/dev/null 2>&1 && pwd )"
NODE_BIN="$(which node || echo "/usr/local/bin/node")"

echo "=================================================="
echo "Memasang WebScrcpy Wi-Fi Bridge sebagai servis latar belakang..."
echo "Direktori: $DIR"
echo "Node binary: $NODE_BIN"
echo "=================================================="

mkdir -p "$HOME/Library/LaunchAgents"

PLIST_PATH="$HOME/Library/LaunchAgents/com.webscrcpy.wifibridge.plist"

cat << EOF > "$PLIST_PATH"
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.webscrcpy.wifibridge</string>
    <key>ProgramArguments</key>
    <array>
        <string>$NODE_BIN</string>
        <string>$DIR/wifi-bridge.mjs</string>
    </array>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>StandardOutPath</key>
    <string>/tmp/webscrcpy-bridge.log</string>
    <key>StandardErrorPath</key>
    <string>/tmp/webscrcpy-bridge.err</string>
</dict>
</plist>
EOF

launchctl unload "$PLIST_PATH" 2>/dev/null || true
launchctl load -w "$PLIST_PATH"

echo "✅ Berjaya dipasang dan sedang berjalan di latar belakang!"
echo "Mulai sekarang, bila-bila buka webscrcpy di pelayar, Wi-Fi bridge sentiasa sedia aktif."
echo "Anda boleh tutup tetingkap Terminal ini."
