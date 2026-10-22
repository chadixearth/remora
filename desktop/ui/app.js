// @ts-check
/* Remora desktop UI renderer. Plain browser script, no build step.
 * Its only bridge is window.remora (contract §6). Renders update nodes in place
 * or rebuild a single list while keeping scroll position and keyboard focus. */
(() => {
  'use strict';

  /** @type {any} */
  const api = /** @type {any} */ (window).remora;

  const NS = 'http://www.w3.org/2000/svg';
  const MAX_ACTIVITY = 200;
  const PERM_KEYS = /** @type {const} */ (['screen', 'control', 'terminal', 'files']);
  const PERM_LABEL = {
    screen: 'View screen',
    control: 'Control mouse & keyboard',
    terminal: 'Terminal',
    files: 'Files',
  };
  const PLATFORM = { win32: 'Windows', darwin: 'macOS', linux: 'Linux' };
  const CONN_LABEL = { starting: 'Starting', online: 'Online', offline: 'Offline', error: 'Error' };

  /** Activity kind → label, icon and tone (tone picks the CSS colour). */
  const KIND = {
    pair: { label: 'Phone paired', icon: 'phone', tone: 'accent' },
    connect: { label: 'Phone connected', icon: 'link', tone: 'accent' },
    disconnect: { label: 'Phone disconnected', icon: 'unlink', tone: 'muted' },
    revoke: { label: 'Phone removed', icon: 'trash', tone: 'danger' },
    permission: { label: 'Permission changed', icon: 'shield', tone: 'warn' },
    screen: { label: 'Screen viewed', icon: 'screen', tone: 'muted' },
    terminal: { label: 'Terminal', icon: 'terminal', tone: 'accent' },
    command: { label: 'Command', icon: 'command', tone: 'accent' },
    files: { label: 'Files browsed', icon: 'folder', tone: 'sky' },
    upload: { label: 'File uploaded', icon: 'upload', tone: 'sky' },
    download: { label: 'File downloaded', icon: 'download', tone: 'sky' },
    action: { label: 'Action', icon: 'bolt', tone: 'warn' },
    tunnel: { label: 'Tunnel', icon: 'globe', tone: 'muted' },
  };

  /** Filter chip → activity kinds shown (null = everything). */
  /** @type {Record<string, string[] | null>} */
  const FILTERS = {
    all: null,
    commands: ['command', 'terminal', 'action'],
    files: ['files', 'upload', 'download'],
    connections: ['pair', 'connect', 'disconnect', 'revoke', 'tunnel'],
  };

  const RTF = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });

  /** @template {HTMLElement} T @param {string} id @returns {T} */
  const $ = (id) => /** @type {any} */ (document.getElementById(id));

  const d = {
    hostName: $('hostName'),
    hostNameBtn: $('hostNameBtn'),
    renameForm: $('renameForm'),
    renameInput: $('renameInput'),
    hostMeta: $('hostMeta'),
    conn: $('conn'),
    connLabel: $('connLabel'),
    connText: $('connText'),
    urlRow: $('urlRow'),
    connUrl: $('connUrl'),
    copyUrl: $('copyUrl'),
    beaconErr: $('beaconErr'),
    retryBtn: $('retryBtn'),
    deactivateBtn: $('deactivateBtn'),
    reactivateBtn: $('reactivateBtn'),
    pairCard: $('pairCard'),
    pairIdle: $('pairIdle'),
    pairActive: $('pairActive'),
    pairBtn: $('pairBtn'),
    qrImg: $('qrImg'),
    pairCountdown: $('pairCountdown'),
    copyLinkBtn: $('copyLinkBtn'),
    cancelPairBtn: $('cancelPairBtn'),
    devicesHead: $('devicesHead'),
    deviceCount: $('deviceCount'),
    deviceList: $('deviceList'),
    devicesEmpty: $('devicesEmpty'),
    chips: /** @type {HTMLButtonElement[]} */ (Array.from(document.querySelectorAll('[data-filter]'))),
    feed: $('feed'),
    feedEmpty: $('feedEmpty'),
    perm: {
      screen: $('perm-screen'),
      control: $('perm-control'),
      terminal: $('perm-terminal'),
      files: $('perm-files'),
    },
    autoStart: $('setAutoStart'),
    keepAwake: $('setKeepAwake'),
    version: $('version'),
    webUrl: $('webUrl'),
    openWebBtn: $('openWebBtn'),
    toasts: $('toasts'),
  };

  const ui = {
    /** @type {any} full State from the main process */
    state: null,
    /** @type {any[]} newest first */
    activity: [],
    filter: 'all',
    /** @type {string | null} device id awaiting remove confirmation */
    confirmingDevice: null,
    renaming: false,
    /** @type {Set<string>} */
    busy: new Set(),
    /** Last rendered signatures, so unchanged lists are not rebuilt. */
    sig: { devices: '', feed: '' },
    /** @type {ReturnType<typeof setInterval> | null} */
    pairTimer: null,
    /** @type {string | null} */
    pairLink: null,
    /** @type {string | null} */
    qrSrc: null,
  };

  /* ---------- small helpers ---------- */

  /**
   * Create an element. Text is always set via textContent (device names and
   * activity details are untrusted). Keys starting with "on" bind listeners.
   * @param {string} tag
   * @param {Record<string, any> | null} props
   * @param {...(Node | string | null | undefined | false)} children
   * @returns {HTMLElement}
   */
  function el(tag, props, ...children) {
    const node = document.createElement(tag);
    for (const [key, value] of Object.entries(props || {})) {
      if (value === null || value === undefined || value === false) continue;
      if (key === 'text') node.textContent = String(value);
      else if (key.startsWith('on')) node.addEventListener(key.slice(2), value);
      else node.setAttribute(key, value === true ? '' : String(value));
    }
    node.append(...children.filter((c) => c !== null && c !== undefined && c !== false));
    return node;
  }

  /** @param {string} name @param {string} [cls] */
  function icon(name, cls = 'ico') {
    const svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('class', cls);
    svg.setAttribute('aria-hidden', 'true');
    svg.setAttribute('focusable', 'false');
    const use = document.createElementNS(NS, 'use');
    use.setAttribute('href', `#i-${name}`);
    svg.append(use);
    return svg;
  }

  /** @param {number} ts */
  function fmtDate(ts) {
    return new Date(ts).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
  }

  /** Relative time, e.g. "5 minutes ago". @param {number} ts */
  function rel(ts) {
    const secs = (Date.now() - ts) / 1000;
    if (secs < 45) return 'just now';
    if (secs < 3600) return RTF.format(-Math.round(secs / 60), 'minute');
    if (secs < 86400) return RTF.format(-Math.round(secs / 3600), 'hour');
    if (secs < 7 * 86400) return RTF.format(-Math.round(secs / 86400), 'day');
    return fmtDate(ts);
  }

  /** @param {number} ms */
  function fmtClock(ms) {
    const s = Math.max(0, Math.ceil(ms / 1000));
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  }

  /** @param {unknown} e */
  const errMsg = (e) => (e instanceof Error ? e.message : String(e)) || 'unknown error';

  /**
   * Rebuild a list and put back the scroll position and the focused control
   * (matched by its data-focus-key), so a state push never steals focus.
   * @param {HTMLElement} root
   * @param {() => void} rebuild
   */
  function rebuildKeepingFocus(root, rebuild) {
    const active = /** @type {HTMLElement | null} */ (document.activeElement);
    const key = active && root.contains(active) ? active.dataset.focusKey : undefined;
    const top = root.scrollTop;
    rebuild();
    root.scrollTop = top;
    if (key) focusKey(root, key);
  }

  /** @param {HTMLElement} root @param {string} key @returns {boolean} */
  function focusKey(root, key) {
    const node = /** @type {HTMLElement | undefined} */ (
      Array.from(root.querySelectorAll('[data-focus-key]')).find(
        (n) => /** @type {HTMLElement} */ (n).dataset.focusKey === key,
      )
    );
    if (node) node.focus();
    return !!node;
  }

  /** @param {string} message @param {'info' | 'error'} [tone] */
  function toast(message, tone = 'info') {
    const node = el('div', { class: 'toast', 'data-tone': tone, text: message });
    d.toasts.append(node);
    while (d.toasts.childElementCount > 3) d.toasts.firstElementChild?.remove();
    setTimeout(() => node.remove(), tone === 'error' ? 6000 : 3000);
  }

  /** @param {string} text @param {string} message */
  async function copy(text, message) {
    try {
      await api.copyText(text);
      toast(message);
    } catch (e) {
      toast(`Couldn't copy: ${errMsg(e)}`, 'error');
    }
  }

  /**
   * Run an action once at a time. Returns false when skipped or failed.
   * @param {string} key
   * @param {() => Promise<unknown>} fn
   * @param {string} failMsg
   */
  async function act(key, fn, failMsg) {
    if (ui.busy.has(key)) return false;
    ui.busy.add(key);
    applyBusy();
    try {
      await fn();
      return true;
    } catch (e) {
      toast(`${failMsg}: ${errMsg(e)}`, 'error');
      return false;
    } finally {
      ui.busy.delete(key);
      applyBusy();
    }
  }

  /** aria-disabled rather than disabled, so a busy button keeps focus. */
  function applyBusy() {
    /** @type {[HTMLElement, string][]} */
    const pairs = [
      [d.retryBtn, 'retry'],
      [d.deactivateBtn, 'deactivate'],
      [d.reactivateBtn, 'reactivate'],
      [d.pairBtn, 'pair'],
      [d.cancelPairBtn, 'cancelPair'],
      [d.openWebBtn, 'web'],
    ];
    for (const [btn, key] of pairs) {
      const busy = ui.busy.has(key);
      btn.setAttribute('aria-disabled', String(busy));
      btn.classList.toggle('is-busy', busy);
    }
  }

  /**
   * Merge activity lists, newest first, de-duplicated, capped.
   * @param {any[]} current @param {any[]} incoming
   */
  function mergeActivity(current, incoming) {
    const seen = new Set();
    const out = [];
    for (const a of [...incoming, ...current]) {
      const key = `${a.ts}|${a.kind}|${a.deviceId}|${a.detail}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(a);
    }
    return out.sort((x, y) => y.ts - x.ts).slice(0, MAX_ACTIVITY);
  }

  /** @param {HTMLInputElement} input @param {(on: boolean) => Promise<unknown>} set @param {string} label */
  function bindSwitch(input, set, label) {
    input.addEventListener('change', async () => {
      const on = input.checked;
      try {
        await set(on);
      } catch (e) {
        input.checked = !on;
        toast(`Couldn't update ${label}: ${errMsg(e)}`, 'error');
      }
    });
  }

  /* ---------- host name ---------- */

  /** @param {any} s */
  function renderHost(s) {
    if (!ui.renaming) d.hostName.textContent = s.hostName || 'This computer';
    const platform = PLATFORM[/** @type {keyof typeof PLATFORM} */ (s.platform)] || s.platform;
    d.hostMeta.textContent = `${platform} · Remora v${s.version}`;
  }

  function startRename() {
    if (ui.renaming || !ui.state) return;
    ui.renaming = true;
    d.renameInput.value = ui.state.hostName || '';
    d.hostNameBtn.hidden = true;
    d.renameForm.hidden = false;
    d.renameInput.focus();
    d.renameInput.select();
  }

  /** @param {boolean} refocus */
  function endRename(refocus) {
    ui.renaming = false;
    d.renameForm.hidden = true;
    d.hostNameBtn.hidden = false;
    if (ui.state) renderHost(ui.state);
    if (refocus) d.hostNameBtn.focus();
  }

  /** @param {boolean} refocus */
  async function commitRename(refocus) {
    if (!ui.renaming) return;
    const name = d.renameInput.value.trim();
    const current = ui.state ? ui.state.hostName : '';
    endRename(refocus);
    if (!name || name === current) return;
    try {
      await api.renameHost(name);
    } catch (e) {
      toast(`Couldn't rename this computer: ${errMsg(e)}`, 'error');
    }
  }

  /* ---------- connection ---------- */

  /** @param {any} s */
  function renderConnection(s) {
    const t = s.tunnel || { status: 'offline', url: null, error: null };
    const status = /** @type {keyof typeof CONN_LABEL} */ (CONN_LABEL[t.status] ? t.status : 'offline');
    d.conn.dataset.status = status;
    d.connLabel.textContent = CONN_LABEL[status];

    /** @type {Record<string, string>} */
    const copyByStatus = {
      starting: 'Opening a secure tunnel so your phone can reach this computer.',
      online: 'Your phone can reach this computer from anywhere.',
      offline: 'Remora is not reachable right now. Retry to reconnect.',
      error: t.error || 'The tunnel failed to start.',
    };
    d.connText.textContent = copyByStatus[status];

    const url = status === 'online' ? t.url : null;
    d.urlRow.hidden = !url;
    if (url) {
      d.connUrl.textContent = url;
      d.connUrl.title = url;
    }
    const isRunning = status === 'online' || status === 'starting';
    d.deactivateBtn.hidden = !isRunning;
    d.reactivateBtn.hidden = isRunning;
    d.retryBtn.hidden = status !== 'error';

    const beaconError = s.beacon && s.beacon.error;
    d.beaconErr.hidden = !beaconError;
    d.beaconErr.textContent = beaconError
      ? `Couldn't publish the new address, so phones may not find this computer. (${beaconError})`
      : '';
  }

  /* ---------- pairing ---------- */

  function tickPairing() {
    const p = ui.state && ui.state.pairing;
    if (!p) return;
    const left = p.expiresAt - Date.now();
    const expired = left <= 0;
    d.pairCard.classList.toggle('is-expired', expired);
    d.pairCountdown.textContent = expired ? 'Code expired' : `Expires in ${fmtClock(left)}`;
  }

  function startPairTimer() {
    if (ui.pairTimer === null) ui.pairTimer = setInterval(tickPairing, 1000);
  }

  function stopPairTimer() {
    clearInterval(ui.pairTimer);
    ui.pairTimer = null;
  }

  function renderPairing() {
    const p = ui.state && ui.state.pairing;
    const wasShowing = !d.pairActive.hidden;
    const focusInIdle = d.pairIdle.contains(document.activeElement);
    const focusInActive = d.pairActive.contains(document.activeElement);

    d.pairIdle.hidden = !!p;
    d.pairActive.hidden = !p;

    if (p) {
      ui.pairLink = p.link;
      if (p.qrDataUrl !== ui.qrSrc) {
        ui.qrSrc = p.qrDataUrl;
        d.qrImg.src = p.qrDataUrl;
      }
      startPairTimer();
      tickPairing();
      if (!wasShowing && focusInIdle) d.copyLinkBtn.focus();
    } else {
      ui.pairLink = null;
      ui.qrSrc = null;
      d.qrImg.removeAttribute('src');
      d.pairCard.classList.remove('is-expired');
      stopPairTimer();
      if (wasShowing && focusInActive) d.pairBtn.focus();
    }
  }

  /* ---------- devices ---------- */

  /** @param {any} dev */
  function deviceRow(dev) {
    const confirming = ui.confirmingDevice === dev.id;

    /** @type {HTMLElement} */
    let seen;
    if (dev.online) seen = el('span', { class: 'live', text: 'Online now' });
    else if (dev.lastSeenAt == null) seen = el('span', { text: 'Not connected yet' });
    else seen = el('span', null, 'Last seen ', el('span', { 'data-rel': dev.lastSeenAt, text: rel(dev.lastSeenAt) }));

    const meta = confirming
      ? el('div', { class: 'device-meta is-warn', text: 'Remove this phone? It loses access right away.' })
      : el('div', { class: 'device-meta' }, `Paired ${fmtDate(dev.createdAt)} · `, seen);

    const actions = confirming
      ? el(
          'div',
          { class: 'device-actions' },
          el('button', { type: 'button', class: 'btn btn-ghost', 'data-focus-key': `${dev.id}:keep`, onclick: () => cancelRemove(dev) }, 'Keep'),
          el('button', { type: 'button', class: 'btn btn-danger', 'data-focus-key': `${dev.id}:confirm`, onclick: () => removeDevice(dev) }, 'Remove'),
        )
      : el(
          'div',
          { class: 'device-actions' },
          el('button', {
            type: 'button',
            class: 'btn btn-ghost',
            'data-focus-key': `${dev.id}:remove`,
            'aria-label': `Remove ${dev.name}`,
            onclick: () => askRemove(dev),
          }, 'Remove'),
        );

    return el(
      'li',
      { class: confirming ? 'device is-confirming' : 'device', 'data-id': dev.id },
      el('div', { class: 'device-avatar', 'data-online': dev.online ? 'true' : 'false' }, icon('phone'), el('span', { class: 'online-dot', 'aria-hidden': 'true' })),
      el('div', { class: 'device-info' }, el('div', { class: 'device-name', title: dev.name, text: dev.name }), meta),
      actions,
    );
  }

  function renderDevices() {
    const s = ui.state;
    if (!s) return;
    const devices = [...s.devices].sort(
      (/** @type {any} */ a, /** @type {any} */ b) =>
        Number(b.online) - Number(a.online) || (b.lastSeenAt || 0) - (a.lastSeenAt || 0),
    );
    if (ui.confirmingDevice && !devices.some((x) => x.id === ui.confirmingDevice)) ui.confirmingDevice = null;

    d.deviceCount.textContent = String(devices.length);
    d.devicesEmpty.hidden = devices.length > 0;
    d.deviceList.hidden = devices.length === 0;

    const sig = JSON.stringify([devices, ui.confirmingDevice]);
    if (sig === ui.sig.devices) return;
    ui.sig.devices = sig;
    rebuildKeepingFocus(d.deviceList, () => d.deviceList.replaceChildren(...devices.map(deviceRow)));
  }

  /** @param {any} dev */
  function askRemove(dev) {
    ui.confirmingDevice = dev.id;
    renderDevices();
    focusKey(d.deviceList, `${dev.id}:keep`);
  }

  /** @param {any} dev */
  function cancelRemove(dev) {
    ui.confirmingDevice = null;
    renderDevices();
    focusKey(d.deviceList, `${dev.id}:remove`);
  }

  /** @param {any} dev */
  async function removeDevice(dev) {
    ui.confirmingDevice = null;
    renderDevices();
    const ok = await act(`revoke:${dev.id}`, () => api.revokeDevice(dev.id), `Couldn't remove ${dev.name}`);
    if (!ok) return;
    toast(`${dev.name} removed`);
    const next = /** @type {HTMLElement | undefined} */ (
      Array.from(d.deviceList.querySelectorAll('[data-focus-key$=":remove"]')).find(
        (n) => /** @type {HTMLElement} */ (n).dataset.focusKey !== `${dev.id}:remove`,
      )
    );
    (next || d.devicesHead).focus();
  }

  /* ---------- permissions and settings ---------- */

  /** @param {any} s */
  function renderPerms(s) {
    for (const k of PERM_KEYS) d.perm[k].checked = !!s.permissions[k];
  }

  /** @param {any} s */
  function renderSettings(s) {
    d.autoStart.checked = !!s.autoStart;
    d.keepAwake.checked = !!s.keepAwake;
    d.version.textContent = s.version ? `v${s.version}` : '';
    d.webUrl.textContent = s.webAppUrl || '';
    d.webUrl.title = s.webAppUrl || '';
  }

  /* ---------- activity ---------- */

  /** @param {any} a */
  function activityRow(a) {
    const meta = /** @type {{label: string, icon: string, tone: string}} */ (
      KIND[/** @type {keyof typeof KIND} */ (a.kind)] || { label: a.kind, icon: 'dot', tone: 'muted' }
    );
    const who = a.deviceName || (a.deviceId ? 'Phone' : 'This computer');
    const detail = a.detail || '';
    return el(
      'li',
      { class: 'act', 'data-kind': a.kind },
      el('span', { class: 'act-ico', 'data-tone': meta.tone }, icon(meta.icon)),
      el(
        'div',
        { class: 'act-body' },
        el('div', { class: 'act-title' }, el('span', { text: meta.label }), el('span', { class: 'act-who', text: `· ${who}` })),
        el('div', { class: a.kind === 'command' ? 'act-detail mono' : 'act-detail', title: detail, text: detail }),
      ),
      el('time', {
        class: 'act-time',
        datetime: new Date(a.ts).toISOString(),
        title: new Date(a.ts).toLocaleString(),
        'data-rel': a.ts,
        text: rel(a.ts),
      }),
    );
  }

  /** @param {boolean} [resetScroll] */
  function renderFeed(resetScroll = false) {
    const pred = FILTERS[ui.filter];
    const rows = ui.activity.filter((a) => !pred || pred.includes(a.kind));

    for (const chip of d.chips) chip.setAttribute('aria-pressed', String(chip.dataset.filter === ui.filter));

    d.feedEmpty.hidden = rows.length > 0;
    d.feedEmpty.textContent = ui.activity.length
      ? 'Nothing in this filter yet.'
      : 'No activity yet. Once a phone connects, its actions show up here.';

    const sig = JSON.stringify(rows);
    if (sig === ui.sig.feed && !resetScroll) return;
    ui.sig.feed = sig;
    rebuildKeepingFocus(d.feed, () => d.feed.replaceChildren(...rows.map(activityRow)));
    if (resetScroll) d.feed.scrollTop = 0;
  }

  /** Refresh every relative timestamp in place, no rebuild. */
  function refreshTimes() {
    for (const node of document.querySelectorAll('[data-rel]')) {
      const h = /** @type {HTMLElement} */ (node);
      h.textContent = rel(Number(h.dataset.rel));
    }
  }

  /* ---------- render ---------- */

  function render() {
    const s = ui.state;
    if (!s) return;
    renderHost(s);
    renderConnection(s);
    renderPairing();
    renderDevices();
    renderPerms(s);
    renderSettings(s);
    applyBusy();
  }

  /* ---------- wiring ---------- */

  function bind() {
    d.hostNameBtn.addEventListener('click', startRename);
    d.renameForm.addEventListener('submit', (e) => {
      e.preventDefault();
      commitRename(true);
    });
    d.renameInput.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        endRename(true);
      }
    });
    d.renameInput.addEventListener('blur', () => commitRename(false));

    d.copyUrl.addEventListener('click', () => {
      const url = ui.state?.tunnel?.url;
      if (url) copy(url, 'Address copied');
    });
    d.retryBtn.addEventListener('click', () =>
      act('retry', () => api.restartTunnel(), "Couldn't restart the tunnel"),
    );
    d.deactivateBtn?.addEventListener('click', () =>
      act('deactivate', () => api.stopTunnel(), "Couldn't deactivate the tunnel"),
    );
    d.reactivateBtn?.addEventListener('click', () =>
      act('reactivate', () => api.startTunnel(), "Couldn't reactivate the tunnel"),
    );

    d.pairBtn.addEventListener('click', () =>
      act(
        'pair',
        async () => {
          const p = await api.createPairing();
          // The onState push normally carries the pairing; use the reply if it has not arrived yet.
          if (ui.state && !ui.state.pairing) {
            ui.state = { ...ui.state, pairing: p };
            render();
          }
        },
        "Couldn't create a pairing code",
      ),
    );
    d.copyLinkBtn.addEventListener('click', () => {
      if (ui.pairLink) copy(ui.pairLink, 'Pairing link copied');
    });
    d.cancelPairBtn.addEventListener('click', () =>
      act('cancelPair', () => api.cancelPairing(), "Couldn't cancel pairing"),
    );

    d.openWebBtn.addEventListener('click', () => {
      const url = ui.state?.webAppUrl;
      if (url) act('web', () => api.openExternal(url), "Couldn't open the web app");
    });

    for (const chip of d.chips) {
      chip.addEventListener('click', () => {
        ui.filter = chip.dataset.filter || 'all';
        renderFeed(true);
      });
    }

    for (const k of PERM_KEYS) {
      bindSwitch(d.perm[k], (on) => api.setPermission(k, on), PERM_LABEL[k]);
    }
    bindSwitch(d.autoStart, (on) => api.setAutoStart(on), 'start at sign-in');
    bindSwitch(d.keepAwake, (on) => api.setKeepAwake(on), 'keep awake');
  }

  async function init() {
    if (!api) {
      d.conn.dataset.status = 'error';
      d.connLabel.textContent = CONN_LABEL.error;
      d.connText.textContent = 'Remora could not reach its desktop bridge. Restart the app.';
      return;
    }

    bind();
    api.onState((/** @type {any} */ s) => {
      ui.state = s;
      render();
    });
    api.onActivity((/** @type {any} */ a) => {
      ui.activity = mergeActivity(ui.activity, [a]);
      renderFeed();
    });

    try {
      const [s, acts] = await Promise.all([api.getState(), api.getActivity(MAX_ACTIVITY)]);
      if (!ui.state) ui.state = s;
      ui.activity = mergeActivity(ui.activity, acts);
    } catch (e) {
      toast(`Couldn't load Remora: ${errMsg(e)}`, 'error');
    }
    render();
    renderFeed();
    setInterval(refreshTimes, 30_000);
  }

  init();
})();
