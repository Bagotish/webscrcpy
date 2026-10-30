#!/bin/bash
set -e

echo "=================================================="
echo "      WebScrcpy Wi-Fi Bridge Installer (macOS)"
echo "=================================================="

# Detect Node.js
NODE_BIN=""
for path in "/opt/homebrew/bin/node" "/usr/local/bin/node" "$(which node 2>/dev/null)"; do
    if [ -n "$path" ] && [ -x "$path" ]; then
        NODE_BIN="$path"
        break
    fi
done

if [ -z "$NODE_BIN" ]; then
    echo "⚠️  Node.js was not found on your Mac."
    echo "Node.js is required to run the local Wi-Fi bridge."
    echo "Opening https://nodejs.org in your browser..."
    open "https://nodejs.org/en/download" 2>/dev/null || true
    echo ""
    echo "Please download and install Node.js (LTS), then run this command again."
    exit 1
fi

echo "✅ Node.js detected: $NODE_BIN"

# Prepare installation directory
INSTALL_DIR="$HOME/.webscrcpy"
mkdir -p "$INSTALL_DIR"

echo "📥 Downloading latest wifi-bridge.mjs..."
curl -fsSL "https://webscrcpy.vercel.app/wifi-bridge.mjs" -o "$INSTALL_DIR/wifi-bridge.mjs" 2>/dev/null || \
curl -fsSL "https://raw.githubusercontent.com/Bagotish/webscrcpy/main/wifi-bridge.mjs" -o "$INSTALL_DIR/wifi-bridge.mjs"

# Generate local SSL certs if needed
CERT_DIR="$INSTALL_DIR/wifi-bridge-certs"
mkdir -p "$CERT_DIR"
if [ ! -f "$CERT_DIR/cert.pem" ] || [ ! -f "$CERT_DIR/key.pem" ]; then
    echo "🔒 Generating local SSL certificate for WSS..."
    openssl req -x509 -newkey rsa:2048 -keyout "$CERT_DIR/key.pem" -out "$CERT_DIR/cert.pem" -days 365 -nodes -subj "/CN=127.0.0.1" -addext "subjectAltName=IP:127.0.0.1,DNS:localhost" >/dev/null 2>&1 || true
fi

# Setup LaunchAgent background daemon
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
        <string>$INSTALL_DIR/wifi-bridge.mjs</string>
    </array>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>WorkingDirectory</key>
    <string>$INSTALL_DIR</string>
    <key>StandardOutPath</key>
    <string>/tmp/webscrcpy-bridge.log</string>
    <key>StandardErrorPath</key>
    <string>/tmp/webscrcpy-bridge.err</string>
</dict>
</plist>
EOF

# Kill any existing bridge process and reload service
launchctl unload "$PLIST_PATH" 2>/dev/null || true
kill -9 $(lsof -ti :8765 -ti :8766 2>/dev/null) 2>/dev/null || true
launchctl load -w "$PLIST_PATH"

echo ""
echo "=================================================="
echo "🎉 WebScrcpy Wi-Fi Bridge is now actively running!"
echo "It will automatically start whenever your Mac boots."
echo "You can now return to WebScrcpy and connect wirelessly."
echo "=================================================="
