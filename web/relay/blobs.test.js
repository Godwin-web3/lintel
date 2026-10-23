// Offer v3: content-addressed blobs and manifest checks.
process.env.NODE_ENV = 'test';
process.env.RELAY_STORAGE = 'memory';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
const { server } = await import('./server.js');

await new Promise((r) => server.listen(0, r));
const base = `http://127.0.0.1:${server.address().port}`;
const h32 = (c) => c.repeat(64);
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
const call = async (method, path, body, tok) => {
  const r = await fetch(base + path, {
    method, headers: { 'Content-Type': 'application/json', ...(tok ? { Authorization: `Bearer ${tok}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: r.status, json: await r.json() };
};
const put = (id, bytes) => fetch(`${base}/blobs/${id}`, { method: 'PUT', headers: { 'Content-Type': 'application/octet-stream' }, body: bytes });
const blob = (seed, len = 29104) => { const b = Buffer.alloc(len); for (let i = 0; i < len; i++) b[i] = (i * 31 + seed) & 255; return b; };
const manifest = (blobs, extra = {}) => JSON.stringify({
  v: 3, n: 768, t_point: h32('c'), content_hash: h32('a'),
  parts: blobs.map((b, j) => ({ hash: h32('d'), offset: j * 384, blob: sha(b), len: b.length, ...extra })),
});

test('blob upload is checked against its SHA-256 name; download is byte-exact', async () => {
  const b = blob(1);
  const ok = await put(sha(b), b);
  assert.equal(ok.status, 200);
  assert.equal((await ok.json()).created, true);
  assert.equal((await (await put(sha(b), b)).json()).created, false, 'write-once, idempotent');
  const got = await fetch(`${base}/blobs/${sha(b)}`);
  assert.equal(got.status, 200);
  assert.match(got.headers.get('cache-control'), /immutable/);
  assert.deepEqual(Buffer.from(await got.arrayBuffer()), b);

  // Tampered bytes under the original name: refused.
  const t = Buffer.from(blob(2)); t[100] ^= 1;
  assert.equal((await put(sha(blob(2)), t)).status, 422);
  assert.equal((await fetch(`${base}/blobs/${sha(blob(2))}`)).status, 404);
  // Bad names, empty and oversized bodies.
  assert.equal((await put('xyz', b)).status, 404);
  assert.equal((await put(sha(Buffer.alloc(0)), Buffer.alloc(0))).status, 400);
  const big = blob(3, 49 * 1024);
  assert.equal((await put(sha(big), big)).status, 413);
});

test('v1 listing with a v3 manifest: blobs must exist, size up to the v3 ceiling', async () => {
  const parts = [blob(10), blob(11), blob(12)];
  const listing = (offer, size) => ({ title: 'Big', price_zec: '0.01', content_hash: h32('a'), merchant_vk: h32('b'), t_point: h32('c'), offer, size });
  // Not uploaded yet.
  let r = await call('POST', '/listings', listing(manifest(parts), 60000));
  assert.equal(r.status, 400); assert.match(r.json.error, /not uploaded/);
  for (const b of parts) assert.equal((await put(sha(b), b)).status, 200);
  r = await call('POST', '/listings', listing(manifest(parts), 60000));
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(r.json.listing.size, 60000);
  // The relay stores only the manifest.
  const g = await call('GET', `/listings/${r.json.listing.id}`);
  assert.ok(g.json.listing.offer.length < 2048);
  // Inline data is refused; wrong offsets, sizes and n are refused.
  assert.equal((await call('POST', '/listings', listing(manifest(parts, { data: 'ab' }), 60000))).status, 400);
  const bad = JSON.parse(manifest(parts)); bad.parts[1].offset = 0;
  assert.equal((await call('POST', '/listings', listing(JSON.stringify(bad), 60000))).status, 400);
  const badn = JSON.parse(manifest(parts)); badn.n = 64;
  assert.equal((await call('POST', '/listings', listing(JSON.stringify(badn), 60000))).status, 400);
  assert.equal((await call('POST', '/listings', listing(manifest(parts), 1523682))).status, 400);
  // v1 offers keep the old ceiling.
  assert.equal((await call('POST', '/listings', listing('{"x":1}', 60000))).status, 400);
});

test('presale listing and extra copies with v3 offers', async () => {
  const parts = [blob(20), blob(21)];
  for (const b of parts) await put(sha(b), b);
  const unit = (c, offer) => ({ t_point: h32(c), merchant_vk: h32(c === '1' ? '2' : '3'), r_b: h32(c === '1' ? '4' : '5'), pok: '{}', offer });
  const r = await call('POST', '/listings', { version: 2, title: 'Big presale', price_zec: '0.01', content_hash: h32('a'), size: 40000, unit: unit('1', manifest(parts)) });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  const lid = r.json.listing.id, tok = r.json.seller_token;
  // A v2 (inline) copy cannot hold a 40 KB listing.
  assert.equal((await call('POST', `/listings/${lid}/units`, { unit: unit('6', '{"v":2}') }, tok)).status, 400);
  assert.equal((await call('POST', `/listings/${lid}/units`, { unit: unit('7', manifest([blob(22)].map((b) => b))) }, tok)).status, 400, 'blob not uploaded');
  // v2 listings with inline offers keep 7,905 bytes.
  assert.equal((await call('POST', '/listings', { version: 2, title: 'x', price_zec: '0.01', content_hash: h32('a'), size: 7906, unit: unit('8', '{"v":2}') })).status, 400);
});

test('offer v3 claims (predicates): shape checked, only on v3', async () => {
  const parts = [blob(30)];
  for (const b of parts) await put(sha(b), b);
  const listing = (offer) => ({ title: 'Claims', price_zec: '0.01', content_hash: h32('a'), merchant_vk: h32('b'), t_point: h32('c'), offer, size: 9000 });
  const withClaims = (predicates) => JSON.stringify({ ...JSON.parse(manifest(parts)), predicates });
  const good = [{ id: 'prefix', hex: '25504446' }, { id: 'length', min: 100, max: 20000 }, { id: 'bytes_at', offset: 40, hex: 'ab'.repeat(32) }];
  let r = await call('POST', '/listings', listing(withClaims(good)));
  assert.equal(r.status, 200, JSON.stringify(r.json));
  // Claims survive in the stored manifest for the buyer's app.
  const g = await call('GET', `/listings/${r.json.listing.id}`);
  assert.deepEqual(JSON.parse(g.json.listing.offer).predicates, good);
  for (const bad of [
    [], [{ id: 'regex', hex: '00' }], [{ id: 'prefix', hex: 'ab'.repeat(33) }], [{ id: 'prefix', hex: 'xyz' }],
    [{ id: 'length', min: 5, max: 4 }], [{ id: 'length', min: 0, max: 2 ** 40 }], [{ id: 'length', min: 1, max: 2, extra: 1 }],
    [{ id: 'bytes_at', hex: '00' }], [{ id: 'length', min: 1, max: 2 }, { id: 'length', min: 1, max: 2 }],
    [{ id: 'prefix', hex: '00' }, { id: 'prefix', hex: '00' }, { id: 'prefix', hex: '00' }], 'x',
  ]) assert.equal((await call('POST', '/listings', listing(withClaims(bad)))).status, 400, JSON.stringify(bad));
  // Claims on an inline (v1/v2) offer: refused.
  assert.equal((await call('POST', '/listings', { ...listing('{"v":2,"predicates":[]}'), size: 100 })).status, 400);
});

test.after(() => server.close());
