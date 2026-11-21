#!/usr/bin/env python3
"""Embed wifi-bridge.mjs and mdns.mjs into the platform installers.

The installers write the helper to ~/.webscrcpy, so the embedded copies must
match the repo exactly or users run stale code. Run this after editing either
file:  python3 sync-installer.py

Idempotent: re-running replaces the existing blocks instead of duplicating them.
"""
import sys


def read(path):
    return open(path).read().rstrip('\n').split('\n')


def replace_heredoc(lines, open_line, end_marker, payload):
    """Replace the body of a heredoc/here-string, keeping the open line."""
    start = next((i for i, l in enumerate(lines) if l.strip() == open_line), None)
    if start is None:
        raise SystemExit(f'marker not found: {open_line!r}')
    end = next((i for i, l in enumerate(lines[start + 1:], start + 1)
                if l.strip() == end_marker), None)
    if end is None:
        raise SystemExit(f'terminator not found for: {open_line!r}')
    lines[start + 1:end] = payload


def sync_sh():
    lines = open('install-mac.sh').read().split('\n')
    mdns = read('mdns.mjs')
    bridge = read('wifi-bridge.mjs')
    replace_heredoc(lines, "cat << 'MDNS_EOF' > \"$INSTALL_DIR/mdns.mjs\"", 'MDNS_EOF', mdns)
    replace_heredoc(lines, "cat << 'BRIDGE_EOF' > \"$INSTALL_DIR/wifi-bridge.mjs\"", 'BRIDGE_EOF', bridge)
    open('install-mac.sh', 'w').write('\n'.join(lines))
    print(f'install-mac.sh: mdns.mjs ({len(mdns)}) + wifi-bridge.mjs ({len(bridge)})')


def sync_ps1():
    lines = open('install-windows.ps1').read().split('\n')
    mdns = read('mdns.mjs')
    bridge = read('wifi-bridge.mjs')

    # Insert the mdns here-string on first run; replace it on later runs.
    if not any(l.strip() == "$mdnsCode = @'" for l in lines):
        idx = next(i for i, l in enumerate(lines) if l.strip() == "$bridgeCode = @'")
        block = ["$mdnsCode = @'"] + mdns + [
            "'@",
            '',
            'Set-Content -Path "$installDir\\mdns.mjs" -Value $mdnsCode -Encoding UTF8',
            '',
        ]
        lines[idx:idx] = block

    replace_heredoc(lines, "$mdnsCode = @'", "'@", mdns)
    replace_heredoc(lines, "$bridgeCode = @'", "'@", bridge)

    open('install-windows.ps1', 'w').write('\n'.join(lines))
    print(f'install-windows.ps1: mdns.mjs ({len(mdns)}) + wifi-bridge.mjs ({len(bridge)})')


if __name__ == '__main__':
    sync_sh()
    sync_ps1()
