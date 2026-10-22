// @ts-check
'use strict';

const path = require('path');
const os = require('os');
const { app, BrowserWindow, Tray, Menu, ipcMain, shell, clipboard, nativeImage, powerSaveBlocker, Notification } = require('electron');
const QRCode = require('qrcode');

const { Store } = require('./core/store');
const { Pairing } = require('./core/pairing');
const { Tunnel } = require('./core/tunnel');
const { Beacon } = require('./core/beacon');
const { createServer } = require('./core/server');
const { createCapture } = require('./capture/capture');
const { createInput } = require('./platform/input');
const { createTerminalManager } = require('./platform/terminal');
const files = require('./platform/files');
const system = require('./platform/system');
const actions = require('./platform/actions');

const WEB_APP_URL = process.env.REMORA_WEB_URL || 'https://chadixearth.github.io/remora/';
const ICON = path.join(__dirname, '..', 'assets', 'icon.png');
const TRAY_ICON = path.join(__dirname, '..', 'assets', 'tray.png');
const startHidden = process.argv.includes('--hidden');

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => showWindow());
  app.whenReady().then(main).catch((err) => {
    console.error('[remora] failed to start', err);
    app.exit(1);
  });
}

/** @type {BrowserWindow|null} */
let win = null;
/** @type {Tray|null} */
let tray = null;
let quitting = false;

