// @ts-check
'use strict';

/**
 * Lightweight headless terminal & status host for Remora Mobile Terminal.
 * Exposes ONLY authenticated PTY terminal sessions (node-pty) and system telemetry
 * over a localhost-bound server behind a Cloudflare tunnel.
 */
const http = require('http');
const os = require('os');
const path = require('path');
const { WebSocketServer } = require('ws');

const { Store } = require('../desktop/core/store');
const { Pairing } = require('../desktop/core/pairing');
const { Tunnel } = require('../desktop/core/tunnel');
const { Beacon } = require('../desktop/core/beacon');
const { createTerminalManager } = require('../desktop/platform/terminal');
const system = require('../desktop/platform/system');

const WEB_APP_URL = process.env.REMORA_WEB_URL || 'https://chadixearth.github.io/remora/';
const PORT = Number(process.env.REMORA_PORT) || 47820;
const DATA_DIR = process.env.REMORA_DATA_DIR || path.join(process.env.APPDATA || os.homedir(), 'Remora');

const store = new Store(DATA_DIR, os.hostname());
// Enforce terminal-only permissions for the headless terminal host.
store.config.permissions = { screen: false, control: false, terminal: true, files: false };
store.save();

const pairing = new Pairing(() => {});
const tunnel = new Tunnel(path.join(DATA_DIR, 'bin'));
const beacon = new Beacon(() => store.config);

/** @type {Set<{id:number, ws:import('ws').WebSocket, device:any, terms:Set<string>}>} */
const conns = new Set();
let nextConnId = 1;

/** @param {string} key */
function parseKey(key) {
  const sep = key.indexOf(':');
  const cid = Number(key.slice(0, sep));
  const conn = [...conns].find((c) => c.id === cid) || null;
  return { conn, id: key.slice(sep + 1) };
}

/** @param {{ws:import('ws').WebSocket}} conn @param {object} msg */
function send(conn, msg) {
  if (conn.ws.readyState === conn.ws.OPEN) conn.ws.send(JSON.stringify(msg));
}

const terminals = createTerminalManager({
  onData(key, data) {
    const { conn, id } = parseKey(key);
    if (conn) send(conn, { type: 'term.data', id, data });
  },
  onExit(key, code) {
    const { conn, id } = parseKey(key);
    if (conn) {
      conn.terms.delete(key);
      send(conn, { type: 'term.exit', id, code });
    }
  },
  audit(key, line) {
    const { conn } = parseKey(key);
    store.log('command', line, conn?.device || null);
  },
});

/** @param {http.ServerResponse} res @param {number} code @param {object} body */
function sendJson(res, code, body) {
  res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

const httpServer = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  const url = new URL(req.url || '/', 'http://localhost');
  if (url.pathname === '/api/ping' && req.method === 'GET') {
    sendJson(res, 200, { ok: true, hostId: store.config.hostId, name: store.config.hostName, version: '0.1.0' });
    return;
  }

  if (url.pathname === '/api/pair' && req.method === 'POST') {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      let body = {};
      try { body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); } catch {
        sendJson(res, 400, { error: 'bad_request' });
        return;
      }
      if (pairing.consume(body.secret) !== 'ok') {
        sendJson(res, 401, { error: 'bad_or_expired_secret' });
        return;
      }
      const { device, token } = store.addDevice(String(body.deviceName || 'Phone'));
      store.log('pair', `Paired ${device.name}`, device);
      sendJson(res, 200, {
        deviceId: device.id,
        token,
        hostId: store.config.hostId,
        hostName: store.config.hostName,
      });
    });
    return;
  }

  sendJson(res, 404, { error: 'not_found' });
});

const wss = new WebSocketServer({ noServer: true, maxPayload: 512 * 1024 });

