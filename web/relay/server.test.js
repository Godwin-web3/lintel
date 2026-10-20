process.env.NODE_ENV = 'test';
process.env.DATA_FILE = '/tmp/lintel-relay-test.json';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
try { fs.unlinkSync(process.env.DATA_FILE); } catch {}
const { server } = await import('./server.js');

await new Promise((r) => server.listen(0, r));
const base = `http://127.0.0.1:${server.address().port}`;
const h32 = (c) => c.repeat(64);
const call = async (method, path, body, tok) => {
  const r = await fetch(base + path, {
    method, headers: { 'Content-Type': 'application/json', ...(tok ? { Authorization: `Bearer ${tok}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: r.status, json: await r.json() };
};

test('full public-data flow, write-once fields, single sale', async () => {
  const listing = { title: 'Report', price_zec: '0.5', content_hash: h32('a'), merchant_vk: h32('b'), t_point: h32('c'), offer: '{"x":1}', size: 10 };
  const c = await call('POST', '/listings', listing);
  assert.equal(c.status, 200);
  const { seller_token } = c.json; const lid = c.json.listing.id;
  assert.equal(c.json.listing.seller_token_hash, undefined);

  const list = await call('GET', '/listings');
  assert.equal(list.json.listings[0].offer, undefined);

  const sess = { payer_vk: h32('d'), r_a: h32('e'), alpha: h32('f'), sighash: h32('1') };
  const s = await call('POST', `/listings/${lid}/sessions`, sess);
  assert.equal(s.status, 200);
  const sid = s.json.session.id; const bt = s.json.buyer_token;

  assert.equal((await call('POST', `/listings/${lid}/sessions`, sess)).status, 409);
  assert.equal((await call('POST', `/sessions/${sid}/partial`, { partial: '{}', merchant_pok: '{}' }, bt)).status, 401);
  assert.equal((await call('POST', `/sessions/${sid}/partial`, { partial: '{}', merchant_pok: '{}' }, seller_token)).status, 200);
  assert.equal((await call('POST', `/sessions/${sid}/partial`, { partial: '{}', merchant_pok: '{}' }, seller_token)).status, 400);
  assert.equal((await call('POST', `/sessions/${sid}/presig`, { presig: '{}' }, seller_token)).status, 401);
  assert.equal((await call('POST', `/sessions/${sid}/presig`, { presig: '{}' }, bt)).status, 200);
  assert.equal((await call('POST', `/sessions/${sid}/signature`, { signature: 'zz' }, seller_token)).status, 400);
  assert.equal((await call('POST', `/sessions/${sid}/signature`, { signature: h32('9').repeat(2) }, seller_token)).status, 200);
  const done = await call('GET', `/listings/${lid}`);
  assert.equal(done.json.listing.status, 'sold');
  assert.equal(done.json.session.buyer_token_hash, undefined);
});

test('on-chain fields: write-once, role-gated, validated', async () => {
  const listing = { title: 'Chain', price_zec: '0.02', content_hash: h32('a'), merchant_vk: h32('b'), t_point: h32('c'), offer: '{"x":1}', size: 10 };
  const c = await call('POST', '/listings', listing);
  const st = c.json.seller_token, lid = c.json.listing.id;
  const s = await call('POST', `/listings/${lid}/sessions`, { payer_vk: h32('d'), r_a: h32('e'), alpha: h32('f'), sighash: h32('1') });
  const sid = s.json.session.id, bt = s.json.buyer_token;
  const ua = 'utest1azw74le4084s6xnsww50smrm2n74ztw5y6stmdfmga7yaj5jzp4rhjvhgepft0eyzvy7lw6ufeg7jcljwu9pfdd68edzugxh0vqw4mug';
  assert.equal((await call('POST', `/sessions/${sid}/chain/payer_contrib`, { value: h32('3') }, st)).status, 401);
  assert.equal((await call('POST', `/sessions/${sid}/chain/payer_contrib`, { value: h32('3') }, bt)).status, 200);
  assert.equal((await call('POST', `/sessions/${sid}/chain/payer_contrib`, { value: h32('4') }, bt)).status, 400);
  assert.equal((await call('POST', `/sessions/${sid}/chain/escrow_address`, { value: 'zs1nope' }, st)).status, 400);
  assert.equal((await call('POST', `/sessions/${sid}/chain/escrow_address`, { value: ua }, st)).status, 200);
  assert.equal((await call('POST', `/sessions/${sid}/chain/t_secret`, { value: h32('5') }, st)).status, 404);
  assert.equal((await call('POST', `/sessions/${sid}/chain/settle_txid`, { value: h32('6') }, st)).status, 200);
  const done = await call('GET', `/listings/${lid}`);
  assert.equal(done.json.listing.status, 'sold');
  assert.equal(done.json.session.chain.escrow_address, ua);
  assert.equal(done.json.session.signature, null, 'on-chain flow never stores the completed signature');
});

test('decodes a lightwalletd RawTransaction', async () => {
  const { decodeRawTransaction } = await import('./server.js');
  // field 1 (bytes) = 0xdeadbeef, field 2 (varint) = 4521277
  const h = 4521277; const v = []; let n = h; while (n > 127) { v.push((n & 127) | 128); n = Math.floor(n / 128); } v.push(n);
  const r = decodeRawTransaction(Buffer.from([0x0a, 4, 0xde, 0xad, 0xbe, 0xef, 0x10, ...v]));
  assert.equal(r.data.toString('hex'), 'deadbeef');
  assert.equal(r.height, h);
  assert.equal((await call('GET', '/chain/tx/xyz')).status, 404);
});

test('rejects malformed input', async () => {
  assert.equal((await call('POST', '/listings', { title: 'x', price_zec: '-1' })).status, 400);
  assert.equal((await call('POST', '/listings', { title: 'x', price_zec: '1', content_hash: 'zz' })).status, 400);
  const r = await fetch(base + '/listings', { method: 'POST', body: 'x'.repeat(70000) }).catch(() => ({ status: 413 }));
  assert.equal(r.status, 413);
  server.close();
});
