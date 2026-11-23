import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync, execFile, execFileSync, spawn, spawnSync } from 'node:child_process';
import os from 'node:os';
import { discoverAdb } from './mdns.mjs';

const port = Number(process.env.WIFI_BRIDGE_PORT || 8765);
const securePort = Number(process.env.WIFI_BRIDGE_TLS_PORT || 8766);
const certDir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'wifi-bridge-certs');

function allowedOrigin(origin) {
  if (!origin || origin === 'null') return true;
  let url;
  try { url = new URL(origin); } catch { return false; }
  if (url.protocol === 'file:') return true;
  const local = url.hostname === 'localhost' || url.hostname === '127.0.0.1';
  if ((url.protocol === 'http:' || url.protocol === 'https:') && local) return true;
  if (url.protocol === 'https:' && (url.hostname === 'webscrcpy.vercel.app' || url.hostname.endsWith('.vercel.app'))) return true;
  return false;
}

function isLanAddress(host) {
  const kind = net.isIP(host);
  if (kind === 4) {
    const [a, b] = host.split('.').map(Number);
    if (a === 10 || a === 127) return true;
    if (a === 192 && b === 168) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 169 && b === 254) return true;
    // Tailscale / CGNAT 100.64.0.0/10
    if (a === 100 && b >= 64 && b <= 127) return true;
    return false;
  }
  if (kind === 6) {
    const lower = host.toLowerCase();
    return lower === '::1' || lower.startsWith('fc') || lower.startsWith('fd') || lower.startsWith('fe80:');
  }
  return false;
}

function frameReader(socket, head = Buffer.alloc(0)) {
  let buffer = head.length ? Buffer.from(head) : Buffer.alloc(0);
  const waiters = [];
  let failed = null;
  const pump = () => {
    while (waiters.length && buffer.length >= waiters[0].size) {
      const waiter = waiters.shift();
      const out = Buffer.from(buffer.subarray(0, waiter.size));
      buffer = buffer.subarray(waiter.size);
      waiter.resolve(out);
    }
  };
  const fail = (err) => {
    failed = err;
    while (waiters.length) waiters.shift().reject(err);
  };
  socket.on('data', (chunk) => {
    buffer = buffer.length ? Buffer.concat([buffer, chunk]) : chunk;
    pump();
  });
  socket.on('close', () => fail(new Error('closed')));
  socket.on('error', fail);
  return function readExact(size) {
    if (failed) return Promise.reject(failed);
    if (buffer.length >= size) {
      const out = Buffer.from(buffer.subarray(0, size));
      buffer = buffer.subarray(size);
      return Promise.resolve(out);
    }
    return new Promise((resolve, reject) => waiters.push({ size, resolve, reject }));
  };
}

async function readFrame(readExact) {
  const head = await readExact(2);
  const opcode = head[0] & 0x0f;
  let length = head[1] & 0x7f;
  if (length === 126) length = (await readExact(2)).readUInt16BE(0);
  else if (length === 127) length = Number((await readExact(8)).readBigUInt64BE(0));
  const mask = head[1] & 0x80 ? await readExact(4) : null;
  const payload = length ? await readExact(length) : Buffer.alloc(0);
  if (mask) {
    for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3];
  }
  return { opcode, payload };
}

function sendFrame(socket, opcode, payload = Buffer.alloc(0)) {
  const data = Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
  let header;
  if (data.length < 126) {
    header = Buffer.from([0x80 | opcode, data.length]);
  } else if (data.length < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x80 | opcode;
    header[1] = 126;
    header.writeUInt16BE(data.length, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x80 | opcode;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(data.length), 2);
  }
  socket.write(header);
  if (data.length) socket.write(data);
}

