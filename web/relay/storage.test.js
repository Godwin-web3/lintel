// Storage backends: file (default), memory, and Upstash REST against a local
// mock that implements the subset of the API the relay uses.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import { createStorage, pickBackend } from './storage.js';

function mockUpstash({ token = 'tkn', failFirst = 0 } = {}) {
  const hashes = new Map(); let fails = failFirst; const seen = [];
  const run = ([cmd, key, ...a]) => {
    const h = hashes.get(key) || new Map(); hashes.set(key, h);
    if (cmd === 'HSET') { h.set(a[0], a[1]); return 1; }
    if (cmd === 'HDEL') { return h.delete(a[0]) ? 1 : 0; }
    if (cmd === 'HGETALL') return [...h.entries()].flat();
    throw new Error('unsupported ' + cmd);
  };
  const srv = http.createServer((req, res) => {
    let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => {
      seen.push({ path: req.url, auth: req.headers.authorization, body: b });
      if (req.headers.authorization !== `Bearer ${token}`) { res.writeHead(401); return res.end('{"error":"unauthorized"}'); }
      if (fails > 0 && req.url === '/pipeline') { fails--; res.writeHead(500); return res.end('{"error":"boom"}'); }
      const body = JSON.parse(b);
      const out = req.url === '/pipeline' ? body.map((c) => ({ result: run(c) })) : { result: run(body) };
      res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(out));
    });
  });
  return new Promise((r) => srv.listen(0, '127.0.0.1', () => r({ srv, hashes, seen, url: `http://127.0.0.1:${srv.address().port}` })));
}

test('backend selection', () => {
  assert.equal(pickBackend({}), 'file');
  assert.equal(pickBackend({ UPSTASH_REDIS_REST_URL: 'https://x', UPSTASH_REDIS_REST_TOKEN: 't' }), 'upstash');
  assert.equal(pickBackend({ RELAY_STORAGE: 'memory', UPSTASH_REDIS_REST_URL: 'https://x', UPSTASH_REDIS_REST_TOKEN: 't' }), 'memory');
  assert.throws(() => createStorage({ RELAY_STORAGE: 'nope' }));
  assert.throws(() => createStorage({ RELAY_STORAGE: 'upstash', UPSTASH_REDIS_REST_URL: 'http://evil.example', UPSTASH_REDIS_REST_TOKEN: 't' }));
});

test('file backend persists across restarts', async () => {
  const f = `/tmp/lintel-storage-${process.pid}.json`; try { fs.unlinkSync(f); } catch {}
  const a = createStorage({ RELAY_STORAGE: 'file', DATA_FILE: f });
  const db = await a.load(); db.listings.x = { id: 'x' }; a.touch('listings', 'x'); await a.flush();
  const b = createStorage({ RELAY_STORAGE: 'file', DATA_FILE: f });
  assert.deepEqual((await b.load()).listings.x, { id: 'x' });
  assert.deepEqual((await b.load()).orders, {});
});

test('upstash backend: batched writes, deletes, reload, retry, token only in header', async () => {
  const m = await mockUpstash({ failFirst: 1 });
  const env = { RELAY_STORAGE: 'upstash', UPSTASH_REDIS_REST_URL: m.url, UPSTASH_REDIS_REST_TOKEN: 'tkn', UPSTASH_PREFIX: 't1' };
  const errs = []; const orig = console.error; console.error = (x) => errs.push(String(x));
  try {
    const a = createStorage(env, { delay: 5 });
    const db = await a.load();
    db.listings.L1 = { id: 'L1', title: 'one' }; db.orders.O1 = { id: 'O1' }; db.sessions.S1 = { id: 'S1' };
    a.touch('listings', 'L1'); a.touch('orders', 'O1'); a.touch('sessions', 'S1');
    await new Promise((r) => setTimeout(r, 30)); // first write fails (mock 500) and is re-queued
    assert.ok(errs.some((e) => e.includes('retrying')));
    assert.ok(!errs.some((e) => e.includes('tkn') || e.includes('one')), 'no token or record contents in logs');
    await a.flush();
    assert.equal(m.hashes.get('t1:listings').get('L1'), JSON.stringify({ id: 'L1', title: 'one' }));
    delete db.sessions.S1; a.touch('sessions', 'S1'); await a.flush();
    assert.equal(m.hashes.get('t1:sessions').size, 0);
    const b = createStorage(env);
    const db2 = await b.load();
    assert.deepEqual(db2.listings.L1, { id: 'L1', title: 'one' });
    assert.deepEqual(db2.orders.O1, { id: 'O1' });
    assert.ok(m.seen.every((r) => !r.path.includes('tkn') && !r.body.includes('tkn')));
  } finally { console.error = orig; m.srv.close(); }
});

test('upstash save-all writes only changed records and deletions', async () => {
  const m = await mockUpstash();
  const env = { RELAY_STORAGE: 'upstash', UPSTASH_REDIS_REST_URL: m.url, UPSTASH_REDIS_REST_TOKEN: 'tkn', UPSTASH_PREFIX: 't2' };
  try {
    const a = createStorage(env, { delay: 5 });
    const db = await a.load();
    for (let i = 0; i < 5; i++) db.listings['L' + i] = { i };
    a.touchAll(); await a.flush();
    assert.equal(m.hashes.get('t2:listings').size, 5);
    const before = m.seen.length;
    db.listings.L2.sold = true; delete db.listings.L4;
    a.touchAll(); await a.flush();
    const cmds = JSON.parse(m.seen.slice(before).find((r) => r.path === '/pipeline').body);
    assert.deepEqual(cmds.map((c) => c[0] + ' ' + c[2]).sort(), ['HDEL L4', 'HSET L2']);
    a.touchAll(); await a.flush();
    assert.equal(m.seen.length, before + 1, 'nothing changed, nothing sent');
  } finally { m.srv.close(); }
});

test('relay boots on upstash and keeps listings across a restart', async () => {
  const m = await mockUpstash();
  const { spawn } = await import('node:child_process');
  const port = 9300 + Math.floor(Math.random() * 300);
  const env = { ...process.env, NODE_ENV: '', PORT: String(port), UPSTASH_REDIS_REST_URL: m.url, UPSTASH_REDIS_REST_TOKEN: 'tkn' };
  const boot = async () => {
    const p = spawn(process.execPath, [new URL('./server.js', import.meta.url).pathname], { env, stdio: 'ignore' });
    for (let i = 0; i < 50; i++) { try { await fetch(`http://127.0.0.1:${port}/health`); return p; } catch { await new Promise((r) => setTimeout(r, 100)); } }
    throw new Error('relay did not start');
  };
  const stop = (p) => new Promise((r) => { p.on('exit', r); p.kill('SIGTERM'); });
  try {
    let p = await boot();
    const h = (c) => c.repeat(64);
    const r = await fetch(`http://127.0.0.1:${port}/listings`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'Persisted', price_zec: '1', content_hash: h('a'), merchant_vk: h('b'), t_point: h('c'), offer: '{}', size: 1 }) });
    const { listing } = await r.json();
    await stop(p); // SIGTERM flushes pending writes
    p = await boot();
    const again = await (await fetch(`http://127.0.0.1:${port}/listings/${listing.id}`)).json();
    assert.equal(again.listing.title, 'Persisted');
    await stop(p);
  } finally { m.srv.close(); }
});
