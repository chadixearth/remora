// @ts-check
'use strict';

const http = require('http');
const path = require('path');
const { WebSocketServer } = require('ws');
const { screen } = require('electron');

/** @typedef {import('./store').Store} Store */
/** @typedef {import('./store').Device} Device */
/** @typedef {import('./store').Permissions} Permissions */
/** @typedef {import('ws').WebSocket} WebSocket */

const DEFAULT_PORT = 47820;
const AUTH_TIMEOUT_MS = 5000;
const MAX_WS_MESSAGE = 1024 * 1024;
const PAIR_RATE_LIMIT = 30; // attempts per minute, across all callers

/** @type {Record<string, keyof Permissions | null>} */
const PERMISSION_FOR = {
  'status': null,
  'screen.start': 'screen', 'screen.ack': 'screen', 'screen.config': 'screen', 'screen.stop': 'screen',
  'input.mouse': 'control', 'input.key': 'control', 'input.text': 'control',
  'term.open': 'terminal', 'term.input': 'terminal', 'term.resize': 'terminal', 'term.close': 'terminal',
  'files.list': 'files',
  'action': 'control',
};

/**
 * @typedef {{
 *   id: number, ws: WebSocket, device: Device|null, displayId: string|null,
 *   terms: Set<string>
 * }} Conn
 */

/**
 * @typedef {{
 *   store: Store,
 *   pairing: import('./pairing').Pairing,
 *   version: string,
 *   createCapture: typeof import('../capture/capture').createCapture,
 *   input: ReturnType<typeof import('../platform/input').createInput>,
 *   createTerminalManager: typeof import('../platform/terminal').createTerminalManager,
 *   files: typeof import('../platform/files'),
 *   system: typeof import('../platform/system'),
 *   actions: typeof import('../platform/actions'),
 * }} ServerDeps
 */

/** @param {http.ServerResponse} res @param {number} status @param {object} body */
function sendJson(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

/** @param {http.IncomingMessage} req @param {number} limit */
function readJson(req, limit) {
  return new Promise((resolve, reject) => {
    let size = 0;
    /** @type {Buffer[]} */
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) { reject(new Error('too large')); req.destroy(); return; }
      chunks.push(chunk);
    });
    req.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); } catch (err) { reject(err); }
    });
    req.on('error', reject);
  });
}

/** @param {number} bytes */
function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
}

/**
 * The phone-facing server. Binds to 127.0.0.1 only; the tunnel is the sole public entry point.
 * @param {ServerDeps} deps
 */
