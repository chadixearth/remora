// @ts-check
'use strict';

const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');
const { pipeline } = require('stream/promises');

/**
 * @typedef {{name:string, path:string, type:'dir'|'file', size:number, mtime:number}} Entry
 * @typedef {{path:string, parent:string|null, entries:Entry[]}} Listing
 */

const MAX_NAME = 200;
const MAX_TRIES = 10000;

/**
 * Lists a folder, or the curated roots when `p` is `''`.
 * Only real directories and regular files are returned; dirs come first.
 * @param {string} p
 * @returns {Promise<Listing>}
 */
async function listDir(p) {
  if (!p) return { path: '', parent: null, entries: await rootEntries() };
  const abs = path.resolve(p);
  const dirents = await fsp.readdir(abs, { withFileTypes: true });
  const rows = await Promise.all(
    dirents.map(async (d) => {
      if (!d.isDirectory() && !d.isFile()) return null;
      const full = path.join(abs, d.name);
      try {
        const st = await fsp.stat(full);
        return /** @type {Entry} */ ({
          name: d.name,
          path: full,
          type: d.isDirectory() ? 'dir' : 'file',
          size: st.size,
          mtime: st.mtimeMs,
        });
      } catch {
        return null;
      }
    }),
  );
  const entries = rows.filter((e) => e !== null).sort(compareEntries);
  const dirname = path.dirname(abs);
  return { path: abs, parent: dirname === abs ? '' : dirname, entries };
}

/**
 * @param {Entry} a
 * @param {Entry} b
 */
function compareEntries(a, b) {
  if (a.type !== b.type) return a.type === 'dir' ? -1 : 1;
  return a.name.localeCompare(b.name, undefined, { sensitivity: 'base', numeric: true });
}

/**
 * Curated roots: Home, Desktop, Documents, Downloads, then each drive letter on Windows.
 * Drive letters start at C: so A: and B: are never probed.
 * @returns {Promise<Entry[]>}
 */
async function rootEntries() {
  const home = os.homedir();
  /** @type {Entry[]} */
  const roots = [];
  const curated = [
    ['Home', home],
    ['Desktop', path.join(home, 'Desktop')],
    ['Documents', path.join(home, 'Documents')],
    ['Downloads', path.join(home, 'Downloads')],
  ];
  for (const [name, dir] of curated) {
    const entry = await dirEntry(name, dir);
    if (entry) roots.push(entry);
  }
  if (process.platform === 'win32') {
    for (let c = 'C'.charCodeAt(0); c <= 'Z'.charCodeAt(0); c++) {
      const drive = `${String.fromCharCode(c)}:\\`;
      const entry = await dirEntry(drive, drive);
      if (entry) roots.push(entry);
    }
  }
  return roots;
}

/**
 * @param {string} name
 * @param {string} dir
 * @returns {Promise<Entry|null>}
 */
async function dirEntry(name, dir) {
  try {
    const st = await fsp.stat(dir);
    if (!st.isDirectory()) return null;
    return { name, path: dir, type: 'dir', size: 0, mtime: st.mtimeMs };
  } catch {
    return null;
  }
}

/**
 * @param {string} p
 * @returns {Promise<Entry & {parent:string|null}>}
 */
async function stat(p) {
  const abs = path.resolve(p);
  const st = await fsp.stat(abs);
  return {
    name: path.basename(abs),
    path: abs,
    type: st.isDirectory() ? 'dir' : 'file',
    size: st.size,
    mtime: st.mtimeMs,
    parent: path.dirname(abs) === abs ? null : path.dirname(abs),
  };
}

/**
 * Opens a regular file for streaming. Throws synchronously if it is not a file.
 * @param {string} p
 * @returns {fs.ReadStream}
 */
function openRead(p) {
  const abs = path.resolve(p);
  if (!fs.statSync(abs).isFile()) throw new Error('not a file');
  return fs.createReadStream(abs);
}

/**
 * Strips path separators and characters Windows forbids; never returns '', '.' or '..'.
 * @param {string} name
 * @returns {string}
 */
function sanitizeName(name) {
  const base = path.basename(String(name || ''));
  // eslint-disable-next-line no-control-regex
  const cleaned = base.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').replace(/[. ]+$/, '').trim();
  if (!cleaned || cleaned === '.' || cleaned === '..') return 'upload';
  return cleaned.slice(0, MAX_NAME);
}

/**
 * Writes a readable stream into `dir`, never overwriting: `name`, `name (1)`, `name (2)`...
 * The partial file is deleted if the copy fails.
 * @param {string} dir
 * @param {string} name
 * @param {NodeJS.ReadableStream} readable
 * @returns {Promise<string>} absolute path of the saved file
 */
async function saveUpload(dir, name, readable) {
  const folder = path.resolve(dir);
  const st = await fsp.stat(folder);
  if (!st.isDirectory()) throw new Error('upload target is not a folder');

  const clean = sanitizeName(name);
  const { name: stem, ext } = path.parse(clean);

  let handle = null;
  let target = '';
  for (let i = 0; i < MAX_TRIES; i++) {
    const candidate = i === 0 ? clean : `${stem} (${i})${ext}`;
    target = path.join(folder, candidate);
    try {
      handle = await fsp.open(target, 'wx');
      break;
    } catch (err) {
      if (/** @type {NodeJS.ErrnoException} */ (err).code !== 'EEXIST') throw err;
    }
  }
  if (!handle) throw new Error('no free file name');

  try {
    await pipeline(readable, handle.createWriteStream());
  } catch (err) {
    await fsp.rm(target, { force: true }).catch(() => undefined);
    throw err;
  }
  return target;
}

module.exports = { listDir, stat, openRead, saveUpload };
