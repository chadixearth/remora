// @ts-check
'use strict';

const crypto = require('crypto');
const { EventEmitter } = require('events');

const NTFY = 'https://ntfy.sh';
const AAD = Buffer.from('remora-beacon-v1');
// ntfy keeps messages for 12 h; republish well inside that window.
const REPUBLISH_MS = 3 * 60 * 60 * 1000;
const RETRY_MS = 60 * 1000;

/**
 * Encrypts the beacon payload: base64url(iv || ciphertext || tag), AES-256-GCM.
 * @param {string} keyB64u
 * @param {object} payload
 */
function sealBeacon(keyB64u, payload) {
  const key = Buffer.from(keyB64u, 'base64url');
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(AAD);
  const ct = Buffer.concat([cipher.update(JSON.stringify(payload), 'utf8'), cipher.final()]);
  return Buffer.concat([iv, ct, cipher.getAuthTag()]).toString('base64url');
}

/** @param {string} keyB64u @param {string} sealed */
function openBeacon(keyB64u, sealed) {
  const raw = Buffer.from(sealed, 'base64url');
  const decipher = crypto.createDecipheriv('aes-256-gcm', Buffer.from(keyB64u, 'base64url'), raw.subarray(0, 12));
  decipher.setAAD(AAD);
  decipher.setAuthTag(raw.subarray(raw.length - 16));
  return JSON.parse(Buffer.concat([decipher.update(raw.subarray(12, raw.length - 16)), decipher.final()]).toString('utf8'));
}

/**
 * Publishes the host's current tunnel URL so paired phones can find it after it changes.
 * Emits 'status' ({lastPublishedAt, error}).
 */
class Beacon extends EventEmitter {
  /** @param {() => {hostId:string, beaconTopic:string, beaconKey:string}} getIdentity */
  constructor(getIdentity) {
    super();
    this.getIdentity = getIdentity;
    /** @type {string|null} */
    this.url = null;
    /** @type {number|null} */
    this.lastPublishedAt = null;
    /** @type {string|null} */
    this.error = null;
    /** @type {NodeJS.Timeout|undefined} */
    this.timer = undefined;
  }

  /** @param {string|null} url */
  update(url) {
    this.url = url;
    clearTimeout(this.timer);
    if (url) void this.#publish();
  }

  async #publish() {
    const url = this.url;
    if (!url) return;
    const { hostId, beaconTopic, beaconKey } = this.getIdentity();
    try {
      const body = sealBeacon(beaconKey, { v: 1, h: hostId, u: url, ts: Date.now() });
      const res = await fetch(`${NTFY}/${beaconTopic}`, { method: 'POST', body, headers: { 'X-Cache': 'yes' } });
      if (!res.ok) throw new Error(`ntfy HTTP ${res.status}`);
      this.lastPublishedAt = Date.now();
      this.error = null;
      this.#schedule(REPUBLISH_MS);
    } catch (err) {
      this.error = /** @type {Error} */ (err).message;
      this.#schedule(RETRY_MS);
    }
    this.emit('status', { lastPublishedAt: this.lastPublishedAt, error: this.error });
  }

  /** @param {number} ms */
  #schedule(ms) {
    clearTimeout(this.timer);
    if (this.url) this.timer = setTimeout(() => void this.#publish(), ms);
  }

  stop() {
    clearTimeout(this.timer);
    this.url = null;
  }
}

module.exports = { Beacon, sealBeacon, openBeacon };