function accept(socket, tcp, readExact) {
  let open = true;
  const stop = () => {
    if (!open) return;
    open = false;
    socket.destroy();
    tcp.destroy();
  };
  tcp.on('data', (chunk) => {
    if (open) sendFrame(socket, 0x2, chunk);
  });
  tcp.on('close', stop);
  tcp.on('error', stop);
  socket.on('close', stop);
  socket.on('error', stop);
  (async () => {
    try {
      while (open) {
        const { opcode, payload } = await readFrame(readExact);
        if (opcode === 0x8) break;
        if (opcode === 0x9) {
          sendFrame(socket, 0xA, payload);
          continue;
        }
        if (opcode === 0x2 || opcode === 0x0) tcp.write(payload);
      }
    } catch {}
    stop();
  })();
}

// ---------------------------------------------------------------- adb helpers

// Locate the adb binary. GUI/launchd processes get a minimal PATH, so probe the
// usual install locations instead of trusting PATH alone.
let adbPathCache;
function findAdb() {
  if (adbPathCache !== undefined) return adbPathCache;
  const exe = process.platform === 'win32' ? 'adb.exe' : 'adb';
  const fromPath = String(process.env.PATH || '').split(path.delimiter).filter(Boolean)
    .map((dir) => path.join(dir, exe));
  const home = os.homedir();
  const candidates = [
    process.env.ADB_PATH,
    ...fromPath,
    '/opt/homebrew/bin/adb',
    '/usr/local/bin/adb',
    '/usr/bin/adb',
    path.join(home, 'homebrew/bin/adb'),
    path.join(home, 'Library/Android/sdk/platform-tools/adb'),
    path.join(home, 'Android/Sdk/platform-tools/adb'),
    process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Android/Sdk/platform-tools/adb.exe'),
    process.env.USERPROFILE && path.join(process.env.USERPROFILE, 'AppData/Local/Android/Sdk/platform-tools/adb.exe'),
    process.env.ProgramFiles && path.join(process.env.ProgramFiles, 'Android/platform-tools/adb.exe'),
    'C:\\Android\\platform-tools\\adb.exe',
  ].filter(Boolean);
  for (const candidate of candidates) {
    try {
      execFileSync(candidate, ['version'], { stdio: 'ignore', timeout: 5000 });
      adbPathCache = candidate;
      return candidate;
    } catch {}
  }
  adbPathCache = null;
  return null;
}

function runAdb(bin, args, timeout = 15000) {
  return new Promise((resolve) => {
    execFile(bin, args, { timeout, maxBuffer: 1024 * 1024 }, (err, stdout, stderr) => {
      resolve({ ok: !err, stdout: String(stdout || ''), stderr: String(stderr || '') });
    });
  });
}

// Cache discovery briefly so a page load does not trigger a query storm.
let mdnsCache = { at: 0, devices: [] };
async function mdnsDiscover(force = false) {
  const now = Date.now();
  if (!force && mdnsCache.at && now - mdnsCache.at < 4000) return mdnsCache.devices;
  let devices = [];
  try {
    devices = await discoverAdb({ timeoutMs: 2500 });
  } catch {}
  // Only cache successful scans. Caching an empty result makes a single
  // dropped query look like "no phones nearby" for the next few seconds.
  if (devices.length) mdnsCache = { at: Date.now(), devices };
  return devices;
}

