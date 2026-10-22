// @ts-check
'use strict';

const fs = require('fs');
const path = require('path');
const { spawn, execFile } = require('child_process');
const { EventEmitter } = require('events');

const RELEASES = 'https://github.com/cloudflare/cloudflared/releases/latest/download';
const URL_RE = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/;
const RETRY_DELAYS_MS = [3000, 10000, 30000, 60000];

/** @returns {{asset:string, file:string, archive:boolean}} */
function assetForPlatform() {
  const arch = process.arch === 'arm64' ? 'arm64' : 'amd64';
  if (process.platform === 'win32') return { asset: `cloudflared-windows-${arch}.exe`, file: 'cloudflared.exe', archive: false };
  if (process.platform === 'darwin') return { asset: `cloudflared-darwin-${arch}.tgz`, file: 'cloudflared', archive: true };
  return { asset: `cloudflared-linux-${arch}`, file: 'cloudflared', archive: false };
}

/**
 * Downloads cloudflared into binDir once (per-user, no admin needed).
 * @param {string} binDir
 * @returns {Promise<string>} path to the executable
 */
async function ensureCloudflared(binDir) {
  const { asset, file, archive } = assetForPlatform();
  const target = path.join(binDir, file);
  if (fs.existsSync(target)) return target;
  fs.mkdirSync(binDir, { recursive: true });
  const res = await fetch(`${RELEASES}/${asset}`);
  if (!res.ok) throw new Error(`cloudflared download failed: HTTP ${res.status}`);
  const bytes = Buffer.from(await res.arrayBuffer());
  const download = path.join(binDir, archive ? asset : `${file}.download`);
  fs.writeFileSync(download, bytes, { mode: 0o755 });
  if (archive) {
    await new Promise((resolve, reject) =>
      execFile('tar', ['-xzf', download, '-C', binDir], (err) => (err ? reject(err) : resolve(undefined))));
    fs.rmSync(download, { force: true });
    fs.chmodSync(target, 0o755);
  } else {
    fs.renameSync(download, target);
  }
  return target;
}

/**
 * Keeps a Cloudflare quick tunnel to http://127.0.0.1:<port> alive.
 * Emits 'status' ({status, url, error}) on every change.
 */
class Tunnel extends EventEmitter {
  /** @param {string} binDir */
  constructor(binDir) {
    super();
    this.binDir = binDir;
    /** @type {'starting'|'online'|'offline'|'error'} */
    this.status = 'offline';
    /** @type {string|null} */
    this.url = null;
    /** @type {string|null} */
    this.error = null;
    /** @type {import('child_process').ChildProcess|null} */
    this.proc = null;
    this.port = 0;
    this.failures = 0;
    this.stopped = true;
    /** @type {NodeJS.Timeout|undefined} */
    this.retryTimer = undefined;
  }

  /** @param {'starting'|'online'|'offline'|'error'} status @param {string|null} url @param {string|null} error */
  #set(status, url, error) {
    this.status = status;
    this.url = url;
    this.error = error;
    this.emit('status', { status, url, error });
  }

  /** @param {number} port */
  async start(port) {
    this.port = port;
    this.stopped = false;
    await this.#spawn();
  }

  async #spawn() {
    if (this.stopped) return;
    this.#set('starting', null, null);
    let bin;
    try {
      bin = await ensureCloudflared(this.binDir);
    } catch (err) {
      this.#fail(`Could not download the tunnel helper: ${/** @type {Error} */ (err).message}`);
      return;
    }
    if (this.stopped) return;
    // After repeated failures switch to HTTP/2, which works on networks that block QUIC/UDP.
    const protocol = this.failures >= 2 ? 'http2' : 'auto';
    const proc = spawn(bin, ['tunnel', '--no-autoupdate', '--protocol', protocol, '--url', `http://127.0.0.1:${this.port}`], {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    this.proc = proc;
    let tail = '';
    /** @param {Buffer} chunk */
    const onOutput = (chunk) => {
      const text = chunk.toString();
      tail = (tail + text).slice(-2000);
      const match = text.match(URL_RE);
      if (match && this.url !== match[0]) {
        this.failures = 0;
        this.#set('online', match[0], null);
      }
    };
    proc.stdout?.on('data', onOutput);
    proc.stderr?.on('data', onOutput);
    proc.on('error', (err) => this.#fail(err.message));
    proc.on('exit', (code) => {
      if (this.proc !== proc) return;
      this.proc = null;
      if (this.stopped) return;
      const lastLine = tail.trim().split('\n').pop() ?? '';
      this.#fail(`Tunnel stopped (code ${code}). ${lastLine.replace(/^\S+\s+\S+\s+/, '').slice(0, 200)}`);
    });
  }

  /** @param {string} message */
  #fail(message) {
    this.failures += 1;
    this.#set('error', null, message);
    if (this.stopped) return;
    const delay = RETRY_DELAYS_MS[Math.min(this.failures - 1, RETRY_DELAYS_MS.length - 1)];
    clearTimeout(this.retryTimer);
    this.retryTimer = setTimeout(() => void this.#spawn(), delay);
  }

  async restart() {
    this.#kill();
    this.failures = 0;
    this.stopped = false;
    await this.#spawn();
  }

  stop() {
    this.stopped = true;
    this.#kill();
    this.#set('offline', null, null);
  }

  #kill() {
    clearTimeout(this.retryTimer);
    const proc = this.proc;
    this.proc = null;
    proc?.kill();
  }
}

module.exports = { Tunnel, ensureCloudflared };
