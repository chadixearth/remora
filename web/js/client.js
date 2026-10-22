// @ts-check
import { fromBase64Url, resolveHostUrl, upsertHost } from './beacon.js';

export function guessDeviceName() {
  const ua = navigator.userAgent || '';
  if (/iPhone/i.test(ua)) return 'iPhone';
  if (/iPad/i.test(ua)) return 'iPad';
  if (/Android/i.test(ua)) return 'Android Phone';
  if (/Macintosh/i.test(ua)) return 'Mac Browser';
  if (/Windows/i.test(ua)) return 'Windows Browser';
  return 'Mobile Browser';
}

/**
 * Decodes a `#pair=...` payload and exchanges the one-time secret for a device token.
 * @param {string} pairInput full URL or base64url payload
 */
export async function pairFromLink(pairInput) {
  let encoded = pairInput.trim();
  const idx = encoded.indexOf('#pair=');
  if (idx >= 0) encoded = encoded.slice(idx + 6);
  const payload = JSON.parse(new TextDecoder().decode(fromBase64Url(encoded)));
  if (!payload || !payload.h || !payload.c) {
    throw new Error('Invalid pairing link format.');
  }

  let baseUrl = (payload.u || '').replace(/\/+$/, '');
  const deviceName = guessDeviceName();

  async function tryPair(url) {
    const res = await fetch(`${url}/api/pair`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ secret: payload.c, deviceName }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error || `HTTP ${res.status}`);
    }
    return res.json();
  }

  let result;
  try {
    result = await tryPair(baseUrl);
  } catch (firstErr) {
    if (payload.t && payload.k) {
      const resolved = await resolveHostUrl(payload.t, payload.k, payload.h);
      if (resolved && resolved !== baseUrl) {
        baseUrl = resolved;
        result = await tryPair(baseUrl);
      } else {
        throw firstErr;
      }
    } else {
      throw firstErr;
    }
  }

  const record = {
    hostId: result.hostId || payload.h,
    name: result.hostName || payload.n || 'Laptop',
    deviceId: result.deviceId,
    token: result.token,
    topic: payload.t || '',
    key: payload.k || '',
    lastUrl: baseUrl,
    pairedAt: Date.now(),
  };
  upsertHost(record);
  return record;
}

/**
 * Manages a live WebSocket connection to a paired host.
 */
export class HostClient {
  /**
   * @param {any} hostRecord
   * @param {{
   *   onState?: (st: {phase:string, detail?:string, hello?:any}) => void,
   *   onPermissions?: (perms: any) => void,
   *   onTermData?: (id: string, data: string) => void,
   *   onTermExit?: (id: string, code: number) => void,
   *   onScreenMeta?: (meta: any) => void,
   *   onScreenFrame?: (blob: Blob) => void,
   * }} handlers
   */
  constructor(hostRecord, handlers = {}) {
    this.host = hostRecord;
    this.handlers = handlers;
    /** @type {WebSocket|null} */
    this.ws = null;
    this.hello = null;
    this.reqCounter = 1;
    /** @type {Map<string, {resolve:Function, reject:Function}>} */
    this.pending = new Map();
    this.closedByUser = false;
    this.failures = 0;
  }

