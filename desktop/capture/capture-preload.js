// @ts-check
'use strict';

// Sandboxed preload for the hidden capture window. It may only use `electron` and the DOM.
const { ipcRenderer } = require('electron');

/** @type {MediaStream|null} */
let stream = null;
/** @type {HTMLVideoElement|null} */
let video = null;
/** @type {OffscreenCanvas|null} */
let canvas = null;
/** @type {OffscreenCanvasRenderingContext2D|null} */
let ctx = null;
let busy = false;

/** @param {unknown} v @param {number} fallback */
function dim(v, fallback) {
  const n = Math.floor(Number(v));
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/** @param {string} message */
function fail(message) {
  ipcRenderer.send('capture:error', message);
}

/** Releases the current capture, if any. */
function release() {
  if (stream) for (const t of stream.getTracks()) t.stop();
  stream = null;
  if (video) video.srcObject = null;
  video = null;
  canvas = null;
  ctx = null;
}

ipcRenderer.on('capture:start', async () => {
  try {
    release();
    // The main process answers this request with the source chosen for the capture.
    stream = await navigator.mediaDevices.getDisplayMedia({ audio: false, video: true });
    const el = document.createElement('video');
    el.muted = true;
    el.srcObject = stream;
    video = el;
    await el.play();
    if (!el.videoWidth) {
      await new Promise((resolve) => el.addEventListener('loadedmetadata', resolve, { once: true }));
    }
    ipcRenderer.send('capture:started', { videoWidth: el.videoWidth, videoHeight: el.videoHeight });
  } catch (err) {
    release();
    fail(/** @type {Error} */ (err).message || String(err));
  }
});

ipcRenderer.on('capture:pull', async (_event, p) => {
  if (!video || !stream || busy || video.readyState < 2) return;
  busy = true;
  try {
    const w = dim(p.imgWidth, 1);
    const h = dim(p.imgHeight, 1);
    if (!canvas || canvas.width !== w || canvas.height !== h) {
      canvas = new OffscreenCanvas(w, h);
      ctx = canvas.getContext('2d');
    }
    if (!ctx || !canvas) return;
    ctx.drawImage(video, 0, 0, w, h);
    const quality = Math.min(0.95, Math.max(0.3, Number(p.quality) || 0.6));
    const blob = await canvas.convertToBlob({ type: 'image/jpeg', quality });
    const buf = await blob.arrayBuffer();
    ipcRenderer.send('capture:frame', { imgWidth: w, imgHeight: h }, buf);
  } catch (err) {
    fail(/** @type {Error} */ (err).message || String(err));
  } finally {
    busy = false;
  }
});

ipcRenderer.on('capture:stop', () => {
  release();
});
