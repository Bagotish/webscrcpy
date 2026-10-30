#!/bin/bash
cd "$(dirname "$0")"

echo "=================================================="
echo "          WebScrcpy Wi-Fi Helper (Mac)"
echo "=================================================="

# Locate Node.js binary
NODE_BIN=""
for path in "/opt/homebrew/bin/node" "/usr/local/bin/node" "$(which node 2>/dev/null)"; do
    if [ -x "$path" ]; then
        NODE_BIN="$path"
        break
    fi
done

if [ -z "$NODE_BIN" ]; then
    echo "⚠️  Node.js was not found on your Mac."
    echo "Opening https://nodejs.org in your browser..."
    open "https://nodejs.org/en/download" 2>/dev/null || true
    echo ""
    read -p "Please install Node.js, then press [Enter] here to continue..."
    for path in "/opt/homebrew/bin/node" "/usr/local/bin/node" "$(which node 2>/dev/null)"; do
        if [ -x "$path" ]; then
            NODE_BIN="$path"
            break
        fi
    done
    if [ -z "$NODE_BIN" ]; then
        echo "❌ Node.js is still not installed. Please install it and run this file again."
        read -p "Press [Enter] to exit..."
        exit 1
    fi
fi

echo "✅ Node.js detected: $NODE_BIN"
echo ""
echo "Setup options:"
echo "  [1] Install as background service (Automatically starts on login - Recommended)"
echo "  [2] Run once in this terminal window"
read -p "Your choice [1/2] (Press Enter for 1): " choice
choice=${choice:-1}

if [ "$choice" = "1" ]; then
    mkdir -p "$HOME/Library/LaunchAgents"
    PLIST_PATH="$HOME/Library/LaunchAgents/com.webscrcpy.wifibridge.plist"
    SCRIPT_PATH="$(pwd)/wifi-bridge.mjs"
    
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
        <string>$SCRIPT_PATH</string>
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
    echo ""
    echo "=================================================="
    echo "🎉 Success! Wi-Fi Bridge is now running in the background."
    echo "You can close this window and return to WebScrcpy."
    echo "=================================================="
    read -p "Press [Enter] to close..."
else
    echo "Starting Wi-Fi bridge... (Do not close this window while using WebScrcpy)"
    "$NODE_BIN" wifi-bridge.mjs
fi
