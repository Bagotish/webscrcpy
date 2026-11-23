#!/usr/bin/env python3
"""
Inject mouse and keyboard events into macOS for the WebScrcpy second-screen
mode. Called by wifi-bridge.mjs; reads one JSON command per line on stdin.

  {"type":"move","x":0.5,"y":0.5}      normalized 0..1 screen coords
  {"type":"down","button":"left"}
  {"type":"up","button":"left"}
  {"type":"click","x":..,"y":..}
  {"type":"scroll","dy":-3}
  {"type":"key","code":6}              CGKeyCode
  {"type":"text","text":"hello"}

Requires Accessibility permission for the process that owns this binary
(Terminal, or the launchd job's executable). macOS silently drops events
otherwise, so a denied permission looks like "nothing happens".
"""
import ctypes
import ctypes.util
import json
import sys

CG = ctypes.cdll.LoadLibrary(ctypes.util.find_library('ApplicationServices'))

CG.CGEventCreate.restype = ctypes.c_void_p
CG.CGEventCreate.argtypes = [ctypes.c_void_p]
CG.CGEventGetLocation.restype = ctypes.c_void_p
CG.CGEventPost.argtypes = [ctypes.c_uint32, ctypes.c_void_p]
CG.CGEventSetIntegerValueField.argtypes = [ctypes.c_void_p, ctypes.c_uint32, ctypes.c_int64]
CG.CGEventSetType.argtypes = [ctypes.c_void_p, ctypes.c_uint32]
CG.CGEventCreateMouseEvent.restype = ctypes.c_void_p
CG.CGEventCreateMouseEvent.argtypes = [
    ctypes.c_void_p, ctypes.c_uint32, ctypes.c_void_p, ctypes.c_uint32]
CG.CGEventCreateKeyboardEvent.restype = ctypes.c_void_p
CG.CGEventCreateKeyboardEvent.argtypes = [ctypes.c_void_p, ctypes.c_uint16, ctypes.c_bool]
CG.CGEventCreateScrollWheelEvent.restype = ctypes.c_void_p
CG.CGEventCreateScrollWheelEvent.argtypes = [
    ctypes.c_void_p, ctypes.c_uint32, ctypes.c_uint32, ctypes.c_int32]
CG.CGEventSetFlags.argtypes = [ctypes.c_void_p, ctypes.c_uint64]
CG.AXIsProcessTrusted.restype = ctypes.c_bool


class CGPoint(ctypes.Structure):
    _fields_ = [('x', ctypes.c_double), ('y', ctypes.c_double)]


# Quartz event types
LEFT_DOWN, LEFT_UP = 1, 2
RIGHT_DOWN, RIGHT_UP = 3, 4
MOUSE_MOVED, LEFT_DRAG, RIGHT_DRAG = 5, 6, 7
SCROLL = 22
KEY_DOWN, KEY_UP = 10, 11
TAP = 0  # kCGHIDEventTap

BUTTONS = {
    'left': (LEFT_DOWN, LEFT_UP, 0),
    'right': (RIGHT_DOWN, RIGHT_UP, 1),
    'middle': (1, 2, 2),
}


def screen_size():
    """Return the main display's pixel size via CoreGraphics."""
    CG.CGDisplayPixelsWide.restype = ctypes.c_size_t
    CG.CGDisplayPixelsHigh.restype = ctypes.c_size_t
    CG.CGMainDisplayID.restype = ctypes.c_uint32
    display = CG.CGMainDisplayID()
    return CG.CGDisplayPixelsWide(display), CG.CGDisplayPixelsHigh(display)


WIDTH, HEIGHT = screen_size()


def point(x, y):
    """Convert normalized 0..1 coordinates to absolute screen points."""
    return CGPoint(float(x) * WIDTH, float(y) * HEIGHT)


def post(event):
    if not event:
        return
    CG.CGEventPost(TAP, event)
    CFRelease = CG.CFRelease
    CFRelease.argtypes = [ctypes.c_void_p]
    CFRelease(event)


def mouse_event(kind, pt, button=0):
    p = CGPoint(pt.x, pt.y)
    ev = CG.CGEventCreateMouseEvent(None, kind, ctypes.byref(p), button)
    post(ev)


def handle(cmd):
    kind = cmd.get('type')
    if kind == 'move':
        mouse_event(MOUSE_MOVED, point(cmd.get('x', 0), cmd.get('y', 0)))
    elif kind == 'down':
        _, _, btn = BUTTONS.get(cmd.get('button', 'left'), BUTTONS['left'])
        down, _, _ = BUTTONS.get(cmd.get('button', 'left'), BUTTONS['left'])
        mouse_event(down, point(cmd.get('x', 0), cmd.get('y', 0)), btn)
    elif kind == 'up':
        _, up, btn = BUTTONS.get(cmd.get('button', 'left'), BUTTONS['left'])
        mouse_event(up, point(cmd.get('x', 0), cmd.get('y', 0)), btn)
    elif kind == 'click':
        x, y = cmd.get('x', 0), cmd.get('y', 0)
        pt = point(x, y)
        down, up, btn = BUTTONS.get(cmd.get('button', 'left'), BUTTONS['left'])
        mouse_event(MOUSE_MOVED, pt, btn)
        mouse_event(down, pt, btn)
        mouse_event(up, pt, btn)
    elif kind == 'scroll':
        ev = CG.CGEventCreateScrollWheelEvent(
            None, 1, 1, int(cmd.get('dy', 0)))
        post(ev)
    elif kind == 'key':
        code = int(cmd.get('code', 0))
        flags = int(cmd.get('flags', 0))
        for is_down in (True, False):
            ev = CG.CGEventCreateKeyboardEvent(None, code, is_down)
            if flags:
                CG.CGEventSetFlags(ev, flags)
            post(ev)
    elif kind == 'text':
        # Unicode typing: post each character as a keyboard event pair using
        # the CGEventKeyboardSetUnicodeString path.
        text = str(cmd.get('text', ''))
        CG.CGEventKeyboardSetUnicodeString.argtypes = [
            ctypes.c_void_p, ctypes.c_ulong, ctypes.c_void_p]
        for ch in text:
            for is_down in (True, False):
                ev = CG.CGEventCreateKeyboardEvent(None, 0, is_down)
                buf = ctypes.create_string_buffer(ch.encode('utf-16-le'))
                CG.CGEventKeyboardSetUnicodeString(
                    ev, len(ch.encode('utf-16-le')) // 2, buf)
                post(ev)
    return True


def main():
    if not CG.AXIsProcessTrusted():
        # Report clearly instead of silently doing nothing.
        print(json.dumps({
            'type': 'error',
            'message': 'Accessibility permission is not granted. Enable it for '
                       'this helper in System Settings -> Privacy & Security -> '
                       'Accessibility.',
        }), flush=True)
    print(json.dumps({'type': 'ready', 'width': WIDTH, 'height': HEIGHT}), flush=True)

    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            handle(json.loads(line))
        except Exception as exc:  # never die on a malformed command
            print(json.dumps({'type': 'error', 'message': str(exc)}), flush=True)


if __name__ == '__main__':
    main()
