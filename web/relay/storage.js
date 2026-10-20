// Pluggable persistence for the relay. Zero dependencies.
//
// The relay keeps its working set in memory (one instance) and persists
// changed records behind it. Select a backend with RELAY_STORAGE:
//
//   file     (default) JSON snapshot at DATA_FILE (./data.json). On Render's
//            free plan the disk is ephemeral, so data resets on redeploy.
//   memory   nothing persisted (tests, throwaway instances).
//   upstash  Upstash Redis over its REST API (free tier, works from Render
//            free). Needs UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN.
//            Picked automatically when both are set and RELAY_STORAGE is not.
//
// Only public protocol data is ever stored (see server.js). Tokens are kept
// as SHA-256 hashes. Backend errors are logged without record contents.

import fs from 'node:fs';

const COLLECTIONS = ['listings', 'sessions', 'orders'];
const empty = () => Object.fromEntries(COLLECTIONS.map((c) => [c, {}]));

export function pickBackend(env = process.env) {
  const want = (env.RELAY_STORAGE || '').toLowerCase();
  if (want) return want;
  return env.UPSTASH_REDIS_REST_URL && env.UPSTASH_REDIS_REST_TOKEN ? 'upstash' : 'file';
}

export function createStorage(env = process.env, opts = {}) {
  const kind = pickBackend(env);
  if (kind === 'memory') return memoryStorage();
  if (kind === 'file') return fileStorage(env.DATA_FILE || `${process.cwd()}/data.json`, opts);
  if (kind === 'upstash') return upstashStorage(env, opts);
  throw new Error(`unknown RELAY_STORAGE "${kind}" (use file, memory or upstash)`);
}

function withCollections(db) {
  for (const c of COLLECTIONS) db[c] ||= {};
  return db;
}

function memoryStorage() {
  return { kind: 'memory', async load() { return empty(); }, touch() {}, touchAll() {}, async flush() {} };
}

function fileStorage(file, { delay = 200 } = {}) {
  let db = null, timer = null;
  const write = () => {
    timer = null;
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(db));
    fs.renameSync(tmp, file);
  };
  return {
    kind: 'file',
    async load() {
      try { db = withCollections(JSON.parse(fs.readFileSync(file, 'utf8'))); } catch { db = empty(); }
      return db;
    },
    touch() { clearTimeout(timer); timer = setTimeout(write, delay); },
    touchAll() { this.touch(); },
    async flush() { if (timer) { clearTimeout(timer); write(); } },
  };
}

// Upstash Redis REST: one hash per collection (`<prefix>:listings` etc.), one
// field per record id holding its JSON. Writes are batched through /pipeline.
function upstashStorage(env, { delay = 150, fetchImpl = globalThis.fetch } = {}) {
  const url = (env.UPSTASH_REDIS_REST_URL || '').replace(/\/$/, '');
  const tok = env.UPSTASH_REDIS_REST_TOKEN || '';
  const prefix = env.UPSTASH_PREFIX || 'lintel';
  const okUrl = /^https:\/\//.test(url) || /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(url); // http only for local tests
  if (!okUrl || !tok) throw new Error('upstash storage needs UPSTASH_REDIS_REST_URL (https://...) and UPSTASH_REDIS_REST_TOKEN');
  const key = (c) => `${prefix}:${c}`;
  const MAX_BATCH_BYTES = 512 * 1024; // stay well under Upstash's request size limit

  async function call(path, body) {
    const res = await fetchImpl(url + path, {
      method: 'POST',
      headers: { Authorization: `Bearer ${tok}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const json = await res.json().catch(() => null);
    if (!res.ok || !json) throw new Error(`upstash HTTP ${res.status}`);
    return json;
  }

  let db = null, timer = null, inflight = null, backoff = 0, scanAll = false;
  const dirty = new Map(); // `${collection}\u0000${id}` -> [collection, id]
  const written = new Map(); // same key -> JSON last confirmed in Redis

  async function writeBatch(cmds) {
    const out = await call('/pipeline', cmds);
    const bad = Array.isArray(out) ? out.find((r) => r && r.error) : { error: 'bad response' };
    if (bad) throw new Error(`upstash error: ${String(bad.error).slice(0, 120)}`);
  }

  async function drain() {
    if (scanAll) {
      // save() without specifics: consider every record, and every deletion.
      scanAll = false;
      for (const c of COLLECTIONS) for (const id of Object.keys(db[c])) dirty.set(`${c}\u0000${id}`, [c, id]);
      for (const k of written.keys()) if (!dirty.has(k)) { const [c, id] = k.split('\u0000'); if (db[c][id] === undefined) dirty.set(k, [c, id]); }
    }
    const items = [...dirty.values()];
    dirty.clear();
    let batch = [], size = 0, pend = [];
    const commit = () => { for (const [k, j] of pend) j === null ? written.delete(k) : written.set(k, j); pend = []; };
    try {
      for (const [c, id] of items) {
        const k = `${c}\u0000${id}`, rec = db[c][id];
        const json = rec === undefined ? null : JSON.stringify(rec);
        if (json === (written.has(k) ? written.get(k) : null)) continue; // unchanged
        const cmd = json === null ? ['HDEL', key(c), id] : ['HSET', key(c), id, json];
        const n = cmd.reduce((a, x) => a + x.length, 16);
        if (batch.length && size + n > MAX_BATCH_BYTES) { await writeBatch(batch); commit(); batch = []; size = 0; }
        batch.push(cmd); pend.push([k, json]); size += n;
      }
      if (batch.length) { await writeBatch(batch); commit(); }
      backoff = 0;
    } catch (e) {
      // Re-queue everything; unchanged records are skipped on the retry.
      for (const [c, id] of items) dirty.set(`${c}\u0000${id}`, [c, id]);
      backoff = Math.min(backoff ? backoff * 2 : 1000, 30000);
      console.error(`relay storage: ${e.message}; retrying in ${backoff} ms`);
      schedule(backoff);
    }
  }

  function schedule(ms = delay) {
    if (timer) return;
    timer = setTimeout(() => {
      timer = null;
      inflight = (inflight || Promise.resolve()).then(drain);
    }, ms);
  }

  return {
    kind: 'upstash',
    async load() {
      db = empty();
      for (const c of COLLECTIONS) {
        const { result, error } = await call('', ['HGETALL', key(c)]);
        if (error) throw new Error(`upstash error: ${String(error).slice(0, 120)}`);
        const flat = Array.isArray(result) ? result : Object.entries(result || {}).flat();
        for (let i = 0; i + 1 < flat.length; i += 2) {
          try { db[c][flat[i]] = JSON.parse(flat[i + 1]); written.set(`${c}\u0000${flat[i]}`, flat[i + 1]); } catch { /* skip corrupt record */ }
        }
      }
      return db;
    },
    // touch(collection, id): that record changed (or was deleted).
    touch(c, id) {
      if (!c || id === undefined) return;
      dirty.set(`${c}\u0000${id}`, [c, id]);
      if (!backoff) schedule();
    },
    touchAll() { scanAll = true; if (!backoff) schedule(); },
    async flush() {
      if (timer) { clearTimeout(timer); timer = null; }
      await inflight;
      if (dirty.size || scanAll) await drain();
    },
    pending: () => dirty.size,
  };
}
