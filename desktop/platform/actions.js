// @ts-check
'use strict';

const { execFile } = require('child_process');
const { clipboard, shell } = require('electron');

const MAX_CLIPBOARD = 1000000;

/**
 * @param {string} file
 * @param {string[]} args
 * @returns {Promise<void>}
 */
function run(file, args) {
  return new Promise((resolve, reject) => {
    execFile(file, args, { windowsHide: true, timeout: 10000 }, (err) => {
      if (err) reject(err);
      else resolve();
    });
  });
}

/**
 * @param {unknown} arg
 * @returns {string}
 */
function textArg(arg) {
  if (typeof arg !== 'string') throw new Error('text argument required');
  return arg;
}

/**
 * Runs one whitelisted action. Unknown names throw.
 * @param {string} name
 * @param {unknown} arg
 * @returns {Promise<any>}
 */
async function runAction(name, arg) {
  switch (name) {
    case 'lock':
      if (process.platform !== 'win32') throw new Error('lock is supported on Windows only');
      await run('rundll32', ['user32.dll,LockWorkStation']);
      return null;
    case 'sleep':
      if (process.platform !== 'win32') throw new Error('sleep is supported on Windows only');
      await run('rundll32', ['powrprof.dll,SetSuspendState', '0,1,0']);
      return null;
    case 'openUrl': {
      const url = new URL(textArg(arg));
      if (url.protocol !== 'http:' && url.protocol !== 'https:') {
        throw new Error('only http and https links can be opened');
      }
      await shell.openExternal(url.toString());
      return null;
    }
    case 'clipboard.get':
      return clipboard.readText();
    case 'clipboard.set': {
      const text = textArg(arg);
      if (text.length > MAX_CLIPBOARD) throw new Error('clipboard text too large');
      clipboard.writeText(text);
      return null;
    }
    default:
      throw new Error(`unknown action: ${name}`);
  }
}

module.exports = { runAction };