function showWindow() {
  if (!win) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

async function main() {
  app.setAppUserModelId('dev.remora.desktop');
  const store = new Store(app.getPath('userData'), os.hostname());
  const { config } = store;
  const pairing = new Pairing(() => pushState());
  const tunnel = new Tunnel(path.join(app.getPath('userData'), 'bin'));
  const beacon = new Beacon(() => store.config);
  /** @type {{link:string, expiresAt:number, qrDataUrl:string}|null} */
  let pairingView = null;
  /** @type {number|null} */
  let awakeBlocker = null;

  const server = createServer({
    store,
    pairing,
    version: app.getVersion(),
    createCapture,
    input: createInput(),
    createTerminalManager,
    files,
    system,
    actions,
  });
  const port = await server.listen();
  const localUrl = `http://127.0.0.1:${port}`;

  // ----- state pushed to the desktop UI -----
  function buildState() {
    const online = server.onlineDeviceIds();
    return {
      hostId: config.hostId,
      hostName: config.hostName,
      version: app.getVersion(),
      platform: process.platform,
      webAppUrl: WEB_APP_URL,
      tunnel: { status: tunnel.status, url: tunnel.url, error: tunnel.error },
      beacon: { lastPublishedAt: beacon.lastPublishedAt, error: beacon.error },
      permissions: { ...config.permissions },
      devices: config.devices.map((d) => ({
        id: d.id, name: d.name, createdAt: d.createdAt, lastSeenAt: d.lastSeenAt, online: online.has(d.id),
      })),
      pairing: pairing.active ? pairingView : null,
      autoStart: config.autoStart,
      keepAwake: config.keepAwake,
    };
  }

  /** @type {NodeJS.Timeout|undefined} */
  let pushTimer;
  function pushState() {
    clearTimeout(pushTimer);
    pushTimer = setTimeout(() => {
      if (win && !win.isDestroyed()) win.webContents.send('remora:state', buildState());
      updateTray();
    }, 30);
  }

  store.on('change', pushState);
  store.on('activity', (entry) => {
    if (win && !win.isDestroyed()) win.webContents.send('remora:activity', entry);
  });
  server.onDevicesChanged(pushState);
  tunnel.on('status', ({ status, url, error }) => {
    if (status === 'online') store.log('tunnel', `Online at ${url}`);
    if (status === 'error') store.log('tunnel', error ?? 'Tunnel error');
    beacon.update(url);
    pushState();
  });
  beacon.on('status', pushState);

  // ----- settings that touch the OS -----
  function applyAutoStart() {
    if (!app.isPackaged) return; // never register the dev build (electron.exe) as a login item
    app.setLoginItemSettings({ openAtLogin: config.autoStart, args: ['--hidden'] });
  }
  function applyKeepAwake() {
    if (config.keepAwake && awakeBlocker === null) awakeBlocker = powerSaveBlocker.start('prevent-app-suspension');
    if (!config.keepAwake && awakeBlocker !== null) {
      powerSaveBlocker.stop(awakeBlocker);
      awakeBlocker = null;
    }
  }
  applyAutoStart();
  applyKeepAwake();

  /** @returns {Promise<{link:string, expiresAt:number, qrDataUrl:string}>} */
  async function createPairing() {
    const { secret, expiresAt } = pairing.create();
    const payload = {
      v: 1,
      h: config.hostId,
      n: config.hostName,
      t: config.beaconTopic,
      k: config.beaconKey,
      c: secret,
      u: tunnel.url ?? localUrl,
    };
    const link = `${WEB_APP_URL}#pair=${Buffer.from(JSON.stringify(payload)).toString('base64url')}`;
    const qrDataUrl = await QRCode.toDataURL(link, {
      errorCorrectionLevel: 'M', margin: 1, width: 360, color: { dark: '#0b0f14', light: '#ffffff' },
    });
    pairingView = { link, expiresAt, qrDataUrl };
    pushState();
    return pairingView;
  }

  // ----- IPC for window.remora -----
  /** @param {string} name @param {(...args: any[]) => any} fn */
  const handle = (name, fn) => ipcMain.handle(`remora:${name}`, (_event, ...args) => fn(...args));
  handle('getState', () => buildState());
  handle('createPairing', () => createPairing());
  handle('cancelPairing', () => pairing.cancel());
  handle('setPermission', (key, on) => {
    store.setPermission(key, Boolean(on));
    store.log('permission', `${key} ${on ? 'on' : 'off'}`);
    server.permissionsChanged();
  });
  handle('revokeDevice', (id) => {
    const device = store.removeDevice(String(id));
    if (!device) return;
    server.disconnectDevice(device.id);
    store.log('revoke', `Removed ${device.name}`, device);
  });
  handle('renameHost', (name) => store.renameHost(String(name)));
  handle('setAutoStart', (on) => { store.setFlag('autoStart', Boolean(on)); applyAutoStart(); });
  handle('setKeepAwake', (on) => { store.setFlag('keepAwake', Boolean(on)); applyKeepAwake(); });
  handle('restartTunnel', () => tunnel.restart());
  handle('stopTunnel', () => {
    beacon.stop();
    tunnel.stop();
    store.log('tunnel', 'Deactivated tunnel from laptop');
  });
  handle('startTunnel', () => {
    store.log('tunnel', 'Reactivated tunnel from laptop');
    return tunnel.start(port);
  });
  handle('getActivity', (limit) => store.recentActivity(Math.min(Number(limit) || 200, 500)));
  handle('copyText', (text) => clipboard.writeText(String(text)));
  handle('openExternal', (url) => {
    if (/^https?:\/\//i.test(String(url))) return shell.openExternal(String(url));
  });

  // ----- window + tray -----
  win = new BrowserWindow({
    width: 1040,
    height: 700,
    minWidth: 760,
    minHeight: 520,
    show: false,
    title: 'Remora',
    icon: ICON,
    backgroundColor: '#0b0f14',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (event) => event.preventDefault());
  let toldAboutTray = false;
  win.on('close', (event) => {
    if (quitting) return;
    event.preventDefault();
    win?.hide();
    if (!toldAboutTray && Notification.isSupported()) {
      toldAboutTray = true;
      new Notification({ title: 'Remora is still running', body: 'Your phone can still reach this laptop. Quit from the tray icon.', icon: ICON }).show();
    }
  });
  await win.loadFile(path.join(__dirname, 'ui', 'index.html'));
  if (!startHidden) win.show();

  tray = new Tray(nativeImage.createFromPath(TRAY_ICON).resize({ width: 16, height: 16 }));
  tray.on('click', showWindow);
  function updateTray() {
    if (!tray) return;
    const online = tunnel.status === 'online';
    tray.setToolTip(`Remora: ${online ? 'online' : tunnel.status}`);
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: `Remora (${online ? 'online' : tunnel.status})`, enabled: false },
      { type: 'separator' },
      { label: 'Open Remora', click: showWindow },
      { label: 'Pair a phone…', click: () => { showWindow(); void createPairing(); } },
      {
        label: online || tunnel.status === 'starting' ? 'Deactivate tunnel' : 'Reactivate tunnel',
        click: () => {
          if (online || tunnel.status === 'starting') {
            beacon.stop();
            tunnel.stop();
          } else {
            void tunnel.start(port);
          }
        },
      },
      { type: 'separator' },
      { label: 'Quit Remora', click: () => { quitting = true; app.quit(); } },
    ]));
  }
  updateTray();

  app.on('before-quit', () => {
    quitting = true;
    beacon.stop();
    tunnel.stop();
    server.close();
  });
  app.on('window-all-closed', () => { /* stay alive in the tray */ });

  console.log(`[remora] listening on ${localUrl}`);
  await tunnel.start(port);
}
