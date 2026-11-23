#!/usr/bin/env python3
"""
Stream this Mac's screen as fragmented MP4 on stdout for WebScrcpy's
second-screen mode. wifi-bridge.mjs pipes the output to the browser.

  python3 second-screen-stream.py --fps 30 --width 1920 --bitrate 8M

Two capture backends:
  --source screen   the Mac's display (default)
  --source camera   any AVFoundation device, useful for testing the pipe

Uses ffmpeg's avfoundation input with VideoToolbox hardware encoding, so the
CPU cost is small. Output is fragmented MP4 (frag_keyframe+empty_moov) which a
browser can play from a MediaSource as the bytes arrive.
"""
import argparse
import os
import shutil
import signal
import subprocess
import sys

FFMPEG_CANDIDATES = [
    '/opt/homebrew/bin/ffmpeg',
    '/usr/local/bin/ffmpeg',
    os.path.expanduser('~/homebrew/bin/ffmpeg'),
    '/usr/bin/ffmpeg',
]


def find_ffmpeg():
    for path in FFMPEG_CANDIDATES:
        if os.path.isfile(path) and os.access(path, os.X_OK):
            return path
    found = shutil.which('ffmpeg')
    if found:
        return found
    raise SystemExit('ffmpeg not found. Install it with: brew install ffmpeg')


def screen_device(ffmpeg):
    """Find the avfoundation index of the Mac's screen."""
    try:
        out = subprocess.run(
            [ffmpeg, '-hide_banner', '-f', 'avfoundation',
             '-list_devices', 'true', '-i', ''],
            capture_output=True, text=True, timeout=15,
        )
    except Exception:
        return None
    for line in out.stderr.splitlines():
        if 'Capture screen' not in line:
            continue
        # Line looks like: [AVFoundation indev @ 0x...] [2] Capture screen 0
        # so the device index is in the LAST bracketed group.
        head, _, _ = line.partition('Capture screen')
        digits = head.rstrip().rsplit('[', 1)[-1].rstrip(']').strip()
        if digits.isdigit():
            return digits
    return None


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--source', default='screen', choices=['screen', 'camera'])
    ap.add_argument('--device', default=None, help='avfoundation index')
    ap.add_argument('--fps', type=int, default=30)
    ap.add_argument('--width', type=int, default=1920)
    ap.add_argument('--bitrate', default='8M')
    ap.add_argument('--codec', default='h264', choices=['h264', 'hevc'])
    args = ap.parse_args()

    ffmpeg = find_ffmpeg()
    device = args.device
    if device is None:
        device = screen_device(ffmpeg) if args.source == 'screen' else '0'
    if device is None:
        raise SystemExit(
            'Could not find the screen capture device. Grant Screen Recording '
            'permission to your terminal (System Settings -> Privacy & Security '
            '-> Screen Recording), then run this again.')

    encoder = 'h264_videotoolbox' if args.codec == 'h264' else 'hevc_videotoolbox'
    # scale=W:-2 keeps the aspect ratio and an even height for yuv420p.
    # Note: avfoundation applies a bare -pix_fmt to the *input* device and then
    # fails with "Selected pixel format (yuv420p) is not supported by the input
    # device". Converting in the filter chain avoids that entirely.
    cmd = [
        ffmpeg, '-hide_banner', '-loglevel', 'error',
        '-f', 'avfoundation',
        '-capture_cursor', '1',
        '-framerate', str(args.fps),
        '-i', f'{device}:none',
        '-vf', f'scale={args.width}:-2:flags=bilinear,format=yuv420p',
        '-c:v', encoder,
        '-b:v', args.bitrate,
        # Force a keyframe once a second. Without this VideoToolbox rarely emits
        # one, so frag_keyframe would hand the browser a single huge fragment and
        # playback would only start after several seconds.
        '-force_key_frames', 'expr:gte(t,n_forced*1)',
        '-g', str(args.fps * 2),
        # frag_duration cuts fragments on a timer as well as at keyframes, which
        # is what keeps the browser's first frame arriving quickly.
        '-frag_duration', '250000',
        '-movflags', 'frag_keyframe+empty_moov+default_base_moof',
        '-flush_packets', '1',
        '-f', 'mp4',
        '-',
    ]
    sys.stderr.write('starting: ' + ' '.join(cmd) + '\n')

    # start_new_session puts ffmpeg in its own process group so we can kill the
    # whole group. A plain terminate() can leave ffmpeg alive holding the
    # exclusive AVFoundation screen device, which makes the *next* capture fail
    # with a bogus "Selected pixel format (yuv420p) is not supported" error.
    proc = subprocess.Popen(
        cmd, stdout=sys.stdout.buffer, stderr=sys.stderr, start_new_session=True)

    stopping = False

    def kill_group(sig=signal.SIGTERM):
        try:
            os.killpg(os.getpgid(proc.pid), sig)
        except Exception:
            try:
                proc.send_signal(sig)
            except Exception:
                pass

    def stop(signum, frame):
        nonlocal stopping
        if stopping:
            return
        stopping = True
        kill_group(signal.SIGTERM)

    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)

    try:
        proc.wait()
    finally:
        # Always reap the group, even on an unexpected exit path.
        if proc.poll() is None:
            kill_group(signal.SIGKILL)
        else:
            # A SIGTERM'd child that already exited may have left grandchildren.
            kill_group(signal.SIGKILL)


if __name__ == '__main__':
    main()
