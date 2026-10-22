// @ts-check
import { loadHosts, pairFromLink, removeHost, TerminalSessionClient } from './js/terminal-client.js';

/** @type {TerminalSessionClient|null} */
let session = null;
/** @type {any} */
let term = null;
/** @type {any} */
let fitAddon = null;
let ptyOpened = false;
let fontSize = 13;
/** @type {ReturnType<typeof setInterval>|null} */
let statusTimer = null;

const el = (/** @type {string} */ id) => document.getElementById(id);

function setBadge(phase, text) {
  const pill = el('conn-pill');
  const label = el('conn-label');
  if (!pill || !label) return;
  pill.className = `status-pill ${phase}`;
  label.textContent = text;
}

function formatUptime(sec) {
  if (!Number.isFinite(sec)) return '—';
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

async function mountXterm() {
  if (term) return;
  const hostEl = el('term-mount');
  if (!hostEl) return;

  const xtermMod = await import('./vendor/xterm.mjs');
  const fitMod = await import('./vendor/addon-fit.mjs');
  const Terminal = xtermMod.Terminal || xtermMod.default?.Terminal;
  const FitAddon = fitMod.FitAddon || fitMod.default?.FitAddon;
  if (!Terminal) return;

  term = new Terminal({
    fontFamily: '"SF Mono", "Geist Mono", "JetBrains Mono", ui-monospace, monospace',
    fontSize,
    lineHeight: 1.22,
    cursorBlink: true,
    scrollback: 2500,
    theme: {
      background: '#141413',
      foreground: '#F7F6F3',
      cursor: '#F7F6F3',
      selectionBackground: 'rgba(247, 246, 243, 0.22)',
    },
  });

  if (FitAddon) {
    fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
  }

  term.open(hostEl);
  fitAddon?.fit();

  term.writeln('ChadiEarthy Mobile Terminal (PowerShell · OMP)');
  term.writeln('------------------------------------');

  term.onData((data) => {
    if (session && ptyOpened) {
      session.send({ type: 'term.input', id: 'main', data });
    }
  });

  const syncSize = () => {
    if (!fitAddon || !term) return;
    fitAddon.fit();
    if (session && ptyOpened) {
      session.send({ type: 'term.resize', id: 'main', cols: term.cols, rows: term.rows });
    }
  };
  window.addEventListener('resize', syncSize);
  window.visualViewport?.addEventListener('resize', syncSize);
}

function openRemotePty() {
  if (!session || !session.hello || !term) return;
  const permBanner = el('term-perm-banner');
  if (!session.hello.permissions?.terminal) {
    if (permBanner) permBanner.hidden = false;
    return;
  }
  if (permBanner) permBanner.hidden = true;
  if (ptyOpened) return;

  ptyOpened = true;
  fitAddon?.fit();
  term.clear();
  session.send({
    type: 'term.open',
    id: 'main',
    cols: term.cols || 80,
    rows: term.rows || 24,
  });
}

function attachHost(record) {
  session?.close();
  if (statusTimer) clearInterval(statusTimer);
  ptyOpened = false;

  const sub = el('host-subtitle');
  if (sub) sub.textContent = `${record.name} · paired terminal`;

  session = new TerminalSessionClient(record, {
    onState(st) {
      const pairBox = el('pair-card');
      const chromeStatus = el('chrome-status');
      if (st.phase === 'online') {
        setBadge('online', 'Live Shell');
        if (pairBox) pairBox.hidden = true;
        if (chromeStatus) chromeStatus.textContent = `${record.name} · PS C:\\Users\\richa`;
        openRemotePty();
        session?.send({ type: 'status', reqId: 's0' });
        statusTimer = setInterval(() => session?.send({ type: 'status', reqId: 's' }), 5000);
      } else if (st.phase === 'connecting') {
        setBadge('connecting', 'Connecting');
        if (chromeStatus) chromeStatus.textContent = 'Connecting to laptop tunnel…';
      } else if (st.phase === 'forbidden') {
        setBadge('connecting', 'Locked');
        const permBanner = el('term-perm-banner');
        if (permBanner) permBanner.hidden = false;
      } else if (st.phase === 'unauthorized') {
        setBadge('offline', 'Unpaired');
        if (pairBox) pairBox.hidden = false;
        removeHost(record.hostId);
        term?.writeln('\r\n[Session unpaired or expired. Open a fresh pairing link.]');
      } else {
        setBadge('offline', 'Offline');
        if (chromeStatus) chromeStatus.textContent = 'Tunnel unreachable · tap Reconnect';
      }
    },
    onTermData(data) {
      term?.write(data);
    },
    onTermExit(code) {
      ptyOpened = false;
      term?.writeln(`\r\n[Shell exited with code ${code}. Tap Reconnect to start a new shell.]`);
    },
    onStatus(st) {
      const cpuEl = el('metric-cpu');
      const memEl = el('metric-mem');
      const batEl = el('metric-bat');
      const upEl = el('metric-up');
      if (cpuEl) cpuEl.textContent = `${Math.round(st.cpu)}%`;
      if (memEl && st.mem) memEl.textContent = `${Math.round((st.mem.used / st.mem.total) * 100)}%`;
      if (batEl) batEl.textContent = st.battery ? `${st.battery.percent}%` : 'AC';
      if (upEl) upEl.textContent = formatUptime(st.uptime);
    },
  });

  void session.connect();
}

function sendToShell(rawText) {
  if (session && ptyOpened) {
    session.send({ type: 'term.input', id: 'main', data: rawText });
  } else {
    term?.writeln(`\r\n[Not connected — pair your laptop first or tap Workspace for VS Code Tunnel.]`);
  }
}

async function init() {
  await mountXterm();

  // Bottom navigation
  document.querySelectorAll('.nav-tab').forEach((btn) => {
    btn.addEventListener('click', () => {
      const target = btn.getAttribute('data-target');
      document.querySelectorAll('.nav-tab').forEach((b) => b.classList.toggle('active', b === btn));
      document.querySelectorAll('[data-view]').forEach((p) => p.classList.toggle('active', p.getAttribute('data-view') === target));
      if (target === 'terminal') {
        setTimeout(() => {
          fitAddon?.fit();
          if (session && ptyOpened && term) {
            session.send({ type: 'term.resize', id: 'main', cols: term.cols, rows: term.rows });
          }
        }, 40);
      }
    });
  });

  // Mobile Composer Bar (type command or OMP prompt comfortably on mobile keyboard)
  el('composer-form')?.addEventListener('submit', (ev) => {
    ev.preventDefault();
    const input = /** @type {HTMLInputElement|null} */ (el('composer-input'));
    if (!input) return;
    const val = input.value;
    input.value = '';
    sendToShell(val + '\r');
  });

  // Tactile key strip
  const KEY_MAP = {
    OMP: 'omp\r',
    STATUS: 'git status\r',
    UP: '\x1b[A',
    DOWN: '\x1b[B',
    TAB: '\t',
    CTRL_C: '\x03',
    ESC: '\x1b',
    ENTER: '\r',
  };
  document.querySelectorAll('[data-key]').forEach((k) => {
    k.addEventListener('click', () => {
      const code = k.getAttribute('data-key') || '';
      sendToShell(KEY_MAP[code] ?? code);
    });
  });

  // Terminal toolbar: Font size, Clear, Reconnect
  el('btn-font-dec')?.addEventListener('click', () => {
    if (!term) return;
    fontSize = Math.max(10, fontSize - 1);
    term.options.fontSize = fontSize;
    fitAddon?.fit();
    if (session && ptyOpened) session.send({ type: 'term.resize', id: 'main', cols: term.cols, rows: term.rows });
  });
  el('btn-font-inc')?.addEventListener('click', () => {
    if (!term) return;
    fontSize = Math.min(20, fontSize + 1);
    term.options.fontSize = fontSize;
    fitAddon?.fit();
    if (session && ptyOpened) session.send({ type: 'term.resize', id: 'main', cols: term.cols, rows: term.rows });
  });
  el('btn-term-clear')?.addEventListener('click', () => term?.clear());
  el('btn-term-reconnect')?.addEventListener('click', () => {
    const hosts = loadHosts();
    if (hosts.length > 0) attachHost(hosts[0]);
    else el('pair-input')?.focus();
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
        setTimeout(() => { btn.textContent = orig; btn.classList.remove('copied'); }, 1200);
      } catch {
        window.prompt('Copy command:', text);
      }
    });
  });

  // Pairing form
  el('pair-form')?.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const input = /** @type {HTMLInputElement|null} */ (el('pair-input'));
    const msg = el('pair-feedback');
    if (!input || !input.value.trim()) return;
    if (msg) msg.textContent = 'Pairing with laptop…';
    try {
      const rec = await pairFromLink(input.value);
      input.value = '';
      if (msg) msg.textContent = `Paired with ${rec.name}. Opening shell…`;
      attachHost(rec);
    } catch (err) {
      if (msg) msg.textContent = `Pairing failed: ${err.message}`;
    }
  });

  // Auto-pair from #pair= hash
  if (location.hash.startsWith('#pair=')) {
    const hash = location.hash;
    history.replaceState(null, '', location.pathname + location.search);
    try {
      term?.writeln('Pairing phone with ChadiEarthy…');
      const rec = await pairFromLink(hash);
      attachHost(rec);
      return;
    } catch (err) {
      term?.writeln(`Pairing link error: ${err.message}`);
    }
  }

  const saved = loadHosts();
  if (saved.length > 0) {
    attachHost(saved[0]);
  } else {
    term?.writeln('Not paired yet. Open the one-time pairing link or paste it above.');
  }
}

void init();