  async connect() {
    this.closedByUser = false;
    this.handlers.onState?.({ phase: 'connecting', detail: this.host.lastUrl });

    let url = (this.host.lastUrl || '').replace(/\/+$/, '');
    if (!url || this.failures >= 1) {
      if (this.host.topic && this.host.key) {
        this.handlers.onState?.({ phase: 'resolving', detail: 'Locating current tunnel address…' });
        const fresh = await resolveHostUrl(this.host.topic, this.host.key, this.host.hostId);
        if (fresh) {
          url = fresh;
          this.host.lastUrl = fresh;
          upsertHost(this.host);
        }
      }
    }

    if (!url) {
      this.handlers.onState?.({ phase: 'offline', detail: 'No tunnel address available.' });
      return;
    }

    const wsUrl = url.replace(/^http/i, 'ws') + '/ws';
    const ws = new WebSocket(wsUrl);
    ws.binaryType = 'blob';
    this.ws = ws;

    ws.onopen = () => {
      ws.send(JSON.stringify({ type: 'auth', token: this.host.token }));
    };

    ws.onmessage = (event) => {
      if (typeof event.data !== 'string') {
        const blob = event.data instanceof Blob ? event.data : new Blob([event.data], { type: 'image/jpeg' });
        this.handlers.onScreenFrame?.(blob);
        return;
      }
      let msg;
      try { msg = JSON.parse(event.data); } catch { return; }

      if (msg.reqId && this.pending.has(msg.reqId)) {
        const waiter = this.pending.get(msg.reqId);
        this.pending.delete(msg.reqId);
        if (msg.type === 'error') waiter?.reject(new Error(msg.message || msg.code || 'Request error'));
        else waiter?.resolve(msg);
        return;
      }

      switch (msg.type) {
        case 'hello':
          this.failures = 0;
          this.hello = msg;
          this.host.name = msg.name || this.host.name;
          upsertHost(this.host);
          this.handlers.onState?.({ phase: 'online', hello: msg });
          this.handlers.onPermissions?.(msg.permissions);
          break;
        case 'permissions':
          if (this.hello) this.hello.permissions = msg.permissions;
          this.handlers.onPermissions?.(msg.permissions);
          break;
        case 'term.data':
          this.handlers.onTermData?.(msg.id, msg.data);
          break;
        case 'term.exit':
          this.handlers.onTermExit?.(msg.id, msg.code);
          break;
        case 'screen.meta':
          this.handlers.onScreenMeta?.(msg);
          break;
        case 'error':
          if (msg.code === 'unauthorized') {
            this.closedByUser = true;
            this.handlers.onState?.({ phase: 'unauthorized', detail: 'This phone was removed on the laptop.' });
          }
          break;
      }
    };

    ws.onclose = (ev) => {
      for (const [, w] of this.pending) w.reject(new Error('Disconnected'));
      this.pending.clear();
      if (this.closedByUser || ev.code === 4401) {
        if (ev.code === 4401) {
          this.handlers.onState?.({ phase: 'unauthorized', detail: 'Access token rejected or revoked.' });
        }
        return;
      }
      this.failures += 1;
      this.handlers.onState?.({
        phase: 'offline',
        detail: 'Laptop tunnel unreachable. Retry or use the VS Code Tunnel links.',
      });
    };
  }

  /** @param {any} payload */
  send(payload) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(payload));
    }
  }

  /** @param {any} payload @returns {Promise<any>} */
  request(payload) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error('Not connected to laptop'));
    }
    const reqId = `r${this.reqCounter++}`;
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => {
        this.pending.delete(reqId);
        reject(new Error('Request timed out'));
      }, 12000);
      this.pending.set(reqId, {
        resolve: (val) => { clearTimeout(t); resolve(val); },
        reject: (err) => { clearTimeout(t); reject(err); },
      });
      this.send({ ...payload, reqId });
    });
  }

  /** @param {string} filePath */
  async downloadFile(filePath) {
    const url = `${this.host.lastUrl}/api/files/download?path=${encodeURIComponent(filePath)}`;
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${this.host.token}` },
    });
    if (!res.ok) throw new Error(`Download failed (HTTP ${res.status})`);
    const blob = await res.blob();
    const name = filePath.split(/[\\/]/).pop() || 'download';
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  }

  /** @param {string} dirPath @param {File} file */
  async uploadFile(dirPath, file) {
    const url = `${this.host.lastUrl}/api/files/upload?dir=${encodeURIComponent(dirPath)}&name=${encodeURIComponent(file.name)}`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.host.token}` },
      body: file,
    });
    if (!res.ok) throw new Error(`Upload failed (HTTP ${res.status})`);
    return res.json();
  }

  close() {
    this.closedByUser = true;
    this.ws?.close();
  }
}