async function onRequest(request, response) {
  const origin = request.headers.origin || '';
  if (request.method === 'OPTIONS' || request.headers['access-control-request-private-network']) {
    response.writeHead(204, {
      'Access-Control-Allow-Origin': allowedOrigin(origin) ? origin : 'null',
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
      'Access-Control-Allow-Headers': '*',
      'Access-Control-Allow-Private-Network': 'true',
      'Vary': 'Origin',
    });
    response.end();
    return;
  }
  if (request.method === 'GET' && (request.url.startsWith('/discover') || request.url.startsWith('/probe') || request.url.startsWith('/devices') || request.url.startsWith('/pair') || request.url.startsWith('/screen'))) {
    // These endpoints make the bridge dial arbitrary hosts: refuse any origin that
    // is not the app, otherwise a random website could use this Mac as a scanner.
    if (!allowedOrigin(origin)) {
      response.writeHead(403, { 'content-type': 'application/json', 'Vary': 'Origin' });
      response.end(JSON.stringify({ ok: false, message: 'Origin not allowed.' }));
      return;
    }
  }
  const replyJson = (status, body) => {
    response.writeHead(status, {
      'content-type': 'application/json',
      'Access-Control-Allow-Origin': allowedOrigin(origin) ? (origin || '*') : 'null',
      'Vary': 'Origin',
      'Cache-Control': 'no-store',
    });
    response.end(JSON.stringify(body));
  };

  // List every phone this Mac can see over mDNS. This is what lets the app
  // connect without the user ever reading an IP off the phone screen.
  if (request.method === 'GET' && request.url.startsWith('/devices')) {
    const query = new URL(request.url, 'http://localhost').searchParams;
    const devices = await mdnsDiscover(query.get('refresh') === '1');
    replyJson(200, {
      ok: true,
      devices: devices.map((d) => ({
        name: d.name,
        host: d.host,
        port: d.port,
        serial: d.serial || null,
        model: d.model || null,
        kind: d.kind,
      })),
    });
    return;
  }

  if (request.method === 'GET' && request.url.startsWith('/discover')) {
    const query = new URL(request.url, 'http://localhost').searchParams;
    const host = String(query.get('host') || '');
    const reply = replyJson;
    if (!isLanAddress(host)) {
      reply(400, { ok: false, message: 'Invalid host.' });
      return;
    }
    // 1) mDNS: Android broadcasts Wireless Debugging services. Fast path.
    const mdns = await mdnsDiscover();
    const mdnsDevices = mdns.map((d) => ({ name: d.name, host: d.host, port: d.port, serial: d.serial || null }));
    const quick = mdns.filter((m) => m.host === host).map((m) => m.port);
    if (quick.length) {
      reply(200, { ok: true, host, ports: quick.sort((a, b) => a - b), source: 'mdns', devices: mdnsDevices });
      return;
    }
    // 2) Probe 5555 plus the range Android uses for Wireless Debugging.
    const ports = [5555];
    for (let p = 30000; p <= 50000; p += 1) ports.push(p);
    const open = [];
    const probe = (port) => new Promise((resolve) => {
      const s = net.connect({ host, port });
      const done = (hit) => {
        s.destroy();
        if (hit) open.push(port);
        resolve();
      };
      const t = setTimeout(() => done(false), 1200);
      s.once('connect', () => { clearTimeout(t); done(true); });
      s.once('error', () => { clearTimeout(t); done(false); });
    });
    const batch = 512;
    for (let i = 0; i < ports.length; i += batch) {
      await Promise.all(ports.slice(i, i + batch).map(probe));
      if (open.length) break; // first live port is enough
    }
    reply(200, { ok: true, host, ports: open.sort((a, b) => a - b), source: 'sweep', devices: mdnsDevices });
    return;
  }
  // Pair with a phone using its 6-digit code. The bridge runs `adb pair` for
  // you, so pairing never requires copying a command into Terminal.
  if (request.method === 'GET' && request.url.startsWith('/pair')) {
    const query = new URL(request.url, 'http://localhost').searchParams;
    const host = String(query.get('host') || '');
    const remotePort = Number(query.get('port'));
    const code = String(query.get('code') || '').replace(/\D/g, '');
    if (!isLanAddress(host) || !Number.isInteger(remotePort) || remotePort < 1 || remotePort > 65535) {
      replyJson(400, { ok: false, message: 'Enter the pairing address shown on the phone (e.g. 192.168.1.10:37123).' });
      return;
    }
    if (!/^\d{6}$/.test(code)) {
      replyJson(400, { ok: false, message: 'The pairing code must be 6 digits.' });
      return;
    }
    const adb = findAdb();
    if (!adb) {
      replyJson(200, {
        ok: false,
        needsAdb: true,
        message: 'adb was not found. Install it with "brew install android-platform-tools", then retry.',
      });
      return;
    }
    const result = await runAdb(adb, ['pair', `${host}:${remotePort}`, code], 25000);
    // adb pair starts the daemon, which would block WebUSB mirroring later.
    // Stop it again so the browser can take over the device.
    await runAdb(adb, ['kill-server'], 8000);
    const output = `${result.stdout}${result.stderr}`.trim();
    const ok = /Successfully paired/i.test(output);
    replyJson(200, {
      ok,
      output,
      message: ok
        ? 'Paired. Now tap Connect — the port was found automatically.'
        : output || 'Pairing failed. Check the code and that both devices are on the same network.',
    });
    return;
  }

  if (request.method === 'GET' && request.url.startsWith('/probe')) {
    const query = new URL(request.url, 'http://localhost').searchParams;
    const host = String(query.get('host') || '');
    const remotePort = Number(query.get('port'));
    const reply = (status, body) => {
      response.writeHead(status, {
        'content-type': 'application/json',
        'Access-Control-Allow-Origin': allowedOrigin(origin) ? (origin || '*') : 'null',
        'Vary': 'Origin',
      });
      response.end(JSON.stringify(body));
    };
    if (!isLanAddress(host) || !Number.isInteger(remotePort) || remotePort < 1 || remotePort > 65535) {
      reply(400, { ok: false, reason: 'invalid', message: 'Invalid host/port.' });
      return;
    }
    const sock = net.connect({ host, port: remotePort });
    const finish = (result) => {
      sock.destroy();
      reply(200, result);
    };
    const timer = setTimeout(() => finish({ ok: false, reason: 'timeout', message: `${host}:${remotePort} timed out.` }), 4000);
    sock.once('connect', () => { clearTimeout(timer); finish({ ok: true, reason: 'open', message: `${host}:${remotePort} is listening.` }); });
    sock.once('error', (err) => {
      clearTimeout(timer);
      const code = err?.code || 'failed';
      const reason = code === 'ECONNREFUSED' ? 'refused' : code === 'EHOSTUNREACH' || code === 'ENETUNREACH' ? 'unreachable' : 'error';
      finish({ ok: false, reason, code, message: `${host}:${remotePort} ${code}.` });
    });
    return;
  }
  // Serve the app's own page at / so the bridge is a usable origin for
  // second-screen mode and local testing without a separate web server.
  if (request.method === 'GET' && (request.url === '/' || request.url.startsWith('/?'))) {
    const pagePath = path.join(path.dirname(fileURLToPath(import.meta.url)), 'index.html');
    if (fs.existsSync(pagePath)) {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      response.end(fs.readFileSync(pagePath));
      return;
    }
  }

  // Serve the app.js module referenced by index.html.
  if (request.method === 'GET' && (request.url === '/app.js' || request.url.startsWith('/app.js?'))) {
    const jsPath = path.join(path.dirname(fileURLToPath(import.meta.url)), 'app.js');
    if (fs.existsSync(jsPath)) {
      response.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'no-store' });
      response.end(fs.readFileSync(jsPath));
      return;
    }
  }

  // Serve the second-screen launcher from the bridge so the copy-paste command
  // works against 127.0.0.1 without waiting for a deploy.
  if (request.method === 'GET' && (request.url === '/second-screen.sh' || request.url.startsWith('/second-screen.sh?'))) {
    const scriptPath = path.join(path.dirname(fileURLToPath(import.meta.url)), 'second-screen.sh');
    if (!fs.existsSync(scriptPath)) {
      response.writeHead(404, { 'content-type': 'text/plain' });
      response.end('second-screen.sh is missing.\n');
      return;
    }
    response.writeHead(200, {
      'content-type': 'text/x-shellscript; charset=utf-8',
      'cache-control': 'no-store',
    });
    response.end(fs.readFileSync(scriptPath));
    return;
  }

  // Serve the second-screen page from the bridge so the tablet needs nothing
  // but the cable: http://127.0.0.1:8765/second-screen.html
  if (request.method === 'GET' && (request.url === '/second-screen.html' || request.url.startsWith('/second-screen.html?'))) {
    const pagePath = path.join(path.dirname(fileURLToPath(import.meta.url)), 'second-screen.html');
    if (!fs.existsSync(pagePath)) {
      response.writeHead(404, { 'content-type': 'text/plain' });
      response.end('second-screen.html is missing.\n');
      return;
    }
    response.writeHead(200, {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
    });
    response.end(fs.readFileSync(pagePath));
    return;
  }

  // Stream the Mac's display as fragmented MP4 for second-screen mode.
  if (request.method === 'GET' && request.url.startsWith('/screen')) {
    if (!SECOND_SCREEN_SUPPORTED) {
      response.writeHead(501, {
        'content-type': 'application/json',
        'cache-control': 'no-store',
        'access-control-allow-origin': allowedOrigin(origin) ? (origin || '*') : 'null',
        'vary': 'Origin',
      });
      response.end(JSON.stringify({
        ok: false,
        message: 'Second-screen mode is currently macOS only.',
      }));
      return;
    }
  }

  if (request.method === 'GET' && request.url.startsWith('/screen/permissions')) {
    response.writeHead(200, {
      'content-type': 'application/json',
      'cache-control': 'no-store',
      'access-control-allow-origin': allowedOrigin(origin) ? (origin || '*') : 'null',
      'vary': 'Origin',
    });
    response.end(JSON.stringify({ ok: true, ...screenPermissions() }));
    return;
  }

  if (request.method === 'GET' && request.url.startsWith('/screen')) {
    const query = new URL(request.url, 'http://localhost').searchParams;
    startScreenStream(response, query, origin);
    return;
  }

  response.writeHead(200, { 'content-type': 'text/plain' });
  response.end('webscrcpy wifi bridge\n');
}