wss.on('connection', (ws) => {
  const conn = { id: nextConnId++, ws, device: null, terms: new Set() };
  const authTimer = setTimeout(() => ws.close(4401, 'auth timeout'), 5000);

  ws.on('message', async (raw, isBinary) => {
    if (isBinary) return;
    let msg;
    try { msg = JSON.parse(raw.toString('utf8')); } catch { return; }
    if (!msg || typeof msg.type !== 'string') return;

    if (!conn.device) {
      clearTimeout(authTimer);
      const dev = msg.type === 'auth' ? store.verifyToken(msg.token) : null;
      if (!dev) {
        send(conn, { type: 'error', code: 'unauthorized' });
        ws.close(4401, 'unauthorized');
        return;
      }
      conn.device = dev;
      conns.add(conn);
      store.touchDevice(dev.id);
      store.log('connect', `${dev.name} connected`, dev);
      send(conn, {
        type: 'hello',
        hostId: store.config.hostId,
        name: store.config.hostName,
        version: '0.1.0',
        platform: process.platform,
        permissions: store.config.permissions,
        displays: [],
        inputSupported: false,
      });
      return;
    }

    switch (msg.type) {
      case 'status':
        send(conn, { type: 'status', reqId: msg.reqId, ...(await system.getStatus()) });
        break;
      case 'term.open': {
        const key = `${conn.id}:${String(msg.id)}`;
        conn.terms.add(key);
        const cols = Math.min(300, Math.max(20, Number(msg.cols) || 80));
        const rows = Math.min(150, Math.max(6, Number(msg.rows) || 24));
        terminals.open(key, cols, rows);
        store.log('terminal', 'Opened mobile terminal', conn.device);
        send(conn, { type: 'term.opened', id: msg.id });
        break;
      }
      case 'term.input': {
        const key = `${conn.id}:${String(msg.id)}`;
        if (conn.terms.has(key) && typeof msg.data === 'string') {
          terminals.write(key, msg.data);
        }
        break;
      }
      case 'term.resize': {
        const key = `${conn.id}:${String(msg.id)}`;
        if (conn.terms.has(key)) {
          const cols = Math.min(300, Math.max(20, Number(msg.cols) || 80));
          const rows = Math.min(150, Math.max(6, Number(msg.rows) || 24));
          terminals.resize(key, cols, rows);
        }
        break;
      }
      case 'term.close': {
        const key = `${conn.id}:${String(msg.id)}`;
        if (conn.terms.delete(key)) terminals.close(key);
        break;
      }
      default:
        send(conn, { type: 'error', reqId: msg.reqId, code: 'forbidden', permission: 'terminal' });
    }
  });

  ws.on('close', () => {
    clearTimeout(authTimer);
    if (!conns.delete(conn)) return;
    for (const key of conn.terms) terminals.close(key);
    conn.terms.clear();
  });
});

httpServer.on('upgrade', (req, socket, head) => {
  if (new URL(req.url || '/', 'http://localhost').pathname !== '/ws') {
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
});

function mintLocalPairLink(url) {
  const fs = require('fs');
  const { secret, expiresAt } = pairing.create();
  const payload = {
    v: 1,
    h: store.config.hostId,
    n: store.config.hostName,
    t: store.config.beaconTopic,
    k: store.config.beaconKey,
    c: secret,
    u: url || tunnel.url || `http://127.0.0.1:${PORT}`,
  };
  const link = `${WEB_APP_URL}#pair=${Buffer.from(JSON.stringify(payload)).toString('base64url')}`;
  fs.writeFileSync(path.join(DATA_DIR, 'latest-pair-link.json'), JSON.stringify({ link, expiresAt }), { mode: 0o600 });
}

tunnel.on('status', ({ status, url }) => {
  beacon.update(url);
  if (status === 'online' && url) {
    mintLocalPairLink(url);
    console.log(`[remora-terminal] tunnel online: ${url}`);
  }
});

process.stdin?.on('data', () => {
  mintLocalPairLink(tunnel.url);
  console.log('[remora-terminal] minted fresh pair link');
});

httpServer.listen(PORT, '127.0.0.1', () => {
  console.log(`[remora-terminal] listening on http://127.0.0.1:${PORT}`);
  void tunnel.start(PORT);
});
