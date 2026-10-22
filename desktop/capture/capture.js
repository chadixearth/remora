// @ts-check
'use strict';

const path = require('path');
const { BrowserWindow, desktopCapturer, ipcMain, screen, session } = require('electron');

const PARTITION = 'remora-capture';
const PULL_WATCHDOG_MS = 2000;
const START_TIMEOUT_MS = 10000;

/**
 * @typedef {{displayId:string, width:number, height:number, imgWidth:number, imgHeight:number}} Meta
 * @typedef {{displayId:string, name:string, width:number, height:number, primary:boolean}} DisplayInfo
 */

/**
 * Screen capture for the phone. The capture pipeline runs in a hidden, sandboxed window
 * (capture.html + capture-preload.js): desktopCapturer source -> getUserMedia -> canvas -> JPEG.
 * Flow control: one frame in flight. A pull is sent only after the previous frame was acked
 * and no sooner than 1000/fps ms after the previous pull.
 * @param {{onFrame(buf:Buffer, meta:Meta):void, onMeta(meta:Meta):void}} opts
 */
function createCapture({ onFrame, onMeta }) {
  /** @type {BrowserWindow|null} */
  let win = null;
  /** @type {Promise<void>|null} */
  let loading = null;
  /** @type {null|{display:Electron.Display, fps:number, quality:number, maxWidth:number,
   *   videoWidth:number, videoHeight:number, imgWidth:number, imgHeight:number}} */
  let active = null;
  let awaitingFrame = false;
  let awaitingAck = false;
  let lastPullAt = 0;
  /** @type {ReturnType<typeof setTimeout>|null} */
  let pullTimer = null;
  /** @type {ReturnType<typeof setTimeout>|null} */
  let watchdog = null;
  /** @type {{res:(v:{videoWidth:number, videoHeight:number})=>void, rej:(e:Error)=>void}|null} */
  let startWaiter = null;
  /** Source chosen by start(); served to the display-media request. @type {Electron.DesktopCapturerSource|null} */
  let pendingSource = null;

  /**
   * @param {Electron.IpcMainEvent} event
   * @returns {boolean}
   */
  function fromOurWindow(event) {
    return !!win && !win.isDestroyed() && event.sender.id === win.webContents.id;
  }

  /** @param {Electron.IpcMainEvent} _event @param {{videoWidth:number, videoHeight:number}} info */
  function onStarted(_event, info) {
    if (!fromOurWindow(_event) || !startWaiter) return;
    startWaiter.res(info);
    startWaiter = null;
  }

  /** @param {Electron.IpcMainEvent} event @param {{imgWidth:number, imgHeight:number}} frame @param {ArrayBuffer} buf */
  function onFrameIpc(event, frame, buf) {
    if (!active || !fromOurWindow(event)) return;
    if (watchdog) clearTimeout(watchdog);
    watchdog = null;
    awaitingFrame = false;
    awaitingAck = true;
    onFrame(Buffer.from(buf), metaNow());
  }

  /** @param {Electron.IpcMainEvent} event @param {string} message */
  function onErrorIpc(event, message) {
    if (!fromOurWindow(event)) return;
    console.warn('[remora] screen capture error:', message);
    stop();
  }

  ipcMain.on('capture:started', onStarted);
  ipcMain.on('capture:frame', onFrameIpc);
  ipcMain.on('capture:error', onErrorIpc);

  /** @returns {Promise<void>} */
  function ensureWindow() {
    if (win && !win.isDestroyed() && loading) return loading;
    const ses = session.fromPartition(PARTITION);
    const allowed = (/** @type {string} */ permission) => permission === 'media' || permission === 'display-capture';
    ses.setPermissionRequestHandler((_wc, permission, callback) => callback(allowed(permission)));
    ses.setPermissionCheckHandler((_wc, permission) => allowed(permission));
    ses.setDisplayMediaRequestHandler((_request, callback) => {
      callback(pendingSource ? { video: pendingSource } : null);
    });
    win = new BrowserWindow({
      show: false,
      skipTaskbar: true,
      width: 320,
      height: 240,
      webPreferences: {
        partition: PARTITION,
        preload: path.join(__dirname, 'capture-preload.js'),
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        devTools: false,
        backgroundThrottling: false,
        paintWhenInitiallyHidden: true,
      },
    });
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    win.webContents.on('will-navigate', (event) => event.preventDefault());
    loading = win.loadFile(path.join(__dirname, 'capture.html'));
    return loading;
  }

  /** @returns {DisplayInfo[]} */
  function listDisplays() {
    const primaryId = screen.getPrimaryDisplay().id;
    return screen.getAllDisplays().map((d, i) => ({
      id: String(d.id),
      name: d.label || `Display ${i + 1}`,
      width: Math.round(d.bounds.width * d.scaleFactor),
      height: Math.round(d.bounds.height * d.scaleFactor),
      primary: d.id === primaryId,
    }));
  }

  /** @returns {Meta} */
  function metaNow() {
    if (!active) throw new Error('capture not running');
    return {
      displayId: String(active.display.id),
      width: Math.round(active.display.bounds.width * active.display.scaleFactor),
      height: Math.round(active.display.bounds.height * active.display.scaleFactor),
      imgWidth: active.imgWidth,
      imgHeight: active.imgHeight,
    };
  }

  /**
   * Derives the JPEG size from the video size, capped at maxWidth, keeping aspect ratio.
   * @param {number} videoWidth
   * @param {number} videoHeight
   * @param {number} maxWidth
   */
  function fitSize(videoWidth, videoHeight, maxWidth) {
    if (!videoWidth || !videoHeight) return { imgWidth: 0, imgHeight: 0 };
    const scale = Math.min(1, maxWidth / videoWidth);
    return {
      imgWidth: Math.max(1, Math.round(videoWidth * scale)),
      imgHeight: Math.max(1, Math.round(videoHeight * scale)),
    };
  }

  function clearTimers() {
    if (pullTimer) clearTimeout(pullTimer);
    if (watchdog) clearTimeout(watchdog);
    pullTimer = null;
    watchdog = null;
  }

  function schedulePull() {
    if (!active || pullTimer || awaitingFrame || awaitingAck) return;
    const delay = Math.max(0, lastPullAt + 1000 / active.fps - Date.now());
    pullTimer = setTimeout(() => {
      pullTimer = null;
      sendPull();
    }, delay);
  }

  function sendPull() {
    if (!active || !win || win.isDestroyed() || awaitingFrame || awaitingAck) return;
    awaitingFrame = true;
    lastPullAt = Date.now();
    watchdog = setTimeout(() => {
      watchdog = null;
      awaitingFrame = false;
      schedulePull();
    }, PULL_WATCHDOG_MS);
    win.webContents.send('capture:pull', {
      imgWidth: active.imgWidth,
      imgHeight: active.imgHeight,
      quality: active.quality,
    });
  }

  /**
   * Picks the desktopCapturer source for one display. Electron on Windows can return an
   * empty display_id, so fall back to matching by index when every source id is empty
   * and the counts agree. Anything ambiguous throws rather than capturing the wrong screen.
   * @param {Electron.Display} display
   */
  async function findSource(display) {
    const sources = await desktopCapturer.getSources({
      types: ['screen'],
      thumbnailSize: { width: 1, height: 1 },
    });
    const byId = sources.find((s) => s.display_id === String(display.id));
    if (byId) return byId;
    const displays = screen.getAllDisplays();
    const allEmpty = sources.every((s) => !s.display_id);
    if (allEmpty && sources.length === displays.length) {
      const idx = displays.findIndex((d) => d.id === display.id);
      if (idx >= 0) return sources[idx];
    }
    throw new Error('display not found for capture');
  }

  /**
   * Starts capturing one display. Replaces any running capture.
   * @param {{displayId?:string, maxWidth?:number, quality?:number, fps?:number}} opts
   * @returns {Promise<void>}
   */
  async function start(opts = {}) {
    stop();
    const displays = screen.getAllDisplays();
    const display = opts.displayId
      ? displays.find((d) => String(d.id) === String(opts.displayId))
      : screen.getPrimaryDisplay();
    if (!display) throw new Error('display not found');

    await ensureWindow();
    const source = await findSource(display);
    pendingSource = source;
    const mine = {
      display,
      fps: clampNum(opts.fps, 1, 30, 12),
      quality: clampNum(opts.quality, 0.3, 0.95, 0.6),
      maxWidth: clampNum(opts.maxWidth, 320, 3840, 1280),
      videoWidth: 0,
      videoHeight: 0,
      imgWidth: 0,
      imgHeight: 0,
    };
    active = mine;

    const started = new Promise((res, rej) => {
      startWaiter = { res, rej };
    });
    const timer = setTimeout(() => {
      if (startWaiter) {
        startWaiter.rej(new Error('capture start timed out'));
        startWaiter = null;
      }
    }, START_TIMEOUT_MS);
    try {
      win?.webContents.send('capture:start');
      const info = await started;
      if (active !== mine) return;
      const size = fitSize(info.videoWidth, info.videoHeight, mine.maxWidth);
      mine.videoWidth = info.videoWidth;
      mine.videoHeight = info.videoHeight;
      mine.imgWidth = size.imgWidth;
      mine.imgHeight = size.imgHeight;
      onMeta(metaNow());
      lastPullAt = 0;
      schedulePull();
    } catch (err) {
      if (active === mine) stop();
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Updates quality, fps and maxWidth of the running capture. Size changes trigger onMeta.
   * @param {{maxWidth?:number, quality?:number, fps?:number}} opts
   */
  function configure(opts = {}) {
    if (!active) return;
    if (opts.quality !== undefined) active.quality = clampNum(opts.quality, 0.3, 0.95, active.quality);
    if (opts.fps !== undefined) active.fps = clampNum(opts.fps, 1, 30, active.fps);
    if (opts.maxWidth !== undefined) {
      active.maxWidth = clampNum(opts.maxWidth, 320, 3840, active.maxWidth);
      const before = `${active.imgWidth}x${active.imgHeight}`;
      const size = fitSize(active.videoWidth, active.videoHeight, active.maxWidth);
      active.imgWidth = size.imgWidth;
      active.imgHeight = size.imgHeight;
      if (`${active.imgWidth}x${active.imgHeight}` !== before) onMeta(metaNow());
    }
  }

  /** The phone acknowledges a drawn frame, which releases the next pull. */
  function ack() {
    if (!awaitingAck) return;
    awaitingAck = false;
    schedulePull();
  }

  /** Stops the running capture. The hidden window is kept for reuse. */
  function stop() {
    clearTimers();
    awaitingFrame = false;
    awaitingAck = false;
    if (startWaiter) {
      startWaiter.rej(new Error('capture stopped'));
      startWaiter = null;
    }
    if (active && win && !win.isDestroyed()) win.webContents.send('capture:stop');
    active = null;
  }

  function dispose() {
    stop();
    ipcMain.removeListener('capture:started', onStarted);
    ipcMain.removeListener('capture:frame', onFrameIpc);
    ipcMain.removeListener('capture:error', onErrorIpc);
    if (win && !win.isDestroyed()) win.destroy();
    win = null;
    loading = null;
  }

  return { listDisplays, start, configure, ack, stop, dispose };
}

/**
 * @param {unknown} v
 * @param {number} min
 * @param {number} max
 * @param {number} fallback
 */
function clampNum(v, min, max, fallback) {
  const n = Number(v);
  if (v === undefined || v === null || !Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

module.exports = { createCapture };
