// @ts-check
'use strict';

const { spawn } = require('child_process');

const READY_TIMEOUT_MS = 15000;
const CMD_TIMEOUT_MS = 3000;
const MAX_TEXT = 2000;
const STDERR_KEEP = 500;

const BUTTONS = {
  left: { down: 0x0002, up: 0x0004 },
  right: { down: 0x0008, up: 0x0010 },
  middle: { down: 0x0020, up: 0x0040 },
};
const MOD_BITS = { ctrl: 1, alt: 2, shift: 4, win: 8 };
const KEY_VK = {
  Enter: { vk: 0x0d, ext: false },
  Backspace: { vk: 0x08, ext: false },
  Tab: { vk: 0x09, ext: false },
  Escape: { vk: 0x1b, ext: false },
  Space: { vk: 0x20, ext: false },
  Delete: { vk: 0x2e, ext: true },
  Home: { vk: 0x24, ext: true },
  End: { vk: 0x23, ext: true },
  PageUp: { vk: 0x21, ext: true },
  PageDown: { vk: 0x22, ext: true },
  ArrowUp: { vk: 0x26, ext: true },
  ArrowDown: { vk: 0x28, ext: true },
  ArrowLeft: { vk: 0x25, ext: true },
  ArrowRight: { vk: 0x27, ext: true },
};

/**
 * The helper is a single PowerShell process running this script. It reads one command per line
 * on stdin and answers `ok` or `err <message>`. It prints `ready` once the C# type is loaded.
 * Commands:
 *   M px py flags wheel   move to physical px,py, then send flags ('-' = none, else CSV of
 *                         MOUSEEVENTF values), then one wheel event if wheel != 0
 *   K vk ext mods         press modifiers, tap virtual key, release modifiers (mods = bitmask)
 *   T base64              type UTF-8 text as KEYEVENTF_UNICODE, one event per UTF-16 unit
 * The script is passed with -EncodedCommand, so it works inside an asar-packaged app.
 */
const HELPER_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @"
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public static class RemoraNative {
  [StructLayout(LayoutKind.Sequential)]
  public struct MOUSEINPUT { public int dx; public int dy; public uint mouseData; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }
  [StructLayout(LayoutKind.Sequential)]
  public struct KEYBDINPUT { public ushort wVk; public ushort wScan; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }
  [StructLayout(LayoutKind.Explicit)]
  public struct INPUT { [FieldOffset(0)] public uint type; [FieldOffset(8)] public MOUSEINPUT mi; [FieldOffset(8)] public KEYBDINPUT ki; }
  [DllImport("user32.dll", SetLastError = true)]
  static extern uint SendInput(uint n, INPUT[] inputs, int size);
  [DllImport("user32.dll")]
  static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")]
  static extern bool SetProcessDPIAware();

  const uint KEYEVENTF_EXTENDEDKEY = 0x0001;
  const uint KEYEVENTF_KEYUP = 0x0002;
  const uint KEYEVENTF_UNICODE = 0x0004;
  const uint MOUSEEVENTF_WHEEL = 0x0800;

  public static void Init() { SetProcessDPIAware(); }

  static void Send(List<INPUT> list) {
    INPUT[] arr = list.ToArray();
    uint sent = SendInput((uint)arr.Length, arr, Marshal.SizeOf(typeof(INPUT)));
    if (sent != (uint)arr.Length) throw new Exception("SendInput blocked (" + sent + " of " + arr.Length + ")");
  }

  static INPUT Mouse(uint flags, uint data) {
    INPUT i = new INPUT();
    i.type = 0;
    i.mi.dwFlags = flags;
    i.mi.mouseData = data;
    return i;
  }

  static INPUT Key(ushort vk, bool ext, bool up) {
    INPUT i = new INPUT();
    i.type = 1;
    i.ki.wVk = vk;
    i.ki.dwFlags = (ext ? KEYEVENTF_EXTENDEDKEY : 0) | (up ? KEYEVENTF_KEYUP : 0);
    return i;
  }

  static INPUT Uni(ushort scan, bool up) {
    INPUT i = new INPUT();
    i.type = 1;
    i.ki.wScan = scan;
    i.ki.dwFlags = KEYEVENTF_UNICODE | (up ? KEYEVENTF_KEYUP : 0);
    return i;
  }

  public static void MouseAt(int x, int y, uint[] flags, int wheel) {
    if (!SetCursorPos(x, y)) throw new Exception("SetCursorPos failed");
    if (flags.Length > 0) {
      List<INPUT> list = new List<INPUT>();
      foreach (uint f in flags) list.Add(Mouse(f, 0));
      Send(list);
    }
    if (wheel != 0) {
      List<INPUT> list = new List<INPUT>();
      list.Add(Mouse(MOUSEEVENTF_WHEEL, unchecked((uint)wheel)));
      Send(list);
    }
  }

  public static void Key(ushort vk, bool ext, int mods) {
    ushort[] modVks = new ushort[] { 0x11, 0x12, 0x10, 0x5B };
    List<ushort> held = new List<ushort>();
    for (int b = 0; b < 4; b++) if ((mods & (1 << b)) != 0) held.Add(modVks[b]);
    List<INPUT> list = new List<INPUT>();
    foreach (ushort m in held) list.Add(Key(m, false, false));
    list.Add(Key(vk, ext, false));
    list.Add(Key(vk, ext, true));
    for (int i = held.Count - 1; i >= 0; i--) list.Add(Key(held[i], false, true));
    Send(list);
  }

  public static void Unicode(string s) {
    List<INPUT> list = new List<INPUT>();
    foreach (char c in s) {
      list.Add(Uni((ushort)c, false));
      list.Add(Uni((ushort)c, true));
    }
    if (list.Count > 0) Send(list);
  }
}
"@

