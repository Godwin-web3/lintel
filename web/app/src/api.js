// Thin clients for the crypto worker and the public relay.

const worker = new Worker(new URL('./lintel.worker.js', import.meta.url), { type: 'module' });
let seq = 0;
const pending = new Map();
worker.onmessage = ({ data }) => {
  const p = pending.get(data.id);
  if (!p) return;
  if (data.progress !== undefined) { p.onProgress?.(data.progress); return; }
  pending.delete(data.id);
  data.ok ? p.resolve(data.result) : p.reject(new Error(data.error));
};
// `onProgress` receives the worker's progress events for long operations
// (big offers report one event per proven part).
export const crypto = (op, args, onProgress) =>
  new Promise((resolve, reject) => {
    const id = ++seq;
    pending.set(id, { resolve, reject, onProgress });
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

// ---- offer v3 (big payloads): content-addressed blobs ----
//
// A v3 offer on the relay is a manifest; each part's ciphertext + proof is a
// blob named by its SHA-256. Uploads: the relay refuses bytes that do not hash
// to the name. Downloads: re-hashed here, and again inside the WASM engine
// against the manifest, before any proof is checked.
const hex = (u8) => Array.from(u8, (b) => b.toString(16).padStart(2, '0')).join('');
export const sha256hex = async (bytes) => hex(new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', bytes)));

export async function putBlob(id, bytes) {
  if ((await sha256hex(bytes)) !== id) throw new Error('blob does not match its id');
  const res = await fetch(`${RELAY}/blobs/${id}`, { method: 'PUT', headers: { 'Content-Type': 'application/octet-stream' }, body: bytes });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.error || `blob upload failed (${res.status})`);
  return json;
}

/** Uploads blobs `[{ id, bytes }]`, a few at a time. `onStep(done, total)`. */
export async function putBlobs(blobs, onStep = () => {}) {
  let done = 0, next = 0;
  const run = async () => { while (next < blobs.length) { const b = blobs[next++]; await putBlob(b.id, b.bytes); onStep(++done, blobs.length); } };
  await Promise.all(Array.from({ length: Math.min(4, blobs.length) }, run));
}

const blobCache = new Map();
async function getBlob(id) {
  if (blobCache.has(id)) return blobCache.get(id);
  const res = await fetch(`${RELAY}/blobs/${id}`);
  if (!res.ok) throw new Error(`could not fetch offer part ${id.slice(0, 12)}… (${res.status})`);
  const bytes = new Uint8Array(await res.arrayBuffer());
  if ((await sha256hex(bytes)) !== id) throw new Error('an offer part does not match its content address; refusing it');
  if (blobCache.size > 128) blobCache.clear();
  blobCache.set(id, bytes);
  return bytes;
}

/** Returns the offer ready for the engine: v1/v2 unchanged, v3 with every blob attached. */
export async function resolveOffer(offer) {
  let o; try { o = JSON.parse(offer); } catch { return offer; }
  if (!o || o.v !== 3) return offer;
  const datas = await Promise.all(o.parts.map((p) => getBlob(p.blob)));
  return JSON.stringify({ ...o, parts: o.parts.map((p, i) => ({ ...p, data: hex(datas[i]) })) });
}
/** A presale unit with its offer resolved (see resolveOffer). */
export const resolveUnit = async (unit) => ({ ...unit, offer: unit.offer ? await resolveOffer(unit.offer) : unit.offer });

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

// Raw mined transaction (public) via the relay's lightwalletd proxy.
export const chainTx = (txid) => relay('GET', `/chain/tx/${txid}`);

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
