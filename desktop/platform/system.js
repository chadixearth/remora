// @ts-check
'use strict';

const os = require('os');
const { execFile } = require('child_process');

/**
 * @typedef {{percent:number, charging:boolean}} Battery
 * @typedef {{hostname:string, cpu:number, mem:{used:number,total:number}, battery:Battery|null, uptime:number}} Status
 */

const BATTERY_TTL_MS = 30000;
// ACPI BatteryStatus codes that mean "on AC power": 2, 3, 6, 7, 8, 9.
const AC_STATUSES = new Set([2, 3, 6, 7, 8, 9]);

/** @type {{idle:number, total:number}|null} */
let lastCpu = null;
/** @type {{at:number, value:Battery|null}|null} */
let batteryCache = null;

/**
 * Busy percent since the previous call (or since boot on the first call).
 * @returns {number}
 */
function cpuBusyPercent() {
  let idle = 0;
  let total = 0;
  for (const cpu of os.cpus()) {
    for (const v of Object.values(cpu.times)) total += v;
    idle += cpu.times.idle;
  }
  const prev = lastCpu;
  lastCpu = { idle, total };
  const dIdle = prev ? idle - prev.idle : idle;
  const dTotal = prev ? total - prev.total : total;
  if (dTotal <= 0) return 0;
  const busy = ((dTotal - dIdle) / dTotal) * 100;
  return Math.max(0, Math.min(100, Math.round(busy * 10) / 10));
}

/**
 * Reads the battery through one CIM query. Cached for 30 s.
 * @returns {Promise<Battery|null>}
 */
function readBattery() {
  if (process.platform !== 'win32') return Promise.resolve(null);
  if (batteryCache && Date.now() - batteryCache.at < BATTERY_TTL_MS) {
    return Promise.resolve(batteryCache.value);
  }
  const script =
    'Get-CimInstance Win32_Battery | Select-Object EstimatedChargeRemaining,BatteryStatus | ConvertTo-Json -Compress';
  return new Promise((resolve) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', script],
      { timeout: 8000, windowsHide: true },
      (err, stdout) => {
        /** @type {Battery|null} */
        let value = null;
        if (!err && stdout && stdout.trim()) {
          try {
            const parsed = JSON.parse(stdout);
            const first = Array.isArray(parsed) ? parsed[0] : parsed;
            if (first && typeof first.EstimatedChargeRemaining === 'number') {
              value = {
                percent: first.EstimatedChargeRemaining,
                charging: AC_STATUSES.has(Number(first.BatteryStatus)),
              };
            }
          } catch {
            value = null;
          }
        }
        batteryCache = { at: Date.now(), value };
        resolve(value);
      },
    );
  });
}

/**
 * Snapshot of host health for the phone's status card.
 * @returns {Promise<Status>}
 */
async function getStatus() {
  const battery = await readBattery();
  return {
    hostname: os.hostname(),
    cpu: cpuBusyPercent(),
    mem: { used: os.totalmem() - os.freemem(), total: os.totalmem() },
    battery,
    uptime: Math.floor(os.uptime()),
  };
}

module.exports = { getStatus };
