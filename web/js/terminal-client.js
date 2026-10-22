// @ts-check

const STORAGE_KEY = 'remora.hosts';
const AAD = new TextEncoder().encode('remora-beacon-v1');

/** @param {string} b64u */
export function fromBase64Url(b64u) {
  const pad = '='.repeat((4 - (b64u.length % 4)) % 4);
  const bin = atob(b64u.replace(/-/g, '+').replace(/_/g, '/') + pad);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/**
 * @param {string} keyB64u
 * @param {string} sealedB64u
 */
export async function decryptBeacon(keyB64u, sealedB64u) {
  const raw = fromBase64Url(sealedB64u);
  if (raw.byteLength < 29) throw new Error('Invalid beacon payload');
  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    fromBase64Url(keyB64u),
    { name: 'AES-GCM' },
    false,
    ['decrypt'],
  );
  const plainBuf = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: raw.slice(0, 12), additionalData: AAD },
    cryptoKey,
    raw.slice(12),
  );
  return JSON.parse(new TextDecoder().decode(plainBuf));
}

/**
 * @param {string} topic
 * @param {string} keyB64u
 * @param {string} expectedHostId
 * @returns {Promise<string|null>}
 */
export async function resolveHostUrl(topic, keyB64u, expectedHostId) {
  const res = await fetch(`https://ntfy.sh/${encodeURIComponent(topic)}/json?poll=1&since=12h`, {
    cache: 'no-store',
  });
  if (!res.ok) return null;
  const lines = (await res.text()).trim().split('\n').filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const evt = JSON.parse(lines[i]);
      if (evt.event !== 'message' || typeof evt.message !== 'string') continue;
      const open = await decryptBeacon(keyB64u, evt.message);
      if (open && open.h === expectedHostId && typeof open.u === 'string') {
        return open.u.replace(/\/+$/, '');
      }
    } catch {
      // Skip unrelated messages
    }
  }
  return null;
}

export function loadHosts() {
  try {
    const raw = JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]');
    return Array.isArray(raw) ? raw : [];
  } catch {
    return [];
  }
}

/** @param {any} record */
export function upsertHost(record) {
  const list = loadHosts().filter((h) => h.hostId !== record.hostId);
  list.unshift(record);
  localStorage.setItem(STORAGE_KEY, JSON.stringify(list));
  return list;
}

/** @param {string} hostId */
export function removeHost(hostId) {
  const list = loadHosts().filter((h) => h.hostId !== hostId);
  localStorage.setItem(STORAGE_KEY, JSON.stringify(list));
}

function guessDeviceName() {
  const ua = navigator.userAgent || '';
  if (/iPhone/i.test(ua)) return 'iPhone';
  if (/iPad/i.test(ua)) return 'iPad';
  if (/Android/i.test(ua)) return 'Android Phone';
  return 'Mobile Browser';
}

/** @param {string} pairInput */
export async function pairFromLink(pairInput) {
  let encoded = pairInput.trim();
  const idx = encoded.indexOf('#pair=');
  if (idx >= 0) encoded = encoded.slice(idx + 6);
  const payload = JSON.parse(new TextDecoder().decode(fromBase64Url(encoded)));
  if (!payload || !payload.h || !payload.c) {
    throw new Error('Invalid pairing link.');
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
  } catch (err) {
    if (payload.t && payload.k) {
      const fresh = await resolveHostUrl(payload.t, payload.k, payload.h);
      if (fresh && fresh !== baseUrl) {
        baseUrl = fresh;
        result = await tryPair(baseUrl);
      } else {
        throw err;
      }
    } else {
      throw err;
    }
  }

  const record = {
    hostId: result.hostId || payload.h,
    name: result.hostName || payload.n || 'ChadiEarthy',
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

export class TerminalSessionClient {
  /**
   * @param {any} host
   * @param {{
   *   onState?: (st: {phase:string, detail?:string, hello?:any}) => void,
   *   onTermData?: (data:string) => void,
   *   onTermExit?: (code:number) => void,
   *   onStatus?: (st:any) => void,
   * }} cb
   */
  constructor(host, cb = {}) {
    this.host = host;
    this.cb = cb;
    /** @type {WebSocket|null} */
    this.ws = null;
    this.hello = null;
    this.failures = 0;
    this.closed = false;
  }

  async connect() {
    this.closed = false;
    this.cb.onState?.({ phase: 'connecting', detail: 'Connecting to laptop…' });

    let url = (this.host.lastUrl || '').replace(/\/+$/, '');
    if (!url || this.failures > 0) {
      if (this.host.topic && this.host.key) {
        const fresh = await resolveHostUrl(this.host.topic, this.host.key, this.host.hostId);
        if (fresh) {
          url = fresh;
          this.host.lastUrl = fresh;
          upsertHost(this.host);
        }
      }
    }
    if (!url) {
      this.cb.onState?.({ phase: 'offline', detail: 'No tunnel address found.' });
      return;
    }

    const ws = new WebSocket(url.replace(/^http/i, 'ws') + '/ws');
    this.ws = ws;

    ws.onopen = () => {
      ws.send(JSON.stringify({ type: 'auth', token: this.host.token }));
    };

    ws.onmessage = (ev) => {
      if (typeof ev.data !== 'string') return;
      let msg;
      try { msg = JSON.parse(ev.data); } catch { return; }

      switch (msg.type) {
        case 'hello':
          this.failures = 0;
          this.hello = msg;
          this.cb.onState?.({ phase: 'online', hello: msg });
          break;
        case 'permissions':
          if (this.hello) this.hello.permissions = msg.permissions;
          this.cb.onState?.({ phase: 'online', hello: this.hello });
          break;
        case 'term.data':
          this.cb.onTermData?.(msg.data);
          break;
        case 'term.exit':
          this.cb.onTermExit?.(msg.code);
          break;
        case 'status':
          this.cb.onStatus?.(msg);
          break;
        case 'error':
          if (msg.code === 'unauthorized') {
            this.closed = true;
            this.cb.onState?.({ phase: 'unauthorized', detail: 'Session revoked on laptop.' });
          } else if (msg.code === 'forbidden' && msg.permission === 'terminal') {
            this.cb.onState?.({ phase: 'forbidden', detail: 'Terminal permission is off on laptop.' });
          }
          break;
      }
    };

    ws.onclose = (ev) => {
      if (this.closed || ev.code === 4401) {
        if (ev.code === 4401) {
          this.cb.onState?.({ phase: 'unauthorized', detail: 'Device token rejected.' });
        }
        return;
      }
      this.failures += 1;
      this.cb.onState?.({ phase: 'offline', detail: 'Disconnected from laptop.' });
    };
  }

  /** @param {any} msg */
  send(msg) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
    }
  }

  close() {
    this.closed = true;
    this.ws?.close();
  }
}
