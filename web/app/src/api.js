// Thin clients for the crypto worker and the public relay.

const worker = new Worker(new URL('./lintel.worker.js', import.meta.url), { type: 'module' });
let seq = 0;
const pending = new Map();
worker.onmessage = ({ data }) => {
  const p = pending.get(data.id);
  if (!p) return;
  pending.delete(data.id);
  data.ok ? p.resolve(data.result) : p.reject(new Error(data.error));
};
export const crypto = (op, args) =>
  new Promise((resolve, reject) => {
    const id = ++seq;
    pending.set(id, { resolve, reject });
    worker.postMessage({ id, op, args });
  });

export const RELAY = (import.meta.env.VITE_RELAY_URL || 'http://localhost:8787').replace(/\/$/, '');

export async function relay(method, path, body, token) {
  const res = await fetch(RELAY + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.error || `relay error ${res.status}`);
  return json;
}

// Device-local storage. Seller entries hold SECRET merchant state and never
// leave this browser; buyer entries hold only public session data + token.
const KEY = 'lintel.v1';
export const store = {
  get() { try { return JSON.parse(localStorage.getItem(KEY)) || { selling: {}, buying: {} }; } catch { return { selling: {}, buying: {} }; } },
  put(fn) { const s = store.get(); fn(s); localStorage.setItem(KEY, JSON.stringify(s)); return s; },
};

export const randomHex = (n) => Array.from(globalThis.crypto.getRandomValues(new Uint8Array(n)), (b) => b.toString(16).padStart(2, '0')).join('');

// A uniformly random scalar for the re-randomizer alpha, kept below 2^250 so
// it is always canonical in the Pallas scalar field. Placeholder until the
// value comes from the real PCZT.
export const randomAlpha = () => {
  const b = globalThis.crypto.getRandomValues(new Uint8Array(32));
  b[31] &= 0x03;
  return Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
};

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
