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

echo "📦 Setting up wifi-bridge.mjs..."
cat << 'MDNS_EOF' > "$INSTALL_DIR/mdns.mjs"
// Minimal multicast-DNS (mDNS) client for ADB discovery.
//
// Node's dns.resolveSrv() only talks to a unicast resolver, so it can never see
// Android's _adb._tcp / _adb-tls-pairing._tcp advertisements. This module sends
// real mDNS queries to 224.0.0.251:5353 and parses the answers, so we can find
// phones by name instead of asking the user to read an IP off the screen.
import dgram from 'node:dgram';
import os from 'node:os';

const MDNS_ADDR = '224.0.0.251';
const MDNS_PORT = 5353;

// ---------------------------------------------------------------- DNS encode

function encodeName(name) {
  const parts = String(name).replace(/\.$/, '').split('.').filter(Boolean);
  const out = [];
  for (const part of parts) {
    const buf = Buffer.from(part, 'utf8');
    out.push(Buffer.from([buf.length]), buf);
  }
  out.push(Buffer.from([0]));
  return Buffer.concat(out);
}

function buildQuery(name, type) {
  const header = Buffer.alloc(12);
  header.writeUInt16BE(0, 0); // transaction id
  header.writeUInt16BE(0, 2); // flags: standard query
  header.writeUInt16BE(1, 4); // qdcount
  const tail = Buffer.alloc(4);
  tail.writeUInt16BE(type, 0);
  tail.writeUInt16BE(1, 2); // class IN
  return Buffer.concat([header, encodeName(name), tail]);
}

// ---------------------------------------------------------------- DNS decode

function readName(buf, offset, depth = 0) {
  const labels = [];
  let pos = offset;
  let end = offset;
  let jumped = false;
  while (pos < buf.length && depth < 16) {
    const len = buf[pos];
    if (len === 0) {
      pos += 1;
      if (!jumped) end = pos;
      break;
    }
    if ((len & 0xc0) === 0xc0) {
      const ptr = ((len & 0x3f) << 8) | buf[pos + 1];
      if (!jumped) {
        end = pos + 2;
        jumped = true;
      }
      const sub = readName(buf, ptr, depth + 1);
      if (sub.name) labels.push(sub.name);
      pos = end;
      break;
    }
    labels.push(buf.subarray(pos + 1, pos + 1 + len).toString('utf8'));
    pos += 1 + len;
    if (!jumped) end = pos;
  }
  return { name: labels.filter(Boolean).join('.'), offset: end };
}

function parseTxt(buf) {
  const out = {};
  let i = 0;
  while (i < buf.length) {
    const len = buf[i];
    i += 1;
    if (!len || i + len > buf.length) break;
    const entry = buf.subarray(i, i + len).toString('utf8');
    i += len;
    const eq = entry.indexOf('=');
    if (eq === -1) out[entry] = '';
    else out[entry.slice(0, eq)] = entry.slice(eq + 1);
  }
  return out;
}

function parsePacket(buf) {
  if (buf.length < 12) return [];
  const qd = buf.readUInt16BE(4);
  const an = buf.readUInt16BE(6);
  const ns = buf.readUInt16BE(8);
  const ar = buf.readUInt16BE(10);

  let pos = 12;
  for (let i = 0; i < qd; i++) {
    const n = readName(buf, pos);
    pos = n.offset + 4;
  }

  const records = [];
  const total = an + ns + ar;
  for (let i = 0; i < total && pos < buf.length; i++) {
    const n = readName(buf, pos);
    pos = n.offset;
    if (pos + 10 > buf.length) break;
    const type = buf.readUInt16BE(pos);
    const ttl = buf.readUInt32BE(pos + 4);
    const rdlen = buf.readUInt16BE(pos + 8);
    const rdStart = pos + 10;
    const rdEnd = rdStart + rdlen;
    if (rdEnd > buf.length) break;

    const record = { name: n.name, type, ttl };
    if (type === 12) {
      // PTR
      record.data = readName(buf, rdStart).name;
    } else if (type === 33) {
      // SRV
      record.port = buf.readUInt16BE(rdStart + 4);
      record.target = readName(buf, rdStart + 6).name;
    } else if (type === 1) {
      // A
      if (rdlen === 4) record.data = `${buf[rdStart]}.${buf[rdStart + 1]}.${buf[rdStart + 2]}.${buf[rdStart + 3]}`;
    } else if (type === 28) {
      // AAAA
      if (rdlen === 16) {
        const groups = [];
        for (let g = 0; g < 16; g += 2) groups.push(buf.readUInt16BE(rdStart + g).toString(16));
        record.data = groups.join(':');
      }
    } else if (type === 16) {
      // TXT
      record.txt = parseTxt(buf.subarray(rdStart, rdEnd));
    }
    records.push(record);
    pos = rdEnd;
  }
  return records;
}

