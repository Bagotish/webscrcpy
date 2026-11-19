# WebScrcpy

Mirror and control your Android phone from a web browser — no app install, works over USB or Wi-Fi.

## Features

- 📱 Screen mirroring via WebUSB or Wi-Fi (ADB over TCP)
- 🖱️ Full control: touch, keyboard, virtual remote for TV/Android boxes
- 🌐 Runs fully in the browser (Chrome/Edge recommended — needs WebUSB + WebCodecs)
- 📦 PWA — installable on desktop and mobile

## Quick Start

1. **One-time setup — Wi-Fi Helper** (required for wireless):

   **Mac:**
   ```bash
   curl -fsSL https://webscrcpy.vercel.app/install-mac.sh | bash
   ```

   **Windows (PowerShell):**
   ```powershell
   powershell -ExecutionPolicy Bypass -c "irm https://webscrcpy.vercel.app/install-windows.ps1 | iex"
   ```

2. **Enable USB debugging on your phone**: Settings → About phone → tap Build number 7× → Developer options → USB debugging ON

3. **USB**: plug in, open the site, tap your phone.

4. **Wi-Fi (plug & play)**: plug the phone in via USB once, double-click `connect-wifi.command` (Mac) — it switches the phone to wireless mode and tells you when to unplug. On Windows, use `start-windows.bat`.

## After a phone reboot / Wi-Fi drop

ADB wireless mode resets. Just run `connect-wifi.command` again with the cable in.

## Troubleshooting

| Problem | Fix |
|---|---|
| "Device is busy / in use" | Run `adb kill-server` in Terminal, retry. The helper script does this automatically. |
| Phone shows "unauthorized" | Unlock phone, tap **Allow** on the USB debugging prompt (tick "Always allow"). |
| Phone not found on Wi-Fi | Phone and computer must be on the same network; router may have assigned a new IP — run `connect-wifi.command` again. |
| "Wi-Fi bridge is unreachable" | The Wi-Fi Helper isn't running. Re-run the install command or `node wifi-bridge.mjs`. |
| Using HTTPS/Vercel and bridge fails | Open `https://127.0.0.1:8766` once in a new tab → Advanced → Proceed (accepts local cert). |
| macOS blocks the script | Right-click → Open, or `chmod +x connect-wifi.command`. |

## Manual Wi-Fi setup (no script)

```bash
adb tcpip 5555              # phone plugged in via USB
adb connect <phone-ip>:5555 # find IP: Settings → Wi-Fi → details
adb kill-server             # release USB so the browser can use it
```

## Development

Static site — serve locally with any HTTP server, e.g. `npx serve .`.

Files:
- `index.html` — main app
- `remote.html` — TV remote UI
- `wifi-bridge.mjs` — local WebSocket→TCP bridge for wireless
- `tango-bundle.js` — WebADB library (bundled)
- `scrcpy-server-v3.3.3` — scrcpy server binary pushed to the phone
