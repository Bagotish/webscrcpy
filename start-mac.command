#!/bin/bash
cd "$(dirname "$0")"

echo "=================================================="
echo "          WebScrcpy Wi-Fi Helper (Mac)"
echo "=================================================="

# Cari lokasi Node.js
NODE_BIN=""
for path in "/opt/homebrew/bin/node" "/usr/local/bin/node" "$(which node 2>/dev/null)"; do
    if [ -x "$path" ]; then
        NODE_BIN="$path"
        break
    fi
done

if [ -z "$NODE_BIN" ]; then
    echo "⚠️  Node.js tidak dijumpai di Mac anda."
    echo "Membuka https://nodejs.org di pelayar..."
    open "https://nodejs.org/en/download" 2>/dev/null || true
    echo ""
    read -p "Sila pasang Node.js, kemudian tekan [Enter] di sini untuk sambung..."
    for path in "/opt/homebrew/bin/node" "/usr/local/bin/node" "$(which node 2>/dev/null)"; do
        if [ -x "$path" ]; then
            NODE_BIN="$path"
            break
        fi
    done
    if [ -z "$NODE_BIN" ]; then
        echo "❌ Node.js masih belum dipasang. Sila pasang dan buka semula fail ini."
        read -p "Tekan [Enter] untuk keluar..."
        exit 1
    fi
fi

echo "✅ Node.js sedia: $NODE_BIN"
echo ""
echo "Pilihan pemasangan:"
echo "  [1] Pasang servis latar belakang (Automatik aktif setiap masa - Disyorkan)"
echo "  [2] Jalankan sekali sahaja dalam tetingkap ini"
read -p "Pilihan anda [1/2] (Tekan Enter untuk 1): " choice
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
    echo "🎉 Selesai! Wi-Fi Bridge kini aktif di latar belakang."
    echo "Anda boleh tutup tetingkap ini dan kembali ke laman webscrcpy."
    echo "=================================================="
    read -p "Tekan [Enter] untuk keluar..."
else
    echo "Memulakan Wi-Fi bridge... (Jangan tutup tetingkap ini)"
    "$NODE_BIN" wifi-bridge.mjs
fi
