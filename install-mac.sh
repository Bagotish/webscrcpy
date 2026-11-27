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
  if (request.method === 'GET' && (request.url.startsWith('/discover') || request.url.startsWith('/probe') || request.url.startsWith('/devices') || request.url.startsWith('/pair') || request.url.startsWith('/screen') || request.url.startsWith('/share'))) {
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

  // ---------------------------------------------------------------- share
  // Clipboard/file exchange between this Mac and whatever opened the app
  // (phone over USB, another computer over Tailscale/LAN). Items live in
  // memory, capped, and expire after 24h so nothing lingers.
  if (request.url.startsWith('/share')) {
    return handleShare(request, response, replyJson);
  }

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

  // Serve the remaining assets the app's origin needs: the ADB/scrcpy module
  // bundle and the scrcpy server binary pushed to the phone. Without these the
  // page loads but every module import fails and no handler ever attaches.
  if (request.method === 'GET' && (request.url === '/tango-bundle.js' || request.url.startsWith('/tango-bundle.js?'))) {
    const bundlePath = path.join(path.dirname(fileURLToPath(import.meta.url)), 'tango-bundle.js');
    if (fs.existsSync(bundlePath)) {
      response.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'no-store' });
      response.end(fs.readFileSync(bundlePath));
      return;
    }
  }
  if (request.method === 'GET' && (request.url === '/scrcpy-server-v3.3.3' || request.url.startsWith('/scrcpy-server-v3.3.3?'))) {
    const serverPath = path.join(path.dirname(fileURLToPath(import.meta.url)), 'scrcpy-server-v3.3.3');
    if (fs.existsSync(serverPath)) {
      response.writeHead(200, { 'content-type': 'application/octet-stream', 'cache-control': 'no-store' });
      response.end(fs.readFileSync(serverPath));
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

// ---------------------------------------------------------------- share
// In-memory clipboard/file exchange. Text items are capped, files are streamed
// to disk under a size cap, everything expires after a day.
const SHARE_MAX_TEXT = 1 * 1024 * 1024;        // 1 MB of text per item
const SHARE_MAX_FILE = 500 * 1024 * 1024;      // 500 MB per file
const SHARE_MAX_TOTAL = 1024 * 1024 * 1024;    // 1 GB across everything
const SHARE_TTL_MS = 24 * 60 * 60 * 1000;      // expire after a day
const shareDir = fs.mkdtempSync(path.join(os.tmpdir(), 'webscrcpy-share-'));
const shareItems = new Map(); // id -> {kind, name, text?, file?, size, mime, at}
let shareSeq = 0;

function shareTotalBytes() {
  let total = 0;
  for (const item of shareItems.values()) total += item.size;
  return total;
}

function shareSweep() {
  const now = Date.now();
  for (const [id, item] of shareItems) {
    if (now - item.at > SHARE_TTL_MS) {
      if (item.file) fs.rm(item.file, { force: true }, () => {});
      shareItems.delete(id);
    }
  }
}

function handleShare(request, response, replyJson) {
  const url = new URL(request.url, 'http://localhost');
  const pathname = url.pathname;
  const method = request.method;

  // List everything currently shared.
  if (method === 'GET' && pathname === '/share') {
    shareSweep();
    replyJson(200, {
      ok: true,
      items: [...shareItems.entries()].map(([id, item]) => ({
        id, kind: item.kind, name: item.name, size: item.size,
        mime: item.mime, at: item.at,
      })),
    });
    return;
  }

  // Download: /share/<id> for files, /share/<id>/raw for raw text.
  const downloadMatch = pathname.match(/^\/share\/([a-z0-9]+)(\/raw)?$/);
  if (method === 'GET' && downloadMatch) {
    const [, id, raw] = downloadMatch;
    const item = shareItems.get(id);
    if (!item) {
      response.writeHead(404, { 'content-type': 'text/plain' });
      response.end('gone');
      return;
    }
    if (item.kind === 'text') {
      response.writeHead(200, {
        'content-type': 'text/plain; charset=utf-8',
        'cache-control': 'no-store',
      });
      response.end(item.text);
      return;
    }
    if (raw) {
      response.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
      response.end(item.text);
      return;
    }
    const stat = fs.statSync(item.file);
    response.writeHead(200, {
      'content-type': item.mime || 'application/octet-stream',
      'content-length': stat.size,
      'content-disposition': `attachment; filename="${encodeURIComponent(item.name)}"`,
      'cache-control': 'no-store',
    });
    fs.createReadStream(item.file).pipe(response);
    return;
  }

  // Upload text.
  if (method === 'POST' && pathname === '/share/text') {
    let body = '';
    request.on('data', (chunk) => {
      body += chunk;
      if (body.length > SHARE_MAX_TEXT) {
        replyJson(413, { ok: false, message: 'Text too large (1 MB max).' });
        request.destroy();
      }
    });
    request.on('end', () => {
      if (!request.readableEnded && request.destroyed) return;
      let parsed;
      try { parsed = JSON.parse(body || '{}'); } catch { parsed = {}; }
      const text = String(parsed.text ?? body ?? '');
      if (!text) { replyJson(400, { ok: false, message: 'Empty.' }); return; }
      const id = `t${++shareSeq}${Date.now().toString(36)}`;
      shareItems.set(id, {
        kind: 'text', name: parsed.name || 'text', text,
        size: Buffer.byteLength(text), mime: 'text/plain', at: Date.now(),
      });
      shareSweep();
      replyJson(200, { ok: true, id });
    });
    return;
  }

  // Upload a file (multipart not needed: the client sends raw bytes + query).
  if (method === 'POST' && pathname === '/share/file') {
    shareSweep();
    if (shareTotalBytes() > SHARE_MAX_TOTAL) {
      replyJson(507, { ok: false, message: 'Share storage full (1 GB). Remove old items.' });
      return;
    }
    const name = path.basename(url.searchParams.get('name') || 'file.bin');
    const id = `f${++shareSeq}${Date.now().toString(36)}`;
    const dest = path.join(shareDir, id);
    const out = fs.createWriteStream(dest);
    let size = 0;
    let aborted = false;
    request.on('data', (chunk) => {
      size += chunk.length;
      if (size > SHARE_MAX_FILE) {
        aborted = true;
        replyJson(413, { ok: false, message: 'File too large (500 MB max).' });
        out.destroy();
        fs.rm(dest, { force: true }, () => {});
        request.destroy();
      } else if (!out.destroyed && !out.write(chunk)) {
        request.pause();
        out.once('drain', () => request.resume());
      }
    });
    request.on('end', () => {
      if (aborted) return;
      out.end(() => {
        shareItems.set(id, {
          kind: 'file', name, file: dest, size,
          mime: url.searchParams.get('mime') || 'application/octet-stream',
          at: Date.now(),
        });
        replyJson(200, { ok: true, id, size });
      });
    });
    request.on('error', () => {
      out.destroy();
      fs.rm(dest, { force: true }, () => {});
    });
    return;
  }

  // Remove one item (frees storage without waiting for the TTL).
  if (method === 'DELETE' && pathname.startsWith('/share/')) {
    const id = pathname.slice('/share/'.length).split('/')[0];
    const item = shareItems.get(id);
    if (item?.file) fs.rm(item.file, { force: true }, () => {});
    shareItems.delete(id);
    replyJson(200, { ok: true });
    return;
  }

  response.writeHead(405, { 'content-type': 'text/plain' });
  response.end('method not allowed');
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
// Bind every interface: phones on the LAN and machines on Tailscale open the
// app straight at http://<mac-ip>:8765. Uploader-guarded endpoints
// (/discover, /probe, /pair, /screen, /share) still check Origin themselves.
server.listen(port, () => {
  console.log(`Wi-Fi bridge listening on http://0.0.0.0:${port}`);
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
  secure.listen(securePort, () => {
    console.log(`Wi-Fi bridge listening on https://0.0.0.0:${securePort}`);
  });
} else {
  console.log('No wifi-bridge-certs found, wss://127.0.0.1 is disabled (only ws://127.0.0.1:8765 is active).');
}
BRIDGE_EOF

cat << 'SECOND_SCREEN_PAGE_EOF' > "$INSTALL_DIR/second-screen.html"
<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no,viewport-fit=cover">
<meta name="theme-color" content="#09090b">
<title>WebScrcpy — Second Screen</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; -webkit-tap-highlight-color: transparent; }
  html, body {
    width: 100%; height: 100%; overflow: hidden; background: #000; color: #fafafa;
    font-family: -apple-system, BlinkMacSystemFont, "Helvetica Neue", Arial, sans-serif;
    overscroll-behavior: none; touch-action: none;
  }
  #stage { position: fixed; inset: 0; display: flex; align-items: center; justify-content: center; }
  #screen {
    display: block; width: 100%; height: 100%; object-fit: contain;
    background: #000; cursor: none;
  }
  #screen.hidden { display: none; }

  /* ---------------------------------------------------------------- overlay */
  #overlay {
    position: fixed; inset: 0; display: flex; flex-direction: column;
    align-items: center; justify-content: center; gap: 18px; padding: 32px;
    background: radial-gradient(circle at 50% 40%, #18181b 0%, #09090b 70%);
    text-align: center; z-index: 20;
  }
  #overlay.gone { display: none; }
  .logo { font-size: 13px; letter-spacing: .3em; text-transform: uppercase; color: #34d399; font-weight: 600; }
  h1 { font-size: 26px; font-weight: 700; line-height: 1.25; }
  h1 span { color: #34d399; }
  .hint { font-size: 14px; color: #a1a1aa; line-height: 1.6; max-width: 30em; }
  .field {
    display: flex; gap: 8px; width: 100%; max-width: 420px; margin-top: 6px;
  }
  input {
    flex: 1; min-width: 0; padding: 13px 15px; border-radius: 11px;
    background: #18181b; border: 1px solid #3f3f46; color: #fafafa;
    font-size: 15px; font-family: inherit; outline: none;
  }
  input:focus { border-color: #34d399; }
  button {
    padding: 13px 22px; border-radius: 11px; border: 0; font-size: 15px;
    font-weight: 600; font-family: inherit; background: #34d399; color: #052e1c;
    cursor: pointer; transition: filter .15s ease;
  }
  button:active { filter: brightness(.9); }
  button:disabled { opacity: .5; }
  button.ghost { background: #27272a; color: #e4e4e7; }
  #status { font-size: 13px; color: #71717a; min-height: 1.4em; }
  #status.err { color: #f87171; }
  #status.ok { color: #34d399; }
  #perms { font-size: 13px; line-height: 1.9; color: #a1a1aa; display: none; }
  #perms.show { display: block; }
  #perms .row { display: flex; align-items: center; gap: 8px; justify-content: center; }
  #perms .dot { width: 7px; height: 7px; border-radius: 50%; flex: none; }
  #perms .dot.ok { background: #34d399; }
  #perms .dot.bad { background: #f59e0b; }

  /* ---------------------------------------------------------------- toolbar */
  #toolbar {
    position: fixed; top: 0; left: 0; right: 0; z-index: 15;
    display: flex; align-items: center; gap: 8px; padding: 8px 12px;
    background: linear-gradient(#000c, #0000); transition: opacity .25s ease;
    padding-top: max(8px, env(safe-area-inset-top));
  }
  #toolbar.idle { opacity: 0; pointer-events: none; }
  #toolbar button {
    padding: 8px 14px; font-size: 13px; border-radius: 9px;
    background: #18181bcc; color: #e4e4e7; border: 1px solid #3f3f46;
    backdrop-filter: blur(10px);
  }
  #toolbar .spacer { flex: 1; }
  #stats { font-size: 11px; color: #a1a1aa; font-variant-numeric: tabular-nums; }
</style>
</head>
<body>

<div id="stage">
  <video id="screen" class="hidden" playsinline muted autoplay></video>
</div>

<div id="toolbar" class="idle">
  <button id="btnFull" type="button">⛶ Fullscreen</button>
  <span class="spacer"></span>
  <span id="stats"></span>
  <button id="btnStop" type="button">Stop</button>
</div>

<div id="overlay">
  <div class="logo">WebScrcpy</div>
  <h1>Use this device as a<br><span>second screen</span></h1>
  <p class="hint" id="hint">
    Connect this tablet to your Mac with a USB cable, then open this page on it.
  </p>
  <div class="field">
    <input id="url" type="url" spellcheck="false" autocapitalize="off"
           placeholder="http://127.0.0.1:8765">
    <button id="btnStart" type="button">Start</button>
  </div>
  <div id="status"></div>
  <div id="perms"></div>
</div>

<script>
(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const video = $('screen');
  const overlay = $('overlay');
  const toolbar = $('toolbar');
  const statusEl = $('status');
  const statsEl = $('stats');
  const urlInput = $('url');

  let inputSocket = null;
  let started = false;
  let idleTimer = null;
  let lastTouchAt = 0;

  // With adb reverse, 127.0.0.1:8765 on the tablet is the Mac's bridge.
  const defaultBase = `${location.protocol}//${location.hostname || '127.0.0.1'}${location.port ? ':' + location.port : ':8765'}`;
  urlInput.value = localStorage.getItem('webscrcpy.screenBase') || defaultBase;

  const setStatus = (text, kind = '') => {
    statusEl.textContent = text;
    statusEl.className = kind;
  };

  // ------------------------------------------------------------ MediaSource
  // The bridge sends fragmented MP4, which MSE plays as it arrives. This is
  // what keeps latency low compared with a plain <video src> download.
  function supportsMse() {
    return typeof MediaSource !== 'undefined'
      && MediaSource.isTypeSupported('video/mp4; codecs="avc1.640028"');
  }

  // Network chunks split MP4 boxes at arbitrary offsets. appendBuffer rejects a
  // partial box ("Failed to execute 'appendBuffer'"), which made roughly half
  // of the streams start black. This accumulates bytes and emits whole
  // fragments, each starting at a moof box.
  function createBoxSplitter() {
    let buffer = new Uint8Array(0);

    const readUint32 = (bytes, offset) =>
      ((bytes[offset] << 24) >>> 0) + (bytes[offset + 1] << 16)
      + (bytes[offset + 2] << 8) + bytes[offset + 3];

    return function push(chunk) {
      const merged = new Uint8Array(buffer.length + chunk.length);
      merged.set(buffer, 0);
      merged.set(chunk, buffer.length);
      buffer = merged;

      // Locate complete box boundaries first.
      const boxes = [];
      let offset = 0;
      for (;;) {
        if (buffer.length - offset < 8) break;
        let size = readUint32(buffer, offset);
        let headerSize = 8;
        if (size === 1) {
          if (buffer.length - offset < 16) break;
          size = Number(readUint32(buffer, offset + 8)) * 4294967296
            + readUint32(buffer, offset + 12);
          headerSize = 16;
        } else if (size === 0) {
          break; // runs to end of stream; unknown boundary
        }
        if (size < headerSize || buffer.length - offset < size) break;
        boxes.push({
          type: String.fromCharCode(
            buffer[offset + 4], buffer[offset + 5],
            buffer[offset + 6], buffer[offset + 7]),
          bytes: buffer.subarray(offset, offset + size),
        });
        offset += size;
      }
      buffer = buffer.subarray(offset);

      // A fragment is one moof plus everything up to the next moof. Anything
      // before the first moof (ftyp + moov) is the init segment: it must be
      // appended too, or the decoder never learns the track layout and the
      // video stays black.
      const segments = [];
      let current = [];
      for (const box of boxes) {
        if (box.type === 'moof' && current.length) {
          segments.push(concat(current));
          current = [];
        }
        current.push(box.bytes);
      }
      if (current.length) {
        const tail = current[current.length - 1];
        const tailType = String.fromCharCode(tail[4], tail[5], tail[6], tail[7]);
        const hasMoof = current.some((b) => b.length > 8
          && String.fromCharCode(b[4], b[5], b[6], b[7]) === 'moof');
        // Emit a finished fragment, or the complete init segment on its own.
        if (tailType === 'mdat' || !hasMoof) {
          segments.push(concat(current));
        } else {
          // Still mid-fragment: carry these boxes into the next chunk.
          buffer = concat([...current, buffer]);
        }
      }
      return segments;
    };
  }

  function concat(parts) {
    const total = parts.reduce((sum, part) => sum + part.length, 0);
    const out = new Uint8Array(total);
    let at = 0;
    for (const part of parts) {
      out.set(part, at);
      at += part.length;
    }
    return out;
  }

  function playWithMse(base) {
    return new Promise((resolve, reject) => {
      const ms = new MediaSource();
      const objectUrl = URL.createObjectURL(ms);
      video.src = objectUrl;

      ms.addEventListener('sourceopen', async () => {
        let sourceBuffer;
        try {
          sourceBuffer = ms.addSourceBuffer('video/mp4; codecs="avc1.640028"');
        } catch (err) {
          reject(new Error('This browser cannot decode the stream.'));
          return;
        }

        // Keep the buffer short so playback stays near live.
        const TRIM_AT = 6;
        const TRIM_TO = 2;
        const trim = () => {
          if (sourceBuffer.updating || ms.readyState !== 'open') return;
          const buffered = sourceBuffer.buffered;
          if (!buffered.length) return;
          const start = buffered.start(0);
          const end = buffered.end(buffered.length - 1);
          if (end - start > TRIM_AT) {
            try { sourceBuffer.remove(start, start + (end - start - TRIM_TO)); } catch {}
          }
          // Follow the live edge.
          if (video.currentTime < end - 1.2) {
            video.currentTime = end - 0.4;
          }
        };
        sourceBuffer.addEventListener('updateend', trim);

        const queue = [];
        const pump = () => {
          if (sourceBuffer.updating || !queue.length) return;
          try {
            sourceBuffer.appendBuffer(queue.shift());
          } catch (err) {
            reject(new Error('Stream buffer failed.'));
          }
        };
        sourceBuffer.addEventListener('updateend', pump);

        try {
          const res = await fetch(`${base}/screen?fps=30&width=1920&bitrate=8M`, { cache: 'no-store' });
          if (!res.ok) throw new Error(`Bridge returned ${res.status}`);
          const reader = res.body.getReader();
          const push = createBoxSplitter();
          resolve();
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            for (const segment of push(value)) queue.push(segment);
            pump();
          }
        } catch (err) {
          reject(err);
        }
      }, { once: true });
    });
  }

  // Fallback for browsers without MSE: let the video element download it.
  function playDirect(base) {
    video.src = `${base}/screen?fps=30&width=1920&bitrate=8M`;
    video.play().catch(() => {});
    return Promise.resolve();
  }

  // ------------------------------------------------------------ input
  function openInput(base) {
    const wsBase = base.replace(/^http/, 'ws');
    try {
      inputSocket = new WebSocket(`${wsBase}/screen-input`);
    } catch { return; }
    inputSocket.addEventListener('open', () => {
      setStatus('Connected', 'ok');
    });
    inputSocket.addEventListener('close', () => { inputSocket = null; });
    inputSocket.addEventListener('error', () => { inputSocket = null; });
  }

  function send(command) {
    if (inputSocket && inputSocket.readyState === WebSocket.OPEN) {
      inputSocket.send(JSON.stringify(command));
    }
  }

  // Map a pointer position on the video to normalized screen coordinates.
  function toScreen(event) {
    const rect = video.getBoundingClientRect();
    const vw = video.videoWidth || 16;
    const vh = video.videoHeight || 9;
    const scale = Math.min(rect.width / vw, rect.height / vh);
    const dw = vw * scale;
    const dh = vh * scale;
    const left = rect.left + (rect.width - dw) / 2;
    const top = rect.top + (rect.height - dh) / 2;
    const x = (event.clientX - left) / dw;
    const y = (event.clientY - top) / dh;
    return {
      x: Math.min(Math.max(x, 0), 1),
      y: Math.min(Math.max(y, 0), 1),
      inside: x >= 0 && x <= 1 && y >= 0 && y <= 1,
    };
  }

  video.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    const p = toScreen(e);
    if (!p.inside) return;
    video.setPointerCapture?.(e.pointerId);
    send({ type: 'down', x: p.x, y: p.y, button: e.button === 2 ? 'right' : 'left' });
  });

  video.addEventListener('pointermove', (e) => {
    const p = toScreen(e);
    if (!p.inside) return;
    send({ type: 'move', x: p.x, y: p.y });
  });

  video.addEventListener('pointerup', (e) => {
    const p = toScreen(e);
    send({ type: 'up', x: p.x, y: p.y, button: e.button === 2 ? 'right' : 'left' });
  });

  video.addEventListener('wheel', (e) => {
    e.preventDefault();
    send({ type: 'scroll', dy: e.deltaY > 0 ? -1 : 1 });
  }, { passive: false });

  video.addEventListener('contextmenu', (e) => e.preventDefault());

  // Keyboard: forward printable keys and common control keys.
  const SPECIAL = {
    Enter: 36, Escape: 53, Backspace: 51, Tab: 48, ' ': 49,
    ArrowLeft: 123, ArrowRight: 124, ArrowDown: 125, ArrowUp: 126,
    Delete: 117, Home: 115, End: 119, PageUp: 116, PageDown: 121,
  };
  document.addEventListener('keydown', (e) => {
    if (!started) return;
    const code = SPECIAL[e.key];
    if (code !== undefined) {
      e.preventDefault();
      send({ type: 'key', code });
    } else if (e.key.length === 1 && !e.metaKey && !e.ctrlKey) {
      send({ type: 'text', text: e.key });
    }
  });

  // ------------------------------------------------------------ chrome
  function showToolbar() {
    toolbar.classList.remove('idle');
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => toolbar.classList.add('idle'), 2600);
  }

  ['pointermove', 'pointerdown', 'keydown'].forEach((name) => {
    document.addEventListener(name, showToolbar, { passive: true });
  });

  $('btnFull').addEventListener('click', async () => {
    try {
      if (document.fullscreenElement) await document.exitFullscreen();
      else await document.documentElement.requestFullscreen();
    } catch {}
  });

  $('btnStop').addEventListener('click', () => {
    location.reload();
  });

  // ------------------------------------------------------------ start
  // Show which macOS permissions are still missing, before the user starts.
  async function showPermissions(base) {
    const perms = $('perms');
    try {
      const res = await fetch(`${base}/screen/permissions`, { cache: 'no-store' });
      if (!res.ok) return;
      const info = await res.json();
      const rows = [
        ['Screen Recording', info.screenRecording],
        ['Accessibility', info.accessibility],
      ];
      perms.innerHTML = rows.map(([name, ok]) =>
        `<div class="row"><span class="dot ${ok ? 'ok' : 'bad'}"></span>` +
        `${name}${ok ? '' : ' — needs approval on the Mac'}</div>`).join('');
      perms.classList.add('show');
      if (!info.accessibility) {
        setStatus('Enable Accessibility on your Mac to control it from here.', 'err');
      }
    } catch {}
  }

  async function start() {
    const base = urlInput.value.trim().replace(/\/$/, '');
    if (!base) { setStatus('Enter the bridge address.', 'err'); return; }
    localStorage.setItem('webscrcpy.screenBase', base);

    $('btnStart').disabled = true;
    setStatus('Connecting…');

    try {
      // Fail fast with a useful message if the bridge is not reachable.
      const health = await fetch(`${base}/devices`, { cache: 'no-store' })
        .catch(() => null);
      if (!health) throw new Error(
        'Cannot reach the bridge. Is the cable connected and the helper running?');

      openInput(base);
      if (supportsMse()) await playWithMse(base);
      else await playDirect(base);

      video.classList.remove('hidden');
      overlay.classList.add('gone');
      started = true;
      await video.play().catch(() => {});
      setStatus('Connected', 'ok');
      showToolbar();
      // Best effort fullscreen (needs a user gesture; the click above counts).
      document.documentElement.requestFullscreen?.().catch(() => {});
    } catch (err) {
      $('btnStart').disabled = false;
      setStatus(err.message || 'Could not start the stream.', 'err');
    }
  }

  $('btnStart').addEventListener('click', start);
  urlInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') start(); });

  // Check permissions on load so the user knows before tapping Start.
  showPermissions(urlInput.value.trim().replace(/\/$/, ''));

  // ------------------------------------------------------------ stats
  setInterval(() => {
    if (!started) return;
    const v = video;
    const buffered = v.buffered.length ? v.buffered.end(v.buffered.length - 1) : 0;
    const lag = buffered ? Math.max(0, buffered - v.currentTime) : 0;
    const fps = v.getVideoPlaybackQuality?.().totalVideoFrames || 0;
    statsEl.textContent = `${fps}f · ${lag.toFixed(1)}s buffer`;
  }, 1000);
})();
</script>
</body>
</html>
SECOND_SCREEN_PAGE_EOF

cat << 'SECOND_SCREEN_STREAM_EOF' > "$INSTALL_DIR/second-screen-stream.py"
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
SECOND_SCREEN_STREAM_EOF

cat << 'SECOND_SCREEN_INPUT_EOF' > "$INSTALL_DIR/second-screen-input.py"
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
SECOND_SCREEN_INPUT_EOF

# The bridge spawns these helpers directly, so they must be executable.
chmod +x "$INSTALL_DIR/second-screen-stream.py" "$INSTALL_DIR/second-screen-input.py" 2>/dev/null || true

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
