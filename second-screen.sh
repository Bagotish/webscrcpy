#!/bin/bash
# WebScrcpy — Second Screen over USB
#
#   ./second-screen.sh
#
# Connects a tablet or phone as a second screen for this Mac over a USB cable.
# Uses `adb reverse` so the tablet reaches the bridge at 127.0.0.1 — no Wi-Fi,
# no IP address, and nothing to type.
set -u
cd "$(dirname "$0")"

BRIDGE_PORT="${WIFI_BRIDGE_PORT:-8765}"
TABLET_URL="http://127.0.0.1:${BRIDGE_PORT}/second-screen.html"

say() { printf '%s\n' "$*"; }
die() { printf '\n❌ %s\n' "$*" >&2; exit 1; }

say "=================================================="
say "   WebScrcpy — Second Screen (USB)"
say "=================================================="
say ""

# ---------------------------------------------------------------- adb
ADB_BIN=""
for p in "$(command -v adb 2>/dev/null)" \
         "/opt/homebrew/bin/adb" \
         "/usr/local/bin/adb" \
         "$HOME/homebrew/bin/adb" \
         "$HOME/Library/Android/sdk/platform-tools/adb"; do
    if [ -n "$p" ] && [ -x "$p" ]; then ADB_BIN="$p"; break; fi
done
[ -n "$ADB_BIN" ] || die "adb not found. Install it with: brew install android-platform-tools"
say "✅ adb: $ADB_BIN"

# ---------------------------------------------------------------- device
say ""
say "🔌 Plug the tablet in with a USB cable"
say "   Unlock it and tap 'Allow' when it asks about USB debugging."
say ""

SERIAL=""
for i in $(seq 1 30); do
    SERIAL=$("$ADB_BIN" devices 2>/dev/null | awk '$2=="device" && $1 !~ /:/ {print $1; exit}')
    [ -n "$SERIAL" ] && break
    printf '   waiting for device… (%s/30)\r' "$i"
    sleep 1
done
say ""
[ -n "$SERIAL" ] || die "No USB device detected. Check the cable, unlock the tablet, and allow USB debugging."
say "✅ Tablet: $SERIAL"

MODEL=$("$ADB_BIN" -s "$SERIAL" shell getprop ro.product.model 2>/dev/null | tr -d '\r')
say "   Model: ${MODEL:-unknown}"

# ---------------------------------------------------------------- bridge
if ! curl -fsS --max-time 3 "http://127.0.0.1:${BRIDGE_PORT}/devices" >/dev/null 2>&1; then
    say ""
    say "⚠️  The Wi-Fi helper is not running on port ${BRIDGE_PORT}."
    say "   Starting it for this session…"
    if command -v node >/dev/null 2>&1; then
        (node wifi-bridge.mjs >/tmp/webscrcpy-bridge.log 2>&1 &)
        for i in $(seq 1 20); do
            curl -fsS --max-time 2 "http://127.0.0.1:${BRIDGE_PORT}/devices" >/dev/null 2>&1 && break
            sleep 0.5
        done
    fi
    if ! curl -fsS --max-time 3 "http://127.0.0.1:${BRIDGE_PORT}/devices" >/dev/null 2>&1; then
        die "Could not start the helper. Run: node wifi-bridge.mjs"
    fi
fi
say "✅ Helper running on port ${BRIDGE_PORT}"

# ---------------------------------------------------------------- reverse
# The tablet's 127.0.0.1:8765 is forwarded to this Mac's bridge. This is what
# removes the need for Wi-Fi or an IP address.
say ""
say "🔗 Wiring the tablet to this Mac…"
"$ADB_BIN" -s "$SERIAL" reverse --remove-all >/dev/null 2>&1
if ! "$ADB_BIN" -s "$SERIAL" reverse "tcp:${BRIDGE_PORT}" "tcp:${BRIDGE_PORT}" >/dev/null 2>&1; then
    die "adb reverse failed. Some devices disable it; try another cable or port."
fi
say "✅ 127.0.0.1:${BRIDGE_PORT} on the tablet → this Mac"

# ---------------------------------------------------------------- open it
say ""
say "🚀 Opening the second screen on the tablet…"
"$ADB_BIN" -s "$SERIAL" shell am start \
    -a android.intent.action.VIEW \
    -d "$TABLET_URL" >/dev/null 2>&1 || true

# Some tablets open the browser in the background; bring it forward.
"$ADB_BIN" -s "$SERIAL" shell input keyevent KEYCODE_WAKEUP >/dev/null 2>&1 || true
"$ADB_BIN" -s "$SERIAL" shell wm dismiss-keyguard >/dev/null 2>&1 || true
"$ADB_BIN" -s "$SERIAL" shell am start \
    -a android.intent.action.VIEW \
    -d "$TABLET_URL" >/dev/null 2>&1 || true

say ""
say "=================================================="
say "🎉 Second screen is ready"
say ""
say "   Tablet : $TABLET_URL"
say "   If the browser did not open, type that address"
say "   into the tablet's browser manually."
say ""
say "   Tap 'Start' on the tablet. Your Mac's screen"
say "   appears, and taps control the Mac."
say "=================================================="
say ""

# Report the macOS permissions this needs, so a denied one is obvious now
# rather than looking like "the screen is just black".
PERMS=$(curl -fsS --max-time 20 "http://127.0.0.1:${BRIDGE_PORT}/screen/permissions" 2>/dev/null || true)
if [ -n "$PERMS" ]; then
    case "$PERMS" in
        *'"screenRecording":true'*) say "✅ Screen Recording is allowed" ;;
        *)
            say "⚠️  Screen Recording is NOT allowed yet:"
            say "   System Settings → Privacy & Security → Screen Recording"
            say "   Enable it for Terminal (or your terminal app), then rerun."
            ;;
    esac
    case "$PERMS" in
        *'"accessibility":true'*) say "✅ Accessibility is allowed" ;;
        *)
            say "⚠️  Accessibility is NOT allowed yet:"
            say "   System Settings → Privacy & Security → Accessibility"
            say "   Enable it for Terminal (or your terminal app)."
            say "   Without it the screen shows, but taps do nothing."
            ;;
    esac
fi

say ""
say "Press Ctrl+C here to stop."
say ""

# Keep the reverse tunnel alive while this script runs.
trap 'say ""; say "Stopping…"; "$ADB_BIN" -s "$SERIAL" reverse --remove-all >/dev/null 2>&1; exit 0' INT TERM
while true; do
    sleep 5
    if ! "$ADB_BIN" devices 2>/dev/null | grep -q "^${SERIAL}.*device"; then
        say "⚠️  Tablet disconnected."
        exit 1
    fi
done
