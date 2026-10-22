// @ts-check

const STORAGE_KEY = 'remora.hosts';
const AAD = new TextEncoder().encode('remora-beacon-v1');

/** @param {string} b64u */
export function fromBase64Url(b64u) {
  const pad = '='.repeat((4 - (b64u.length % 4)) % 4);
  const bin = atob(b64u.replace(/-/g, '+').replace(/_/g, '/') + pad);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/**
 * Decrypts a sealed beacon message using WebCrypto AES-256-GCM.
 * @param {string} keyB64u
 * @param {string} sealedB64u
 */
export async function decryptBeacon(keyB64u, sealedB64u) {
  const raw = fromBase64Url(sealedB64u);
  if (raw.byteLength < 29) throw new Error('Beacon payload too short');
  const iv = raw.slice(0, 12);
  const ciphertext = raw.slice(12);
  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    fromBase64Url(keyB64u),
    { name: 'AES-GCM' },
    false,
    ['decrypt'],
  );
  const plainBuf = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv, additionalData: AAD },
    cryptoKey,
    ciphertext,
  );
  return JSON.parse(new TextDecoder().decode(plainBuf));
}

/**
 * Resolves the latest tunnel URL for a host from ntfy.sh.
 * @param {string} topic
 * @param {string} keyB64u
 * @param {string} expectedHostId
 * @returns {Promise<string|null>}
 */
export async function resolveHostUrl(topic, keyB64u, expectedHostId) {
  const res = await fetch(`https://ntfy.sh/${encodeURIComponent(topic)}/json?poll=1&since=12h`, {
    cache: 'no-store',
  });
  if (!res.ok) return null;
  const text = await res.text();
  const lines = text.trim().split('\n').filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const evt = JSON.parse(lines[i]);
      if (evt.event !== 'message' || typeof evt.message !== 'string') continue;
      const open = await decryptBeacon(keyB64u, evt.message);
      if (open && open.h === expectedHostId && typeof open.u === 'string') {
        return open.u.replace(/\/+$/, '');
      }
    } catch {
      // Ignore malformed or outdated records.
    }
  }
  return null;
}

export function loadHosts() {
  try {
    const raw = JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]');
    return Array.isArray(raw) ? raw : [];
  } catch {
    return [];
  }
}

/** @param {any[]} hosts */
export function saveHosts(hosts) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(hosts));
}

/** @param {any} record */
export function upsertHost(record) {
  const hosts = loadHosts().filter((h) => h.hostId !== record.hostId);
  hosts.unshift(record);
  saveHosts(hosts);
  return hosts;
}

/** @param {string} hostId */
export function removeHost(hostId) {
  const hosts = loadHosts().filter((h) => h.hostId !== hostId);
  saveHosts(hosts);
  return hosts;
}