// ---------------------------------------------------------------- second screen
// Second-screen mode drives macOS-only capture (AVFoundation) and input
// (CoreGraphics), so it is only offered on Darwin.
const SECOND_SCREEN_SUPPORTED = process.platform === 'darwin';

// Stream this Mac's display to a tablet/phone over USB (adb reverse) so it can
// act as a second monitor. Capture and encoding run in a Python helper that
// drives ffmpeg; this process only relays bytes and forwards input events.

const SECOND_SCREEN_STREAM = path.join(path.dirname(fileURLToPath(import.meta.url)), 'second-screen-stream.py');
const SECOND_SCREEN_INPUT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'second-screen-input.py');

let streamProc = null;
let streamStartedAt = 0;
let inputProc = null;

function pythonBin() {
  for (const candidate of [
    process.env.PYTHON,
    '/opt/homebrew/bin/python3',
    '/usr/local/bin/python3',
    '/usr/bin/python3',
  ]) {
    if (!candidate) continue;
    try {
      execFileSync(candidate, ['--version'], { stdio: 'ignore', timeout: 5000 });
      return candidate;
    } catch {}
  }
  return null;
}

// Stop the active capture and wait for it to actually exit. ffmpeg holds the
// AVFoundation screen device exclusively: starting a second capture before the
// first releases it makes ffmpeg report a bogus "Selected pixel format
// (yuv420p) is not supported by the input device" and emit zero bytes.
function stopStream() {
  return new Promise((resolve) => {
    const child = streamProc;
    streamProc = null;
    if (!child) {
      resolve();
      return;
    }
    let settled = false;
    const done = () => {
      if (settled) return;
      settled = true;
      resolve();
    };
    // It may already be gone (the tablet closed its tab a moment ago).
    if (child.exitCode !== null || child.signalCode !== null) {
      done();
      return;
    }
    child.once('exit', done);
    // SIGTERM only: the wrapper forwards it to its own process group so ffmpeg
    // dies too. SIGKILL would strand ffmpeg holding the screen device.
    try { child.kill('SIGTERM'); } catch {}
    setTimeout(done, 5000);
  });
}

