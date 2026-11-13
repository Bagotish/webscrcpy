import React, { useEffect, useState, useRef, useCallback } from 'react';
import type { DataConnection, Peer as PeerType } from 'peerjs';

/**
 * Standard Android KeyEvent codes matching scrcpy / adb keyevent definitions.
 */
export const ADB_KEYCODES = {
  // Navigation
  HOME: 3,
  BACK: 4,
  UP: 19,
  DOWN: 20,
  LEFT: 21,
  RIGHT: 22,
  DPAD_CENTER: 23,
  RECENTS: 187,
  NOTIFICATIONS: 83,

  // Media Playback
  MEDIA_PLAY_PAUSE: 85,
  MEDIA_STOP: 86,
  MEDIA_NEXT: 87,
  MEDIA_PREVIOUS: 88,

  // Volume & Power
  VOLUME_UP: 24,
  VOLUME_DOWN: 25,
  VOLUME_MUTE: 164,
  POWER: 26,
} as const;

export type AdbKeyCode = typeof ADB_KEYCODES[keyof typeof ADB_KEYCODES];

export interface TVRemoteModalProps {
  /** Whether the modal is visible */
  isOpen: boolean;
  /** Callback when user closes the modal */
  onClose: () => void;
  /** Handler invoked when a keycode is received over WebRTC from the phone */
  onSendKeycode: (code: number) => Promise<void> | void;
  /** Handler invoked when arbitrary text is submitted by the phone */
  onInjectText?: (text: string) => Promise<void> | void;
  /** Handler invoked when screen off / brightness toggle is requested from the phone */
  onToggleScreen?: (off?: boolean) => Promise<void> | void;
  /** Handler invoked when touch trackpad swipe gesture is performed */
  onSwipe?: (direction: string) => Promise<void> | void;
  /** Handler invoked when touch trackpad scroll event is performed */
  onScroll?: (scrollX: number, scrollY: number) => Promise<void> | void;
  /** Base URL for the mobile remote web page (defaults to window.location.origin + /remote.html) */
  remoteUrlBase?: string;
}

export type ConnectionStatus = 'idle' | 'initializing' | 'waiting' | 'connected' | 'error';

/**
 * TVRemoteModal component
 *
 * Hosts a WebRTC DataChannel via PeerJS. Displays a QR code that an iPhone or Android phone
 * can scan to open the mobile remote control interface and send keycodes directly to the stream.
 */