// ---------------------------------------------------------------- discovery

function localAddresses() {
  const out = new Set();
  for (const list of Object.values(os.networkInterfaces())) {
    for (const iface of list || []) {
      if (iface.family === 'IPv4' && !iface.internal) out.add(iface.address);
    }
  }
  return out;
}

/**
 * Browse mDNS for ADB services.
 * @param {object} [opts]
 * @param {number} [opts.timeoutMs=1500]
 * @param {string[]} [opts.services]
 * @returns {Promise<Array<{name:string,host:string,port:number,serial?:string,kind:'connect'|'pairing'}>>}
 */
export function discoverAdb(opts = {}) {
  const timeoutMs = opts.timeoutMs ?? 1500;
  const services = opts.services ?? ['_adb._tcp.local', '_adb-tls-connect._tcp.local', '_adb-tls-pairing._tcp.local'];

  return new Promise((resolve) => {
    let socket;
    try {
      socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    } catch {
      resolve([]);
      return;
    }

    const records = [];
    let done = false;
    let active = socket;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (retries) clearInterval(retries);
      try { active.close(); } catch {}
      resolve(assemble(records));
    };
    const timer = setTimeout(finish, timeoutMs);

    const onMessage = (msg) => {
      try { for (const rec of parsePacket(msg)) records.push(rec); } catch {}
    };
    const ask = (sock) => {
      try {
        sock.setMulticastTTL(255);
        sock.addMembership(MDNS_ADDR);
      } catch {}
      for (const svc of services) sock.send(buildQuery(svc, 12), MDNS_PORT, MDNS_ADDR, () => {});
    };

    // A single query is unreliable: Android's responder frequently drops the
    // first packet from an unknown source, so the same scan that works
    // standalone returns nothing when it runs inside a long-lived process.
    // Repeat the query on a short cadence and keep the socket open.
    let retries;
    const startAsking = (sock) => {
      ask(sock);
      let elapsed = 0;
      const step = 400;
      retries = setInterval(() => {
        elapsed += step;
        if (elapsed >= timeoutMs - 100) {
          clearInterval(retries);
          return;
        }
        ask(sock);
      }, step);
    };

    socket.on('error', () => {
      // 5353 taken and not shareable — retry once from an ephemeral port.
      if (done) return;
      try { socket.close(); } catch {}
      const retry = dgram.createSocket({ type: 'udp4' });
      active = retry;
      retry.on('error', finish);
      retry.on('message', onMessage);
      retry.bind(0, () => startAsking(retry));
    });
    socket.on('message', onMessage);
    // Android's mDNS responder only answers queries that originate from the
    // mDNS port itself, so bind 5353 (reuseAddr lets us share it with the OS).
    socket.bind(MDNS_PORT, () => startAsking(socket));
  });
}

function assemble(records) {
  const ptrs = records.filter((r) => r.type === 12);
  const srvs = records.filter((r) => r.type === 33);
  const addrs = new Map();
  for (const r of records) {
    if ((r.type === 1 || r.type === 28) && r.data) addrs.set(r.name.toLowerCase(), r.data);
  }
  const txts = new Map();
  for (const r of records) if (r.type === 16 && r.txt) txts.set(r.name.toLowerCase(), r.txt);

  const lan = localAddresses();
  const devices = [];
  const seen = new Set();

  for (const ptr of ptrs) {
    const instance = ptr.data;
    if (!instance) continue;
    const srv = srvs.find((s) => s.name.toLowerCase() === instance.toLowerCase());
    if (!srv) continue;
    const host = addrs.get(String(srv.target || '').toLowerCase());
    if (!host) continue;
    // Skip ourselves and loopback.
    if (lan.has(host) || host.startsWith('127.') || host === '0.0.0.0') continue;

    const txt = txts.get(instance.toLowerCase()) || {};
    const key = `${host}:${srv.port}`;
    if (seen.has(key)) continue;
    seen.add(key);

    const kind = /pairing/i.test(ptr.name || '') ? 'pairing' : 'connect';
    devices.push({
      name: txt.given_name || txt.name || instance.split('.').pop() || host,
      host,
      port: srv.port,
      serial: txt.serial,
      model: txt.name,
      kind,
      service: ptr.name,
    });
  }
  return devices;
}
MDNS_EOF

cat << 'BRIDGE_EOF' > "$INSTALL_DIR/wifi-bridge.mjs"
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync, execFile, execFileSync } from 'node:child_process';
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
  if (request.method === 'GET' && (request.url.startsWith('/discover') || request.url.startsWith('/probe') || request.url.startsWith('/devices') || request.url.startsWith('/pair'))) {
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
  response.writeHead(200, { 'content-type': 'text/plain' });
  response.end('webscrcpy wifi bridge\n');
}

