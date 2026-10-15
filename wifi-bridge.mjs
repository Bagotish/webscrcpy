import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const port = Number(process.env.WIFI_BRIDGE_PORT || 8765);
const securePort = Number(process.env.WIFI_BRIDGE_TLS_PORT || 8766);
const certDir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'wifi-bridge-certs');

function allowedOrigin(origin) {
  if (!origin) return false;
  let url;
  try { url = new URL(origin); } catch { return false; }
  const local = url.hostname === 'localhost' || url.hostname === '127.0.0.1';
  if (url.protocol === 'http:' && local) return true;
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

function onRequest(request, response) {
  const origin = request.headers.origin || '';
  if (request.method === 'OPTIONS') {
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
        sendFrame(socket, 0x1, JSON.stringify({ type: 'error', message: 'Guna IP tempatan telefon, contoh 192.168.1.10.' }));
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
          ? `Tidak dapat hubungi ${host}:${remotePort}. timed out`
          : `Tidak dapat hubungi ${host}:${remotePort}. ${err?.message || 'gagal'}`;
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

const certFile = path.join(certDir, 'cert.pem');
const keyFile = path.join(certDir, 'key.pem');
if (fs.existsSync(certFile) && fs.existsSync(keyFile)) {
  const secure = https.createServer({
    cert: fs.readFileSync(certFile),
    key: fs.readFileSync(keyFile),
  }, onRequest);
  secure.on('upgrade', onUpgrade);
  secure.listen(securePort, '127.0.0.1', () => {
    console.log(`Wi-Fi bridge listening on wss://127.0.0.1:${securePort}`);
  });
} else {
  console.log('No wifi-bridge-certs yet, so https://webscrcpy.vercel.app cannot use Wi-Fi.');
}