export const TVRemoteModal: React.FC<TVRemoteModalProps> = ({
  isOpen,
  onClose,
  onSendKeycode,
  onInjectText,
  onToggleScreen,
  onSwipe,
  onScroll,
  remoteUrlBase,
}) => {
  const [status, setStatus] = useState<ConnectionStatus>('idle');
  const [peerId, setPeerId] = useState<string | null>(null);
  const [remoteUrl, setRemoteUrl] = useState<string>('');
  const [connectedDevice, setConnectedDevice] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string>('');
  const [copied, setCopied] = useState<boolean>(false);

  const peerRef = useRef<PeerType | null>(null);
  const connRef = useRef<DataConnection | null>(null);
  const qrCanvasRef = useRef<HTMLCanvasElement | null>(null);

  // Initialize WebRTC Peer when modal opens
  useEffect(() => {
    if (!isOpen) {
      if (peerRef.current) {
        peerRef.current.destroy();
        peerRef.current = null;
      }
      connRef.current = null;
      setStatus('idle');
      setPeerId(null);
      setConnectedDevice(null);
      return;
    }

    let isMounted = true;
    setStatus('initializing');
    setErrorMessage('');

    async function setupPeer() {
      try {
        // Dynamically import PeerJS if running in browser
        const { default: Peer } = await import('peerjs');

        // Create random host room ID
        const hostId = `webscrcpy-${Math.random().toString(36).substring(2, 9)}`;
        const peer = new Peer(hostId, {
          debug: 1,
        });

        peerRef.current = peer;

        peer.on('open', (id) => {
          if (!isMounted) return;
          setPeerId(id);
          setStatus('waiting');

          // Build mobile remote URL
          const base = remoteUrlBase || (typeof window !== 'undefined'
            ? `${window.location.origin}${window.location.pathname.replace(/\/index\.html$/, '')}/remote.html`
            : './remote.html');
          const targetUrl = `${base}?peer=${encodeURIComponent(id)}`;
          setRemoteUrl(targetUrl);

          renderQrCode(targetUrl);
        });

        peer.on('connection', (connection) => {
          if (!isMounted) return;
          connRef.current = connection;

          connection.on('open', () => {
            if (!isMounted) return;
            setStatus('connected');
            setConnectedDevice('Mobile Device');
          });

          connection.on('data', async (raw: unknown) => {
            if (!raw || typeof raw !== 'object') return;
            const data = raw as { type?: string; code?: number; text?: string; device?: string };

            if (data.type === 'handshake' && data.device) {
              setConnectedDevice(data.device);
            } else if (data.type === 'key' && typeof data.code === 'number') {
              try {
                await onSendKeycode(data.code);
              } catch (err) {
                console.error('Failed to dispatch keycode:', err);
              }
            } else if (data.type === 'text' && typeof data.text === 'string' && onInjectText) {
              try {
                await onInjectText(data.text);
              } catch (err) {
                console.error('Failed to inject text:', err);
              }
            } else if ((data.type === 'toggle_screen' || data.type === 'screen_off') && onToggleScreen) {
              try {
                const off = (data as { off?: boolean }).off;
                await onToggleScreen(off);
              } catch (err) {
                console.error('Failed to toggle screen:', err);
              }
            } else if (data.type === 'swipe' && onSwipe) {
              try {
                const dir = (data as { direction?: string }).direction;
                if (dir) await onSwipe(dir);
              } catch (err) {
                console.error('Failed to handle swipe:', err);
              }
            } else if (data.type === 'scroll' && onScroll) {
              try {
                const s = data as { scrollX?: number; scrollY?: number };
                await onScroll(s.scrollX || 0, s.scrollY || 0);
              } catch (err) {
                console.error('Failed to handle scroll:', err);
              }
            }
          });

          connection.on('close', () => {
            if (!isMounted) return;
            setStatus('waiting');
            setConnectedDevice(null);
          });

          connection.on('error', (err) => {
            console.error('DataConnection error:', err);
            if (!isMounted) return;
            setStatus('waiting');
          });
        });

        peer.on('error', (err) => {
          console.error('Peer error:', err);
          if (!isMounted) return;
          setStatus('error');
          setErrorMessage(err.message || 'WebRTC Peer error');
        });
      } catch (err: any) {
        console.error('Failed to initialize PeerJS:', err);
        if (!isMounted) return;
        setStatus('error');
        setErrorMessage(err?.message || 'Could not load PeerJS WebRTC client');
      }
    }

    setupPeer();

    return () => {
      isMounted = false;
      if (peerRef.current) {
        peerRef.current.destroy();
        peerRef.current = null;
      }
      connRef.current = null;
    };
  }, [isOpen, onSendKeycode, onInjectText, remoteUrlBase]);

  // Render QR code to canvas using qrcode library or fallback
  const renderQrCode = useCallback(async (url: string) => {
    if (!qrCanvasRef.current) return;
    try {
      // Dynamic import of 'qrcode' package
      const QRCode = await import('qrcode');
      await QRCode.toCanvas(qrCanvasRef.current, url, {
        width: 220,
        margin: 1,
        color: {
          dark: '#09090b',
          light: '#ffffff',
        },
      });
    } catch {
      // Fallback: Check if global QRCode is available via window
      if (typeof (window as any).QRCode === 'function') {
        const container = qrCanvasRef.current.parentElement;
        if (container) {
          qrCanvasRef.current.style.display = 'none';
          const existing = container.querySelector('.js-qrcode-fallback');
          if (existing) existing.remove();
          const fallbackDiv = document.createElement('div');
          fallbackDiv.className = 'js-qrcode-fallback rounded-xl overflow-hidden';
          container.appendChild(fallbackDiv);
          new (window as any).QRCode(fallbackDiv, {
            text: url,
            width: 220,
            height: 220,
            colorDark: '#09090b',
            colorLight: '#ffffff',
          });
        }
      }
    }
  }, []);

  const handleCopyLink = async () => {
    if (!remoteUrl) return;
    try {
      await navigator.clipboard.writeText(remoteUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      window.prompt('Copy remote URL:', remoteUrl);
    }
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm p-4 animate-fadeIn">
      <div className="relative w-full max-w-sm rounded-3xl bg-zinc-900 border border-zinc-800 shadow-2xl p-6 flex flex-col items-center text-center space-y-4">
        {/* Close Button */}
        <button
          type="button"
          onClick={onClose}
          className="absolute top-4 right-4 w-8 h-8 rounded-full text-zinc-400 hover:text-white hover:bg-zinc-800 transition flex items-center justify-center"
          title="Close"
        >
          <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>

        {/* Header */}
        <div className="space-y-1">
          <div className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full bg-blue-500/10 border border-blue-500/20 text-blue-400 text-xs font-medium">
            <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <rect x="2" y="3" width="20" height="14" rx="2" />
              <line x1="8" y1="21" x2="16" y2="21" />
              <line x1="12" y1="17" x2="12" y2="21" />
            </svg>
            <span>Peer-to-Peer TV Remote</span>
          </div>
          <h2 className="text-base font-semibold text-white">Scan with Phone Camera</h2>
          <p className="text-xs text-zinc-400 max-w-xs">
            Open the Camera on your iPhone or Android to pair instantly over WebRTC. Zero app download required.
          </p>
        </div>

        {/* QR Code Container */}
        <div className="relative p-3.5 rounded-2xl bg-white shadow-inner flex items-center justify-center min-w-[240px] min-h-[240px]">
          {status === 'initializing' && (
            <div className="flex flex-col items-center gap-2 text-zinc-600">
              <div className="w-6 h-6 border-2 border-blue-500 border-t-transparent rounded-full animate-spin" />
              <span className="text-xs font-medium">Starting WebRTC...</span>
            </div>
          )}

          {status === 'error' && (
            <div className="p-3 text-xs text-rose-600 text-center space-y-1">
              <p className="font-semibold">Signaling Error</p>
              <p className="text-[11px] text-zinc-500">{errorMessage || 'Check internet connection.'}</p>
            </div>
          )}

          <canvas
            ref={qrCanvasRef}
            className={`rounded-lg ${status === 'waiting' || status === 'connected' ? 'block' : 'hidden'}`}
          />
        </div>

        {/* Live Status Indicator */}
        <div className="w-full flex items-center justify-between px-3 py-2 rounded-xl bg-zinc-950 border border-zinc-800 text-xs">
          <div className="flex items-center gap-2">
            <span
              className={`w-2 h-2 rounded-full shrink-0 ${
                status === 'connected'
                  ? 'bg-emerald-400 animate-pulse'
                  : status === 'waiting'
                  ? 'bg-amber-400 animate-pulse'
                  : 'bg-zinc-600'
              }`}
            />
            <span className="text-zinc-300 font-medium">
              {status === 'connected'
                ? `Paired: ${connectedDevice || 'Phone'}`
                : status === 'waiting'
                ? 'Waiting for scan...'
                : status === 'initializing'
                ? 'Connecting to WebRTC...'
                : 'Offline'}
            </span>
          </div>
          <button
            type="button"
            onClick={handleCopyLink}
            disabled={!remoteUrl}
            className="text-[11px] text-blue-400 hover:text-blue-300 font-medium disabled:opacity-50 transition"
          >
            {copied ? 'Copied' : 'Copy Link'}
          </button>
        </div>

        {/* Quick Testing Bar */}
        <div className="w-full pt-1 border-t border-zinc-800/80 flex items-center justify-between text-[11px] text-zinc-500">
          <span>Supported: Play, Volume, D-Pad, Home</span>
          {peerId && <span className="font-mono text-[10px] text-zinc-600">{peerId.slice(-6)}</span>}
        </div>
      </div>
    </div>
  );
};

export default TVRemoteModal;