function captureProcesses() {
  try {
    const out = execFileSync('pgrep', ['-f', 'avfoundation.*-i 2:none'], {
      encoding: 'utf8', timeout: 5000,
    });
    return out.split('\n').map((s) => s.trim()).filter(Boolean);
  } catch {
    return [];
  }
}

// Wait until nothing holds the screen capture device. Cleans up stragglers from
// a crashed or reloaded session, which would otherwise break the new capture.
async function waitForCaptureFree(timeoutMs = 6000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const pids = captureProcesses();
    if (!pids.length) {
      // The device is released a moment after the process disappears.
      await new Promise((r) => setTimeout(r, 250));
      if (!captureProcesses().length) return true;
    }
    for (const pid of pids) {
      try { process.kill(Number(pid), 'SIGTERM'); } catch {}
    }
    if (Date.now() > deadline) return false;
    await new Promise((r) => setTimeout(r, 300));
  }
}

async function startScreenStream(response, query, origin) {
  const py = pythonBin();
  if (!py) {
    response.writeHead(500, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ ok: false, message: 'python3 not found.' }));
    return;
  }
  if (!fs.existsSync(SECOND_SCREEN_STREAM)) {
    response.writeHead(500, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ ok: false, message: 'second-screen-stream.py is missing.' }));
    return;
  }

  // One capture at a time: two ffmpeg screen grabs would fight over the device.
  await stopStream();
  if (!(await waitForCaptureFree())) {
    console.error('[screen] capture device still busy; starting anyway');
  }

  const args = [
    SECOND_SCREEN_STREAM,
    '--fps', String(Math.min(Math.max(Number(query.get('fps')) || 30, 5), 60)),
    '--width', String(Math.min(Math.max(Number(query.get('width')) || 1920, 480), 3840)),
    '--bitrate', String(query.get('bitrate') || '8M'),
  ];

  const child = spawn(py, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  streamProc = child;
  streamStartedAt = Date.now();
  let bytes = 0;

  response.writeHead(200, {
    'content-type': 'video/mp4',
    'cache-control': 'no-store',
    'access-control-allow-origin': allowedOrigin(origin) ? (origin || '*') : 'null',
    'vary': 'Origin',
  });

  child.stdout.on('data', (chunk) => {
    bytes += chunk.length;
    if (!response.write(chunk)) {
      // Backpressure: pause until the client drains, otherwise a slow tablet
      // makes the pipe buffer balloon.
      child.stdout.pause();
      response.once('drain', () => child.stdout.resume());
    }
  });

  child.stderr.on('data', (chunk) => {
    const text = chunk.toString().trim();
    if (text) console.error('[screen]', text.split('\n').slice(-2).join(' '));
  });

  const stop = () => {
    try { child.kill('SIGTERM'); } catch {}
    if (streamProc === child) streamProc = null;
  };
  child.on('exit', (code) => {
    console.log(`[screen] capture stopped (code ${code}) after ${((Date.now() - streamStartedAt) / 1000).toFixed(1)}s, ${(bytes / 1048576).toFixed(1)}MB`);
    if (streamProc === child) streamProc = null;
    try { response.end(); } catch {}
  });
  // The tablet closing the tab must stop capture immediately.
  response.on('close', stop);
  response.on('error', stop);
}

