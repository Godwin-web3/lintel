// Content-addressed blob store for big sealed offers (offer v3).
//
// A v3 offer is a small manifest (kept in the listing like any other offer)
// plus one blob per proven part: that part's ciphertext and Halo 2 proof. The
// blob's name IS its SHA-256, so:
//   * the relay refuses an upload whose bytes do not hash to the name, and
//   * the buyer's app re-hashes every blob it downloads and the WASM engine
//     checks it again against the manifest before verifying the proofs.
// A relay (or anyone in between) that swaps a blob is caught before payment,
// and blobs are public data like the rest of an offer (ciphertext + proof).
//
// Backends follow RELAY_STORAGE (see storage.js):
//   file     one file per blob under BLOB_DIR (default: <DATA_FILE dir>/blobs).
//   memory   in-process Map (tests, throwaway instances).
//   upstash  one Redis string per blob (`<prefix>:blob:<sha256>`, base64).
//
// Limits: MAX_BLOB bytes per blob, BLOB_QUOTA bytes in total (env-tunable).
// Write-once: re-uploading identical bytes is a no-op.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { pickBackend } from './storage.js';

export const BLOB_ID = /^[0-9a-f]{64}$/;
export const sha256hex = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

export function createBlobStore(env = process.env, { fetchImpl = globalThis.fetch } = {}) {
  const kind = pickBackend(env);
  const quota = Number(env.BLOB_QUOTA || 2 * 1024 ** 3);
  if (kind === 'memory') return memoryBlobs(quota);
  if (kind === 'file') {
    const dir = env.BLOB_DIR || path.join(path.dirname(env.DATA_FILE || `${process.cwd()}/data.json`), 'blobs');
    return fileBlobs(dir, quota);
  }
  if (kind === 'upstash') return upstashBlobs(env, quota, fetchImpl);
  throw new Error(`unknown RELAY_STORAGE "${kind}"`);
}

function memoryBlobs(quota) {
  const m = new Map(); let used = 0;
  return {
    kind: 'memory',
    async has(id) { return m.has(id); },
    async get(id) { return m.get(id) || null; },
    async put(id, buf) {
      if (m.has(id)) return false;
      if (used + buf.length > quota) throw Object.assign(new Error('blob store is full'), { code: 507 });
      m.set(id, Buffer.from(buf)); used += buf.length; return true;
    },
  };
}

function fileBlobs(dir, quota) {
  fs.mkdirSync(dir, { recursive: true });
  let used = 0;
  try { for (const f of fs.readdirSync(dir)) if (BLOB_ID.test(f)) used += fs.statSync(path.join(dir, f)).size; } catch {}
  const file = (id) => path.join(dir, id); // id is validated hex: no traversal
  return {
    kind: 'file',
    async has(id) { return fs.existsSync(file(id)); },
    async get(id) { try { return fs.readFileSync(file(id)); } catch { return null; } },
    async put(id, buf) {
      if (fs.existsSync(file(id))) return false;
      if (used + buf.length > quota) throw Object.assign(new Error('blob store is full'), { code: 507 });
      const tmp = `${file(id)}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, buf);
      fs.renameSync(tmp, file(id));
      used += buf.length; return true;
    },
  };
}

function upstashBlobs(env, quota, fetchImpl) {
  const url = (env.UPSTASH_REDIS_REST_URL || '').replace(/\/$/, '');
  const tok = env.UPSTASH_REDIS_REST_TOKEN || '';
  const key = (id) => `${env.UPSTASH_PREFIX || 'lintel'}:blob:${id}`;
  const call = async (cmd) => {
    const res = await fetchImpl(url, { method: 'POST', headers: { Authorization: `Bearer ${tok}`, 'Content-Type': 'application/json' }, body: JSON.stringify(cmd) });
    const json = await res.json().catch(() => null);
    if (!res.ok || !json || json.error) throw new Error(`upstash blob error ${res.status}`);
    return json.result;
  };
  return {
    kind: 'upstash',
    async has(id) { return (await call(['EXISTS', key(id)])) === 1; },
    async get(id) { const r = await call(['GET', key(id)]); return r ? Buffer.from(r, 'base64') : null; },
    // SET NX keeps blobs write-once. (The quota is enforced by the Upstash plan.)
    async put(id, buf) { void quota; return (await call(['SET', key(id), buf.toString('base64'), 'NX'])) === 'OK'; },
  };
}