function createServer(deps) {
  const { store, pairing, input, files, system, actions } = deps;
  /** @type {Set<Conn>} */
  const conns = new Set();
  let nextConnId = 1;
  /** @type {Conn|null} the connection currently receiving screen frames */
  let viewer = null;
  let pairAttempts = { windowStart: Date.now(), count: 0 };
  /** @type {(() => void)|null} */
  let onDevicesChange = null;
  // Frames sent to the viewer but not yet acked. Allowing a few in flight hides tunnel round-trip
  // latency (1 in flight caps a 200 ms RTT at 5 fps) while still bounding lag on slow links.
  let framesInFlight = 0;
  const MAX_FRAMES_IN_FLIGHT = 3;

  // Screen frames go only to the current viewer.
  const capture = deps.createCapture({
    onFrame: (buf) => {
      if (!viewer || viewer.ws.readyState !== viewer.ws.OPEN) return;
      viewer.ws.send(buf, { binary: true });
      framesInFlight += 1;
      if (framesInFlight < MAX_FRAMES_IN_FLIGHT) capture.ack();
    },
    onMeta: (meta) => {
      if (viewer) send(viewer, { type: 'screen.meta', ...meta });
    },
  });

  // Terminal ids are namespaced per connection as `<connId>:<clientId>`.
  const terminals = deps.createTerminalManager({
    onData: (key, data) => {
      const { conn, id } = parseTermKey(key);
      if (conn) send(conn, { type: 'term.data', id, data });
    },
    onExit: (key, code) => {
      const { conn, id } = parseTermKey(key);
      if (conn) { conn.terms.delete(key); send(conn, { type: 'term.exit', id, code }); }
    },
    audit: (key, line) => {
      const { conn } = parseTermKey(key);
      store.log('command', line, conn?.device ?? null);
    },
  });

  /** @param {string} key */
  function parseTermKey(key) {
    const sep = key.indexOf(':');
    const connId = Number(key.slice(0, sep));
    const conn = [...conns].find((c) => c.id === connId) ?? null;
    return { conn, id: key.slice(sep + 1) };
  }

  /** @param {Conn} conn @param {object} msg */
  function send(conn, msg) {
    if (conn.ws.readyState === conn.ws.OPEN) conn.ws.send(JSON.stringify(msg));
  }

  function listDisplays() {
    return screen.getAllDisplays().map((d, i) => ({
      id: String(d.id),
      name: d.label || `Display ${i + 1}`,
      width: Math.round(d.size.width * d.scaleFactor),
      height: Math.round(d.size.height * d.scaleFactor),
      primary: d.id === screen.getPrimaryDisplay().id,
    }));
  }

  /** @param {string|null} displayId */
  function displayFor(displayId) {
    return screen.getAllDisplays().find((d) => String(d.id) === displayId) ?? screen.getPrimaryDisplay();
  }

  function stopViewing() {
    viewer = null;
    framesInFlight = 0;
    capture.stop();
  }

  /** @param {Conn} conn */
  function closeConnTerminals(conn) {
    for (const key of conn.terms) terminals.close(key);
    conn.terms.clear();
  }

  // ----- HTTP -----
  /** @param {http.IncomingMessage} req @returns {Device|null} */
  function bearer(req) {
    const header = req.headers.authorization ?? '';
    return header.startsWith('Bearer ') ? store.verifyToken(header.slice(7)) : null;
  }

  /** @param {http.IncomingMessage} req @param {http.ServerResponse} res */
  async function handleHttp(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Expose-Headers', 'Content-Disposition, Content-Length');
    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }
    const url = new URL(req.url ?? '/', 'http://localhost');
    const { config } = store;

    if (url.pathname === '/api/ping' && req.method === 'GET') {
      sendJson(res, 200, { ok: true, hostId: config.hostId, name: config.hostName, version: deps.version });
      return;
    }

    if (url.pathname === '/api/pair' && req.method === 'POST') {
      const now = Date.now();
      if (now - pairAttempts.windowStart > 60_000) pairAttempts = { windowStart: now, count: 0 };
      if (++pairAttempts.count > PAIR_RATE_LIMIT) { sendJson(res, 429, { error: 'rate_limited' }); return; }
      let body;
      try { body = await readJson(req, 4096); } catch { sendJson(res, 400, { error: 'bad_request' }); return; }
      const result = pairing.consume(body.secret);
      if (result !== 'ok') { sendJson(res, 401, { error: 'bad_secret' }); return; }
      const { device, token } = store.addDevice(String(body.deviceName ?? 'Phone'));
      store.log('pair', `Paired ${device.name}`, device);
      sendJson(res, 200, { deviceId: device.id, token, hostId: config.hostId, hostName: config.hostName });
      return;
    }

    if (url.pathname === '/api/files/download' || url.pathname === '/api/files/upload') {
      const device = bearer(req);
      if (!device) { sendJson(res, 401, { error: 'unauthorized' }); return; }
      if (!config.permissions.files) { sendJson(res, 403, { error: 'forbidden', permission: 'files' }); return; }

      if (url.pathname === '/api/files/download' && req.method === 'GET') {
        const target = url.searchParams.get('path') ?? '';
        let info;
        try { info = await files.stat(target); } catch { sendJson(res, 404, { error: 'not_found' }); return; }
        if (info.type !== 'file') { sendJson(res, 400, { error: 'not_a_file' }); return; }
        const name = path.basename(target);
        res.writeHead(200, {
          'Content-Type': 'application/octet-stream',
          'Content-Length': info.size,
          'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(name)}`,
          'Cache-Control': 'no-store',
        });
        files.openRead(target).on('error', () => res.destroy()).pipe(res);
        store.log('download', `${target} (${formatBytes(info.size)})`, device);
        return;
      }

      if (url.pathname === '/api/files/upload' && req.method === 'POST') {
        const dir = url.searchParams.get('dir') ?? '';
        const name = url.searchParams.get('name') ?? '';
        try {
          const saved = await files.saveUpload(dir, name, req);
          store.log('upload', saved, device);
          sendJson(res, 200, { ok: true, path: saved });
        } catch (err) {
          sendJson(res, 400, { error: 'upload_failed', message: /** @type {Error} */ (err).message });
        }
        return;
      }
    }

    sendJson(res, 404, { error: 'not_found' });
  }

  // ----- WebSocket -----
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_WS_MESSAGE });

  /** @param {WebSocket} ws */
  function onConnection(ws) {
    /** @type {Conn} */
    const conn = { id: nextConnId++, ws, device: null, displayId: null, terms: new Set() };
    const authTimer = setTimeout(() => ws.close(4401, 'auth timeout'), AUTH_TIMEOUT_MS);

    ws.on('message', (raw, isBinary) => {
      if (isBinary) return;
      let msg;
      try { msg = JSON.parse(raw.toString('utf8')); } catch { return; }
      if (!msg || typeof msg.type !== 'string') return;

      if (!conn.device) {
        clearTimeout(authTimer);
        const device = msg.type === 'auth' ? store.verifyToken(msg.token) : null;
        if (!device) {
          send(conn, { type: 'error', code: 'unauthorized' });
          ws.close(4401, 'unauthorized');
          return;
        }
        conn.device = device;
        conns.add(conn);
        store.touchDevice(device.id);
        store.log('connect', `${device.name} connected`, device);
        onDevicesChange?.();
        send(conn, {
          type: 'hello',
          hostId: store.config.hostId,
          name: store.config.hostName,
          version: deps.version,
          platform: process.platform,
          permissions: store.config.permissions,
          displays: listDisplays(),
          inputSupported: input.supported,
        });
        return;
      }
      handleMessage(conn, msg).catch((err) => {
        send(conn, { type: 'error', reqId: msg.reqId, code: 'internal', message: String(err?.message ?? err) });
      });
    });

    ws.on('close', () => {
      clearTimeout(authTimer);
      if (!conns.delete(conn)) return;
      if (viewer === conn) stopViewing();
      closeConnTerminals(conn);
      if (conn.device) {
        store.touchDevice(conn.device.id);
        store.log('disconnect', `${conn.device.name} disconnected`, conn.device);
      }
      onDevicesChange?.();
    });
    ws.on('error', () => ws.terminate());
  }

  /** @param {Conn} conn @param {any} msg */
  async function handleMessage(conn, msg) {
    const device = /** @type {Device} */ (conn.device);
    const perm = PERMISSION_FOR[msg.type];
    if (perm === undefined) {
      send(conn, { type: 'error', reqId: msg.reqId, code: 'bad_request', message: `unknown type ${msg.type}` });
      return;
    }
    if (perm && !store.config.permissions[perm]) {
      send(conn, { type: 'error', reqId: msg.reqId, code: 'forbidden', permission: perm });
      return;
    }

    switch (msg.type) {
      case 'status':
        send(conn, { type: 'status', reqId: msg.reqId, ...(await system.getStatus()) });
        return;

      case 'screen.start': {
        const isNewViewer = viewer !== conn;
        viewer = conn;
        framesInFlight = 0;
        conn.displayId = msg.displayId ? String(msg.displayId) : String(screen.getPrimaryDisplay().id);
        await capture.start({
          displayId: conn.displayId,
          maxWidth: clampNumber(msg.maxWidth, 320, 3840, 1280),
          quality: clampNumber(msg.quality, 0.2, 0.95, 0.6),
          fps: clampNumber(msg.fps, 1, 30, 12),
        });
        if (isNewViewer) store.log('screen', 'Started viewing the screen', device);
        return;
      }
      case 'screen.ack':
        if (viewer !== conn) return;
        framesInFlight = Math.max(0, framesInFlight - 1);
        if (framesInFlight < MAX_FRAMES_IN_FLIGHT) capture.ack();
        return;
      case 'screen.config':
        if (viewer === conn) {
          /** @type {Record<string, number>} */
          const opts = {};
          if (msg.maxWidth !== undefined) opts.maxWidth = clampNumber(msg.maxWidth, 320, 3840, 1280);
          if (msg.quality !== undefined) opts.quality = clampNumber(msg.quality, 0.2, 0.95, 0.6);
          if (msg.fps !== undefined) opts.fps = clampNumber(msg.fps, 1, 30, 12);
          capture.configure(opts);
        }
        return;
      case 'screen.stop':
        if (viewer === conn) stopViewing();
        return;

      case 'input.mouse':
        if (!input.supported) return void send(conn, { type: 'error', code: 'unsupported', message: 'Input control is not supported on this OS yet.' });
        await input.mouse(msg, displayFor(conn.displayId));
        return;
      case 'input.key':
        if (input.supported) await input.key(msg);
        return;
      case 'input.text':
        if (input.supported && typeof msg.text === 'string') await input.text(msg.text.slice(0, 4000));
        return;

      case 'term.open': {
        const key = `${conn.id}:${String(msg.id)}`;
        conn.terms.add(key);
        terminals.open(key, clampNumber(msg.cols, 10, 500, 80), clampNumber(msg.rows, 4, 200, 24));
        store.log('terminal', 'Opened a terminal', device);
        send(conn, { type: 'term.opened', id: msg.id });
        return;
      }
      case 'term.input': {
        const key = `${conn.id}:${String(msg.id)}`;
        if (conn.terms.has(key) && typeof msg.data === 'string') terminals.write(key, msg.data);
        return;
      }
      case 'term.resize': {
        const key = `${conn.id}:${String(msg.id)}`;
        if (conn.terms.has(key)) terminals.resize(key, clampNumber(msg.cols, 10, 500, 80), clampNumber(msg.rows, 4, 200, 24));
        return;
      }
      case 'term.close': {
        const key = `${conn.id}:${String(msg.id)}`;
        if (conn.terms.delete(key)) terminals.close(key);
        return;
      }

      case 'files.list': {
        const listing = await files.listDir(typeof msg.path === 'string' ? msg.path : '');
        const entries = listing.entries.map(({ type, ...entry }) => ({ ...entry, dir: type === 'dir' }));
        send(conn, { type: 'files.list', reqId: msg.reqId, path: listing.path, parent: listing.parent, entries });
        return;
      }

      case 'action': {
        const name = String(msg.name);
        try {
          const data = await actions.runAction(name, msg.arg);
          const detail = name === 'openUrl' ? `openUrl ${String(msg.arg)}` : name;
          store.log('action', detail, device);
          send(conn, { type: 'action.result', reqId: msg.reqId, ok: true, data });
        } catch (err) {
          send(conn, { type: 'action.result', reqId: msg.reqId, ok: false, error: /** @type {Error} */ (err).message });
        }
      }
    }
  }

  /** @param {unknown} value @param {number} min @param {number} max @param {number} fallback */
  function clampNumber(value, min, max, fallback) {
    const n = Number(value);
    return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
  }

  const httpServer = http.createServer((req, res) => {
    handleHttp(req, res).catch((err) => {
      console.error('[remora] http error', err);
      if (!res.headersSent) sendJson(res, 500, { error: 'internal' });
      else res.destroy();
    });
  });
  httpServer.on('upgrade', (req, socket, head) => {
    if (new URL(req.url ?? '/', 'http://localhost').pathname !== '/ws') { socket.destroy(); return; }
    wss.handleUpgrade(req, socket, head, onConnection);
  });

  return {
    /** @returns {Promise<number>} the bound port */
    listen() {
      return new Promise((resolve, reject) => {
        const tryListen = (/** @type {number} */ port) => {
          httpServer.once('error', (err) => {
            if (/** @type {NodeJS.ErrnoException} */ (err).code === 'EADDRINUSE' && port !== 0) tryListen(0);
            else reject(err);
          });
          httpServer.listen(port, '127.0.0.1', () => {
            const addr = httpServer.address();
            resolve(typeof addr === 'object' && addr ? addr.port : port);
          });
        };
        tryListen(Number(process.env.REMORA_PORT) || DEFAULT_PORT);
      });
    },

    /** Push the current permissions to every phone and tear down anything no longer allowed. */
    permissionsChanged() {
      const { permissions } = store.config;
      if (!permissions.screen && viewer) stopViewing();
      for (const conn of conns) {
        if (!permissions.terminal) closeConnTerminals(conn);
        send(conn, { type: 'permissions', permissions });
      }
    },

    /** @param {string} deviceId */
    disconnectDevice(deviceId) {
      for (const conn of conns) {
        if (conn.device?.id === deviceId) {
          send(conn, { type: 'error', code: 'unauthorized' });
          conn.ws.close(4401, 'revoked');
        }
      }
    },

    /** @returns {Set<string>} ids of devices with a live connection */
    onlineDeviceIds() {
      return new Set([...conns].map((c) => /** @type {Device} */ (c.device).id));
    },

    /** @param {() => void} cb */
    onDevicesChanged(cb) { onDevicesChange = cb; },

    close() {
      stopViewing();
      for (const conn of conns) { closeConnTerminals(conn); conn.ws.terminate(); }
      terminals.closeAll();
      capture.dispose();
      input.dispose();
      wss.close();
      httpServer.close();
    },
  };
}

module.exports = { createServer };
