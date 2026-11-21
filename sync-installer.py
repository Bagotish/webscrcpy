#!/usr/bin/env python3
"""Embed wifi-bridge.mjs and mdns.mjs into install-mac.sh.

The installer writes the helper to ~/.webscrcpy, so the embedded copies must
match the repo exactly or users run stale code. Run this after editing either
file:  python3 sync-installer.py
"""
import sys

def main():
    sh = open('install-mac.sh').read().split('\n')
    mdns = open('mdns.mjs').read().rstrip('\n').split('\n')
    bridge = open('wifi-bridge.mjs').read().rstrip('\n').split('\n')

    def find(prefix):
        return next(i for i, l in enumerate(sh) if l.startswith(prefix))

    # Replace mdns block first (it appears before the bridge block).
    s = find("cat << 'MDNS_EOF'")
    e = next(i for i, l in enumerate(sh) if l == 'MDNS_EOF')
    sh[s + 1:e] = mdns

    s = find("cat << 'BRIDGE_EOF'")
    e = next(i for i, l in enumerate(sh) if l == 'BRIDGE_EOF')
    sh[s + 1:e] = bridge

    open('install-mac.sh', 'w').write('\n'.join(sh))
    print(f'embedded mdns.mjs ({len(mdns)} lines) and wifi-bridge.mjs ({len(bridge)} lines)')

if __name__ == '__main__':
    main()
