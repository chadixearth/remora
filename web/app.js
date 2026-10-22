// @ts-check
import { loadHosts, removeHost } from './js/beacon.js';
import { HostClient, pairFromLink } from './js/client.js';

/** @type {HostClient|null} */
let client = null;
/** @type {any} */
let termInstance = null;
/** @type {any} */
let fitAddon = null;
let termOpened = false;
let currentDir = '';
/** @type {ReturnType<typeof setInterval>|null} */
let statusTimer = null;
let screenActive = false;

const el = (/** @type {string} */ id) => document.getElementById(id);

function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return '—';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
}

function formatUptime(sec) {
  if (!Number.isFinite(sec)) return '—';
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

function setStatusBadge(phase, text) {
  const pill = el('conn-pill');
  const label = el('conn-label');
  if (!pill || !label) return;
  pill.className = `status-pill ${phase}`;
  label.textContent = text;
}

function switchView(viewName) {
  document.querySelectorAll('.nav-tab').forEach((btn) => {
    btn.classList.toggle('active', btn.getAttribute('data-target') === viewName);
  });
  document.querySelectorAll('[data-view]').forEach((panel) => {
    panel.classList.toggle('active', panel.getAttribute('data-view') === viewName);
  });

  if (viewName === 'terminal') {
    ensureTerminalSession();
  }
  if (viewName === 'files' && client?.hello) {
    void loadDirectory(currentDir);
  }
  if (viewName === 'display') {
    startScreenIfReady();
  } else if (screenActive) {
    stopScreen();
  }
}

async function initTerminalUi() {
  if (termInstance) return;
  const mount = el('term-mount');
  if (!mount) return;
  try {
    const xtermMod = await import('./vendor/xterm.mjs');
    const fitMod = await import('./vendor/addon-fit.mjs');
    const Terminal = xtermMod.Terminal || xtermMod.default?.Terminal;
    const FitAddon = fitMod.FitAddon || fitMod.default?.FitAddon;
    if (!Terminal) return;
    termInstance = new Terminal({
      fontFamily: '"SF Mono", "Geist Mono", "JetBrains Mono", monospace',
      fontSize: 13,
      cursorBlink: true,
      theme: {
        background: '#141413',
        foreground: '#F7F6F3',
        cursor: '#F7F6F3',
      },
    });
    if (FitAddon) {
      fitAddon = new FitAddon();
      termInstance.loadAddon(fitAddon);
    }
    termInstance.open(mount);
    fitAddon?.fit();
    termInstance.writeln('Remora Mobile Terminal — Pair or connect your laptop to attach a live shell.');
    termInstance.onData((data) => {
      if (client && termOpened) {
        client.send({ type: 'term.input', id: 'main', data });
      }
    });
    window.addEventListener('resize', () => {
      if (!fitAddon || !termInstance) return;
      fitAddon.fit();
      if (client && termOpened) {
        client.send({ type: 'term.resize', id: 'main', cols: termInstance.cols, rows: termInstance.rows });
      }
    });
  } catch (err) {
    mount.textContent = `Terminal module load error: ${err.message}`;
  }
}

function ensureTerminalSession() {
  void initTerminalUi().then(() => {
    fitAddon?.fit();
    if (!client || !client.hello) return;
    if (!client.hello.permissions?.terminal) {
      const banner = el('term-perm-note');
      if (banner) banner.hidden = false;
      return;
    }
    const banner = el('term-perm-note');
    if (banner) banner.hidden = true;
    if (!termOpened && termInstance) {
      termOpened = true;
      termInstance.clear();
      client.send({
        type: 'term.open',
        id: 'main',
        cols: termInstance.cols || 80,
        rows: termInstance.rows || 24,
      });
    }
  });
}

async function refreshTelemetry() {
  if (!client || !client.hello) return;
  try {
    const st = await client.request({ type: 'status' });
    const cpuEl = el('metric-cpu');
    const memEl = el('metric-mem');
    const batEl = el('metric-bat');
    const upEl = el('metric-up');
    if (cpuEl) cpuEl.textContent = `${Math.round(st.cpu)}%`;
    if (memEl && st.mem) {
      const pct = Math.round((st.mem.used / st.mem.total) * 100);
      memEl.textContent = `${pct}%`;
    }
    if (batEl) {
      batEl.textContent = st.battery ? `${st.battery.percent}%` : 'AC';
    }
    if (upEl) upEl.textContent = formatUptime(st.uptime);
  } catch {
    // Ignore transient status poll timeouts.
  }
}

async function loadDirectory(dirPath) {
  const listEl = el('files-list');
  const pathEl = el('files-current-path');
  const permNote = el('files-perm-note');
  if (!listEl || !pathEl) return;

  if (!client || !client.hello) {
    listEl.innerHTML = '<div class="list-row"><div class="row-main"><div class="row-title">Connect Remora Desktop to browse live filesystem</div><div class="row-code">Or use the VS Code folder cards on the Workspace tab.</div></div></div>';
    return;
  }

  if (!client.hello.permissions?.files) {
    if (permNote) permNote.hidden = false;
    listEl.innerHTML = '<div class="list-row"><div class="row-main"><div class="row-title">Files permission is off on laptop</div><div class="row-code">Enable Files in the Remora desktop window on ChadiEarthy.</div></div></div>';
    return;
  }
  if (permNote) permNote.hidden = true;

  try {
    const res = await client.request({ type: 'files.list', path: dirPath });
    currentDir = res.path || '';
    pathEl.textContent = currentDir || 'System Roots';
    const upBtn = el('files-up-btn');
    if (upBtn) {
      upBtn.onclick = () => {
        if (res.parent !== null && res.parent !== undefined) {
          void loadDirectory(res.parent);
        }
      };
    }

    listEl.innerHTML = '';
    for (const item of res.entries || []) {
      const row = document.createElement('div');
      row.className = 'list-row';

      const main = document.createElement('div');
      main.className = 'row-main';

      const title = document.createElement('div');
      title.className = 'row-title';
      title.textContent = item.dir ? `${item.name}/` : item.name;

      const meta = document.createElement('div');
      meta.className = 'row-code';
      meta.textContent = item.dir ? item.path : `${formatBytes(item.size)} · ${item.path}`;

      main.append(title, meta);

      const action = document.createElement('button');
      action.className = 'btn-secondary';
      action.textContent = item.dir ? 'Open' : 'Download';
      action.onclick = () => {
        if (item.dir) void loadDirectory(item.path);
        else void client?.downloadFile(item.path);
      };

      row.append(main, action);
      listEl.appendChild(row);
    }
  } catch (err) {
    listEl.innerHTML = `<div class="list-row"><div class="row-main"><div class="row-title">Could not list directory</div><div class="row-code">${err.message}</div></div></div>`;
  }
}

function startScreenIfReady() {
  const statusEl = el('screen-status-note');
  if (!client || !client.hello) {
    if (statusEl) statusEl.textContent = 'Pair with the Remora desktop app to stream live display frames.';
    return;
  }
  if (!client.hello.permissions?.screen) {
    if (statusEl) statusEl.textContent = 'Screen permission is turned off on the laptop.';
    return;
  }
  const presetEl = /** @type {HTMLSelectElement|null} */ (el('screen-quality'));
  const mode = presetEl?.value || 'balanced';
  const cfg = mode === 'fast'
    ? { maxWidth: 960, quality: 0.45, fps: 15 }
    : mode === 'sharp'
      ? { maxWidth: 1920, quality: 0.75, fps: 8 }
      : { maxWidth: 1280, quality: 0.6, fps: 12 };
  screenActive = true;
  if (statusEl) statusEl.textContent = 'Streaming live display…';
  client.send({ type: 'screen.start', ...cfg });
}

function stopScreen() {
  screenActive = false;
  client?.send({ type: 'screen.stop' });
}

async function drawScreenFrame(blob) {
  const canvas = /** @type {HTMLCanvasElement|null} */ (el('screen-canvas'));
  if (!canvas) return;
  try {
    const bmp = await createImageBitmap(blob);
    if (canvas.width !== bmp.width || canvas.height !== bmp.height) {
      canvas.width = bmp.width;
      canvas.height = bmp.height;
    }
    const ctx = canvas.getContext('2d');
    ctx?.drawImage(bmp, 0, 0);
    bmp.close();
  } finally {
    if (screenActive) client?.send({ type: 'screen.ack' });
  }
}

function connectHost(record) {
  client?.close();
  if (statusTimer) clearInterval(statusTimer);
  termOpened = false;

  const hostLabel = el('host-subtitle');
  if (hostLabel) hostLabel.textContent = `${record.name} · paired host`;

  client = new HostClient(record, {
    onState(st) {
      if (st.phase === 'online') {
        setStatusBadge('online', 'Live Session');
        const pairBox = el('pair-card');
        if (pairBox) pairBox.hidden = true;
        void refreshTelemetry();
        statusTimer = setInterval(refreshTelemetry, 5000);
      } else if (st.phase === 'connecting' || st.phase === 'resolving') {
        setStatusBadge('connecting', 'Connecting');
      } else if (st.phase === 'unauthorized') {
        setStatusBadge('offline', 'Revoked');
        removeHost(record.hostId);
      } else {
        setStatusBadge('offline', 'Standby');
      }
    },
    onPermissions() {
      if (document.querySelector('[data-view="terminal"].active')) ensureTerminalSession();
      if (document.querySelector('[data-view="files"].active')) void loadDirectory(currentDir);
      if (document.querySelector('[data-view="display"].active')) startScreenIfReady();
    },
    onTermData(_id, data) {
      termInstance?.write(data);
    },
    onTermExit() {
      termOpened = false;
      termInstance?.writeln('\r\n[Process exited]');
    },
    onScreenFrame(blob) {
      void drawScreenFrame(blob);
    },
  });

  void client.connect();
}

async function bootstrap() {
  // Navigation tabs
  document.querySelectorAll('.nav-tab').forEach((btn) => {
    btn.addEventListener('click', () => {
      const target = btn.getAttribute('data-target');
      if (target) switchView(target);
    });
  });

  // Copy buttons
  document.querySelectorAll('[data-copy]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const text = btn.getAttribute('data-copy') || '';
      try {
        await navigator.clipboard.writeText(text);
        const orig = btn.textContent;
        btn.textContent = 'Copied';
        btn.classList.add('copied');
        setTimeout(() => {
          btn.textContent = orig;
          btn.classList.remove('copied');
        }, 1200);
      } catch {
        window.prompt('Copy command:', text);
      }
    });
  });

  // Terminal shortcut keys
  document.querySelectorAll('[data-term-send]').forEach((keyEl) => {
    keyEl.addEventListener('click', () => {
      const seq = keyEl.getAttribute('data-term-send') || '';
      const mapped = seq === 'ENTER' ? '\r' : seq === 'CTRL_C' ? '\x03' : seq === 'TAB' ? '\t' : seq === 'ESC' ? '\x1b' : seq + '\r';
      if (client && termOpened) {
        client.send({ type: 'term.input', id: 'main', data: mapped });
      } else {
        void navigator.clipboard.writeText(seq);
      }
    });
  });

  // Screen quality change
  el('screen-quality')?.addEventListener('change', () => {
    if (screenActive) startScreenIfReady();
  });

  // File upload button
  const fileInput = /** @type {HTMLInputElement|null} */ (el('file-upload-input'));
  el('files-upload-btn')?.addEventListener('click', () => fileInput?.click());
  fileInput?.addEventListener('change', async () => {
    const file = fileInput.files?.[0];
    if (!file || !client || !currentDir) return;
    await client.uploadFile(currentDir, file);
    fileInput.value = '';
    await loadDirectory(currentDir);
  });

  // Manual pairing form
  el('pair-form')?.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const input = /** @type {HTMLInputElement|null} */ (el('pair-input'));
    const status = el('pair-feedback');
    if (!input || !input.value.trim()) return;
    if (status) status.textContent = 'Pairing with laptop…';
    try {
      const rec = await pairFromLink(input.value);
      input.value = '';
      if (status) status.textContent = `Paired with ${rec.name}.`;
      connectHost(rec);
    } catch (err) {
      if (status) status.textContent = `Pairing failed: ${err.message}`;
    }
  });

  // Auto-pair if URL contains #pair=...
  if (location.hash.startsWith('#pair=')) {
    const hashVal = location.hash;
    history.replaceState(null, '', location.pathname + location.search);
    try {
      const rec = await pairFromLink(hashVal);
      connectHost(rec);
      return;
    } catch (err) {
      const status = el('pair-feedback');
      if (status) status.textContent = `Auto-pair link expired or invalid: ${err.message}`;
    }
  }

  const hosts = loadHosts();
  if (hosts.length > 0) {
    connectHost(hosts[0]);
  }
}

void bootstrap();
