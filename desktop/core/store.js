// @ts-check
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { EventEmitter } = require('events');

/** @typedef {{screen:boolean, control:boolean, terminal:boolean, files:boolean}} Permissions */
/** @typedef {{id:string, name:string, tokenHash:string, createdAt:number, lastSeenAt:number|null}} Device */
/** @typedef {{ts:number, deviceId:string|null, deviceName:string|null, kind:string, detail:string}} Activity */
/**
 * @typedef {{
 *   version: 1, hostId: string, hostName: string, beaconTopic: string, beaconKey: string,
 *   permissions: Permissions, devices: Device[], autoStart: boolean, keepAwake: boolean
 * }} Config
 */

const ACTIVITY_MEMORY = 500;
const ACTIVITY_FILE_MAX_BYTES = 2 * 1024 * 1024;

/** @param {number} n */
const randomId = (n) => crypto.randomBytes(n).toString('base64url');
/** @param {string} token */
const hashToken = (token) => crypto.createHash('sha256').update(token).digest('hex');

/**
 * Persistent host identity, paired devices, permissions and the activity log.
 * Emits 'change' when config changes and 'activity' (Activity) for each log entry.
 */
class Store extends EventEmitter {
  /**
   * @param {string} dir directory for remora.json and activity.jsonl
   * @param {string} defaultHostName
   */
  constructor(dir, defaultHostName) {
    super();
    this.dir = dir;
    this.configPath = path.join(dir, 'remora.json');
    this.activityPath = path.join(dir, 'activity.jsonl');
    fs.mkdirSync(dir, { recursive: true });
    /** @type {Config} */
    this.config = this.#load(defaultHostName);
    /** @type {Activity[]} */
    this.activity = this.#loadActivity();
  }

  /** @param {string} defaultHostName @returns {Config} */
  #load(defaultHostName) {
    try {
      const raw = JSON.parse(fs.readFileSync(this.configPath, 'utf8'));
      if (raw && raw.version === 1 && raw.hostId && raw.beaconKey) {
        return {
          ...raw,
          permissions: { screen: true, control: false, terminal: false, files: false, ...raw.permissions },
          devices: Array.isArray(raw.devices) ? raw.devices : [],
        };
      }
    } catch (err) {
      if (/** @type {NodeJS.ErrnoException} */ (err).code !== 'ENOENT') {
        // Keep the unreadable file for inspection instead of silently overwriting it.
        fs.renameSync(this.configPath, `${this.configPath}.corrupt-${Date.now()}`);
      }
    }
    /** @type {Config} */
    const fresh = {
      version: 1,
      hostId: randomId(16),
      hostName: defaultHostName,
      beaconTopic: `remora-${randomId(18)}`,
      beaconKey: randomId(32),
      permissions: { screen: true, control: false, terminal: false, files: false },
      devices: [],
      autoStart: true,
      keepAwake: true,
    };
    this.#write(fresh);
    return fresh;
  }

  /** @param {Config} config */
  #write(config) {
    const tmp = `${this.configPath}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(config, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, this.configPath);
  }

  save() {
    this.#write(this.config);
    this.emit('change');
  }

  /** @returns {Activity[]} */
  #loadActivity() {
    try {
      const lines = fs.readFileSync(this.activityPath, 'utf8').trim().split('\n');
      return lines.slice(-ACTIVITY_MEMORY).flatMap((line) => {
        try { return [JSON.parse(line)]; } catch { return []; }
      });
    } catch {
      return [];
    }
  }

  /**
   * @param {string} kind
   * @param {string} detail
   * @param {{id:string, name:string}|null} [device]
   */
  log(kind, detail, device = null) {
    /** @type {Activity} */
    const entry = { ts: Date.now(), deviceId: device?.id ?? null, deviceName: device?.name ?? null, kind, detail };
    this.activity.push(entry);
    if (this.activity.length > ACTIVITY_MEMORY) this.activity.splice(0, this.activity.length - ACTIVITY_MEMORY);
    try {
      if (fs.existsSync(this.activityPath) && fs.statSync(this.activityPath).size > ACTIVITY_FILE_MAX_BYTES) {
        fs.renameSync(this.activityPath, `${this.activityPath}.1`);
      }
      fs.appendFileSync(this.activityPath, `${JSON.stringify(entry)}\n`, { mode: 0o600 });
    } catch (err) {
      console.error('[remora] activity log write failed:', err);
    }
    this.emit('activity', entry);
  }

  /** @param {number} limit */
  recentActivity(limit) {
    return this.activity.slice(-limit).reverse();
  }

  /** @param {keyof Permissions} key @param {boolean} on */
  setPermission(key, on) {
    if (!(key in this.config.permissions)) throw new Error(`unknown permission ${key}`);
    this.config.permissions[key] = on;
    this.save();
  }

  /** @param {string} name */
  renameHost(name) {
    const clean = name.trim().slice(0, 60);
    if (!clean) throw new Error('name required');
    this.config.hostName = clean;
    this.save();
  }

  /** @param {'autoStart'|'keepAwake'} key @param {boolean} on */
  setFlag(key, on) {
    this.config[key] = on;
    this.save();
  }

  /** @param {string} name @returns {{device: Device, token: string}} */
  addDevice(name) {
    const token = randomId(32);
    /** @type {Device} */
    const device = {
      id: randomId(9),
      name: (name || 'Phone').trim().slice(0, 40) || 'Phone',
      tokenHash: hashToken(token),
      createdAt: Date.now(),
      lastSeenAt: null,
    };
    this.config.devices.push(device);
    this.save();
    return { device, token };
  }

  /** @param {string} token @returns {Device|null} */
  verifyToken(token) {
    if (typeof token !== 'string' || token.length < 20 || token.length > 100) return null;
    const candidate = Buffer.from(hashToken(token), 'hex');
    let match = null;
    for (const device of this.config.devices) {
      if (crypto.timingSafeEqual(candidate, Buffer.from(device.tokenHash, 'hex'))) match = device;
    }
    return match;
  }

  /** @param {string} id */
  touchDevice(id) {
    const device = this.config.devices.find((d) => d.id === id);
    if (!device) return;
    device.lastSeenAt = Date.now();
    this.save();
  }

  /** @param {string} id @returns {Device|null} */
  removeDevice(id) {
    const index = this.config.devices.findIndex((d) => d.id === id);
    if (index < 0) return null;
    const [device] = this.config.devices.splice(index, 1);
    this.save();
    return device;
  }
}

module.exports = { Store, randomId };