// Report the two macOS permissions second-screen mode needs, so the tablet can
// show a clear instruction instead of silently doing nothing.
function screenPermissions() {
  const py = pythonBin();
  const result = {
    accessibility: false,
    screenRecording: false,
    helper: process.execPath,
    python: py,
  };
  if (py) {
    try {
      const out = execFileSync(py, ['-c', [
        'import ctypes,ctypes.util',
        'cg=ctypes.cdll.LoadLibrary(ctypes.util.find_library("ApplicationServices"))',
        'cg.AXIsProcessTrusted.restype=ctypes.c_bool',
        'print(cg.AXIsProcessTrusted())',
      ].join('\n')], { encoding: 'utf8', timeout: 8000 }).trim();
      result.accessibility = out.endsWith('True');
    } catch {}
  }
  // Screen recording: ffmpeg lists the capture device only if it may read it.
  // Note: the device list goes to stderr, not stdout.
  try {
    const ffmpeg = findFfmpeg();
    if (ffmpeg) {
      const probe = spawnSync(ffmpeg, ['-hide_banner', '-f', 'avfoundation',
        '-list_devices', 'true', '-i', ''], { encoding: 'utf8', timeout: 15000 });
      const text = `${probe.stderr || ''}${probe.stdout || ''}`;
      result.screenRecording = text.includes('Capture screen');
    }
  } catch {}
  return result;
}

