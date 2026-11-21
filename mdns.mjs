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
