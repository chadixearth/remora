// @ts-check
'use strict';

const { contextBridge, ipcRenderer } = require('electron');

/** @param {string} name */
const invoke = (name) => (/** @type {any[]} */ ...args) => ipcRenderer.invoke(`remora:${name}`, ...args);

/** @param {string} channel @param {(payload: any) => void} cb */
function subscribe(channel, cb) {
  /** @param {unknown} _event @param {any} payload */
  const listener = (_event, payload) => cb(payload);
  ipcRenderer.on(channel, listener);
  return () => { ipcRenderer.removeListener(channel, listener); };
}

contextBridge.exposeInMainWorld('remora', {
  getState: invoke('getState'),
  onState: (/** @type {(state: any) => void} */ cb) => subscribe('remora:state', cb),
  createPairing: invoke('createPairing'),
  cancelPairing: invoke('cancelPairing'),
  setPermission: invoke('setPermission'),
  revokeDevice: invoke('revokeDevice'),
  renameHost: invoke('renameHost'),
  setAutoStart: invoke('setAutoStart'),
  setKeepAwake: invoke('setKeepAwake'),
  restartTunnel: invoke('restartTunnel'),
  stopTunnel: invoke('stopTunnel'),
  startTunnel: invoke('startTunnel'),
  getActivity: invoke('getActivity'),
  onActivity: (/** @type {(entry: any) => void} */ cb) => subscribe('remora:activity', cb),
  copyText: invoke('copyText'),
  openExternal: invoke('openExternal'),
});