function findFfmpeg() {
  for (const candidate of [
    '/opt/homebrew/bin/ffmpeg',
    '/usr/local/bin/ffmpeg',
    path.join(os.homedir(), 'homebrew', 'bin', 'ffmpeg'),
    '/usr/bin/ffmpeg',
  ]) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

// Bridge the tablet's pointer/keyboard to the Mac via the Python injector.
function startScreenInput(request, socket, head) {
  const py = pythonBin();
  if (!py || !fs.existsSync(SECOND_SCREEN_INPUT)) {
    socket.write('HTTP/1.1 500 Internal Server Error\r\n\r\n');
    socket.destroy();
    return;
  }
  // Single injector process: it owns stdin for the whole session.
  if (inputProc) {
    try { inputProc.kill('SIGTERM'); } catch {}
    inputProc = null;
  }
  const child = spawn(py, [SECOND_SCREEN_INPUT], { stdio: ['pipe', 'pipe', 'pipe'] });
  inputProc = child;

  child.stdout.on('data', (chunk) => {
    const text = chunk.toString().trim();
    if (text) console.log('[input]', text);
  });
  child.stderr.on('data', (chunk) => {
    const text = chunk.toString().trim();
    if (text) console.error('[input]', text.split('\n').slice(-2).join(' '));
  });
  child.on('exit', () => { if (inputProc === child) inputProc = null; });

  // Reuse the relay's frame reader: text frames carry one JSON command each.
  const readExact = frameReader(socket, head);
  (async () => {
    try {
      for (;;) {
        const frame = await readFrame(readExact);
        if (frame.opcode === 0x8) break;          // close
        if (frame.opcode === 0x9) continue;       // ping
        if (frame.opcode !== 0x1) continue;       // only text carries commands
        const line = frame.payload.toString('utf8');
        if (line === 'bye') break;
        try { child.stdin.write(line + '\n'); } catch {}
      }
    } catch {}
    try { child.stdin.end(); } catch {}
    try { socket.end(); } catch {}
  })();

  const stop = () => {
    try { child.kill('SIGTERM'); } catch {}
    if (inputProc === child) inputProc = null;
  };
  socket.on('close', stop);
  socket.on('error', stop);
}

function onUpgrade(request, socket, head) {
  const origin = request.headers.origin || '';
  if (!allowedOrigin(origin)) {
    socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
    socket.destroy();
    return;
  }
  const pathname = (request.url || '/').split('?')[0];
  const key = request.headers['sec-websocket-key'];
  const acceptKey = crypto.createHash('sha1').update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest('base64');
  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\n' +
    'Upgrade: websocket\r\n' +
    'Connection: Upgrade\r\n' +
    `Sec-WebSocket-Accept: ${acceptKey}\r\n` +
    `Access-Control-Allow-Origin: ${origin}\r\n` +
    'Access-Control-Allow-Private-Network: true\r\n' +
    '\r\n',
  );
  // Second-screen input has its own protocol: JSON commands straight to the
  // macOS event injector, no ADB relay handshake. It builds its own frame
  // reader, so return before creating one here.
  if (pathname === '/screen-input') {
    startScreenInput(request, socket, head);
    return;
  }
  const readExact = frameReader(socket, head);
  (async () => {
    try {
      const first = await readFrame(readExact);
      const requestBody = JSON.parse(first.payload.toString('utf8'));
      const host = String(requestBody.host || '');
      const remotePort = Number(requestBody.port);
      if (!isLanAddress(host) || !Number.isInteger(remotePort) || remotePort < 1 || remotePort > 65535) {
        sendFrame(socket, 0x1, JSON.stringify({ type: 'error', message: 'Use the phone\'s local IP address, e.g. 192.168.1.10.' }));
        socket.end();
        return;
      }
      const tcp = net.connect({ host, port: remotePort });
      tcp.setNoDelay(true);
      let dialed = false;
      const failDial = (err) => {
        if (dialed) return;
        dialed = true;
        clearTimeout(timer);
        const message = err?.message === 'timed out'
          ? `Unable to reach ${host}:${remotePort}. timed out`
          : `Unable to reach ${host}:${remotePort}. ${err?.message || 'failed'}`;
        try { sendFrame(socket, 0x1, JSON.stringify({ type: 'error', message })); } catch {}
        socket.end();
        tcp.destroy();
      };
      const timer = setTimeout(() => failDial(new Error('timed out')), 5000);
      tcp.once('error', failDial);
      tcp.once('connect', () => {
        if (dialed) {
          tcp.destroy();
          return;
        }
        dialed = true;
        clearTimeout(timer);
        tcp.off('error', failDial);
        sendFrame(socket, 0x1, JSON.stringify({ type: 'ok' }));

        accept(socket, tcp, readExact);
      });
    } catch {
      socket.destroy();
    }
  })();
}

