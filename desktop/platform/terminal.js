// @ts-check
'use strict';

const os = require('os');

const MAX_LINE = 500;
const MAX_DIM = 500;

/** @type {any} */
let ptyModule = null;
/** @type {Error|null} */
let ptyError = null;

/**
 * node-pty is loaded lazily so a native load failure cannot crash startup.
 * @returns {any}
 */
function loadPty() {
  if (ptyModule) return ptyModule;
  if (ptyError) throw ptyError;
  try {
    ptyModule = require('node-pty');
    return ptyModule;
  } catch (err) {
    ptyError = new Error(`terminal unavailable: ${/** @type {Error} */ (err).message}`);
    throw ptyError;
  }
}

/**
 * @param {unknown} n
 * @returns {number}
 */
function clampDim(n) {
  const v = Math.floor(Number(n));
  if (!Number.isFinite(v) || v < 1) return 80;
  return Math.min(MAX_DIM, v);
}

/**
 * Reconstructs the typed command line from keystrokes. Output is never read.
 * Escape sequences are skipped (state carries across writes), backspace edits the line,
 * Ctrl+C and Ctrl+U clear it, and other control characters are dropped.
 * @param {(line:string) => void} onLine
 */
function createLineAuditor(onLine) {
  let buf = '';
  /** @type {null|'esc'|'csi'|'ss3'|'osc'|'oscEsc'} */
  let state = null;

  /** @param {string} ch */
  function feedChar(ch) {
    if (state === 'esc') {
      if (ch === '[') state = 'csi';
      else if (ch === ']') state = 'osc';
      else if (ch === 'O') state = 'ss3';
      else state = null;
      return;
    }
    if (state === 'csi') {
      const code = ch.charCodeAt(0);
      if (code >= 0x40 && code <= 0x7e) state = null;
      return;
    }
    if (state === 'ss3') {
      state = null;
      return;
    }
    if (state === 'osc') {
      if (ch === '\u0007') state = null;
      else if (ch === '\u001b') state = 'oscEsc';
      return;
    }
    if (state === 'oscEsc') {
      state = null;
      return;
    }
    if (ch === '\u001b') {
      state = 'esc';
      return;
    }
    if (ch === '\r' || ch === '\n') {
      if (buf.trim()) onLine(buf.slice(0, MAX_LINE));
      buf = '';
      return;
    }
    if (ch === '\u007f' || ch === '\b') {
      buf = buf.replace(/[\s\S]$/u, '');
      return;
    }
    if (ch === '\u0003' || ch === '\u0015') {
      buf = '';
      return;
    }
    if (ch.charCodeAt(0) < 0x20) return;
    if (buf.length < MAX_LINE) buf += ch;
  }

  return {
    /** @param {string} data */
    feed(data) {
      for (const ch of data) feedChar(ch);
    },
  };
}

/**
 * @param {{onData(id:string, data:string):void, onExit(id:string, code:number):void, audit(id:string, line:string):void}} opts
 */
function createTerminalManager({ onData, onExit, audit }) {
  /** @type {Map<string, {pty:any, auditor:{feed(data:string):void}}>} */
  const sessions = new Map();

  /**
   * @param {string} id
   * @param {number} cols
   * @param {number} rows
   */
  function open(id, cols, rows) {
    close(id);
    const pty = loadPty();
    const isWin = process.platform === 'win32';
    const shell = isWin ? 'powershell.exe' : process.env.SHELL || '/bin/sh';
    const args = isWin ? ['-NoLogo'] : [];
    const proc = pty.spawn(shell, args, {
      name: 'xterm-256color',
      cols: clampDim(cols),
      rows: clampDim(rows),
      cwd: os.homedir(),
      env: process.env,
      useConpty: true,
    });
    const session = {
      pty: proc,
      auditor: createLineAuditor((line) => {
        try {
          audit(id, line);
        } catch (err) {
          console.warn('[remora] terminal audit failed:', err);
        }
      }),
    };
    sessions.set(id, session);
    proc.onData((/** @type {string} */ data) => {
      if (sessions.get(id) === session) onData(id, data);
    });
    proc.onExit(({ exitCode }) => {
      if (sessions.get(id) !== session) return;
      sessions.delete(id);
      onExit(id, exitCode);
    });
  }

  /**
   * @param {string} id
   * @param {string} data
   */
  function write(id, data) {
    const s = sessions.get(id);
    if (!s) return;
    s.auditor.feed(data);
    s.pty.write(data);
  }

  /**
   * @param {string} id
   * @param {number} cols
   * @param {number} rows
   */
  function resize(id, cols, rows) {
    const s = sessions.get(id);
    if (!s) return;
    try {
      s.pty.resize(clampDim(cols), clampDim(rows));
    } catch {
      // The process may have just exited; the exit event reports it.
    }
  }

  /**
   * Silent close: the session is removed before the process is killed, so no exit event fires.
   * @param {string} id
   */
  function close(id) {
    const s = sessions.get(id);
    if (!s) return;
    sessions.delete(id);
    try {
      s.pty.kill();
    } catch {
      // Already gone.
    }
  }

  function closeAll() {
    for (const id of [...sessions.keys()]) close(id);
  }

  return { open, write, resize, close, closeAll };
}

module.exports = { createTerminalManager };
