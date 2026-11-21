#!/usr/bin/env node
/**
 * Record a real browser session of WebScrcpy with Chrome DevTools Protocol.
 *
 * Launches headless Chrome with remote debugging, drives the UI like a user
 * would (move, click, type, scroll) and captures every frame as a JPEG. The
 * frames are later stitched into an MP4 by compose-site-video.sh.
 *
 *   node record-site.mjs <url> <outDir> [--width=1440] [--height=900]
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PORT = 9333;

const url = process.argv[2] || 'https://webscrcpy.vercel.app/';
const outDir = process.argv[3] || 'frames';
const argOf = (name, fallback) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.split('=')[1] : fallback;
};
const WIDTH = Number(argOf('width', 1440));
const HEIGHT = Number(argOf('height', 900));
const FPS = Number(argOf('fps', 20));

fs.rmSync(outDir, { recursive: true, force: true });
fs.mkdirSync(outDir, { recursive: true });

const profile = fs.mkdtempSync('/tmp/wsrec-');
const chrome = spawn(CHROME, [
  '--headless=new',
  `--remote-debugging-port=${PORT}`,
  `--window-size=${WIDTH},${HEIGHT}`,
  '--hide-scrollbars',
  '--disable-gpu',
  '--no-first-run',
  '--no-default-browser-check',
  '--disable-extensions',
  '--disable-dev-shm-usage',
  '--force-device-scale-factor=1',
  // Headless Chrome enforces Private Network Access, which blocks the page's
  // fetches to the loopback bridge (the real browser shows a permission
  // prompt; headless has none). Lift it so the Nearby list works on camera.
  '--enable-features=LocalNetworkAccess',
  '--disable-features=PrivateNetworkAccessRestrictions,BlockInsecurePrivateNetworkRequests',
  `--user-data-dir=${profile}`,
  'about:blank',
], { stdio: 'ignore' });

// If Chrome exits early the CDP socket hangs forever; fail fast instead.
chrome.on('exit', (code) => {
  console.error(`chrome exited early (code ${code})`);
  process.exit(2);
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getTarget() {
  for (let i = 0; i < 100; i += 1) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/json/list`);
      const list = await res.json();
      const page = list.find((t) => t.type === 'page');
      if (page?.webSocketDebuggerUrl) return page.webSocketDebuggerUrl;
    } catch {}
    await sleep(150);
  }
  throw new Error('Chrome did not expose a debugging target');
}

let id = 0;
function connect(wsUrl) {
  const ws = new WebSocket(wsUrl);
  const pending = new Map();
  const events = new Map();
  const ready = new Promise((resolve, reject) => {
    ws.addEventListener('open', () => resolve());
    ws.addEventListener('error', reject);
  });
  ws.addEventListener('message', (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) reject(new Error(msg.error.message));
      else resolve(msg.result);
      return;
    }
    const list = events.get(msg.method);
    if (list) for (const fn of list) fn(msg.params);
  });
  return {
    ready,
    send(method, params = {}) {
      const msgId = (id += 1);
      ws.send(JSON.stringify({ id: msgId, method, params }));
      return new Promise((resolve, reject) => pending.set(msgId, { resolve, reject }));
    },
    on(method, fn) {
      if (!events.has(method)) events.set(method, []);
      events.get(method).push(fn);
    },
    close() { try { ws.close(); } catch {} },
  };
}

const cdp = connect(await getTarget());
await cdp.ready;
await cdp.send('Page.enable');
await cdp.send('Runtime.enable');
await cdp.send('Emulation.setDeviceMetricsOverride', {
  width: WIDTH, height: HEIGHT, deviceScaleFactor: 1, mobile: false,
});

// ---------------------------------------------------------------- frame capture
// Use Chrome's screencast: the renderer pushes a frame only when the page
// actually changes, and Chrome coalesces bursts. Polling captureScreenshot at
// 20fps killed the renderer after ~60 frames, so that approach is gone.
let frameIndex = 0;
let capturing = false;
const frameTimes = [];

function writeFrame(base64) {
  const name = `${String(frameIndex).padStart(5, '0')}.jpg`;
  fs.writeFileSync(path.join(outDir, name), Buffer.from(base64, 'base64'));
  frameTimes.push(Date.now());
  frameIndex += 1;
}

async function startScreencast() {
  cdp.on('Page.screencastFrame', async (params) => {
    if (capturing) writeFrame(params.data);
    try {
      await cdp.send('Page.screencastFrameAck', { sessionId: params.sessionId });
    } catch {}
  });
  await cdp.send('Page.startScreencast', {
    format: 'jpeg',
    quality: 78,
    maxWidth: WIDTH,
    maxHeight: HEIGHT,
    everyNthFrame: 1,
  });
  capturing = true;

  // Screencast only emits when pixels change. During a hold (no motion) the
  // recording would freeze, so nudge a 1px transparent element to force a
  // frame at the target rate. This is invisible on camera.
  await cdp.send('Runtime.evaluate', {
    expression: `
      (() => {
        if (document.getElementById('__recTicker')) return;
        const t = document.createElement('div');
        t.id = '__recTicker';
        t.style.cssText = 'position:fixed;left:0;top:0;width:1px;height:1px;opacity:.01;pointer-events:none;z-index:2147483647;background:#000;';
        document.body.appendChild(t);
        let n = 0;
        setInterval(() => { n = (n + 1) % 2; t.style.transform = 'translateY(' + n + 'px)'; }, ${Math.max(30, Math.floor(1000 / FPS))});
      })();
    `,
  }).catch(() => {});
}

// ---------------------------------------------------------------- input helpers
const mouse = { x: WIDTH / 2, y: HEIGHT / 2 };

async function moveTo(x, y, steps = 14, delay = 16) {
  const x0 = mouse.x;
  const y0 = mouse.y;
  for (let i = 1; i <= steps; i += 1) {
    const t = i / steps;
    // ease-in-out for a human-looking pointer
    const e = t < 0.5 ? 2 * t * t : 1 - ((-2 * t + 2) ** 2) / 2;
    const nx = x0 + (x - x0) * e;
    const ny = y0 + (y - y0) * e;
    await cdp.send('Input.dispatchMouseEvent', {
      type: 'mouseMoved', x: nx, y: ny, button: 'none', buttons: 0,
    });
    await cdp.send('Runtime.evaluate', {
      expression: `window.__rec && window.__rec.move(${nx}, ${ny})`,
    }).catch(() => {});
    await sleep(delay);
  }
  mouse.x = x;
  mouse.y = y;
}

async function click(x, y, hold = 70) {
  await moveTo(x, y);
  await cdp.send('Runtime.evaluate', { expression: 'window.__rec && window.__rec.down()' }).catch(() => {});
  await cdp.send('Input.dispatchMouseEvent', {
    type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1,
  });
  await cdp.send('Runtime.evaluate', {
    expression: `window.__rec && window.__rec.ripple(${x}, ${y})`,
  }).catch(() => {});
  await sleep(hold);
  await cdp.send('Input.dispatchMouseEvent', {
    type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: 1,
  });
  await cdp.send('Runtime.evaluate', { expression: 'window.__rec && window.__rec.up()' }).catch(() => {});
  await sleep(120);
}

async function typeText(text, perChar = 55) {
  for (const ch of text) {
    await cdp.send('Input.insertText', { text: ch });
    await sleep(perChar);
  }
}

async function scroll(y, deltaY) {
  await cdp.send('Input.dispatchMouseEvent', {
    type: 'mouseWheel', x: WIDTH / 2, y, deltaX: 0, deltaY,
  });
  await sleep(220);
}

const evaluate = async (expression) => {
  const res = await cdp.send('Runtime.evaluate', {
    expression, returnByValue: true, awaitPromise: true,
  });
  if (res.exceptionDetails) throw new Error(res.exceptionDetails.text);
  return res.result.value;
};

async function rectOf(selector) {
  return evaluate(`(() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    if (!el) return null;
    const r = el.getBoundingClientRect();
    if (!r.width || !r.height) return null;
    return { x: r.x + r.width / 2, y: r.y + r.height / 2, w: r.width, h: r.height };
  })()`);
}

async function clickSelector(selector, label) {
  const r = await rectOf(selector);
  if (!r) { console.log(`  skip (not visible): ${label || selector}`); return false; }
  await click(r.x, r.y);
  return true;
}

// Highlight a control for a beat so the viewer knows what to look at.
async function highlight(selector, hold = 900) {
  const r = await rectOf(selector);
  if (!r) return null;
  await evaluate(`window.__rec && window.__rec.highlight(${r.x - r.w / 2}, ${r.y - r.h / 2}, ${r.w}, ${r.h})`);
  if (hold) await sleep(hold);
  return r;
}

async function clearHighlight() {
  await evaluate('window.__rec && window.__rec.clearHighlight()').catch(() => {});
}

// ---------------------------------------------------------------- overlay
// A real screen recording has a visible pointer; headless Chrome's captured
// frames do not. Inject a cursor, click ripples and a highlight ring so the
// viewer can follow the action.
const OVERLAY_JS = `
(() => {
  if (document.getElementById('__recOverlay')) return;
  const style = document.createElement('style');
  style.textContent = \`
    #__recCursor, #__recRing, #__recOverlay { pointer-events: none !important; }
    #__recOverlay { position: fixed; inset: 0; z-index: 2147483647; }
    #__recCursor {
      position: fixed; left: 0; top: 0; width: 26px; height: 26px;
      transform: translate(-50%, -50%); z-index: 2147483647;
      transition: width .08s ease, height .08s ease;
    }
    #__recCursor svg { width: 100%; height: 100%; filter: drop-shadow(0 2px 4px rgba(0,0,0,.55)); }
    #__recRipple {
      position: fixed; z-index: 2147483646; border-radius: 999px;
      border: 3px solid #34d399; background: rgba(52,211,153,.28);
      transform: translate(-50%, -50%) scale(.25); opacity: 0;
    }
    #__recRipple.go { animation: __recRip .62s cubic-bezier(.2,.7,.3,1) forwards; }
    @keyframes __recRip {
      0%   { opacity: .95; transform: translate(-50%,-50%) scale(.3); }
      70%  { opacity: .5;  transform: translate(-50%,-50%) scale(1.9); }
      100% { opacity: 0;   transform: translate(-50%,-50%) scale(2.5); }
    }
    #__recRing {
      position: fixed; z-index: 2147483645; border-radius: 14px;
      border: 3px solid #34d399; box-shadow: 0 0 0 4px rgba(52,211,153,.22);
      opacity: 0; transition: opacity .18s ease, transform .18s ease;
      transform: scale(.985);
    }
    #__recRing.show { opacity: 1; transform: scale(1); }
  \`;
  document.documentElement.appendChild(style);

  const layer = document.createElement('div');
  layer.id = '__recOverlay';
  const cursor = document.createElement('div');
  cursor.id = '__recCursor';
  cursor.innerHTML = '<svg viewBox="0 0 24 24"><path d="M4 2.2 20.2 12 12.6 13.4 9.2 21.4Z" fill="#fff" stroke="#111" stroke-width="1.5" stroke-linejoin="round"/></svg>';
  const ripple = document.createElement('div');
  ripple.id = '__recRipple';
  const ring = document.createElement('div');
  ring.id = '__recRing';
  layer.append(ring, ripple, cursor);
  document.body.appendChild(layer);

  window.__rec = {
    move(x, y) { cursor.style.left = x + 'px'; cursor.style.top = y + 'px'; },
    down() { cursor.style.width = '21px'; cursor.style.height = '21px'; },
    up() { cursor.style.width = '26px'; cursor.style.height = '26px'; },
    ripple(x, y) {
      ripple.style.left = x + 'px'; ripple.style.top = y + 'px';
      ripple.classList.remove('go');
      void ripple.offsetWidth;
      ripple.classList.add('go');
    },
    highlight(x, y, w, h) {
      ring.style.left = (x - 6) + 'px'; ring.style.top = (y - 6) + 'px';
      ring.style.width = (w + 12) + 'px'; ring.style.height = (h + 12) + 'px';
      ring.classList.add('show');
    },
    clearHighlight() { ring.classList.remove('show'); },
  };
})();
`;

async function injectOverlay() {
  await cdp.send('Runtime.evaluate', { expression: OVERLAY_JS });
}

const timeline = [];
const mark = (label) => timeline.push({ t: (Date.now() - startedAt) / 1000, label });
const startedAt = Date.now();
const log = (...a) => console.log('•', ...a);


await cdp.send('Page.navigate', { url });
await sleep(1400);
await injectOverlay();
mark('intro');
await startScreencast();

log('hold on the landing page');
await evaluate('window.__rec && window.__rec.move(' + (WIDTH * 0.5) + ',' + (HEIGHT * 0.42) + ')');
await sleep(1800);

log('highlight Connect');
mark('connect');
await highlight('#btnWebUsbConnect', 1100);

log('click Connect');
await clickSelector('#btnWebUsbConnect', 'Connect button');
await clearHighlight();
await sleep(2400);

// Let discovery populate the Nearby list, then highlight and hover it.
mark('nearby');
const nearby = await evaluate(`(() => {
  const list = document.getElementById('wifiList');
  if (!list) return null;
  const rows = [...list.children];
  const idx = rows.findIndex((r) => /Nearby/i.test(r.textContent));
  if (idx === -1) return null;
  const el = rows[idx + 1] || rows[idx];
  const r = el.getBoundingClientRect();
  return { x: r.x + r.width / 2, y: r.y + r.height / 2, top: r.top, left: r.left, w: r.width, h: r.height };
})()`);
if (nearby) {
  log('hover the discovered phone');
  await evaluate(`window.__rec && window.__rec.highlight(${nearby.left}, ${nearby.top}, ${nearby.w}, ${nearby.h})`);
  await moveTo(nearby.x, nearby.y, 24, 20);
  await sleep(1900);
} else {
  log('no Nearby row (phone not advertising) — holding on the panel');
  await sleep(1400);
}

log('click the phone');
mark('tap');
if (nearby) {
  await click(nearby.x, nearby.y);
} else {
  await clickSelector('#wifiList > div', 'first list row');
}
await clearHighlight();
await sleep(4600);

log('hold on the connection state');
mark('allow');
await moveTo(WIDTH * 0.5, HEIGHT * 0.55, 16, 22);
await sleep(2600);

log('open the Wi-Fi setup panel');
mark('setup');
await clickSelector('#btnCloseDevices', 'close devices');
await sleep(500);
await highlight('#btnDownloadHelper', 900);
await clickSelector('#btnDownloadHelper', 'Wi-Fi setup');
await clearHighlight();
await sleep(1800);
const tabWin = await rectOf('#tabWin');
if (tabWin) {
  log('switch to the Windows tab');
  await evaluate(`window.__rec && window.__rec.highlight(${tabWin.x - tabWin.w / 2}, ${tabWin.y - tabWin.h / 2}, ${tabWin.w}, ${tabWin.h})`);
  await sleep(700);
  await click(tabWin.x, tabWin.y);
  await clearHighlight();
  await sleep(1600);
  const tabMac = await rectOf('#tabMac');
  if (tabMac) { await click(tabMac.x, tabMac.y); await sleep(1300); }
}
await clickSelector('#btnCloseDownload', 'close setup');
await sleep(900);

log('open the changelog');
mark('changelog');
await highlight('#btnChangelog', 700);
await clickSelector('#btnChangelog', 'changelog');
await clearHighlight();
await sleep(2200);
await clickSelector('#btnCloseChangelog', 'close changelog');
await sleep(700);

log('settle on the main view');
mark('outro');
await evaluate('window.__rec && window.__rec.move(' + (WIDTH * 0.5) + ',' + (HEIGHT * 0.4) + ')');
await sleep(2400);

capturing = false;
await cdp.send('Page.stopScreencast').catch(() => {});
await sleep(200);

const total = (Date.now() - startedAt) / 1000;
fs.writeFileSync(
  path.join(path.dirname(outDir), 'timeline.json'),
  JSON.stringify({ total, fps: FPS, width: WIDTH, height: HEIGHT, marks: timeline }, null, 2),
);
console.log(`frames: ${frameIndex}  duration: ${total.toFixed(1)}s`);
cdp.close();
chrome.kill();
await sleep(300);
fs.rmSync(profile, { recursive: true, force: true });
