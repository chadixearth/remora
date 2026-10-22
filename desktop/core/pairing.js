// @ts-check
'use strict';

const crypto = require('crypto');
const { randomId } = require('./store');

const PAIRING_TTL_MS = 10 * 60 * 1000;
const MAX_BAD_ATTEMPTS = 10;

/**
 * One active single-use pairing secret at a time.
 * The secret rotates after MAX_BAD_ATTEMPTS wrong guesses, so the pairing endpoint can't be brute-forced.
 */
class Pairing {
  /** @param {() => void} onChange called whenever the active pairing appears/disappears */
  constructor(onChange) {
    this.onChange = onChange;
    /** @type {{secret:string, expiresAt:number, badAttempts:number}|null} */
    this.active = null;
    /** @type {NodeJS.Timeout|null} */
    this.timer = null;
  }

  /** @returns {{secret:string, expiresAt:number}} */
  create() {
    this.#clearTimer();
    const expiresAt = Date.now() + PAIRING_TTL_MS;
    this.active = { secret: randomId(16), expiresAt, badAttempts: 0 };
    this.timer = setTimeout(() => this.cancel(), PAIRING_TTL_MS);
    this.onChange();
    return { secret: this.active.secret, expiresAt };
  }

  cancel() {
    this.#clearTimer();
    if (!this.active) return;
    this.active = null;
    this.onChange();
  }

  /**
   * Consumes the secret if it matches.
   * @param {unknown} secret
   * @returns {'ok'|'bad'|'none'}
   */
  consume(secret) {
    const active = this.active;
    if (!active || active.expiresAt < Date.now()) return 'none';
    const given = Buffer.from(typeof secret === 'string' ? secret : '');
    const expected = Buffer.from(active.secret);
    if (given.length === expected.length && crypto.timingSafeEqual(given, expected)) {
      this.cancel();
      return 'ok';
    }
    active.badAttempts += 1;
    if (active.badAttempts >= MAX_BAD_ATTEMPTS) this.cancel();
    return 'bad';
  }

  #clearTimer() {
    clearTimeout(this.timer ?? undefined);
    this.timer = null;
  }
}

module.exports = { Pairing };