function onUpgrade(request, socket, head) {
  const readExact = frameReader(socket, head);
  const origin = request.headers.origin || '';
  if (!allowedOrigin(origin)) {
    socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
    socket.destroy();
    return;
  }
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
BRIDGE_EOF

# Generate local SSL certs if needed
CERT_DIR="$INSTALL_DIR/wifi-bridge-certs"
mkdir -p "$CERT_DIR"
if [ ! -f "$CERT_DIR/cert.pem" ] || [ ! -f "$CERT_DIR/key.pem" ]; then
    echo "🔒 Generating local SSL certificate for WSS..."
    openssl req -x509 -newkey rsa:2048 -keyout "$CERT_DIR/key.pem" -out "$CERT_DIR/cert.pem" -days 3650 -nodes -subj "/CN=127.0.0.1" -addext "subjectAltName=IP:127.0.0.1,DNS:localhost" >/dev/null 2>&1 || true
fi

# Trust the certificate for this user. Without this, Chrome blocks the
# bridge's https://127.0.0.1:8766 endpoint on HTTPS sites ("Failed to fetch")
# even though the bridge is running, and the Nearby list stays empty.
if [ -f "$CERT_DIR/cert.pem" ]; then
    if security add-trusted-cert -r trustRoot -k "$HOME/Library/Keychains/login.keychain-db" "$CERT_DIR/cert.pem" >/dev/null 2>&1; then
        echo "🔒 Certificate trusted — the browser can now reach the helper."
    else
        echo "⚠️  Could not auto-trust the certificate. If Nearby stays empty, open"
        echo "   https://127.0.0.1:8766 once and click Advanced → Proceed."
    fi
fi

# Setup LaunchAgent background daemon
mkdir -p "$HOME/Library/LaunchAgents"
PLIST_PATH="$HOME/Library/LaunchAgents/com.webscrcpy.wifibridge.plist"

# Remove any other WebScrcpy bridge agents. Older installs used different
# labels (e.g. com.zulhilmi.webscrcpy-bridge); leaving them loaded means two
# bridges race for port 8765 at login and the stale one can win, serving an
# old copy of the code.
for stale in "$HOME"/Library/LaunchAgents/*webscrcpy*.plist; do
    [ -e "$stale" ] || continue
    [ "$stale" = "$PLIST_PATH" ] && continue
    case "$stale" in
        *webscrcpy-bridge.plist|*webscrcpy.wifibridge.plist|*webscrcpy*wifi*.plist)
            echo "🧹 Removing duplicate bridge agent: $(basename "$stale")"
            launchctl unload "$stale" 2>/dev/null || true
            rm -f "$stale"
            ;;
    esac
done

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

# Kill any existing bridge process and reload service. The old process must die
# before the new one binds 8765, otherwise the reload silently keeps serving the
# previous (possibly stale) code.
launchctl unload "$PLIST_PATH" 2>/dev/null || true
for pid in $(lsof -ti :8765 -ti :8766 2>/dev/null); do
    kill "$pid" 2>/dev/null || true
done
# Give the sockets a moment to be released before rebinding.
for _ in 1 2 3 4 5 6 7 8 9 10; do
    lsof -ti :8765 >/dev/null 2>&1 || break
    sleep 0.3
done
for pid in $(lsof -ti :8765 2>/dev/null); do
    kill -9 "$pid" 2>/dev/null || true
done
launchctl load -w "$PLIST_PATH"

# Confirm the new bridge actually answers before declaring success.
BRIDGE_OK=""
for _ in 1 2 3 4 5 6 7 8 9 10; do
    if curl -fsS --max-time 2 "http://127.0.0.1:8765/health" >/dev/null 2>&1 \
        || curl -fsS --max-time 2 "http://127.0.0.1:8765/devices" >/dev/null 2>&1; then
        BRIDGE_OK=1
        break
    fi
    sleep 0.5
done

echo ""
echo "=================================================="
if [ -n "$BRIDGE_OK" ]; then
    echo "🎉 WebScrcpy Wi-Fi Bridge is now actively running!"
    echo "It will automatically start whenever your Mac boots."
    echo "You can now return to WebScrcpy and connect wirelessly."
else
    echo "⚠️  The bridge was installed but is not answering on port 8765."
    echo "   Check the log: /tmp/webscrcpy-bridge.err"
    echo "   Try: launchctl unload ~/Library/LaunchAgents/com.webscrcpy.wifibridge.plist"
    echo "        launchctl load -w ~/Library/LaunchAgents/com.webscrcpy.wifibridge.plist"
fi
echo "=================================================="