[RemoraNative]::Init()
[Console]::Out.WriteLine('ready')
[Console]::Out.Flush()

while ($true) {
  $line = [Console]::In.ReadLine()
  if ($null -eq $line) { break }
  try {
    $p = $line.Split(' ')
    switch ($p[0]) {
      'M' {
        $flags = [uint32[]]@()
        if ($p[3] -ne '-') { $flags = [uint32[]]($p[3].Split(',')) }
        [RemoraNative]::MouseAt([int]$p[1], [int]$p[2], $flags, [int]$p[4])
      }
      'K' { [RemoraNative]::Key([uint16]$p[1], ($p[2] -eq '1'), [int]$p[3]) }
      'T' {
        $text = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($p[1]))
        [RemoraNative]::Unicode($text)
      }
      default { throw "unknown command" }
    }
    [Console]::Out.WriteLine('ok')
  } catch {
    $msg = ($_.Exception.Message -replace '[\r\n]+', ' ')
    [Console]::Out.WriteLine('err ' + $msg)
  }
  [Console]::Out.Flush()
}
`;

const ENCODED_SCRIPT = Buffer.from(HELPER_SCRIPT, 'utf16le').toString('base64');

/**
 * @typedef {{child:import('child_process').ChildProcess, ready:boolean, dead:boolean,
 *   readyPromise:Promise<Helper>, resolveReady:(h:Helper)=>void, rejectReady:(e:Error)=>void,
 *   waiters:Array<(reply:string)=>void>, stderr:string}} Helper
 */

/**
 * @param {number} n
 * @returns {number}
 */
function clamp01(n) {
  const v = Number(n);
  if (!Number.isFinite(v)) return 0;
  return Math.min(1, Math.max(0, v));
}

/**
 * Maps normalized display coordinates to physical virtual-desktop pixels.
 * @param {number} x
 * @param {number} y
 * @param {{bounds:{x:number,y:number,width:number,height:number}, scaleFactor:number}} display
 */
function toPhysical(x, y, display) {
  const s = display.scaleFactor || 1;
  const b = display.bounds;
  const w = Math.max(1, b.width * s - 1);
  const h = Math.max(1, b.height * s - 1);
  return {
    x: Math.round(b.x * s + clamp01(x) * w),
    y: Math.round(b.y * s + clamp01(y) * h),
  };
}

/**
 * @param {unknown} mods
 * @returns {number}
 */
function modBits(mods) {
  if (!Array.isArray(mods)) return 0;
  let bits = 0;
  for (const m of mods) {
    const bit = /** @type {Record<string, number>} */ (MOD_BITS)[String(m)];
    if (bit) bits |= bit;
  }
  return bits;
}

/**
 * @param {string} key
 * @returns {{vk:number, ext:boolean}|null}
 */
function keyToVk(key) {
  const named = /** @type {Record<string, {vk:number, ext:boolean}>} */ (KEY_VK)[key];
  if (named) return named;
  const fn = /^F([1-9]|1[0-2])$/.exec(key);
  if (fn) return { vk: 0x6f + Number(fn[1]), ext: false };
  if (/^[A-Za-z0-9]$/.test(key)) return { vk: key.toUpperCase().charCodeAt(0), ext: false };
  return null;
}

/**
 * Starts the helper. Its readyPromise resolves on `ready` and rejects on early exit or timeout.
 * @returns {Helper}
 */
function startHelper() {
  const child = spawn(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', ENCODED_SCRIPT],
    { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] },
  );
  /** @type {Helper} */
  const h = {
    child,
    ready: false,
    dead: false,
    stderr: '',
    waiters: [],
    resolveReady: () => undefined,
    rejectReady: () => undefined,
    readyPromise: Promise.resolve(/** @type {any} */ (null)),
  };
  h.readyPromise = new Promise((resolve, reject) => {
    h.resolveReady = resolve;
    h.rejectReady = reject;
  });
  const timer = setTimeout(() => {
    if (!h.ready) {
      h.rejectReady(new Error('input helper did not start'));
      child.kill();
    }
  }, READY_TIMEOUT_MS);

  let buf = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (/** @type {string} */ chunk) => {
    buf += chunk;
    let i = buf.indexOf('\n');
    while (i >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (line === 'ready') {
        h.ready = true;
        clearTimeout(timer);
        h.resolveReady(h);
      } else {
        const waiter = h.waiters.shift();
        if (waiter) waiter(line);
      }
      i = buf.indexOf('\n');
    }
  });
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (/** @type {string} */ chunk) => {
    h.stderr = (h.stderr + chunk).slice(-STDERR_KEEP);
  });

  const fail = (/** @type {string} */ reason) => {
    if (h.dead) return;
    h.dead = true;
    clearTimeout(timer);
    const err = new Error(`input helper ${reason}${h.stderr ? `: ${h.stderr.trim()}` : ''}`);
    if (!h.ready) h.rejectReady(err);
    for (const waiter of h.waiters.splice(0)) waiter(`err ${err.message}`);
  };
  child.on('error', (err) => fail(`error: ${err.message}`));
  child.on('exit', (code) => fail(`exited (${code})`));
  return h;
}

/**
 * @param {string} name
 * @param {unknown} v
 */
function warn(name, v) {
  console.warn(`[remora] input ${name} failed:`, v);
}

/**
 * Creates the input injector. On non-Windows platforms every method is a no-op.
 * Methods resolve once the command has run, and never reject; failures are logged.
 * @returns {{supported:boolean, mouse(evt:any, display:any):Promise<void>, key(evt:any):Promise<void>, text(str:string):Promise<void>, dispose():void}}
 */
function createInput() {
  if (process.platform !== 'win32') {
    return {
      supported: false,
      mouse: () => Promise.resolve(),
      key: () => Promise.resolve(),
      text: () => Promise.resolve(),
      dispose: () => undefined,
    };
  }

  /** @type {Helper|null} */
  let helper = null;
  let disposed = false;
  /** @type {Promise<void>} */
  let chain = Promise.resolve();

  /** @returns {Promise<Helper>} */
  function ensureHelper() {
    if (!helper || helper.dead) helper = startHelper();
    return helper.readyPromise;
  }

  /** @param {Helper} h */
  function kill(h) {
    if (helper === h) helper = null;
    if (!h.dead) h.child.kill();
  }

  /**
   * Sends one command line and waits for its reply.
   * @param {string} line
   * @returns {Promise<void>}
   */
  async function send(line) {
    const h = await ensureHelper();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        kill(h);
        reject(new Error('input command timed out'));
      }, CMD_TIMEOUT_MS);
      h.waiters.push((reply) => {
        clearTimeout(timer);
        if (reply === 'ok') resolve();
        else reject(new Error(reply.replace(/^err\s*/, '') || 'input failed'));
      });
      h.child.stdin?.write(`${line}\n`);
    });
  }

  /**
   * Runs jobs one at a time, in order. A failed job is logged and the chain continues.
   * @param {string} name
   * @param {() => Promise<void>} job
   * @returns {Promise<void>}
   */
  function enqueue(name, job) {
    if (disposed) return Promise.resolve();
    const next = chain.then(job).catch((err) => warn(name, err));
    chain = next;
    return next;
  }

  /**
   * @param {string} action
   * @param {string} button
   */
  function buttonFlags(action, button) {
    const b = BUTTONS[/** @type {keyof typeof BUTTONS} */ (button)] || BUTTONS.left;
    return { down: b.down, up: b.up, action };
  }

  return {
    supported: true,

    mouse(evt, display) {
      return enqueue('mouse', async () => {
        const pt = toPhysical(evt.x, evt.y, display);
        const at = `${pt.x} ${pt.y}`;
        const b = buttonFlags(evt.action, evt.button || 'left');
        switch (evt.action) {
          case 'move':
            return send(`M ${at} - 0`);
          case 'down':
            return send(`M ${at} ${b.down} 0`);
          case 'up':
            return send(`M ${at} ${b.up} 0`);
          case 'click':
            return send(`M ${at} ${b.down},${b.up} 0`);
          case 'dblclick':
            return send(`M ${at} ${b.down},${b.up},${b.down},${b.up} 0`);
          case 'scroll': {
            const notches = Math.round(Number(evt.dy) || 0);
            if (notches === 0) return send(`M ${at} - 0`);
            return send(`M ${at} - ${-120 * notches}`);
          }
          default:
            throw new Error(`unknown mouse action: ${evt.action}`);
        }
      });
    },

    key(evt) {
      return enqueue('key', async () => {
        const key = String(evt.key ?? '');
        const mods = modBits(evt.mods);
        const vk = keyToVk(key);
        if (vk) return send(`K ${vk.vk} ${vk.ext ? 1 : 0} ${mods}`);
        if ([...key].length === 1) return send(textCommand(key));
        throw new Error(`unsupported key: ${key}`);
      });
    },

    text(str) {
      return enqueue('text', async () => {
        const capped = Array.from(String(str ?? '')).slice(0, MAX_TEXT).join('');
        if (!capped) return;
        return send(textCommand(capped));
      });
    },

    dispose() {
      disposed = true;
      if (helper) kill(helper);
      helper = null;
    },
  };
}

/**
 * @param {string} text
 * @returns {string}
 */
function textCommand(text) {
  return `T ${Buffer.from(text, 'utf8').toString('base64')}`;
}

module.exports = { createInput };
