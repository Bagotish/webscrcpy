import {
      Adb,
      AdbDaemonTransport,
      AdbDaemonWebUsbDeviceManager,
      AdbDaemonWebUsbDevice,
      AdbWebCredentialStore,
      AdbScrcpyClient,
      AdbScrcpyOptionsLatest,
      DefaultServerPath,
      AndroidMotionEventAction,
      AndroidMotionEventButton,
      AndroidKeyEventAction,
      AndroidScreenPowerMode,
      ScrcpyPointerId,
      WebCodecsVideoDecoder,
      WebGLVideoFrameRenderer,
      BitmapVideoFrameRenderer,
    } from './tango-bundle.js';

    // Must match the scrcpy version the bundled @yume-chan/adb-scrcpy targets (3.3.3).
    const SERVER_FILE = './scrcpy-server-v3.3.3';
    const MAX_SIZE = { '1080p': 2400, '720p': 1600, '480p': 1040 };
    const KEY_MAP = {
      Enter: 66, Backspace: 67, Delete: 112, Tab: 61, Escape: 4,
      ArrowUp: 19, ArrowDown: 20, ArrowLeft: 21, ArrowRight: 22,
    };

    const state = {
      adb: null,
      client: null,
      decoder: null,
      connecting: false,
      link: null,
      usbDevice: null,
      wifiHost: null,
      wifiSerial: null,
      wifiPhones: [],
      wifiHandoff: false,
      wifiError: '',
      resolution: '1080p',
      bitrate: 8,
      fps: 60,
      lastFrames: 0,
      displayMode: 'mirror',
      viewMode: 'mirror',
      hasDex: false,
      oneUi: 0,
    };
    let mirrorRestarting = false;

    const credentialStore = new AdbWebCredentialStore('Tango WebScrcpy');

    const btnWebUsbConnect = document.getElementById('btnWebUsbConnect');
    const termOutput = document.getElementById('termOutput');
    const termForm = document.getElementById('termForm');
    const termInput = document.getElementById('termInput');
    const idleView = document.getElementById('idleView');
    const statusDot = document.getElementById('statusDot');
    const settingsPanel = document.getElementById('settingsPanel');
    const btnSettings = document.getElementById('btnSettings');
    const btnPip = document.getElementById('btnPip');
    const btnFullscreen = document.getElementById('btnFullscreen');
    let pipWindow = null;
    let pipStream = null;
    let pipCaptureCanvas = null;
    let pipSizeKey = '';
    let pipMinimized = false;
    let pipRestoreSize = null;
    let pipPreferredSize = null;
    let pipGeneration = 0;
    let pipClosedMinimized = false;
    let pipAspectTimer = null;
    let pipBezelSize = null;
    let pipSettledSize = null;
    let pipTrimFromUs = false;
    let pipBrightness = 100;
    let fitScreen = false;
    let pipFill = false;
    let pipDockOpen = false;
    let pipDockTimer = null;
    const PIP_DOCK = { width: 340, height: 60 };
    // Chrome refuses a document PiP window narrower than 240 or shorter than 52.
    const PIP_DOCK_DOT = { width: 240, height: 52 };
    const devicePanel = document.getElementById('devicePanel');
    const deviceList = document.getElementById('deviceList');
    const downloadPanel = document.getElementById('downloadPanel');
    const btnDownloadHelper = document.getElementById('btnDownloadHelper');
    const changelogPanel = document.getElementById('changelogPanel');
    const btnChangelog = document.getElementById('btnChangelog');
    const txtDeviceName = document.getElementById('txtDeviceName');
    const badgeFps = document.getElementById('badgeFps');
    const badgeRes = document.getElementById('badgeRes');
    const chkStayAwake = document.getElementById('chkStayAwake');
    const chkTurnOffScreen = document.getElementById('chkTurnOffScreen');
    let videoCanvas = document.getElementById('videoCanvas');

    function logTerm(msg, type = 'normal') {
      const line = document.createElement('div');
      const timeStr = new Date().toLocaleTimeString([], { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });

      const color = {
        success: 'text-emerald-400',
        warn: 'text-amber-400',
        error: 'text-rose-400',
        system: 'text-zinc-400',
      }[type] ?? 'text-zinc-300';
      line.className = `${color} whitespace-pre-wrap break-words`;

      const time = document.createElement('span');
      time.className = 'text-zinc-700 select-none';
      time.textContent = `${timeStr} `;
      line.appendChild(time);
      line.appendChild(document.createTextNode(msg));
      termOutput.appendChild(line);
      termOutput.scrollTop = termOutput.scrollHeight;

      if (type === 'error') toggleSettings(true);
    }

    function toggleSettings(open = settingsPanel.classList.contains('closed')) {
      if (open) {
        toggleDevices(false);
        toggleDownload(false);
        toggleChangelog(false);
      }
      settingsPanel.classList.toggle('closed', !open);
      btnSettings.classList.toggle('bg-zinc-800', open);
      btnSettings.classList.toggle('text-white', open);
    }

    function toggleDevices(open = devicePanel.classList.contains('closed')) {
      if (open) {
        toggleSettings(false);
        toggleDownload(false);
        toggleChangelog(false);
        refreshDeviceList();
      }
      devicePanel.classList.toggle('closed', !open);
    }

    function toggleDownload(open = downloadPanel.classList.contains('closed')) {
      if (open) {
        toggleSettings(false);
        toggleDevices(false);
        toggleChangelog(false);
      }
      downloadPanel.classList.toggle('closed', !open);
      btnDownloadHelper.classList.toggle('ring-2', open);
      btnDownloadHelper.classList.toggle('ring-blue-400', open);
    }

    function toggleChangelog(open = changelogPanel.classList.contains('closed')) {
      if (open) {
        toggleSettings(false);
        toggleDevices(false);
        toggleDownload(false);
        const badge = document.getElementById('changelogBadge');
        if (badge) badge.classList.add('hidden');
      }
      changelogPanel.classList.toggle('closed', !open);
      btnChangelog.classList.toggle('bg-zinc-800', open);
      btnChangelog.classList.toggle('text-white', open);
    }

    btnSettings.addEventListener('click', (e) => {
      e.stopPropagation();
      toggleSettings();
    });
    btnDownloadHelper.addEventListener('click', (e) => {
      e.stopPropagation();
      toggleDownload();
    });
    btnChangelog.addEventListener('click', (e) => {
      e.stopPropagation();
      toggleChangelog();
    });
    document.getElementById('btnCloseSettings').addEventListener('click', () => toggleSettings(false));
    document.getElementById('btnCloseDevices').addEventListener('click', () => toggleDevices(false));
    document.getElementById('btnCloseDownload').addEventListener('click', () => toggleDownload(false));
    document.getElementById('btnCloseChangelog').addEventListener('click', () => toggleChangelog(false));

    const btnCopyMacCmd = document.getElementById('btnCopyMacCmd');
    const txtCopyMacCmd = document.getElementById('txtCopyMacCmd');
    if (btnCopyMacCmd) {
      btnCopyMacCmd.addEventListener('click', async (e) => {
        e.stopPropagation();
        const cmd = 'curl -fsSL https://webscrcpy.vercel.app/install-mac.sh | bash';
        try {
          await navigator.clipboard.writeText(cmd);
          if (txtCopyMacCmd) txtCopyMacCmd.textContent = 'Copied';
          setTimeout(() => { if (txtCopyMacCmd) txtCopyMacCmd.textContent = 'Copy'; }, 2000);
        } catch {
          prompt('Copy this command:', cmd);
        }
      });
    }

    const btnCopyWinCmd = document.getElementById('btnCopyWinCmd');
    const txtCopyWinCmd = document.getElementById('txtCopyWinCmd');
    if (btnCopyWinCmd) {
      btnCopyWinCmd.addEventListener('click', async (e) => {
        e.stopPropagation();
        const cmd = 'powershell -ExecutionPolicy Bypass -c "irm https://webscrcpy.vercel.app/install-windows.ps1 | iex"';
        try {
          await navigator.clipboard.writeText(cmd);
          if (txtCopyWinCmd) txtCopyWinCmd.textContent = 'Copied';
          setTimeout(() => { if (txtCopyWinCmd) txtCopyWinCmd.textContent = 'Copy'; }, 2000);
        } catch {
          prompt('Copy this command:', cmd);
        }
      });
    }

    document.addEventListener('pointerdown', (e) => {
      if (!settingsPanel.contains(e.target) && !btnSettings.contains(e.target)) toggleSettings(false);
      if (!devicePanel.contains(e.target) && !btnWebUsbConnect.contains(e.target)) toggleDevices(false);
      if (!downloadPanel.contains(e.target) && !btnDownloadHelper.contains(e.target)) toggleDownload(false);
      if (!changelogPanel.contains(e.target) && !btnChangelog.contains(e.target)) toggleChangelog(false);
    });
    function layoutCanvas() {
      const canvas = videoCanvas;
      const isFs = document.fullscreenElement != null;
      const restore = () => {
        canvas.style.position = '';
        canvas.style.left = '';
        canvas.style.top = '';
        canvas.style.transform = '';
        canvas.style.zIndex = '';
        canvas.style.width = 'auto';
        canvas.style.height = isFs ? '100vh' : 'auto';
        canvas.style.maxWidth = '100%';
        canvas.style.maxHeight = isFs ? '100vh' : 'calc(100vh - 6.5rem)';
        canvas.style.borderRadius = isFs ? '0' : (state.displayMode === 'dex' ? '12px' : '22px');
        canvas.style.boxShadow = isFs ? 'none' : '';
      };
      if (!fitScreen || !canvas.width || canvas.classList.contains('hidden')) {
        if (!fitScreen) restore();
        return;
      }
      const maxW = window.innerWidth;
      const maxH = window.innerHeight;
      const aspect = canvas.width / canvas.height;
      let width = maxW;
      let height = width / aspect;
      if (height > maxH) {
        height = maxH;
        width = height * aspect;
      }
      canvas.style.setProperty('max-width', 'none', 'important');
      canvas.style.setProperty('max-height', 'none', 'important');
      canvas.style.position = 'fixed';
      canvas.style.left = '50%';
      canvas.style.top = '50%';
      canvas.style.transform = 'translate(-50%, -50%)';
      canvas.style.zIndex = '10';
      canvas.style.width = `${Math.ceil(width)}px`;
      canvas.style.height = `${Math.ceil(height)}px`;
      canvas.style.borderRadius = '0';
      canvas.style.boxShadow = 'none';
    }

    function renderFitButton() {
      const btn = document.getElementById('btnFit');
      btn.classList.toggle('bg-white', fitScreen);
      btn.classList.toggle('text-zinc-900', fitScreen);
      btn.classList.toggle('hover:bg-zinc-200', fitScreen);
      btn.classList.toggle('hover:text-zinc-900', fitScreen);
      btn.classList.toggle('border-transparent', fitScreen);
      btn.title = fitScreen ? 'Actual size' : 'Fit to screen';
    }

    function syncScreenTools() {
      document.getElementById('screenTools').classList.toggle('hidden', videoCanvas.classList.contains('hidden'));
      document.body.classList.toggle('mirroring', !videoCanvas.classList.contains('hidden'));
      document.body.classList.remove('tools-visible');
    }

    document.getElementById('btnFit').addEventListener('click', () => {
      fitScreen = !fitScreen;
      renderFitButton();
      layoutCanvas();
    });
    document.getElementById('btnZoomIn')?.addEventListener('click', () => performPinchZoom(true));
    document.getElementById('btnZoomOut')?.addEventListener('click', () => performPinchZoom(false));

    // Click on the mirrored screen toggles the side tools (auto-hide).
    videoCanvas?.addEventListener('click', () => {
      if (document.body.classList.contains('mirroring')) {
        document.body.classList.toggle('tools-visible');
      }
    });
    // Hide tools again when clicking elsewhere.
    document.addEventListener('click', (e) => {
      if (!document.body.classList.contains('mirroring')) return;
      if (e.target.closest('#screenTools') || e.target === videoCanvas) return;
      document.body.classList.remove('tools-visible');
    });

    // Auto-hide tools a moment after the pointer leaves them (fullscreen safety net).
    let toolsHideTimer = null;
    document.getElementById('screenTools')?.addEventListener('mouseleave', () => {
      clearTimeout(toolsHideTimer);
      toolsHideTimer = setTimeout(() => document.body.classList.remove('tools-visible'), 1200);
    });
    document.getElementById('screenTools')?.addEventListener('mouseenter', () => clearTimeout(toolsHideTimer));

    // Reveal header / tools when the pointer nears the screen edges (hover can't
    // reach them while they are pointer-events:none).
    document.addEventListener('pointermove', (e) => {
      if (!document.body.classList.contains('mirroring')) return;
      clearTimeout(toolsHideTimer);
      const nearTop = e.clientY <= 56;
      const nearLeft = e.clientX <= 90;
      const anyHover = e.target.closest?.('#screenTools, header');
      if (nearTop || nearLeft || anyHover) {
        document.body.classList.add('tools-visible');
      } else {
        toolsHideTimer = setTimeout(() => document.body.classList.remove('tools-visible'), 1200);
      }
    });

    videoCanvas?.addEventListener('dblclick', () => {
      if (document.fullscreenElement) {
        document.exitFullscreen().catch(() => {});
      } else {
        document.documentElement.requestFullscreen().catch(() => {});
      }
    });

    async function takeScreenshot() {
      const canvas = videoCanvas;
      if (!canvas || !canvas.width || canvas.classList.contains('hidden')) {
        logTerm('Connect a phone first to take a screenshot.', 'warn');
        return;
      }
      try {
        canvas.style.transition = 'filter 0.15s ease';
        canvas.style.filter = 'brightness(2.2)';
        setTimeout(() => { canvas.style.filter = ''; }, 150);

        canvas.toBlob(async (blob) => {
          if (!blob) return;
          let pcCopied = false;
          try {
            const item = new ClipboardItem({ 'image/png': blob });
            await navigator.clipboard.write([item]);
            pcCopied = true;
          } catch (err) {
            console.warn('Computer clipboard write failed:', err);
          }

          let phoneCopied = false;
          try {
            if (state.client?.controller) {
              await state.client.controller.setClipboard({
                content: `[Screenshot: ${canvas.width}x${canvas.height} · ${new Date().toLocaleTimeString()}]`,
                paste: false
              });
              phoneCopied = true;
            }
          } catch (err) {
            console.warn('Phone clipboard set failed:', err);
          }

          if (pcCopied) {
            logTerm(`Screenshot (${canvas.width}x${canvas.height}) copied to computer clipboard.`, 'success');
          } else {
            logTerm('Screenshot captured. Please allow clipboard permission in browser.', 'warn');
          }
          if (phoneCopied) {
            logTerm('Phone clipboard updated.', 'system');
          }
        }, 'image/png');
      } catch (err) {
        logTerm(`Screenshot failed: ${err?.message ?? err}`, 'error');
      }
    }
    document.getElementById('btnScreenshot')?.addEventListener('click', takeScreenshot);

    bindHoldKey(document.getElementById('btnVolUp'), 24);
    bindHoldKey(document.getElementById('btnVolDown'), 25);
    window.addEventListener('resize', layoutCanvas);

    function renderFullscreenBtn() {
      const on = document.fullscreenElement != null;
      document.body.classList.toggle('is-fullscreen', on);
      btnFullscreen.title = on ? 'Exit fullscreen' : 'Fullscreen';
      btnFullscreen.classList.toggle('bg-zinc-800', on);
      btnFullscreen.classList.toggle('text-white', on);
      btnFullscreen.querySelector('i').className = on ? 'fa-solid fa-compress text-sm' : 'fa-solid fa-expand text-sm';
    }
    btnFullscreen.addEventListener('click', () => {
      if (document.fullscreenElement) document.exitFullscreen();
      else document.documentElement.requestFullscreen().catch(() => {});
    });
    document.addEventListener('fullscreenchange', () => {
      renderFullscreenBtn();
      layoutCanvas();
      // Reset tool visibility state when entering/leaving fullscreen.
      document.body.classList.remove('tools-visible');
    });

    document.addEventListener('keydown', (e) => {
      if (onPipMinimizeHotkey(e)) return;
      if (e.key === 'Escape' && e.target !== videoCanvas) {
        toggleSettings(false);
        toggleDevices(false);
        toggleDownload(false);
        toggleChangelog(false);
      }
    }, true);

    function updateConnectionStatus() {
      if (state.adb) {
        statusDot.className = 'w-2 h-2 rounded-full bg-emerald-400 shrink-0';
        txtDeviceName.classList.replace('text-zinc-400', 'text-zinc-200');
        btnWebUsbConnect.innerHTML = '<span>Disconnect</span>';
        btnWebUsbConnect.className = 'h-8 px-3.5 rounded-full border border-zinc-700/80 text-zinc-300 hover:bg-zinc-800 hover:text-white text-xs font-medium transition flex items-center gap-1.5';
      } else {
        statusDot.className = state.connecting
          ? 'w-2 h-2 rounded-full bg-amber-400 animate-pulse shrink-0'
          : 'w-2 h-2 rounded-full bg-zinc-600 shrink-0';
        txtDeviceName.classList.replace('text-zinc-200', 'text-zinc-400');
        btnWebUsbConnect.innerHTML = state.connecting
          ? '<i class="fa-solid fa-spinner fa-spin text-[10px]"></i><span>Connecting</span>'
          : '<i class="fa-brands fa-usb text-[11px]"></i><span>Connect</span>';
        btnWebUsbConnect.className = 'h-8 px-3.5 rounded-full bg-zinc-100 text-zinc-900 hover:bg-white disabled:opacity-50 text-xs font-medium transition flex items-center gap-1.5 shadow-sm';
      }
      btnWebUsbConnect.disabled = state.connecting;
      renderWifiStatus();
      updateRemoteStatus();
    }

    function loadWifiPhones() {
      const saved = [];
      try {
        const list = JSON.parse(localStorage.getItem('webscrcpy-phones') || 'null');
        if (Array.isArray(list)) saved.push(...list);
      } catch {}
      try {
        const old = JSON.parse(localStorage.getItem('webscrcpy-wifi') || 'null');
        if (old?.host) saved.push({ serial: old.host, name: 'Phone', host: old.host, port: 5555 });
      } catch {}
      const phones = [];
      for (const phone of saved) {
        if (!phone?.host || !isLan(phone.host)) continue;
        if (phones.some((item) => item.serial === phone.serial || item.host === phone.host)) continue;
        phones.push({
          serial: String(phone.serial || phone.host),
          name: String(phone.name || 'Phone'),
          host: phone.host,
          port: Number(phone.port) > 0 ? Number(phone.port) : 5555,
        });
      }
      state.wifiPhones = phones;
    }
    loadWifiPhones();

    function renderWifiStatus() {
      const list = document.getElementById('wifiList');
      if (!list) return;
      list.replaceChildren();
      if (state.wifiError) {
        const note = document.createElement('div');
        note.className = 'p-2.5 text-[11px] text-zinc-300 leading-relaxed bg-zinc-950 border border-zinc-800 rounded-xl space-y-1.5';
        const msg = document.createElement('p');
        msg.textContent = state.wifiError;
        note.appendChild(msg);

        if (/Wi-Fi bridge/i.test(state.wifiError)) {
          const actionBtn = document.createElement('button');
          actionBtn.type = 'button';
          actionBtn.className = 'w-full py-1.5 px-2.5 rounded-lg bg-zinc-800 hover:bg-zinc-700 text-zinc-200 text-[10px] font-medium transition flex items-center justify-center gap-1.5 border border-zinc-700/60';
          actionBtn.innerHTML = '<i class="fa-solid fa-terminal text-[9px]"></i> View Wi-Fi Setup';
          actionBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            toggleDownload(true);
          });
          note.appendChild(actionBtn);
        }
        list.appendChild(note);
      }
      if (!state.wifiPhones.length) {
        const empty = document.createElement('div');
        empty.className = 'px-2 py-2.5 text-[11px] space-y-2 rounded-xl bg-zinc-950/60 border border-zinc-800/80';
        
        const header = document.createElement('div');
        header.className = 'flex items-center gap-2 text-zinc-300 font-medium';
        header.innerHTML = '<i class="fa-solid fa-wifi text-zinc-400 text-xs"></i><span>First time using Wi-Fi?</span>';
        
        const desc = document.createElement('p');
        desc.className = 'text-zinc-500 text-[10px] leading-relaxed';
        desc.textContent = 'Connect your phone with a USB cable once, or setup the Wi-Fi Helper for wireless mirroring.';
        
        const btnHelper = document.createElement('button');
        btnHelper.type = 'button';
        btnHelper.className = 'w-full py-1.5 px-3 rounded-lg bg-zinc-800 hover:bg-zinc-700 text-zinc-200 text-[11px] font-medium transition flex items-center justify-center gap-1.5 border border-zinc-700/60';
        btnHelper.innerHTML = '<i class="fa-solid fa-terminal text-[10px]"></i> Setup Wi-Fi Helper';
        btnHelper.addEventListener('click', (e) => {
          e.stopPropagation();
          toggleDownload(true);
        });

        empty.append(header, desc, btnHelper);
        list.appendChild(empty);
        return;
      }
      const names = new Map();
      for (const phone of state.wifiPhones) names.set(phone.name, (names.get(phone.name) || 0) + 1);
      for (const phone of state.wifiPhones) list.appendChild(wifiRow(phone, names.get(phone.name) > 1));
    }

    function removeWifiPhone(phone) {
      state.wifiPhones = state.wifiPhones.filter((item) => item.serial !== phone.serial && item.host !== phone.host);
      localStorage.setItem('webscrcpy-phones', JSON.stringify(state.wifiPhones));
      if (state.wifiSerial === phone.serial && !state.adb) {
        state.wifiHost = null;
        state.wifiSerial = null;
      }
      logTerm(`Removed ${phone.name} (${phone.host}) from Wi-Fi list.`, 'system');
      renderWifiStatus();
    }

    function wifiRow(phone, duplicateName) {
      const active = !!state.adb && state.wifiSerial === phone.serial;
      const row = document.createElement('div');
      row.className = 'group flex items-center justify-between w-full rounded-xl hover:bg-zinc-800 transition pr-2';

      const button = document.createElement('button');
      button.type = 'button';
      button.disabled = state.connecting;
      button.className = 'flex-1 text-left px-3 py-2.5 rounded-xl disabled:opacity-40 transition flex items-center gap-3 min-w-0';
      const icon = document.createElement('i');
      icon.className = `fa-solid fa-wifi text-sm w-4 text-center shrink-0 ${active ? 'text-emerald-400' : 'text-zinc-500'}`;
      const text = document.createElement('span');
      text.className = 'min-w-0 flex-1';
      const name = document.createElement('span');
      name.className = 'block text-xs text-zinc-200 truncate';
      name.textContent = duplicateName ? `${phone.name} · ${phone.serial.slice(-4)}` : phone.name;
      const detail = document.createElement('span');
      detail.className = 'block text-[10px] font-mono text-zinc-500 truncate';
      detail.textContent = active && state.link === 'wifi'
        ? `${phone.host} · connected`
        : active && state.link === 'usb'
          ? `${phone.host} · switch to Wi-Fi`
          : phone.host;
      text.append(name, detail);
      button.append(icon, text);
      button.addEventListener('click', (e) => {
        e.stopPropagation();
        useWifi(phone).catch((err) => {
          console.error(err);
          logTerm(`Wi-Fi error: ${err?.message ?? err}`, 'error');
        });
      });

      const delBtn = document.createElement('button');
      delBtn.type = 'button';
      delBtn.title = `Delete ${phone.name}`;
      delBtn.className = 'w-7 h-7 rounded-lg text-zinc-500 hover:text-rose-400 hover:bg-zinc-700/60 transition flex items-center justify-center opacity-0 group-hover:opacity-100 focus:opacity-100 shrink-0';
      delBtn.innerHTML = '<i class="fa-solid fa-trash-can text-xs"></i>';
      delBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        removeWifiPhone(phone);
      });

      row.append(button, delBtn);
      return row;
    }

    function webUsbReady() {
      if (!browserReady()) return false;
      if (!AdbDaemonWebUsbDeviceManager.BROWSER) {
        logTerm('This browser does not support WebUSB. Please use Google Chrome or Microsoft Edge.', 'error');
        return false;
      }
      return true;
    }

    async function forgetUsbDevice(device) {
      try {
        if (typeof device.raw?.forget === 'function') {
          await device.raw.forget();
        }
      } catch (err) {
        console.warn('Could not forget USB device:', err);
      }
      logTerm(`Removed ${device.name || 'device'} (${device.serial || 'USB'}) from paired devices.`, 'system');
      await refreshDeviceList();
    }

    function deviceRow(device) {
      const row = document.createElement('div');
      row.className = 'group flex items-center justify-between w-full rounded-xl hover:bg-zinc-800 transition pr-2';

      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'flex-1 text-left px-3 py-2.5 rounded-xl transition flex items-center gap-3 min-w-0';
      const icon = document.createElement('i');
      icon.className = 'fa-solid fa-mobile-screen text-zinc-500 text-sm w-4 text-center shrink-0';
      const text = document.createElement('span');
      text.className = 'min-w-0 flex-1';
      const name = document.createElement('span');
      name.className = 'block text-xs text-zinc-200 truncate';
      name.textContent = device.name || 'Android device';
      const serial = document.createElement('span');
      serial.className = 'block text-[10px] font-mono text-zinc-500 truncate';
      serial.textContent = device.serial || 'USB';
      text.append(name, serial);
      button.append(icon, text);
      button.addEventListener('click', () => connectDevice(device));

      const delBtn = document.createElement('button');
      delBtn.type = 'button';
      delBtn.title = `Forget ${device.name || 'device'}`;
      delBtn.className = 'w-7 h-7 rounded-lg text-zinc-500 hover:text-rose-400 hover:bg-zinc-700/60 transition flex items-center justify-center opacity-0 group-hover:opacity-100 focus:opacity-100 shrink-0';
      delBtn.innerHTML = '<i class="fa-solid fa-trash-can text-xs"></i>';
      delBtn.addEventListener('click', async (e) => {
        e.stopPropagation();
        await forgetUsbDevice(device);
      });

      row.append(button, delBtn);
      return row;
    }

    async function refreshDeviceList() {
      const manager = AdbDaemonWebUsbDeviceManager.BROWSER;
      deviceList.replaceChildren();
      let devices = [];
      try {
        devices = manager ? await manager.getDevices() : [];
      } catch (err) {
        logTerm(`Could not list devices: ${err?.message ?? err}`, 'error');
      }
      if (!devices.length) {
        const empty = document.createElement('p');
        empty.className = 'px-2 py-3 text-[11px] text-zinc-500 leading-relaxed';
        empty.textContent = 'No paired phone yet. Plug it in, then use Pair a new phone.';
        deviceList.appendChild(empty);
        return;
      }
      devices.forEach((device) => deviceList.appendChild(deviceRow(device)));
    }

    btnWebUsbConnect.addEventListener('click', (e) => {
      e.stopPropagation();
      if (state.adb) disconnect();
      else if (state.connecting) return;
      else toggleDevices();
    });

    document.getElementById('btnPairDevice').addEventListener('click', () => {
      const form = document.getElementById('formPair');
      form.classList.toggle('hidden');
      if (!form.classList.contains('hidden')) document.getElementById('inputPairAddr')?.focus();
    });

    document.getElementById('formPair').addEventListener('submit', async (e) => {
      e.preventDefault();
      const addr = document.getElementById('inputPairAddr').value.trim();
      const status = document.getElementById('pairStatus');
      status.classList.remove('hidden');
      const pair = `${addr}`;
      status.textContent = 'Copying adb pair command…';
      try {
        await navigator.clipboard.writeText(`adb pair ${pair}`);
        status.textContent = 'Command copied. Paste it in Terminal, enter the code, then use the IP Wireless debugging shows.';
        logTerm(`Run in Terminal: adb pair ${addr}`, 'system');
      } catch {
        status.textContent = `Run in Terminal: adb pair ${addr}`;
      }
      logTerm('Browsers cannot run ADB pairing directly (WebUSB only). Use the command above, then connect via the Wireless debugging IP:port.', 'warn');
    });

    async function connectDevice(device) {
      if (!webUsbReady() || state.connecting) return;
      toggleDevices(false);

      state.connecting = true;
      updateConnectionStatus();
      try {
        logTerm(`Connecting to ${device.name} (${device.serial})...`, 'system');

        state.usbDevice = device;
        let connection;
        try {
          connection = await device.connect();
        } catch (err) {
          if (err instanceof AdbDaemonWebUsbDevice.DeviceBusyError) {
            logTerm('Device is busy or in use by another program (adb server / scrcpy).\nClose scrcpy and run "adb kill-server" in your terminal, then try again.', 'error');
            logTerm('Tip: `adb kill-server` only stops the background adb daemon — it does not affect your Wi-Fi connection.', 'system');
            return;
          }
          throw err;
        }

        await startAdbSession(connection, device.serial, 'usb');
      } catch (err) {
        console.error(err);
        logTerm(`Error: ${err?.message ?? err}`, 'error');
        await disconnect();
      } finally {
        if (!state.adb) state.usbDevice = null;
        state.connecting = false;
        updateConnectionStatus();
      }
    }

    async function useWifi(phone) {
      if (!phone?.host || state.connecting) return;
      const onThisPhone = !!state.adb && state.wifiSerial === phone.serial;
      if (onThisPhone && state.link === 'wifi') return;
      const switching = !!state.adb && state.link === 'usb' && (state.wifiSerial === phone.serial || state.wifiHost === phone.host);
      if (switching) {
        const host = await rememberWifiAddress(state.adb, phone.serial, phone.name) || phone.host;
        phone = { ...phone, host };
        logTerm(`Switching ADB to ${host}:5555. Cable can be unplugged after this.`, 'system');
        state.wifiHandoff = true;
        try {
          await state.adb.tcpip.setPort(5555);
        } catch (err) {
          const message = String(err?.message ?? err);
          if (!/restarting in TCP mode/i.test(message)) {
            logTerm(`ADB restarting in Wi-Fi mode (${message}).`, 'system');
          }
        }
        await disconnect(true);
        state.wifiHandoff = false;
        await connectWifi(phone, 8);
        return;
      }
      if (state.adb) await disconnect(true);
      if (await connectWifi(phone, 1, true)) return;
      const host = await enableWifiOverCable(phone);
      if (host) await connectWifi({ ...phone, host }, 8);
      else await connectWifi(phone, 1);
    }

    async function enableWifiOverCable(phone) {
      const manager = AdbDaemonWebUsbDeviceManager.BROWSER;
      if (!manager) return null;
      let device;
      try {
        device = (await manager.getDevices()).find((item) => item.serial === phone.serial);
      } catch {}
      if (!device) return null;
      state.connecting = true;
      updateConnectionStatus();
      let adb;
      try {
        logTerm(`${phone.name} is connected via cable. Enabling Wi-Fi debugging...`, 'system');
        const connection = await device.connect();
        const transport = await AdbDaemonTransport.authenticate({ serial: device.serial, connection, credentialStore });
        adb = new Adb(transport);
        const host = await rememberWifiAddress(adb, phone.serial, phone.name) || phone.host;
        try {
          await adb.tcpip.setPort(5555);
        } catch (err) {
          if (!/restarting in TCP mode/i.test(String(err?.message ?? err))) console.warn(err);
        }
        return host;
      } catch (err) {
        if (err instanceof AdbDaemonWebUsbDevice.DeviceBusyError) {
          logTerm('Cable is in use by adb on Mac. Run "adb kill-server", then try again.', 'warn');
        } else {
          logTerm(`Could not enable Wi-Fi over cable: ${err?.message ?? err}`, 'warn');
        }
        return null;
      } finally {
        try { await adb?.close(); } catch {}
        state.connecting = false;
        updateConnectionStatus();
      }
    }

    async function connectWifi(phone, attempts = 1, probe = false) {
      const host = phone?.host;
      const port = Number(phone?.port) > 0 ? Number(phone.port) : 5555;
      if (!browserReady() || state.connecting || state.adb) return false;
      if (!host || !isLan(host)) {
        logTerm('No Wi-Fi address found for this phone yet. Connect with a cable first.', 'warn');
        return false;
      }
      toggleDevices(false);
      state.wifiError = '';
      state.wifiHost = host;
      state.wifiSerial = phone.serial;
      state.connecting = true;
      updateConnectionStatus();
      let socket;
      try {
        logTerm(`Connecting to ${phone.name} (${host})...`, 'system');
        let lastError = null;
        for (let attempt = 0; attempt < attempts; attempt++) {
          try {
            socket = await openWifiSocket(host, port);
            lastError = null;
            break;
          } catch (err) {
            lastError = err;
            const message = String(err?.message ?? err);
            if (attempt + 1 < attempts && /ECONNREFUSED|timed out|EHOSTUNREACH|ENETUNREACH|ECONNRESET/i.test(message)) {
              logTerm(`Waiting for ${phone.name} at ${host}...`, 'system');
              await new Promise((resolve) => setTimeout(resolve, 800));
              continue;
            }
            throw err;
          }
        }
        if (lastError) throw lastError;
        const connection = createAdbConnection(socket.readable, socket.writable, () => socket.close());
        await startAdbSession(connection, `${host}:${port}`, 'wifi');
        return true;
      } catch (err) {
        try { socket?.close(); } catch {}
        const message = String(err?.message ?? err);
        const unreachable = /ECONNREFUSED|timed out|EHOSTUNREACH|ENETUNREACH/i.test(message);
        await disconnect(true);
        if (probe && unreachable) return false;
        console.error(err);
        if (unreachable) {
          const diag = await diagnoseHost(host, port);
          state.wifiError = diag;
          logTerm(`Wi-Fi error: ${diag}`, 'warn');
          if (/refused|not listening/i.test(diag)) {
            logTerm('Fix: enable Wireless debugging on the phone (Developer options), or plug in USB and run "adb tcpip 5555".', 'system');
          }
        } else {
          state.wifiError = message;
          logTerm(`Wi-Fi error: ${message}`, 'warn');
        }
        if (/Wi-Fi bridge/i.test(message)) {
          logTerm('Wi-Fi Bridge Helper is required for wireless connection.', 'warn');
          logTerm('Mac: Run "curl -fsSL https://webscrcpy.vercel.app/install-mac.sh | bash" in Terminal.', 'system');
          logTerm('Windows: Run \'powershell -ExecutionPolicy Bypass -c "irm https://webscrcpy.vercel.app/install-windows.ps1 | iex"\' in Terminal or CMD.', 'system');
          toggleDownload(true);
        } else {
          toggleDevices(true);
        }
        return false;
      } finally {
        state.connecting = false;
        updateConnectionStatus();
      }
    }

    async function diagnoseHost(host, port) {
      const base = location.protocol === 'https:' ? 'https://127.0.0.1:8766' : 'http://127.0.0.1:8765';
      try {
        const res = await fetch(`${base}/probe?host=${encodeURIComponent(host)}&port=${port}`, { cache: 'no-store' });
        if (!res.ok) throw new Error('probe failed');
        const r = await res.json();
        if (r.ok) return `${host}:${port} accepts connections but ADB handshake was rejected. The phone may need to be re-approved.`;
        if (r.reason === 'refused') return `Nothing is listening at ${host}:${port}. The phone is not running ADB over Wi-Fi (enable Wireless debugging, or run "adb tcpip 5555" over USB once).`;
        if (r.reason === 'timeout') return `${host}:${port} does not respond. The phone may be asleep, on another network, or the port is wrong.`;
        if (r.reason === 'unreachable') return `${host} is not reachable from this computer. Check that both are on the same network / VPN.`;
        return `${host}:${port} failed (${r.code || r.reason}).`;
      } catch {
        return `${host}:${port} did not answer. Ensure the Wi-Fi bridge is running, then verify the phone is listening on port ${port}.`;
      }
    }

    function browserReady() {
      if (window.self !== window.top) {
        logTerm('This page is blocked inside an iframe. Please open directly in a browser tab.', 'error');
        return false;
      }
      if (!WebCodecsVideoDecoder.isSupported) {
        logTerm('This browser does not support WebCodecs video decoding.', 'error');
        return false;
      }
      return true;
    }

    async function openWifiSocket(host, port) {
      if (typeof TCPSocket === 'function') {
        try {
          return await openDirectSocket(host, port);
        } catch (err) {
          console.warn('Direct socket failed', err);
        }
      }
      const urls = location.protocol === 'https:'
        ? ['wss://127.0.0.1:8766', 'ws://127.0.0.1:8765']
        : ['ws://127.0.0.1:8765'];
      let lastError = null;
      for (const url of urls) {
        try {
          return await openBridgeSocket(host, port, url);
        } catch (err) {
          lastError = err;
        }
      }
      throw lastError;
    }

    async function openDirectSocket(host, port) {
      const socket = new TCPSocket({ remoteAddress: host, remotePort: port });
      const opened = await socket.opened;
      return {
        readable: opened.readable,
        writable: opened.writable,
        close() { socket.close?.(); },
      };
    }

    function openBridgeSocket(host, port, url) {
      const bridgeMissing = location.protocol === 'https:'
        ? 'Wi-Fi bridge is unreachable. Ensure the Wi-Fi Helper is running on your computer. If using HTTPS/Vercel, open https://127.0.0.1:8766 in a new tab once and click "Advanced -> Proceed" to allow the local certificate.'
        : 'Wi-Fi bridge is not running. Please launch the Wi-Fi Helper or run "node wifi-bridge.mjs".';
      return new Promise((resolve, reject) => {
        let settled = false;
        const ws = new WebSocket(url);
        ws.binaryType = 'arraybuffer';
        const queue = [];
        let waiter = null;
        let closed = false;
        const fail = (err) => {
          if (settled) return;
          settled = true;
          reject(err);
          try { ws.close(); } catch {}
        };
        const readable = new ReadableStream({
          async pull(controller) {
            if (queue.length) {
              controller.enqueue(queue.shift());
              return;
            }
            if (closed) {
              controller.close();
              return;
            }
            const chunk = await new Promise((done) => { waiter = done; });
            if (!chunk) controller.close();
            else controller.enqueue(chunk);
          },
        });
        const writable = new WritableStream({
          write(chunk) {
            if (ws.readyState === WebSocket.OPEN) ws.send(chunk);
          },
          close() { ws.close(); },
        });
        ws.addEventListener('open', () => {
          ws.send(JSON.stringify({ host, port }));
        });
        ws.addEventListener('message', (event) => {
          if (typeof event.data === 'string') {
            let msg;
            try { msg = JSON.parse(event.data); } catch { return; }
            if (msg.type === 'ok' && !settled) {
              settled = true;
              resolve({ readable, writable, close() { ws.close(); } });
            } else if (msg.type === 'error') {
              fail(new Error(msg.message || 'Wi-Fi connection failed.'));
            }
            return;
          }
          const bytes = new Uint8Array(event.data);
          if (waiter) {
            const done = waiter;
            waiter = null;
            done(bytes);
          } else queue.push(bytes);
        });
        ws.addEventListener('close', () => {
          closed = true;
          if (waiter) {
            const done = waiter;
            waiter = null;
            done(null);
          }
          if (!settled) fail(new Error(bridgeMissing));
        });
        ws.addEventListener('error', () => {
          if (!settled) fail(new Error(bridgeMissing));
        });
      });
    }

    function createAdbConnection(byteReadable, byteWritable, closeSocket) {
      const reader = byteReadable.getReader();
      let buffer = new Uint8Array(0);
      const append = (chunk) => {
        if (!buffer.length) {
          buffer = chunk;
          return;
        }
        const next = new Uint8Array(buffer.length + chunk.length);
        next.set(buffer);
        next.set(chunk, buffer.length);
        buffer = next;
      };
      const readExactly = async (size) => {
        while (buffer.length < size) {
          const { done, value } = await reader.read();
          if (done || !value?.length) return null;
          append(value);
        }
        const out = buffer.subarray(0, size);
        buffer = buffer.subarray(size);
        return out;
      };
      const readable = new ReadableStream({
        async pull(controller) {
          const header = await readExactly(24);
          if (!header) {
            controller.close();
            return;
          }
          const view = new DataView(header.buffer, header.byteOffset, header.byteLength);
          const packet = {
            command: view.getUint32(0, true),
            arg0: view.getUint32(4, true),
            arg1: view.getUint32(8, true),
            payloadLength: view.getUint32(12, true),
            checksum: view.getUint32(16, true),
            magic: view.getUint32(20, true),
            payload: new Uint8Array(0),
          };
          if (packet.payloadLength) {
            const payload = await readExactly(packet.payloadLength);
            if (!payload || payload.length !== packet.payloadLength) {
              controller.close();
              return;
            }
            packet.payload = payload;
          }
          controller.enqueue(packet);
        },
      });
      const byteWriter = byteWritable.getWriter();
      const writable = new WritableStream({
        async write(chunk) {
          const send = async (packet) => {
            const payload = packet.payload ?? new Uint8Array(0);
            const header = new Uint8Array(24);
            const view = new DataView(header.buffer);
            view.setUint32(0, packet.command >>> 0, true);
            view.setUint32(4, (packet.arg0 ?? 0) >>> 0, true);
            view.setUint32(8, (packet.arg1 ?? 0) >>> 0, true);
            view.setUint32(12, payload.byteLength, true);
            view.setUint32(16, (packet.checksum ?? 0) >>> 0, true);
            view.setUint32(20, (packet.magic ?? 0) >>> 0, true);
            await byteWriter.write(header);
            if (payload.byteLength) await byteWriter.write(payload);
          };
          if (chunk && typeof chunk.tryConsume === 'function') await chunk.tryConsume(send);
          else await send(chunk);
        },
        async close() {
          try { await byteWriter.close(); } catch {}
        },
      });
      return {
        readable,
        writable,
        close() {
          try { reader.cancel(); } catch {}
          try { closeSocket?.(); } catch {}
        },
      };
    }

    async function startAdbSession(connection, serial, link) {
        logTerm('If prompted, tap "Allow" on the USB debugging prompt on your phone...', 'warn');
        const transport = await AdbDaemonTransport.authenticate({
          serial,
          connection,
          credentialStore,
        });
        const adb = new Adb(transport);
        state.adb = adb;
        state.link = link;
        if (link === 'usb') state.wifiSerial = serial;
        adb.disconnected.then(() => {
          if (state.wifiHandoff || state.adb !== adb) return;
          logTerm('Device disconnected.', 'warn');
          disconnect();
        });

        const [manufacturer, model, release] = await Promise.all([
          adb.getProp('ro.product.manufacturer'),
          adb.getProp('ro.product.model'),
          adb.getProp('ro.build.version.release'),
        ]);
        if (state.adb !== adb) return;
        txtDeviceName.textContent = `${manufacturer.trim()} ${model.trim()} (Android ${release.trim()})`;
        logTerm(`Connected: ${txtDeviceName.textContent}`, 'success');
        if (link === 'usb') await rememberWifiAddress(adb, serial, `${manufacturer.trim()} ${model.trim()}`);
        if (state.adb !== adb) return;
        state.connecting = false;
        updateConnectionStatus();

        // Turn off persistent touch/pointer indicator on the physical phone
        adb.subprocess.noneProtocol.spawnWait(['settings', 'put', 'system', 'show_touches', '0']).catch(() => {});
        adb.subprocess.noneProtocol.spawnWait(['settings', 'put', 'system', 'pointer_location', '0']).catch(() => {});

        idleView.classList.add('hidden');
        idleView.style.display = 'none';

        state.hasDex = await detectDex(adb, manufacturer.trim());
        if (state.adb !== adb) return;
        renderDisplayMode();
        if (state.hasDex) {
          state.displayMode = null;
          logTerm('Samsung DeX detected. Choose Mirror or DeX.', 'system');
          showModeChooser(true);
        } else {
          state.displayMode = 'mirror';
          await startMirror();
        }
    }

    async function detectDex(adb, manufacturer) {
      state.oneUi = 0;
      let identity = manufacturer;
      if (!/samsung/i.test(identity)) {
        try {
          const [brand, model] = await Promise.all([
            adb.getProp('ro.product.brand'),
            adb.getProp('ro.product.model'),
          ]);
          identity = `${brand} ${model}`;
        } catch {}
      }
      if (!/samsung/i.test(`${manufacturer} ${identity}`)) return false;
      try {
        const oneUi = Number(await adb.getProp('ro.build.version.oneui'));
        if (Number.isFinite(oneUi)) state.oneUi = oneUi;
      } catch {}
      return true;
    }

    function showModeChooser(show) {
      const chooser = document.getElementById('modeChooser');
      const hint = document.getElementById('modeChooserHint');
      chooser.classList.toggle('hidden', !show);
      chooser.style.display = show ? 'flex' : 'none';
      if (!show) return;
      idleView.classList.add('hidden');
      idleView.style.display = 'none';
      videoCanvas.classList.add('hidden');
      videoCanvas.style.display = 'none';
      syncScreenTools();
      hint.textContent = state.oneUi > 0 && state.oneUi < 80000
        ? 'DeX in this window needs One UI 8. This phone may only show an empty desktop.'
        : 'Mirror the phone screen, or open a 1920×1080 DeX desktop.';
    }

    function renderDisplayMode() {
      const row = document.getElementById('dexModeRow');
      row.classList.toggle('hidden', !state.hasDex);
      for (const [id, mode] of [['setMirror', 'mirror'], ['setDex', 'dex']]) {
        const el = document.getElementById(id);
        const on = state.displayMode === mode;
        el.className = on
          ? 'py-1.5 rounded-lg bg-zinc-800 text-white font-medium transition'
          : 'py-1.5 rounded-lg text-zinc-500 hover:text-zinc-300 transition';
      }
    }

    async function chooseDisplayMode(mode) {
      if (!state.adb) return;
      if (state.displayMode === mode && state.client) return;
      state.displayMode = mode;
      showModeChooser(false);
      renderDisplayMode();
      if (mode === 'dex' && state.oneUi > 0 && state.oneUi < 80000) {
        logTerm('DeX on virtual displays requires One UI 8. This phone might display a blank desktop.', 'warn');
      }
      try {
        if (state.client) await restartMirror();
        else await startMirror();
      } catch (err) {
        console.error(err);
        logTerm(`Error: ${err?.message ?? err}`, 'error');
        if (state.client) await stopMirror();
        else if (state.hasDex) showModeChooser(true);
      }
    }

    async function startMirror() {
      const adb = state.adb;
      if (!adb) return;
      const dex = state.displayMode === 'dex';

      logTerm('Preparing scrcpy server on device...', 'system');
      const res = await fetch(SERVER_FILE);
      if (!res.ok) throw new Error(`Failed to load ${SERVER_FILE} (HTTP ${res.status})`);
      if (state.adb !== adb) return;
      await AdbScrcpyClient.pushServer(adb, res.body);
      if (state.adb !== adb) return;

      const options = new AdbScrcpyOptionsLatest({
        audio: false,
        control: true,
        clipboardAutosync: true,
        logLevel: 'info',
        maxSize: MAX_SIZE[state.resolution],
        videoBitRate: state.bitrate * 1_000_000,
        maxFps: state.fps,
        stayAwake: chkStayAwake.checked,
        ...(dex ? { newDisplay: '1920x1080/160' } : {}),
      });

      logTerm(dex
        ? `Starting DeX (1920x1080, ${state.bitrate} Mbps, ${state.fps} FPS)...`
        : `Starting mirror session (${state.resolution}, ${state.bitrate} Mbps, ${state.fps} FPS)...`, 'system');
      const client = await AdbScrcpyClient.start(adb, DefaultServerPath, options);
      if (state.adb !== adb) {
        try { await client.close(); } catch {}
        return;
      }
      state.client = client;

      client.output
        .pipeTo(new WritableStream({ write: (line) => logTerm(`[scrcpy] ${line}`) }))
        .catch(() => {});
      client.exited.then(() => {
        if (state.client === client) {
          logTerm('Server stopped.', 'warn');
          stopMirror();
        }
      });
      watchPhoneClipboard(client);

      const videoStream = await client.videoStream;
      const canvas = resetVideoCanvas();
      const renderer = WebGLVideoFrameRenderer.isSupported
        ? new WebGLVideoFrameRenderer(canvas, true)
        : new BitmapVideoFrameRenderer(canvas);
      const decoder = new WebCodecsVideoDecoder({ codec: videoStream.metadata.codec, renderer });
      state.decoder = decoder;
      state.lastFrames = 0;
      decoder.sizeChanged(({ width, height }) => {
        badgeRes.textContent = `${width}x${height}`;
        fitPipWindow(width, height);
        layoutCanvas();
        renderMainViews();
      });
      videoStream.stream.pipeTo(decoder.writable).catch((err) => {
        if (state.decoder === decoder) logTerm(`Video stream error: ${err?.message ?? err}`, 'error');
      });

      showModeChooser(false);
      idleView.classList.add('hidden');
      idleView.style.display = 'none';
      canvas.style.borderRadius = dex ? '12px' : '22px';
      canvas.classList.remove('hidden');
      canvas.style.display = 'block';
      syncScreenTools();
      layoutCanvas();
      renderMainViews();
      canvas.focus();

      if (chkTurnOffScreen.checked) {
        await client.controller?.setScreenPowerMode(AndroidScreenPowerMode.Off);
      }
      logTerm(dex
        ? 'Samsung DeX active. Mouse and keyboard enabled.'
        : 'Mirroring active. Mouse, keyboard, and touch enabled.', 'success');
    }

    let lastPhoneClipboard = '';

    async function writeMacClipboard(text) {
      if (!text || text === lastPhoneClipboard) return;
      lastPhoneClipboard = text;
      const targets = [];
      if (pipWindow && !pipWindow.closed) targets.push(pipWindow.navigator.clipboard);
      targets.push(navigator.clipboard);
      let lastError = null;
      for (const clipboard of targets) {
        try {
          await clipboard.writeText(text);
          const preview = text.length > 60 ? `${text.slice(0, 60)}…` : text;
          logTerm(`Copied to clipboard: ${preview.replace(/\s+/g, ' ')}`, 'success');
          return;
        } catch (err) {
          lastError = err;
        }
      }
      logTerm(`Mac clipboard sync failed: ${lastError?.message ?? lastError}. Ensure the WebScrcpy tab or PiP is active.`, 'warn');
    }

    function watchPhoneClipboard(client) {
      const stream = client?.clipboard;
      if (!stream) return;
      stream.pipeTo(new WritableStream({
        write(text) {
          writeMacClipboard(String(text ?? '')).catch(() => {});
        },
      })).catch(() => {});
    }

    async function stopMirror() {
      const { client, decoder } = state;
      state.client = null;
      state.decoder = null;
      lastPhoneClipboard = '';
      if (pipWindow) pipWindow.close();
      releasePipStream();
      try { await client?.close(); } catch {}
      try { decoder?.dispose(); } catch {}
      videoCanvas.classList.add('hidden');
      syncScreenTools();
      if (!mirrorRestarting && state.adb && state.hasDex) showModeChooser(true);
      else if (!mirrorRestarting) {
        showModeChooser(false);
        renderMainViews();
      }
      badgeRes.textContent = '--';
      badgeFps.textContent = '0 FPS';
    }

    async function restartMirror() {
      if (!state.adb || !state.client) return;
      logTerm('Restarting mirror session with updated settings...', 'system');
      mirrorRestarting = true;
      try {
        await stopMirror();
        await startMirror();
      } catch (err) {
        console.error(err);
        logTerm(`Error: ${err?.message ?? err}`, 'error');
        mirrorRestarting = false;
        if (state.client) await stopMirror();
        else if (state.hasDex) showModeChooser(true);
        else idleView.classList.remove('hidden');
      } finally {
        mirrorRestarting = false;
      }
    }

    function isLan(ip) {
      const parts = ip.split('.').map(Number);
      if (parts.length !== 4 || parts.some((n) => n > 255)) return false;
      const [a, b, c, d] = parts;
      if (d === 0 || d === 255 || a === 0 || a === 127) return false;
      return a === 10 || (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31)
        || (a === 100 && b >= 64 && b <= 127); // Tailscale / CGNAT
    }

    function lanAddress(text, wlanOnly = false) {
      if (wlanOnly) {
        const wlan = text.match(/wlan\d[\s\S]{0,400}?inet\s+((?:\d{1,3}\.){3}\d{1,3})/);
        return wlan && isLan(wlan[1]) ? wlan[1] : null;
      }
      const src = text.match(/\bsrc\s+((?:\d{1,3}\.){3}\d{1,3})/);
      if (src && isLan(src[1])) return src[1];
      const inet = text.match(/\binet\s+((?:\d{1,3}\.){3}\d{1,3})/);
      if (inet && isLan(inet[1])) return inet[1];
      const bare = text.trim();
      return isLan(bare) ? bare : null;
    }

    function saveWifiPhone(phone) {
      state.wifiHost = phone.host;
      state.wifiSerial = phone.serial;
      state.wifiPhones = [
        phone,
        ...state.wifiPhones.filter((item) => item.serial !== phone.serial && item.host !== phone.host),
      ].slice(0, 8);
      localStorage.setItem('webscrcpy-phones', JSON.stringify(state.wifiPhones));
      logTerm(`Registered ${phone.name} at ${phone.host}`, 'system');
      renderWifiStatus();
      return phone.host;
    }

    async function rememberWifiAddress(adb, serial, name) {
      const attempts = [
        [['ip', '-4', 'addr'], true],
        [['ip', '-4', 'route', 'get', '1.1.1.1'], false],
        [['ip', 'route'], false],
      ];
      for (const [args, wlanOnly] of attempts) {
        try {
          const host = lanAddress(await adb.subprocess.noneProtocol.spawnWaitText(args), wlanOnly);
          if (host) return saveWifiPhone({ serial, name: name || 'Phone', host, port: 5555 });
        } catch {}
      }
      for (const key of ['dhcp.wlan0.ipaddress', 'dhcp.wlan0.ipaddr']) {
        try {
          const host = lanAddress(await adb.getProp(key));
          if (host) return saveWifiPhone({ serial, name: name || 'Phone', host, port: 5555 });
        } catch {}
      }
      logTerm('Phone has no Wi-Fi address. Ensure it is connected to the same Wi-Fi network as your computer.', 'warn');
      return null;
    }

    let disconnecting = false;
    async function disconnect(quiet = false) {
      if (disconnecting) return;
      const adb = state.adb;
      if (!adb && !state.client && !state.link && !state.usbDevice) return;
      disconnecting = true;
      state.usbDevice = null;
      state.adb = null;
      state.hasDex = false;
      state.link = null;
      state.wifiHost = null;
      state.wifiSerial = null;
      state.connecting = false;
      try {
        await stopMirror();
        try { await adb?.close(); } catch {}
      } finally {
        disconnecting = false;
      }
      txtDeviceName.textContent = 'No device connected';
      state.displayMode = 'mirror';
      state.oneUi = 0;
      renderDisplayMode();
      updateConnectionStatus();
      refreshDeviceList().catch(() => {});
      if (adb && !quiet) logTerm('Disconnected.', 'system');
    }

    function onUsbDisconnect(event) {
      if (state.wifiHandoff || !state.usbDevice) return;
      if (event.device !== state.usbDevice.raw) return;
      if (state.link !== 'usb' && !state.connecting) return;
      logTerm('USB cable unplugged. Connection closed.', 'warn');
      disconnect(true);
    }
    navigator.usb?.addEventListener('disconnect', onUsbDisconnect);

    function usbSerial(device) {
      if (device?.serialNumber) return device.serialNumber;
      const hex = (n) => Number(n).toString(16).padStart(4, '0');
      return `${hex(device.vendorId)}x${hex(device.productId)}`;
    }

    setInterval(async () => {
      if (state.wifiHandoff || state.link !== 'usb' || !state.adb || !state.usbDevice || !navigator.usb) return;
      const serial = state.usbDevice.serial;
      try {
        const devices = await navigator.usb.getDevices();
        if (state.link !== 'usb' || state.usbDevice?.serial !== serial) return;
        if (devices.some((device) => usbSerial(device) === serial)) return;
        logTerm('USB cable unplugged. Connection closed.', 'warn');
        disconnect(true);
      } catch {}
    }, 1000);

    // A fresh canvas per session avoids reusing a rendering context owned by a disposed decoder.
    function resetVideoCanvas() {
      const canvas = videoCanvas.cloneNode(false);
      canvas.classList.remove('invisible');
      canvas.classList.remove('hidden');
      canvas.style.display = 'block';
      videoCanvas.replaceWith(canvas);
      videoCanvas = canvas;
      attachInputHandlers(canvas);
      return canvas;
    }

    function surfaceSize(el) {
      return {
        width: el.videoWidth || el.width || 0,
        height: el.videoHeight || el.height || 0,
      };
    }

    function toDevicePoint(e, el) {
      const rect = el.getBoundingClientRect();
      const { width, height } = surfaceSize(el);
      let left = e.clientX - rect.left;
      let top = e.clientY - rect.top;
      let boxW = rect.width;
      let boxH = rect.height;
      if (el.tagName === 'VIDEO' && width && height) {
        boxW = rect.width;
        boxH = rect.height;
      }
      const x = (left / boxW) * width;
      const y = (top / boxH) * height;
      return {
        pointerX: Math.round(Math.min(Math.max(x, 0), width)),
        pointerY: Math.round(Math.min(Math.max(y, 0), height)),
        videoWidth: width,
        videoHeight: height,
      };
    }

    function performPinchZoom(zoomIn, pt) {
      const controller = state.client?.controller;
      const canvas = videoCanvas;
      if (!controller || !canvas) return;
      const { width, height } = surfaceSize(canvas);
      if (!width || !height) return;

      const cx = pt ? pt.pointerX : Math.round(width / 2);
      const cy = pt ? pt.pointerY : Math.round(height / 2);

      const startDist = zoomIn ? 70 : 250;
      const endDist = zoomIn ? 250 : 70;
      const steps = 4;
      const interval = 20;

      const sendPair = (dist, action) => {
        const x0 = Math.round(Math.min(Math.max(cx - dist, 0), width));
        const x1 = Math.round(Math.min(Math.max(cx + dist, 0), width));
        const y = cy;
        const pressure = action === AndroidMotionEventAction.Up ? 0 : 1;
        controller.injectTouch({
          action,
          pointerId: 0n,
          pointerX: x0,
          pointerY: y,
          videoWidth: width,
          videoHeight: height,
          pressure,
          actionButton: 0,
          buttons: 0,
        }).catch(() => {});
        controller.injectTouch({
          action,
          pointerId: 1n,
          pointerX: x1,
          pointerY: y,
          videoWidth: width,
          videoHeight: height,
          pressure,
          actionButton: 0,
          buttons: 0,
        }).catch(() => {});
      };

      sendPair(startDist, AndroidMotionEventAction.Down);
      for (let i = 1; i <= steps; i++) {
        const currDist = startDist + ((endDist - startDist) * (i / steps));
        setTimeout(() => sendPair(currDist, AndroidMotionEventAction.Move), i * interval);
      }
      setTimeout(() => sendPair(endDist, AndroidMotionEventAction.Up), (steps + 1) * interval);
    }

    function attachInputHandlers(canvas) {
      const activePointers = new Set();
      let pinchActive = false;

      const inject = (e, action) => {
        const controller = state.client?.controller;
        if (!controller || !surfaceSize(canvas).width) return;
        e.preventDefault();
        const isMouse = e.pointerType === 'mouse';
        const isHover = action === AndroidMotionEventAction.HoverMove || action === AndroidMotionEventAction.HoverEnter || action === AndroidMotionEventAction.HoverExit;
        const btn = e.buttons === 2 ? AndroidMotionEventButton.Secondary : (e.buttons ? AndroidMotionEventButton.Primary : 0);
        controller.injectTouch({
          action,
          pointerId: isMouse ? ScrcpyPointerId.Mouse : BigInt(e.pointerId),
          ...toDevicePoint(e, canvas),
          pressure: isHover || action === AndroidMotionEventAction.Up ? 0 : 1,
          actionButton: isMouse ? btn : 0,
          buttons: isMouse ? btn : 0,
        }).catch(() => {});
      };

      canvas.addEventListener('pointerenter', (e) => {
        if (e.pointerType === 'mouse') inject(e, AndroidMotionEventAction.HoverEnter);
      });
      canvas.addEventListener('pointerleave', (e) => {
        if (e.pointerType === 'mouse') inject(e, AndroidMotionEventAction.HoverExit);
      });

      canvas.addEventListener('pointerdown', (e) => {
        canvas.focus();
        canvas.setPointerCapture(e.pointerId);

        // Pinch-to-zoom simulation (Ctrl or Cmd + Click & Drag)
        if (e.ctrlKey || e.metaKey) {
          pinchActive = true;
          const { width, height } = surfaceSize(canvas);
          const p0 = toDevicePoint(e, canvas);
          const cx = Math.round(width / 2);
          const cy = Math.round(height / 2);
          const p1X = Math.round(Math.min(Math.max(2 * cx - p0.pointerX, 0), width));
          const p1Y = Math.round(Math.min(Math.max(2 * cy - p0.pointerY, 0), height));

          state.client?.controller?.injectTouch({
            action: AndroidMotionEventAction.Down,
            pointerId: 0n,
            ...p0,
            pressure: 1,
            actionButton: 0,
            buttons: 0,
          }).catch(() => {});

          state.client?.controller?.injectTouch({
            action: AndroidMotionEventAction.Down,
            pointerId: 1n,
            pointerX: p1X,
            pointerY: p1Y,
            videoWidth: width,
            videoHeight: height,
            pressure: 1,
            actionButton: 0,
            buttons: 0,
          }).catch(() => {});
          return;
        }

        activePointers.add(e.pointerId);
        inject(e, AndroidMotionEventAction.Down);
      });

      canvas.addEventListener('pointermove', (e) => {
        if (pinchActive) {
          const { width, height } = surfaceSize(canvas);
          const p0 = toDevicePoint(e, canvas);
          const cx = Math.round(width / 2);
          const cy = Math.round(height / 2);
          const p1X = Math.round(Math.min(Math.max(2 * cx - p0.pointerX, 0), width));
          const p1Y = Math.round(Math.min(Math.max(2 * cy - p0.pointerY, 0), height));

          state.client?.controller?.injectTouch({
            action: AndroidMotionEventAction.Move,
            pointerId: 0n,
            ...p0,
            pressure: 1,
            actionButton: 0,
            buttons: 0,
          }).catch(() => {});

          state.client?.controller?.injectTouch({
            action: AndroidMotionEventAction.Move,
            pointerId: 1n,
            pointerX: p1X,
            pointerY: p1Y,
            videoWidth: width,
            videoHeight: height,
            pressure: 1,
            actionButton: 0,
            buttons: 0,
          }).catch(() => {});
          return;
        }

        if (activePointers.has(e.pointerId)) {
          inject(e, AndroidMotionEventAction.Move);
        } else if (e.pointerType === 'mouse') {
          inject(e, AndroidMotionEventAction.HoverMove);
        }
      });

      const release = (e) => {
        if (pinchActive) {
          pinchActive = false;
          const { width, height } = surfaceSize(canvas);
          const p0 = toDevicePoint(e, canvas);
          const cx = Math.round(width / 2);
          const cy = Math.round(height / 2);
          const p1X = Math.round(Math.min(Math.max(2 * cx - p0.pointerX, 0), width));
          const p1Y = Math.round(Math.min(Math.max(2 * cy - p0.pointerY, 0), height));

          state.client?.controller?.injectTouch({
            action: AndroidMotionEventAction.Up,
            pointerId: 0n,
            ...p0,
            pressure: 0,
            actionButton: 0,
            buttons: 0,
          }).catch(() => {});

          state.client?.controller?.injectTouch({
            action: AndroidMotionEventAction.Up,
            pointerId: 1n,
            pointerX: p1X,
            pointerY: p1Y,
            videoWidth: width,
            videoHeight: height,
            pressure: 0,
            actionButton: 0,
            buttons: 0,
          }).catch(() => {});
          return;
        }

        if (!activePointers.delete(e.pointerId)) return;
        inject(e, AndroidMotionEventAction.Up);
      };
      canvas.addEventListener('pointerup', release);
      canvas.addEventListener('pointercancel', release);
      canvas.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        sendAdbKey(4);
      });

      canvas.addEventListener('wheel', (e) => {
        const controller = state.client?.controller;
        if (!controller || !surfaceSize(canvas).width) return;
        e.preventDefault();

        // Mac trackpad pinch gesture or Ctrl/Cmd + wheel zoom in games like Clash of Clans
        if (e.ctrlKey || e.metaKey) {
          const pt = toDevicePoint(e, canvas);
          performPinchZoom(e.deltaY < 0, pt);
          return;
        }

        const clamp = (v) => Math.min(Math.max(v, -1), 1);
        controller.injectScroll({
          ...toDevicePoint(e, canvas),
          scrollX: clamp(-e.deltaX / 100),
          scrollY: clamp(-e.deltaY / 100),
          buttons: 0,
        }).catch(() => {});
      }, { passive: false });

      canvas.addEventListener('keydown', (e) => {
        const controller = state.client?.controller;
        if (!controller || e.metaKey || e.ctrlKey || e.altKey) return;
        if (KEY_MAP[e.key] !== undefined) {
          e.preventDefault();
          sendAdbKey(KEY_MAP[e.key]);
        } else if (e.key.length === 1) {
          e.preventDefault();
          controller.injectText(e.key).catch(() => {});
        }
      });
    }

    function updatePipButton() {
      const on = !!pipWindow;
      btnPip.classList.toggle('bg-zinc-800', on);
      btnPip.classList.toggle('text-white', on);
      // visibility (not display:none) keeps the canvas rendering, which the PiP capture depends on.
      videoCanvas.classList.toggle('invisible', on);
      document.getElementById('pipView').classList.toggle('hidden', !on);
    }

    document.getElementById('btnExitPip').addEventListener('click', () => pipWindow?.close());
    document.getElementById('btnIdleConnect')?.addEventListener('click', (e) => {
      e.stopPropagation();
      toggleDevices(true);
    });
    document.getElementById('btnIdleWifiHelper')?.addEventListener('click', (e) => {
      e.stopPropagation();
      toggleDownload(true);
    });

    function releasePipStream() {
      pipStream?.getTracks().forEach((track) => track.stop());
      pipStream = null;
      pipCaptureCanvas = null;
    }

    function pipStreamFor(canvas) {
      const live = pipStream?.getVideoTracks().some((track) => track.readyState === 'live');
      if (live && pipCaptureCanvas === canvas) return pipStream;
      releasePipStream();
      pipCaptureCanvas = canvas;
      pipStream = canvas.captureStream(30);
      return pipStream;
    }

    function closePip() {
      clearTimeout(pipAspectTimer);
      clearTimeout(pipDockTimer);
      pipBezelSize = null;
      pipSettledSize = null;
      pipTrimFromUs = false;
      pipDockOpen = false;
      if (pipMinimized && pipPreferredSize) pipClosedMinimized = true;
      pipWindow = null;
      pipSizeKey = '';
      pipMinimized = false;
      pipRestoreSize = null;
      updatePipButton();
    }

    function resizePipTo(width, height) {
      if (!pipWindow) return;
      try {
        const frameW = Math.max(0, pipWindow.outerWidth - pipWindow.innerWidth);
        const frameH = Math.max(0, pipWindow.outerHeight - pipWindow.innerHeight);
        pipWindow.resizeTo(width + frameW, height + frameH);
      } catch (err) {
        console.warn('PiP resize failed', err);
      }
    }

    function openPipSize() {
      return pipPreferredSize ?? pipContentSize(videoCanvas.width, videoCanvas.height);
    }

    function onPipMinimizeHotkey(e) {
      if (!pipWindow || e.repeat) return false;
      if (!(e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey && e.code === 'KeyA')) return false;
      const tag = e.target?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || e.target?.isContentEditable) return false;
      e.preventDefault();
      e.stopPropagation();
      setPipMinimized(!pipMinimized);
      return true;
    }

    function setPipMinimized(minimized) {
      if (!pipWindow || minimized === pipMinimized) return;
      const doc = pipWindow.document;
      const video = doc.getElementById('pipVideo');
      const bar = doc.getElementById('pipMinBar');
      const minBtn = doc.getElementById('pipMinBtn');
      if (!video || !bar || !minBtn) return;
      if (minimized) {
        pipRestoreSize = { width: pipWindow.innerWidth, height: pipWindow.innerHeight };
        pipPreferredSize = { ...pipRestoreSize };
      }
      pipMinimized = minimized;
      doc.body.style.cursor = minimized ? 'pointer' : 'default';
      if (minimized) video.style.display = 'none';
      else applyPipLayout(video);
      bar.style.display = minimized ? 'flex' : 'none';
      minBtn.style.display = minimized ? 'none' : 'grid';
      minBtn.title = minimized ? 'Restore (Ctrl+A)' : 'Minimize (Ctrl+A)';
      minBtn.textContent = minimized ? '+' : '–';
      const chrome = doc.getElementById('pipChrome');
      if (chrome) chrome.style.display = minimized ? 'none' : 'flex';
      setPipChromeOpen(false);
      clearTimeout(pipDockTimer);
      if (minimized) {
        pipDockOpen = false;
        pipSizeKey = 'min';
        layoutPipDock();
        resizePipTo(PIP_DOCK_DOT.width, PIP_DOCK_DOT.height);
      } else if (pipRestoreSize) {
        pipDockOpen = false;
        pipSizeKey = `${video.videoWidth || videoCanvas.width}x${video.videoHeight || videoCanvas.height}`;
        resizePipTo(pipRestoreSize.width, pipRestoreSize.height);
      }
    }

    function setPipChromeOpen(open) {
      const doc = pipWindow?.document;
      if (!doc || pipMinimized) open = false;
      const fillBtn = doc?.getElementById('pipFillBtn');
      const bright = doc?.getElementById('pipBright');
      if (fillBtn) fillBtn.style.display = open ? 'grid' : 'none';
      if (bright) {
        bright.style.display = open ? 'block' : 'none';
        if (!open) {
          const pop = bright.querySelector('div');
          if (pop) pop.style.display = 'none';
        }
      }
    }

    function layoutPipDock() {
      const bar = pipWindow?.document.getElementById('pipMinBar');
      if (!bar) return;
      const collapsed = pipMinimized && !pipDockOpen;
      const innerW = pipWindow.innerWidth || PIP_DOCK_DOT.width;
      const shown = collapsed ? 1 : bar.children.length;
      const button = Math.max(28, Math.min(38, Math.floor((innerW - 12) / shown)));
      for (const child of bar.children) {
        const show = !collapsed || child.id === 'pipMinPlayBtn';
        child.style.display = show ? '' : 'none';
        if (!show) continue;
        child.style.width = `${button}px`;
        child.style.height = `${button}px`;
      }
      const play = bar.querySelector('#pipMinPlayBtn');
      if (play) play.title = collapsed ? 'Play / stop. Hover for controls' : 'Play / stop';
      bar.style.justifyContent = collapsed ? 'center' : 'space-evenly';
    }

    function setPipDockOpen(open) {
      if (!pipWindow || !pipMinimized) return;
      clearTimeout(pipDockTimer);
      if (open) {
        if (pipDockOpen) return;
        pipDockOpen = true;
        layoutPipDock();
        return;
      }
      pipDockTimer = setTimeout(() => {
        if (!pipWindow || !pipMinimized) return;
        if (pipWindow.document.querySelector(':hover')) return;
        pipDockOpen = false;
        layoutPipDock();
      }, 280);
    }

    function pipContentSize(width, height) {
      const shortSide = 200;
      const landscape = width >= height;
      let innerW = landscape ? Math.round(shortSide * width / height) : shortSide;
      let innerH = landscape ? shortSide : Math.round(shortSide * height / width);
      const maxW = screen.availWidth - 48;
      const maxH = screen.availHeight - 96;
      const scale = Math.min(1, maxW / innerW, maxH / innerH);
      return {
        width: Math.max(160, Math.round(innerW * scale)),
        height: Math.max(160, Math.round(innerH * scale)),
      };
    }

    function trimPipBezel() {
      if (!pipWindow || pipMinimized || pipTrimFromUs || pipFill) return;
      const video = pipWindow.document.getElementById('pipVideo');
      const videoW = video?.videoWidth || videoCanvas.width;
      const videoH = video?.videoHeight || videoCanvas.height;
      if (!videoW || !videoH) return;
      const innerW = pipWindow.innerWidth;
      const innerH = pipWindow.innerHeight;
      if (!innerW || !innerH) return;
      const settled = pipSettledSize;
      if (settled && Math.abs(innerW - settled.width) <= 2 && Math.abs(innerH - settled.height) <= 2) return;
      const aspect = videoW / videoH;
      const dw = settled ? Math.abs(innerW - settled.width) : 0;
      const dh = settled ? Math.abs(innerH - settled.height) : 0;
      const honorWidth = !settled || dw >= dh;
      const next = honorWidth
        ? { width: innerW, height: Math.max(80, Math.round(innerW / aspect)) }
        : { width: Math.max(80, Math.round(innerH * aspect)), height: innerH };
      if (Math.abs(next.width - innerW) <= 2 && Math.abs(next.height - innerH) <= 2) {
        pipSettledSize = { width: innerW, height: innerH };
        return;
      }
      if (pipBezelSize?.width === next.width && pipBezelSize?.height === next.height) return;
      pipBezelSize = next;
      pipSettledSize = next;
      pipTrimFromUs = true;
      resizePipTo(next.width, next.height);
      pipPreferredSize = { ...next };
      setTimeout(() => { pipTrimFromUs = false; }, 250);
    }

    function scheduleTrimPipBezel() {
      if (pipFill || pipTrimFromUs || pipMinimized) return;
      clearTimeout(pipAspectTimer);
      pipAspectTimer = setTimeout(trimPipBezel, 160);
    }

    function applyPipBrightness(video) {
      video.style.filter = pipBrightness === 100 ? 'none' : `brightness(${pipBrightness / 100})`;
    }

    function applyPipLayout(video) {
      if (!video) return;
      const base = 'display:block;margin:0;background:#000;cursor:pointer;outline:none;max-width:none;max-height:none;';
      if (!pipFill || !pipWindow || pipMinimized) {
        video.style.cssText = base + 'width:100vw;height:100vh;object-fit:fill;';
        applyPipBrightness(video);
        return;
      }
      const vw = video.videoWidth || videoCanvas.width;
      const vh = video.videoHeight || videoCanvas.height;
      const ww = pipWindow.innerWidth;
      const wh = pipWindow.innerHeight;
      if (!vw || !vh || !ww || !wh) {
        video.style.cssText = base + 'position:fixed;inset:0;width:100%;height:100%;object-fit:cover;';
        applyPipBrightness(video);
        return;
      }
      const scale = Math.max(ww / vw, wh / vh);
      const w = Math.ceil(vw * scale);
      const h = Math.ceil(vh * scale);
      const left = Math.round((ww - w) / 2);
      const top = Math.round((wh - h) / 2);
      video.style.cssText = `${base}position:fixed;width:${w}px;height:${h}px;left:${left}px;top:${top}px;object-fit:fill;`;
      applyPipBrightness(video);
    }

    function renderPipFillBtn() {
      const btn = pipWindow?.document.getElementById('pipFillBtn');
      if (!btn) return;
      btn.title = pipFill ? 'Fit inside window' : 'Fill display';
      btn.innerHTML = pipFill
        ? '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="4 14 10 14 10 20"/><polyline points="20 10 14 10 14 4"/><line x1="14" y1="10" x2="21" y2="3"/><line x1="3" y1="21" x2="10" y2="14"/></svg>'
        : '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 3 21 3 21 9"/><polyline points="9 21 3 21 3 15"/><line x1="21" y1="3" x2="14" y2="10"/><line x1="3" y1="21" x2="10" y2="14"/></svg>';
      btn.style.background = pipFill ? '#fff' : 'rgba(0,0,0,.55)';
      btn.style.color = pipFill ? '#18181b' : '#fff';
    }

    function fitPipWindow(width, height) {
      if (!pipWindow || pipMinimized || !width || !height) return;
      const key = `${width}x${height}`;
      if (pipSizeKey === key) return;
      resizePipTo(pipContentSize(width, height).width, pipContentSize(width, height).height);
      pipSizeKey = key;
    }

    async function pushFileToPhone(file) {
      if (!state.adb) {
        logTerm('Cannot transfer file: Phone not connected.', 'warn');
        return;
      }
      const destPath = `/sdcard/Download/${file.name}`;
      const sizeMb = (file.size / (1024 * 1024)).toFixed(1);
      logTerm(`Pushing ${file.name} (${sizeMb} MB) to ${destPath}...`, 'system');

      try {
        const sync = await state.adb.sync();
        try {
          await sync.write({
            filename: destPath,
            file: file.stream(),
            mtime: Math.floor(file.lastModified / 1000),
          });
        } finally {
          await sync.dispose();
        }
        logTerm(`Transferred: ${file.name} -> ${destPath}`, 'success');
      } catch (err) {
        console.error('File push failed:', err);
        logTerm(`File transfer failed for ${file.name}: ${err?.message ?? err}`, 'error');
      }
    }

    const dropOverlay = document.getElementById('dropOverlay');
    let windowDragCounter = 0;
    const setWindowDropOverlay = (show) => {
      if (dropOverlay) dropOverlay.classList.toggle('hidden', !show);
    };

    window.addEventListener('dragenter', (e) => {
      e.preventDefault();
      e.stopPropagation();
      windowDragCounter++;
      if (Array.from(e.dataTransfer?.types || []).includes('Files')) {
        setWindowDropOverlay(true);
      }
    });

    window.addEventListener('dragover', (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (e.dataTransfer) {
        e.dataTransfer.dropEffect = 'copy';
      }
    });

    window.addEventListener('dragleave', (e) => {
      e.preventDefault();
      e.stopPropagation();
      windowDragCounter--;
      if (windowDragCounter <= 0) {
        windowDragCounter = 0;
        setWindowDropOverlay(false);
      }
    });

    window.addEventListener('drop', async (e) => {
      e.preventDefault();
      e.stopPropagation();
      windowDragCounter = 0;
      setWindowDropOverlay(false);

      const files = e.dataTransfer?.files;
      if (!files || !files.length) return;

      if (!state.adb) {
        logTerm('Cannot transfer files: Phone not connected.', 'error');
        return;
      }

      for (const file of files) {
        await pushFileToPhone(file);
      }
    });

    async function enterPip(options = {}) {
      if (pipWindow && !options.replace) {
        pipWindow.close();
        return;
      }
      if (!('documentPictureInPicture' in window)) {
        logTerm('Picture-in-Picture is only available in standard Chrome tabs.', 'error');
        return;
      }
      if (!state.client || videoCanvas.classList.contains('hidden') || !videoCanvas.width) {
        logTerm('Connect a phone first, then activate PiP.', 'warn');
        return;
      }

      if (options.replace) pipGeneration++;
      const size = options.size ?? openPipSize();
      // First open has no saved size. Force it, or Chrome reopens the last large window.
      const useRequestedSize = options.preferInitial ?? (pipClosedMinimized || !pipPreferredSize);
      pipClosedMinimized = false;
      pipMinimized = !!options.startMinimized;
      pipSizeKey = pipMinimized ? 'min' : `${videoCanvas.width}x${videoCanvas.height}`;
      const win = await documentPictureInPicture.requestWindow({
        width: size.width,
        height: size.height,
        preferInitialWindowPlacement: useRequestedSize,
      });
      pipWindow = win;
      pipSettledSize = { width: size.width, height: size.height };
      pipBezelSize = null;

      const doc = win.document;
      doc.body.style.cssText = 'margin:0;background:#000;height:100%;overflow:hidden;font-family:Inter,sans-serif;';
      const video = doc.createElement('video');
      video.id = 'pipVideo';
      video.autoplay = true;
      video.muted = true;
      video.playsInline = true;
      video.tabIndex = 0;
      applyPipLayout(video);
      const brightWrap = doc.createElement('div');
      brightWrap.id = 'pipBright';
      brightWrap.style.cssText = 'position:relative;display:none;';
      const toolsBtn = doc.createElement('button');
      toolsBtn.type = 'button';
      toolsBtn.title = 'Controls';
      toolsBtn.innerHTML = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="5"/><line x1="12" y1="1" x2="12" y2="3"/><line x1="12" y1="21" x2="12" y2="23"/><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/><line x1="1" y1="12" x2="3" y2="12"/><line x1="21" y1="12" x2="23" y2="12"/><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/></svg>';
      toolsBtn.style.cssText = 'width:28px;height:28px;border:0;border-radius:999px;background:rgba(0,0,0,.55);color:#fff;cursor:pointer;display:grid;place-items:center;';
      const pop = doc.createElement('div');
      pop.style.cssText = 'display:none;margin-top:6px;align-items:center;gap:8px;padding:6px 8px;border-radius:16px;background:rgba(24,24,27,.92);border:1px solid #3f3f46;max-width:calc(100vw - 52px);flex-wrap:wrap;';
      const brightMark = doc.createElement('span');
      brightMark.innerHTML = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="5"/><line x1="12" y1="1" x2="12" y2="3"/><line x1="12" y1="21" x2="12" y2="23"/><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/><line x1="1" y1="12" x2="3" y2="12"/><line x1="21" y1="12" x2="23" y2="12"/><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/></svg>';
      brightMark.style.cssText = 'color:#fff;display:inline-flex;align-items:center;';
      const brightSlider = doc.createElement('input');
      brightSlider.type = 'range';
      brightSlider.min = '30';
      brightSlider.max = '200';
      brightSlider.value = String(pipBrightness);
      brightSlider.title = 'PiP brightness';
      brightSlider.style.cssText = 'width:72px;accent-color:#fff;';
      const screenBtn = doc.createElement('button');
      screenBtn.id = 'pipScreenBtn';
      screenBtn.type = 'button';
      screenBtn.style.cssText = 'width:26px;height:26px;border:0;border-radius:999px;font-size:13px;line-height:1;cursor:pointer;display:grid;place-items:center;flex:none;';
      const setToolsOpen = (open) => {
        pop.style.display = open ? 'flex' : 'none';
      };
      brightWrap.addEventListener('pointerenter', () => setToolsOpen(true));
      brightWrap.addEventListener('pointerleave', () => setToolsOpen(false));
      brightWrap.addEventListener('pointerdown', (e) => e.stopPropagation());
      brightSlider.addEventListener('input', () => {
        pipBrightness = Number(brightSlider.value);
        applyPipBrightness(video);
      });
      screenBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        setPhoneScreenOff(!chkTurnOffScreen.checked).catch(() => {});
      });
      const volStyle = 'width:26px;height:26px;border:0;border-radius:999px;background:transparent;color:#fff;font-size:15px;line-height:1;cursor:pointer;display:grid;place-items:center;flex:none;';
      const volDown = doc.createElement('button');
      volDown.type = 'button';
      volDown.title = 'Volume down';
      volDown.textContent = '−';
      volDown.style.cssText = volStyle;
      const volUp = doc.createElement('button');
      volUp.type = 'button';
      volUp.title = 'Volume up';
      volUp.textContent = '+';
      volUp.style.cssText = volStyle;
      bindHoldKey(volDown, 25);
      bindHoldKey(volUp, 24);
      const rotateBtn = doc.createElement('button');
      rotateBtn.id = 'pipRotateBtn';
      rotateBtn.type = 'button';
      rotateBtn.innerHTML = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg>';
      rotateBtn.style.cssText = volStyle;
      rotateBtn.title = 'Rotate screen (portrait / landscape)';
      rotateBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        rotateScreen().catch((err) => {
          logTerm(`Rotation failed: ${err?.message ?? err}`, 'error');
        });
      });
      const disconnectBtn = doc.createElement('button');
      disconnectBtn.id = 'pipDisconnectBtn';
      disconnectBtn.type = 'button';
      disconnectBtn.title = 'Disconnect';
      disconnectBtn.innerHTML = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18.36 6.64a9 9 0 1 1-12.73 0"/><line x1="12" y1="2" x2="12" y2="12"/></svg>';
      disconnectBtn.style.cssText = volStyle;
      disconnectBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        disconnect();
      });
      pop.append(brightMark, brightSlider, screenBtn, rotateBtn, volDown, volUp, disconnectBtn);
      brightWrap.append(toolsBtn, pop);
      const minBtn = doc.createElement('button');
      minBtn.id = 'pipMinBtn';
      minBtn.type = 'button';
      minBtn.title = 'Minimize (Ctrl+A)';
      minBtn.textContent = '–';
      minBtn.style.cssText = 'width:28px;height:28px;border:0;border-radius:999px;background:rgba(0,0,0,.55);color:#fff;font-size:18px;line-height:1;cursor:pointer;display:grid;place-items:center;flex:none;';
      minBtn.addEventListener('pointerdown', (e) => e.stopPropagation());
      minBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        setPipMinimized(!pipMinimized);
      });
      const fillBtn = doc.createElement('button');
      fillBtn.id = 'pipFillBtn';
      fillBtn.type = 'button';
      fillBtn.style.cssText = 'display:none;width:28px;height:28px;border:0;border-radius:999px;background:rgba(0,0,0,.55);color:#fff;font-size:16px;line-height:1;cursor:pointer;place-items:center;flex:none;';
      fillBtn.addEventListener('pointerdown', (e) => e.stopPropagation());
      fillBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        pipFill = !pipFill;
        if (pipFill) clearTimeout(pipAspectTimer);
        applyPipLayout(video);
        renderPipFillBtn();
      });
      renderPipFillBtn();
      const chrome = doc.createElement('div');
      chrome.id = 'pipChrome';
      chrome.style.cssText = 'position:fixed;top:8px;left:8px;z-index:3;display:flex;align-items:flex-start;gap:6px;';
      chrome.addEventListener('pointerenter', () => setPipChromeOpen(true));
      chrome.addEventListener('pointerleave', () => setPipChromeOpen(false));
      chrome.append(minBtn, fillBtn, brightWrap);
      const bar = buildWalkmanBar(doc);
      doc.body.addEventListener('click', (e) => {
        if (!pipMinimized || e.target.closest('button')) return;
        setPipMinimized(false);
      });
      doc.body.append(video, chrome, bar);
      if (pipMinimized) {
        video.style.display = 'none';
        bar.style.display = 'flex';
        minBtn.style.display = 'none';
        chrome.style.display = 'none';
        doc.body.style.cursor = 'pointer';
        pipDockOpen = false;
        layoutPipDock();
      }

      video.srcObject = pipStreamFor(videoCanvas);
      video.addEventListener('resize', () => {
        if (pipFill) {
          applyPipLayout(video);
          return;
        }
        fitPipWindow(video.videoWidth, video.videoHeight);
      });
      await video.play();
      state.client?.controller?.resetVideo()?.catch(() => {});
      attachInputHandlers(video);
      video.focus();

      renderPipScreenBtn();
      win.addEventListener('resize', () => {
        if (pipMinimized) {
          layoutPipDock();
          return;
        }
        if (pipFill) {
          applyPipLayout(win.document.getElementById('pipVideo'));
          return;
        }
        scheduleTrimPipBezel();
      });
      win.addEventListener('keydown', onPipMinimizeHotkey, true);
      const generation = ++pipGeneration;
      win.addEventListener('pagehide', () => {
        if (generation !== pipGeneration) return;
        closePip();
      });
      doc.documentElement.addEventListener('pointerenter', () => setPipDockOpen(true));
      doc.documentElement.addEventListener('pointerleave', () => setPipDockOpen(false));

      const dropOverlay = doc.createElement('div');
      dropOverlay.id = 'pipDropOverlay';
      dropOverlay.style.cssText = 'position:fixed;inset:0;background:rgba(9,9,11,0.92);backdrop-filter:blur(6px);z-index:9999;display:none;align-items:center;justify-content:center;pointer-events:none;color:#fff;font-family:Inter,sans-serif;text-align:center;border:1px dashed rgba(255,255,255,0.28);box-sizing:border-box;';
      doc.body.append(dropOverlay);

      const iconPhoneMin = '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="flex:none;opacity:0.9;"><rect x="5" y="2" width="14" height="20" rx="2.5"/><path d="M12 6v8m0 0l-2.5-2.5m2.5 2.5l2.5-2.5"/><path d="M10 18h4"/></svg>';
      const iconPhoneFull = '<svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" style="opacity:0.9;margin-bottom:2px;"><rect x="5" y="2" width="14" height="20" rx="3"/><path d="M12 6v8m0 0l-3-3m3 3l3-3"/><path d="M10 18h4"/></svg>';
      const iconCheckMin = '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="#34d399" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" style="flex:none;"><path d="M20 6L9 17l-5-5"/></svg>';
      const iconCheckFull = '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#34d399" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" style="margin-bottom:2px;"><path d="M20 6L9 17l-5-5"/></svg>';

      let dragCounter = 0;
      let overlayResetTimer = null;
      const setDropOverlay = (show, statusText = '', isSuccess = false) => {
        clearTimeout(overlayResetTimer);
        if (!show) {
          dropOverlay.style.display = 'none';
          return;
        }
        if (pipMinimized) {
          dropOverlay.style.flexDirection = 'row';
          dropOverlay.style.gap = '8px';
          dropOverlay.style.padding = '0 10px';
          const icon = isSuccess ? iconCheckMin : iconPhoneMin;
          dropOverlay.innerHTML = statusText
            ? `${icon}<span style="font-size:11px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:180px;">${statusText}</span>`
            : `${icon}<span style="font-size:11px;font-weight:600;white-space:nowrap;">Drop file to phone</span>`;
        } else {
          dropOverlay.style.flexDirection = 'column';
          dropOverlay.style.gap = '6px';
          dropOverlay.style.padding = '12px';
          const icon = isSuccess ? iconCheckFull : iconPhoneFull;
          dropOverlay.innerHTML = statusText
            ? `${icon}<div style="font-size:12px;font-weight:600;max-width:90%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${statusText}</div><div style="font-size:10px;color:#a1a1aa;font-family:monospace;">/sdcard/Download/</div>`
            : `${icon}<div style="font-size:12px;font-weight:600;">Drop file to push to phone</div><div style="font-size:10px;color:#a1a1aa;font-family:monospace;">/sdcard/Download/</div>`;
        }
        dropOverlay.style.display = 'flex';
      };

      const handleDragEnter = (e) => {
        e.preventDefault();
        e.stopPropagation();
        dragCounter++;
        if (Array.from(e.dataTransfer?.types || []).includes('Files')) {
          setDropOverlay(true);
        }
      };

      const handleDragOver = (e) => {
        e.preventDefault();
        e.stopPropagation();
        if (e.dataTransfer) {
          e.dataTransfer.dropEffect = 'copy';
        }
      };

      const handleDragLeave = (e) => {
        e.preventDefault();
        e.stopPropagation();
        dragCounter--;
        if (dragCounter <= 0 || !e.relatedTarget || !doc.contains(e.relatedTarget)) {
          dragCounter = 0;
          setDropOverlay(false);
        }
      };

      const handleDrop = async (e) => {
        e.preventDefault();
        e.stopPropagation();
        dragCounter = 0;

        const files = e.dataTransfer?.files;
        if (!files || !files.length) {
          setDropOverlay(false);
          return;
        }

        if (!state.adb) {
          logTerm('Cannot transfer files: Phone not connected.', 'error');
          setDropOverlay(true, 'Phone not connected');
          overlayResetTimer = setTimeout(() => setDropOverlay(false), 2000);
          return;
        }

        for (const file of files) {
          setDropOverlay(true, `Pushing ${file.name}...`);
          await pushFileToPhone(file);
        }
        setDropOverlay(true, `Saved ${files.length} file(s)!`, true);
        overlayResetTimer = setTimeout(() => setDropOverlay(false), 2000);
      };

      [win, doc, doc.body].forEach((target) => {
        target.addEventListener('dragenter', handleDragEnter);
        target.addEventListener('dragover', handleDragOver);
        target.addEventListener('dragleave', handleDragLeave);
        target.addEventListener('drop', handleDrop);
      });

      updatePipButton();
      if (!options.replace) {
        logTerm('Picture-in-Picture active. Ctrl+A to minimize or restore. Window stays on top.', 'success');
      }
    }

    btnPip.addEventListener('click', () => {
      enterPip().catch((err) => {
        console.error(err);
        try { pipWindow?.close(); } catch {}
        closePip();
        logTerm(`Picture-in-Picture failed: ${err?.message ?? err}`, 'error');
      });
    });

    function bindHoldKey(btn, code) {
      let timer = 0;
      const stop = () => {
        clearInterval(timer);
        timer = 0;
      };
      btn.addEventListener('pointerdown', (e) => {
        e.stopPropagation();
        e.preventDefault();
        sendAdbKey(code).catch(() => {});
        stop();
        timer = setInterval(() => sendAdbKey(code).catch(() => {}), 160);
      });
      btn.addEventListener('pointerup', stop);
      btn.addEventListener('pointercancel', stop);
      btn.addEventListener('pointerleave', stop);
      btn.addEventListener('click', (e) => e.stopPropagation());
    }

    function bindTapKey(btn, code) {
      btn.addEventListener('pointerdown', (e) => e.stopPropagation());
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        sendAdbKey(code).catch(() => {});
      });
    }

    function walkmanKey(doc, iconHtml, title) {
      const btn = doc.createElement('button');
      btn.type = 'button';
      btn.title = title;
      btn.innerHTML = iconHtml;
      btn.style.cssText = 'flex:none;width:34px;height:34px;border:0;border-radius:8px;background:#27272a;color:#f4f4f5;font-size:13px;line-height:1;cursor:pointer;display:inline-flex;align-items:center;justify-content:center;';
      return btn;
    }

    function buildWalkmanBar(doc) {
      const bar = doc.createElement('div');
      bar.id = 'pipMinBar';
      bar.style.cssText = 'display:none;box-sizing:border-box;width:100%;height:100%;align-items:center;justify-content:space-evenly;padding:0 6px;background:#09090b;';
      const iconBack = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 14 4 9 9 4"/><path d="M20 20v-7a4 4 0 0 0-4-4H4"/></svg>';
      const iconPrev = '<svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor"><polygon points="19 20 9 12 19 4 19 20"/><line x1="5" y1="19" x2="5" y2="5" stroke="currentColor" stroke-width="2"/></svg>';
      const iconPlay = '<svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor"><polygon points="5 3 19 12 5 21 5 3"/></svg>';
      const iconNext = '<svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor"><polygon points="5 4 15 12 5 20 5 4"/><line x1="19" y1="5" x2="19" y2="19" stroke="currentColor" stroke-width="2"/></svg>';
      const iconScreen = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="3" width="20" height="14" rx="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/></svg>';
      const iconHangup = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18.36 6.64a9 9 0 1 1-12.73 0"/><line x1="12" y1="2" x2="12" y2="12"/></svg>';
      const goBack = walkmanKey(doc, iconBack, 'Back to PiP');
      const backward = walkmanKey(doc, iconPrev, 'Backward');
      const play = walkmanKey(doc, iconPlay, 'Play / stop');
      play.id = 'pipMinPlayBtn';
      const next = walkmanKey(doc, iconNext, 'Next');
      const up = walkmanKey(doc, '+', 'Volume up');
      const down = walkmanKey(doc, '−', 'Volume down');
      const screen = walkmanKey(doc, iconScreen, 'Turn off phone screen');
      screen.id = 'pipMinScreenBtn';
      const hangUp = walkmanKey(doc, iconHangup, 'Disconnect');
      hangUp.id = 'pipMinDisconnectBtn';
      goBack.addEventListener('pointerdown', (e) => e.stopPropagation());
      goBack.addEventListener('click', (e) => {
        e.stopPropagation();
        setPipMinimized(false);
      });
      screen.addEventListener('pointerdown', (e) => e.stopPropagation());
      screen.addEventListener('click', (e) => {
        e.stopPropagation();
        setPhoneScreenOff(!chkTurnOffScreen.checked).catch(() => {});
      });
      hangUp.addEventListener('pointerdown', (e) => e.stopPropagation());
      hangUp.addEventListener('click', (e) => {
        e.stopPropagation();
        disconnect();
      });
      bindTapKey(backward, 88);
      bindTapKey(play, 85);
      bindTapKey(next, 87);
      bindHoldKey(up, 24);
      bindHoldKey(down, 25);
      bar.append(goBack, backward, play, next, down, up, screen, hangUp);
      return bar;
    }

    async function sendAdbKey(code) {
      const controller = state.client?.controller;
      if (controller) {
        const base = { keyCode: code, repeat: 0, metaState: 0 };
        await controller.injectKeyCode({ ...base, action: AndroidKeyEventAction.Down });
        await controller.injectKeyCode({ ...base, action: AndroidKeyEventAction.Up });
        return;
      }
      if (state.adb) {
        try {
          await state.adb.subprocess.noneProtocol.spawnWait(['input', 'keyevent', String(code)]);
          return;
        } catch (e) {
          logTerm(`Key event failed: ${e?.message ?? e}`, 'error');
        }
        return;
      }
      logTerm('No device connected.', 'warn');
    }

    async function expandNotifications() {
      if (state.adb) {
        try {
          await state.adb.subprocess.noneProtocol.spawnWait(['cmd', 'statusbar', 'expand']);
          logTerm('Notifications expanded.', 'system');
        } catch (e) {
          await sendAdbKey(83);
        }
      } else {
        logTerm('No device connected.', 'warn');
      }
    }

    async function injectTextToPhone(text) {
      if (!text) return;
      if (state.client?.controller) {
        try {
          await state.client.controller.setClipboard({
            content: text,
            paste: true,
          });
          logTerm(`Sent text: "${text}"`, 'success');
          return;
        } catch (e) {
          console.warn('Clipboard paste failed, trying shell input text:', e);
        }
      }
      if (state.adb) {
        try {
          const escaped = text.replace(/([\\"'`$\s&;()|<>{}[\]*?~!])/g, '\\$1');
          await state.adb.subprocess.noneProtocol.spawnWaitText(['input', 'text', escaped || text]);
          logTerm(`Sent text: "${text}"`, 'success');
        } catch (e) {
          logTerm(`Text send failed: ${e?.message ?? e}`, 'error');
        }
      } else {
        logTerm('No device connected.', 'warn');
      }
    }

    function renderMainViews() {
      const isRemote = state.viewMode === 'remote';
      const remoteView = document.getElementById('remoteView');
      const videoCanvas = document.getElementById('videoCanvas');
      const idleView = document.getElementById('idleView');
      const modeChooser = document.getElementById('modeChooser');
      const pipView = document.getElementById('pipView');
      const screenTools = document.getElementById('screenTools');

      if (isRemote) {
        if (idleView) { idleView.classList.add('hidden'); idleView.style.display = 'none'; }
        if (videoCanvas) { videoCanvas.classList.add('hidden'); videoCanvas.style.display = 'none'; }
        if (modeChooser) { modeChooser.classList.add('hidden'); modeChooser.style.display = 'none'; }
        if (pipView) { pipView.classList.add('hidden'); pipView.style.display = 'none'; }
        if (screenTools) screenTools.classList.add('hidden');
        if (remoteView) { remoteView.classList.remove('hidden'); remoteView.style.display = 'flex'; }
      } else {
        document.body.classList.remove('mirroring', 'tools-visible');
        if (remoteView) { remoteView.classList.add('hidden'); remoteView.style.display = 'none'; }
        if (pipWindow) {
          if (pipView) { pipView.classList.remove('hidden'); pipView.style.display = 'flex'; }
          if (videoCanvas) { videoCanvas.classList.add('hidden'); videoCanvas.style.display = 'none'; }
          if (idleView) { idleView.classList.add('hidden'); idleView.style.display = 'none'; }
          if (modeChooser) { modeChooser.classList.add('hidden'); modeChooser.style.display = 'none'; }
          if (screenTools) screenTools.classList.add('hidden');
        } else if (state.client && videoCanvas) {
          if (videoCanvas) { videoCanvas.classList.remove('hidden'); videoCanvas.style.display = 'block'; }
          if (idleView) { idleView.classList.add('hidden'); idleView.style.display = 'none'; }
          if (modeChooser) { modeChooser.classList.add('hidden'); modeChooser.style.display = 'none'; }
          if (pipView) { pipView.classList.add('hidden'); pipView.style.display = 'none'; }
          if (screenTools) screenTools.classList.remove('hidden');
          document.body.classList.add('mirroring');
          document.body.classList.remove('tools-visible');
        } else if (state.hasDex && !state.client) {
          showModeChooser(true);
        } else {
          if (idleView) { idleView.classList.remove('hidden'); idleView.style.display = 'flex'; }
          if (videoCanvas) { videoCanvas.classList.add('hidden'); videoCanvas.style.display = 'none'; }
          if (modeChooser) { modeChooser.classList.add('hidden'); modeChooser.style.display = 'none'; }
          if (pipView) { pipView.classList.add('hidden'); pipView.style.display = 'none'; }
          if (screenTools) screenTools.classList.add('hidden');
        }
      }
    }

    function setViewMode(mode) {
      state.viewMode = mode;
      const isRemote = mode === 'remote';
      const btnMirror = document.getElementById('btnModeMirror');
      const btnRemote = document.getElementById('btnModeRemote');
      const btnToolRemote = document.getElementById('btnToolRemote');

      if (btnMirror) {
        btnMirror.className = isRemote
          ? 'px-3 py-1 rounded-full text-zinc-400 hover:text-zinc-100 transition flex items-center gap-1.5'
          : 'px-3 py-1 rounded-full bg-zinc-800 text-zinc-100 font-medium transition flex items-center gap-1.5 shadow-sm';
      }
      if (btnRemote) {
        btnRemote.className = isRemote
          ? 'px-3 py-1 rounded-full bg-zinc-800 text-zinc-100 font-medium transition flex items-center gap-1.5 shadow-sm'
          : 'px-3 py-1 rounded-full text-zinc-400 hover:text-zinc-100 transition flex items-center gap-1.5';
      }
      if (btnToolRemote) {
        btnToolRemote.classList.toggle('bg-zinc-100', isRemote);
        btnToolRemote.classList.toggle('text-zinc-900', isRemote);
        btnToolRemote.classList.toggle('text-zinc-400', !isRemote);
      }

      renderMainViews();
      updateRemoteStatus();
      logTerm(isRemote
        ? 'Switched to Remote Control Mode (Wi-Fi / USB, 0% video overhead).'
        : 'Switched to Mirroring Mode.', 'system');
    }

    function updateRemoteStatus() {
      const dot = document.getElementById('remoteStatusDot');
      const txt = document.getElementById('remoteStatusText');
      if (dot && txt) {
        if (state.adb) {
          const linkType = state.link === 'wifi' ? 'Wi-Fi' : 'USB';
          const name = state.wifiSerial || state.usbDevice?.name || txtDeviceName?.textContent || 'Connected Phone';
          dot.className = 'w-2 h-2 rounded-full bg-emerald-400 shrink-0';
          txt.textContent = `${linkType} Remote Active · ${name}`;
        } else {
          dot.className = 'w-2 h-2 rounded-full bg-zinc-600 shrink-0';
          txt.textContent = 'No Device Connected (Connect via Wi-Fi or USB)';
        }
      }
    }

    // =========================================================================
    // WebRTC Peer-to-Peer TV & Phone Remote Logic
    // =========================================================================
    let tvRemotePeer = null;
    let activeRemoteConn = null;
    let tvRemotePeerUrl = '';
    let activityTimer = null;

    function flashRemoteActivity(text) {
      const pill = document.getElementById('remoteActivityPill');
      const txt = document.getElementById('remoteActivityText');
      if (!pill || !txt) return;
      txt.textContent = text;
      pill.classList.remove('hidden');
      clearTimeout(activityTimer);
      activityTimer = setTimeout(() => {
        pill.classList.add('hidden');
      }, 1500);
    }

    function renderRemoteQr(url) {
      const qrBox = document.getElementById('remoteQrBox');
      const qrSpinner = document.getElementById('remoteQrSpinner');
      const inputUrl = document.getElementById('remotePeerUrlInput');
      tvRemotePeerUrl = url;
      if (inputUrl) inputUrl.value = url;
      if (qrBox && typeof QRCode !== 'undefined') {
        qrBox.innerHTML = '';
        new QRCode(qrBox, {
          text: url,
          width: 170,
          height: 170,
          colorDark: '#09090b',
          colorLight: '#ffffff',
          correctLevel: QRCode.CorrectLevel.M,
        });
        if (qrSpinner) qrSpinner.style.display = 'none';
      }
    }

    function buildRemoteUrl(peerId) {
      const customHost = localStorage.getItem('webscrcpy-custom-remote-host');
      if (customHost) {
        const prefix = customHost.startsWith('http://') || customHost.startsWith('https://') ? '' : 'http://';
        const url = new URL(prefix + customHost.replace(/\/$/, '') + '/remote.html');
        url.searchParams.set('peer', peerId);
        return url.toString();
      }
      const remoteUrl = new URL('./remote.html', window.location.href);
      remoteUrl.searchParams.set('peer', peerId);
      return remoteUrl.toString();
    }

    function getLocalRemoteUrl(peerId) {
      const id = peerId || currentPeerHostId || (tvRemotePeer && tvRemotePeer.id);
      const url = new URL('./remote.html', window.location.href);
      if (id) url.searchParams.set('peer', id);
      return url.toString();
    }

    let currentPeerHostId = '';

    function detectLocalIp() {
      return new Promise((resolve) => {
        let done = false;
        const finish = (ip) => {
          if (!done) {
            done = true;
            try { pc.close(); } catch {}
            resolve(ip);
          }
        };
        let pc;
        try {
          const RTCPC = window.RTCPeerConnection || window.webkitRTCPeerConnection || window.mozRTCPeerConnection;
          if (!RTCPC) return finish(null);
          pc = new RTCPC({ iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] });
          pc.createDataChannel('local-ip-probe');
          pc.onicecandidate = (evt) => {
            if (!evt || !evt.candidate || !evt.candidate.candidate) return;
            const cand = evt.candidate.candidate;
            const parts = cand.split(' ');
            for (let i = 0; i < parts.length; i++) {
              const item = parts[i];
              if (/^(\d{1,3}\.){3}\d{1,3}$/.test(item)) {
                if (item !== '127.0.0.1' && !item.startsWith('0.') && !item.startsWith('169.254.')) {
                  finish(item);
                  return;
                }
              }
            }
          };
          pc.createOffer().then(o => pc.setLocalDescription(o)).catch(() => finish(null));
          setTimeout(() => finish(null), 1500);
        } catch {
          finish(null);
        }
      });
    }

    async function handleRemoteSwipe(direction) {
      const canvas = videoCanvas;
      const { width, height } = (canvas && surfaceSize(canvas).width) ? surfaceSize(canvas) : { width: 1080, height: 2340 };
      const cx = Math.round(width / 2);
      const cy = Math.round(height / 2);
      let x1 = cx, y1 = cy, x2 = cx, y2 = cy;
      if (direction === 'up') {
        y1 = Math.round(height * 0.70);
        y2 = Math.round(height * 0.30);
      } else if (direction === 'down') {
        y1 = Math.round(height * 0.30);
        y2 = Math.round(height * 0.70);
      } else if (direction === 'left') {
        x1 = Math.round(width * 0.80);
        x2 = Math.round(width * 0.20);
      } else if (direction === 'right') {
        x1 = Math.round(width * 0.20);
        x2 = Math.round(width * 0.80);
      }

      if (state.client?.controller) {
        const ctrl = state.client.controller;
        const pId = 0n;
        try {
          await ctrl.injectTouch({ action: AndroidMotionEventAction.Down, pointerId: pId, pointerX: x1, pointerY: y1, videoWidth: width, videoHeight: height, pressure: 1, actionButton: 0, buttons: 0 });
          const steps = 4;
          for (let i = 1; i <= steps; i++) {
            const curX = Math.round(x1 + (x2 - x1) * (i / steps));
            const curY = Math.round(y1 + (y2 - y1) * (i / steps));
            await ctrl.injectTouch({ action: AndroidMotionEventAction.Move, pointerId: pId, pointerX: curX, pointerY: curY, videoWidth: width, videoHeight: height, pressure: 1, actionButton: 0, buttons: 0 });
          }
          await ctrl.injectTouch({ action: AndroidMotionEventAction.Up, pointerId: pId, pointerX: x2, pointerY: y2, videoWidth: width, videoHeight: height, pressure: 0, actionButton: 0, buttons: 0 });
        } catch {}
      } else if (state.adb) {
        try {
          await state.adb.subprocess.noneProtocol.spawnWait(['input', 'swipe', String(x1), String(y1), String(x2), String(y2), '250']);
        } catch {}
      }
    }

    function handleRemoteScroll(scrollX, scrollY) {
      if (state.client?.controller) {
        const canvas = videoCanvas;
        const { width, height } = (canvas && surfaceSize(canvas).width) ? surfaceSize(canvas) : { width: 1080, height: 2340 };
        state.client.controller.injectScroll({
          pointerX: Math.round(width / 2),
          pointerY: Math.round(height / 2),
          videoWidth: width,
          videoHeight: height,
          scrollX: Math.min(Math.max(scrollX, -1), 1),
          scrollY: Math.min(Math.max(scrollY, -1), 1),
          buttons: 0,
        }).catch(() => {});
      }
    }

    function initTvRemotePeer() {
      if (tvRemotePeer) return;
      const statusText = document.getElementById('remotePeerText');
      const statusDot = document.getElementById('remotePeerDot');

      // Check if file:// or localhost is used and display the helper warning
      const isFileOrLocal = window.location.protocol === 'file:' || window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1';
      const warningBox = document.getElementById('remoteLocalWarning');
      const inputCustomHost = document.getElementById('inputCustomHost');
      if (isFileOrLocal && warningBox) {
        warningBox.classList.remove('hidden');
        if (inputCustomHost) {
          inputCustomHost.value = localStorage.getItem('webscrcpy-custom-remote-host') || '';
        }

        // Auto-detect computer LAN IP so user does not need to type manually
        detectLocalIp().then((ip) => {
          const badge = document.getElementById('remoteAutoIpBadge');
          const desc = document.getElementById('remoteLocalWarningDesc');
          if (ip) {
            const port = window.location.port || '8000';
            const autoHost = `${ip}:${port}`;
            if (badge) {
              badge.textContent = `LAN: ${ip}`;
              badge.className = 'text-[9px] font-mono px-1.5 py-0.5 rounded bg-emerald-950/60 border border-emerald-800 text-emerald-400';
            }
            if (desc) {
              desc.textContent = `Auto-detected LAN host: ${autoHost}. QR code configured for phone access.`;
            }
            if (!localStorage.getItem('webscrcpy-custom-remote-host')) {
              if (inputCustomHost) inputCustomHost.value = autoHost;
              localStorage.setItem('webscrcpy-custom-remote-host', autoHost);
              if (currentPeerHostId) {
                const targetUrl = buildRemoteUrl(currentPeerHostId);
                renderRemoteQr(targetUrl);
              }
            }
            logTerm('Auto-detected computer LAN IP: ' + autoHost, 'success');
          } else {
            if (badge) badge.textContent = 'Manual LAN IP';
          }
        });
      }

      if (typeof Peer === 'undefined') {
        if (statusText) statusText.textContent = 'PeerJS library not loaded.';
        return;
      }

      const hostId = 'webscrcpy-' + Math.random().toString(36).substring(2, 10);
      try {
        tvRemotePeer = new Peer(hostId, {
          debug: 1,
          config: {
            iceServers: [
              { urls: 'stun:stun.l.google.com:19302' },
              { urls: 'stun:stun1.l.google.com:19302' },
              { urls: 'stun:stun2.l.google.com:19302' },
            ]
          }
        });
      } catch (err) {
        console.error('Peer init error:', err);
        if (statusText) statusText.textContent = 'Failed to initialize peer.';
        return;
      }

      tvRemotePeer.on('open', (id) => {
        currentPeerHostId = id;
        const targetUrl = buildRemoteUrl(id);
        renderRemoteQr(targetUrl);
        const btnOpen = document.getElementById('btnOpenRemoteTab');
        if (btnOpen) btnOpen.href = getLocalRemoteUrl(id);

        if (statusText) statusText.textContent = 'Scan QR code with phone';
        if (statusDot) statusDot.className = 'w-1.5 h-1.5 rounded-full bg-zinc-400 animate-pulse';
      });

      tvRemotePeer.on('connection', (conn) => {
        activeRemoteConn = conn;
        if (statusText) statusText.textContent = 'Phone connected (WebRTC P2P)';
        if (statusDot) statusDot.className = 'w-1.5 h-1.5 rounded-full bg-emerald-400';
        logTerm('Phone Remote connected via WebRTC: ' + conn.peer, 'success');
        flashRemoteActivity('Phone connected');
        try { conn.send({ type: 'screen_state', off: !!chkTurnOffScreen.checked }); } catch {}

        conn.on('data', (data) => {
          if (!data) return;
          if (data.type === 'key' && typeof data.code === 'number') {
            sendAdbKey(data.code).catch(() => {});
            flashRemoteActivity('Key: ' + data.code);
          } else if (data.type === 'text' && typeof data.text === 'string') {
            injectTextToPhone(data.text).catch(() => {});
            flashRemoteActivity('Text: "' + data.text.slice(0, 15) + '"');
          } else if (data.type === 'swipe' && typeof data.direction === 'string') {
            handleRemoteSwipe(data.direction).catch(() => {});
            flashRemoteActivity('Swipe: ' + data.direction.toUpperCase());
          } else if (data.type === 'scroll') {
            handleRemoteScroll(data.scrollX || 0, data.scrollY || 0);
          } else if (data.type === 'toggle_screen' || data.type === 'screen_off') {
            const nextOff = typeof data.off === 'boolean' ? data.off : !chkTurnOffScreen.checked;
            setPhoneScreenOff(nextOff).then(() => {
              try { conn.send({ type: 'screen_state', off: chkTurnOffScreen.checked }); } catch {}
            }).catch(() => {});
            flashRemoteActivity(nextOff ? 'Phone screen off' : 'Phone screen on');
          }
        });

        conn.on('close', () => {
          if (activeRemoteConn === conn) activeRemoteConn = null;
          if (statusText) statusText.textContent = 'Phone disconnected. Waiting for scan...';
          if (statusDot) statusDot.className = 'w-1.5 h-1.5 rounded-full bg-zinc-400 animate-pulse';
          logTerm('Phone Remote WebRTC disconnected.', 'warn');
        });
      });

      tvRemotePeer.on('error', (err) => {
        console.warn('Peer error:', err);
        if (statusText) statusText.textContent = 'P2P Error: ' + (err?.type || err?.message || err);
        if (statusDot) statusDot.className = 'w-1.5 h-1.5 rounded-full bg-rose-500';
      });
    }

    function initRemoteControls() {
      document.getElementById('btnModeMirror')?.addEventListener('click', () => setViewMode('mirror'));
      document.getElementById('btnModeRemote')?.addEventListener('click', () => setViewMode('remote'));
      document.getElementById('btnToolRemote')?.addEventListener('click', () => {
        setViewMode(state.viewMode === 'remote' ? 'mirror' : 'remote');
      });

      // Auto detect LAN IP button
      document.getElementById('btnAutoDetectIp')?.addEventListener('click', async () => {
        logTerm('Probing local network IP via WebRTC...', 'system');
        const badge = document.getElementById('remoteAutoIpBadge');
        const desc = document.getElementById('remoteLocalWarningDesc');
        if (badge) badge.textContent = 'Probing...';
        const ip = await detectLocalIp();
        if (ip) {
          const port = window.location.port || '8000';
          const autoHost = `${ip}:${port}`;
          const input = document.getElementById('inputCustomHost');
          if (input) input.value = autoHost;
          localStorage.setItem('webscrcpy-custom-remote-host', autoHost);
          if (currentPeerHostId) {
            const newUrl = buildRemoteUrl(currentPeerHostId);
            renderRemoteQr(newUrl);
          }
          if (badge) {
            badge.textContent = `LAN: ${ip}`;
            badge.className = 'text-[9px] font-mono px-1.5 py-0.5 rounded bg-emerald-950/60 border border-emerald-800 text-emerald-400';
          }
          if (desc) {
            desc.textContent = `Auto-detected LAN host: ${autoHost}. QR code configured for phone access.`;
          }
          logTerm(`Auto-detected computer LAN IP: ${autoHost}`, 'success');
        } else {
          if (badge) badge.textContent = 'Manual LAN IP';
          logTerm('Could not auto-detect LAN IP. Please enter it manually.', 'warn');
        }
      });

      // Apply custom remote host URL / IP
      document.getElementById('btnApplyCustomHost')?.addEventListener('click', () => {
        const input = document.getElementById('inputCustomHost');
        const val = input ? input.value.trim() : '';
        if (val) {
          localStorage.setItem('webscrcpy-custom-remote-host', val);
        } else {
          localStorage.removeItem('webscrcpy-custom-remote-host');
        }
        if (currentPeerHostId) {
          const newUrl = buildRemoteUrl(currentPeerHostId);
          renderRemoteQr(newUrl);
          logTerm('Updated remote QR with host: ' + (val || 'default'), 'system');
        }
      });

      // Copy pairing link button
      const btnCopyRemoteUrl = document.getElementById('btnCopyRemoteUrl');
      const txtCopyRemoteUrl = document.getElementById('txtCopyRemoteUrl');
      btnCopyRemoteUrl?.addEventListener('click', async () => {
        if (!tvRemotePeerUrl) return;
        try {
          await navigator.clipboard.writeText(tvRemotePeerUrl);
          if (txtCopyRemoteUrl) txtCopyRemoteUrl.textContent = 'Copied!';
          setTimeout(() => { if (txtCopyRemoteUrl) txtCopyRemoteUrl.textContent = 'Copy'; }, 2000);
        } catch {
          prompt('Pairing URL:', tvRemotePeerUrl);
        }
      });

      // Open pairing link in new tab on this computer
      document.getElementById('btnOpenRemoteTab')?.addEventListener('click', (e) => {
        const id = currentPeerHostId || (tvRemotePeer && tvRemotePeer.id);
        if (!id) {
          e.preventDefault();
          logTerm('Remote pairing link is still initializing. Please wait a moment...', 'warn');
          return;
        }
        const localUrl = getLocalRemoteUrl(id);
        e.currentTarget.href = localUrl;
      });

      // Initialize WebRTC P2P peer so QR code is ready immediately
      initTvRemotePeer();
    }

    function markCustomProfile() {
      const txtProfile = document.getElementById('txtActiveProfile');
      if (txtProfile) txtProfile.textContent = 'Custom';
      const unselected = 'py-1.5 px-1 rounded-lg text-zinc-400 hover:text-white transition flex flex-col items-center gap-0.5';
      const btnG = document.getElementById('profGaming');
      const btnB = document.getElementById('profBalanced');
      const btnQ = document.getElementById('profQuality');
      if (btnG) btnG.className = unselected;
      if (btnB) btnB.className = unselected;
      if (btnQ) btnQ.className = unselected;
    }

    function applyQualityProfile(profile) {
      const txtProfile = document.getElementById('txtActiveProfile');
      const btnG = document.getElementById('profGaming');
      const btnB = document.getElementById('profBalanced');
      const btnQ = document.getElementById('profQuality');

      const unselected = 'py-1.5 px-1 rounded-lg text-zinc-400 hover:text-white transition flex flex-col items-center gap-0.5';
      const selected = 'py-1.5 px-1 rounded-lg bg-zinc-800 text-white font-medium transition flex flex-col items-center gap-0.5';

      let res = '1080p';
      let bitrate = 8;
      let fps = 60;
      let label = 'Balanced';

      if (profile === 'gaming') {
        res = '720p';
        bitrate = 4;
        fps = 60;
        label = 'Gaming (720p · 4M)';
      } else if (profile === 'quality') {
        res = '1080p';
        bitrate = 16;
        fps = 60;
        label = 'Quality (1080p · 16M)';
      } else {
        res = '1080p';
        bitrate = 8;
        fps = 60;
        label = 'Balanced (1080p · 8M)';
      }

      if (btnG) btnG.className = profile === 'gaming' ? selected : unselected;
      if (btnB) btnB.className = profile === 'balanced' ? selected : unselected;
      if (btnQ) btnQ.className = profile === 'quality' ? selected : unselected;
      if (txtProfile) txtProfile.textContent = label.split(' ')[0];

      state.bitrate = bitrate;
      state.fps = fps;

      const rBitrate = document.getElementById('rangeBitrate');
      const rFps = document.getElementById('rangeFps');
      if (rBitrate) rBitrate.value = String(bitrate);
      if (rFps) rFps.value = String(fps);
      document.getElementById('txtBitrate').textContent = `${bitrate} Mbps`;
      document.getElementById('txtFps').textContent = `${fps} FPS`;

      setResolution(res);
      logTerm(`Applied ${label} performance profile.`, 'system');
    }

    document.getElementById('profGaming')?.addEventListener('click', () => applyQualityProfile('gaming'));
    document.getElementById('profBalanced')?.addEventListener('click', () => applyQualityProfile('balanced'));
    document.getElementById('profQuality')?.addEventListener('click', () => applyQualityProfile('quality'));

    document.getElementById('rangeBitrate').addEventListener('input', (e) => {
      document.getElementById('txtBitrate').textContent = `${e.target.value} Mbps`;
      markCustomProfile();
    });
    document.getElementById('rangeBitrate').addEventListener('change', (e) => {
      state.bitrate = Number(e.target.value);
      restartMirror();
    });
    document.getElementById('rangeFps').addEventListener('input', (e) => {
      document.getElementById('txtFps').textContent = `${e.target.value} FPS`;
      markCustomProfile();
    });
    document.getElementById('rangeFps').addEventListener('change', (e) => {
      state.fps = Number(e.target.value);
      restartMirror();
    });
    chkStayAwake.addEventListener('change', () => restartMirror());
    async function setPhoneScreenOff(off) {
      chkTurnOffScreen.checked = off;
      renderPipScreenBtn();
      updateRemoteStatus();
      if (activeRemoteConn && activeRemoteConn.open) {
        try { activeRemoteConn.send({ type: 'screen_state', off }); } catch {}
      }
      const controller = state.client?.controller;
      if (controller) {
        await controller.setScreenPowerMode(off ? AndroidScreenPowerMode.Off : AndroidScreenPowerMode.Normal);
      } else if (state.adb) {
        if (off) {
          await state.adb.subprocess.noneProtocol.spawnWait(['settings', 'put', 'system', 'screen_brightness', '0']).catch(() => {});
        } else {
          await state.adb.subprocess.noneProtocol.spawnWait(['settings', 'put', 'system', 'screen_brightness', '128']).catch(() => {});
        }
      }
      logTerm(off ? 'Phone physical screen turned off.' : 'Phone physical screen turned on.', 'system');
    }

    function renderPipScreenBtn() {
      const off = chkTurnOffScreen.checked;
      const title = off ? 'Phone screen is off' : 'Turn off phone screen';
      const drawer = pipWindow?.document.getElementById('pipScreenBtn');
      if (drawer) {
        drawer.innerHTML = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="3" width="20" height="14" rx="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/></svg>';
        drawer.title = title;
        drawer.style.background = off ? '#fff' : 'transparent';
        drawer.style.color = off ? '#18181b' : '#fff';
      }
      const min = pipWindow?.document.getElementById('pipMinScreenBtn');
      if (min) {
        min.title = title;
        min.style.background = off ? '#f4f4f5' : '#27272a';
        min.style.color = off ? '#18181b' : '#f4f4f5';
      }
    }

    async function rotateScreen() {
      const adb = state.adb;
      if (!adb) {
        logTerm('No device connected.', 'warn');
        return;
      }
      const landscape = videoCanvas.width > videoCanvas.height;
      const rotation = landscape ? '0' : '1';
      const shell = (args) => adb.subprocess.noneProtocol.spawnWaitText(args);
      const out = await shell(['cmd', 'window', 'user-rotation', 'lock', rotation]).catch((err) => String(err?.message ?? err));
      if (/unknown|error|exception|not found/i.test(out)) {
        await shell(['settings', 'put', 'system', 'accelerometer_rotation', '0']);
        await shell(['settings', 'put', 'system', 'user_rotation', rotation]);
      }
      logTerm(landscape
        ? 'Rotated to portrait.'
        : 'Rotated to landscape.', 'system');
    }

    chkTurnOffScreen.addEventListener('change', () => {
      setPhoneScreenOff(chkTurnOffScreen.checked).catch(() => {});
    });

    function renderResolution() {
      ['res1080', 'res720', 'res480'].forEach(id => {
        const el = document.getElementById(id);
        el.className = id === `res${state.resolution.replace('p', '')}`
          ? 'py-1.5 rounded-lg bg-zinc-800 text-white font-medium transition'
          : 'py-1.5 rounded-lg text-zinc-500 hover:text-zinc-300 transition';
      });
    }

    function setResolution(res) {
      if (state.resolution === res) return;
      state.resolution = res;
      renderResolution();
      restartMirror();
    }
    window.setResolution = setResolution;
    document.getElementById('btnChooseMirror').addEventListener('click', () => chooseDisplayMode('mirror'));
    document.getElementById('btnChooseDex').addEventListener('click', () => chooseDisplayMode('dex'));
    document.getElementById('setMirror').addEventListener('click', () => chooseDisplayMode('mirror'));
    document.getElementById('setDex').addEventListener('click', () => chooseDisplayMode('dex'));

    document.getElementById('btnClearTerm').addEventListener('click', () => {
      termOutput.innerHTML = '';
    });

    termForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      let cmd = termInput.value.trim();
      if (!cmd) return;
      termInput.value = '';
      logTerm(`$ ${cmd}`);

      if (cmd === 'clear') {
        termOutput.innerHTML = '';
        return;
      }
      if (!state.adb) {
        logTerm('No device connected. Click "Connect" (USB) first.', 'warn');
        return;
      }
      cmd = cmd.replace(/^adb\s+shell\s+/, '');
      try {
        const output = await state.adb.subprocess.noneProtocol.spawnWaitText(cmd);
        logTerm(output.trimEnd() || '(no output)', 'success');
      } catch (err) {
        logTerm(`Error: ${err?.message ?? err}`, 'error');
      }
    });

    setInterval(() => {
      const decoder = state.decoder;
      if (!decoder) return;
      const frames = decoder.framesRendered;
      badgeFps.textContent = `${frames - state.lastFrames} FPS`;
      state.lastFrames = frames;
    }, 1000);

    window.addEventListener('beforeunload', () => {
      state.client?.close();
      state.adb?.close();
    });

    renderResolution();
    renderDisplayMode();
    updateConnectionStatus();
    initRemoteControls();
    logTerm(navigator.usb ? 'WebUSB is available. Ready to connect.' : 'WebUSB is not supported in this browser.', navigator.usb ? 'success' : 'error');
 
    const btnToggleManualIp = document.getElementById('btnToggleManualIp');
    const formManualIp = document.getElementById('formManualIp');
    const inputManualIp = document.getElementById('inputManualIp');

    if (btnToggleManualIp && formManualIp) {
      btnToggleManualIp.addEventListener('click', (e) => {
        e.stopPropagation();
        formManualIp.classList.toggle('hidden');
        if (!formManualIp.classList.contains('hidden')) inputManualIp?.focus();
      });
      formManualIp.addEventListener('submit', (e) => {
        e.preventDefault();
        const raw = inputManualIp.value.trim();
        const match = raw.match(/^([0-9.]+)(?::(\d{1,5}))?$/);
        const ip = match?.[1] || '';
        const port = match?.[2] ? Number(match[2]) : 5555;
        if (!isLan(ip) || port < 1 || port > 65535) {
          logTerm('Enter an IP or IP:port, e.g. 192.168.1.50 or 192.168.1.50:37123 (Wireless debugging ports are random).', 'warn');
          return;
        }
        const phone = { serial: `${ip}:${port}`, name: `Phone (${ip}:${port})`, host: ip, port };
        saveWifiPhone(phone);
        formManualIp.classList.add('hidden');
        inputManualIp.value = '';
        useWifi(phone).catch((err) => {
          console.error(err);
          logTerm(`Wi-Fi error: ${err?.message ?? err}`, 'error');
        });
      });
    }

    document.getElementById('btnSyncClipboard').addEventListener('click', async () => {
      try {
        const text = await navigator.clipboard.readText();
        if (!text) {
          logTerm('Clipboard is empty.', 'warn');
          return;
        }
        if (state.client?.controller) {
          await state.client.controller.setClipboard({ content: text, paste: false });
          const preview = text.length > 50 ? `${text.slice(0, 50)}…` : text;
          logTerm(`Clipboard synced to phone: ${preview.replace(/\s+/g, ' ')}`, 'success');
        } else if (state.adb) {
          const escapedText = text.replace(/([ "$`\\])/g, '\\$1');
          await state.adb.subprocess.noneProtocol.spawnWaitText(['input', 'text', escapedText]);
          const preview = text.length > 50 ? `${text.slice(0, 50)}…` : text;
          logTerm(`Text typed to phone: ${preview.replace(/\s+/g, ' ')}`, 'success');
        } else {
          logTerm('No phone connected.', 'warn');
        }
      } catch (err) {
        console.error('Failed to read clipboard:', err);
        logTerm(`Clipboard access denied: ${err?.message ?? err}. Please allow clipboard permission in your browser.`, 'warn');
      }
    });