const server = http.createServer(onRequest);
server.on('upgrade', onUpgrade);
server.listen(port, '127.0.0.1', () => {
  console.log(`Wi-Fi bridge listening on ws://127.0.0.1:${port}`);
});

function loadOrGenerateCerts() {
  const certFile = path.join(certDir, 'cert.pem');
  const keyFile = path.join(certDir, 'key.pem');
  if (fs.existsSync(certFile) && fs.existsSync(keyFile)) {
    return { cert: fs.readFileSync(certFile), key: fs.readFileSync(keyFile) };
  }
  try {
    fs.mkdirSync(certDir, { recursive: true });
    execSync(`openssl req -x509 -newkey rsa:2048 -keyout "${keyFile}" -out "${certFile}" -days 365 -nodes -subj "/CN=127.0.0.1" -addext "subjectAltName=IP:127.0.0.1,DNS:localhost"`, { stdio: 'ignore' });
    if (fs.existsSync(certFile) && fs.existsSync(keyFile)) {
      console.log('Local SSL certificate (WSS) successfully generated.');
      return { cert: fs.readFileSync(certFile), key: fs.readFileSync(keyFile) };
    }
  } catch (err) {
    console.warn('Failed to automatically generate SSL certificate:', err?.message || err);
  }
  return null;
}

const certs = loadOrGenerateCerts();
if (certs) {
  const secure = https.createServer(certs, onRequest);
  secure.on('upgrade', onUpgrade);
  secure.listen(securePort, '127.0.0.1', () => {
    console.log(`Wi-Fi bridge listening on wss://127.0.0.1:${securePort}`);
  });
} else {
  console.log('No wifi-bridge-certs found, wss://127.0.0.1 is disabled (only ws://127.0.0.1:8765 is active).');
}
