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
// Partial wire v2 (s_b masked to the buyer) and v1 (refund, T = identity).
const masked = (t) => JSON.stringify({ v: 2, r_b: h32('7'), enc_sb: h32('8'), t_point: t, vk_a: h32('d'), vk_b: h32('b') });
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
  assert.equal((await call('POST', `/sessions/${sid}/partial`, { partial: masked(h32('c')), merchant_pok: '{}' }, bt)).status, 401);
  assert.equal((await call('POST', `/sessions/${sid}/partial`, { partial: masked(h32('c')), merchant_pok: '{}' }, seller_token)).status, 200);
  assert.equal((await call('POST', `/sessions/${sid}/partial`, { partial: masked(h32('c')), merchant_pok: '{}' }, seller_token)).status, 400);
  assert.equal((await call('POST', `/sessions/${sid}/presig`, { presig: '{}' }, seller_token)).status, 401);
  assert.equal((await call('POST', `/sessions/${sid}/presig`, { presig: '{}' }, bt)).status, 200);
  assert.equal((await call('POST', `/sessions/${sid}/signature`, { signature: 'zz' }, seller_token)).status, 400);
  assert.equal((await call('POST', `/sessions/${sid}/signature`, { signature: h32('9').repeat(2) }, seller_token)).status, 200);
  const done = await call('GET', `/listings/${lid}`, null, bt);
  assert.equal(done.json.listing.status, 'sold');
  assert.equal(done.json.session.buyer_token_hash, undefined);
  assert.equal(done.json.session.signature, h32('9').repeat(2));
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
  const done = await call('GET', `/listings/${lid}`, null, st);
  assert.equal(done.json.listing.status, 'sold');
  assert.equal(done.json.session.chain.escrow_address, ua);
  assert.equal(done.json.session.signature, null, 'on-chain flow never stores the completed signature');
});

test('session privacy: settlement partial must be masked; reads redacted without a token', async () => {
  const T = h32('c');
  const c = await call('POST', '/listings', { title: 'Priv', price_zec: '0.02', content_hash: h32('a'), merchant_vk: h32('b'), t_point: T, offer: '{"x":1}', size: 10 });
  const st = c.json.seller_token, lid = c.json.listing.id;
  const s = await call('POST', `/listings/${lid}/sessions`, { payer_vk: h32('d'), mode: 'chain' });
  const sid = s.json.session.id, bt = s.json.buyer_token;
  assert.ok(s.json.session.payer_vk, 'the buyer sees its own session in full');

  // refund partial: v1 only with T = identity; a T-locked partial in the clear is refused
  const plain = (t) => JSON.stringify({ r_b: h32('7'), s_b: h32('5'), t_point: t });
  const refund = (p) => JSON.stringify({ partial: p, pok: '{}' });
  assert.equal((await call('POST', `/sessions/${sid}/chain/refund_partial`, { value: refund(plain(T)) }, st)).status, 400);
  assert.equal((await call('POST', `/sessions/${sid}/chain/refund_partial`, { value: refund(masked(T)) }, st)).status, 400);
  assert.equal((await call('POST', `/sessions/${sid}/chain/refund_partial`, { value: refund(plain('0'.repeat(64))) }, st)).status, 200);

  // settlement partial: s_b in the clear (old clients) is refused, so is a wrong T
  for (const [k, v] of [['settle_r_a', h32('e')], ['payer_address', 'utest1azw74le4084s6xnsww50smrm2n74ztw5y6stmdfmga7yaj5jzp4rhjvhgepft0eyzvy7lw6ufeg7jcljwu9pfdd68edzugxh0vqw4mug']]) {
    assert.equal((await call('POST', `/sessions/${sid}/chain/${k}`, { value: v }, bt)).status, 200);
  }
  assert.equal((await call('POST', `/sessions/${sid}/chain/settle_pczt`, { value: 'QUJD' }, st)).status, 200);
  const bad = await call('POST', `/sessions/${sid}/partial`, { partial: plain(T), merchant_pok: '{}' }, st);
  assert.equal(bad.status, 400);
  assert.match(bad.json.error, /masked/);
  const both = JSON.stringify({ ...JSON.parse(masked(T)), s_b: h32('5') });
  assert.equal((await call('POST', `/sessions/${sid}/partial`, { partial: both, merchant_pok: '{}' }, st)).status, 400);
  assert.equal((await call('POST', `/sessions/${sid}/partial`, { partial: masked(h32('f')), merchant_pok: '{}' }, st)).status, 400);
  assert.equal((await call('POST', `/sessions/${sid}/partial`, { partial: masked(T), merchant_pok: '{}' }, st)).status, 200);
  assert.equal((await call('POST', `/sessions/${sid}/presig`, { presig: '{"s_a_hex":"00"}' }, bt)).status, 200);
  assert.equal((await call('POST', `/sessions/${sid}/chain/settle_txid`, { value: h32('6') }, st)).status, 200);

  // outsiders (no token, or someone else's token) get the status view only
  const other = (await call('POST', '/listings', { title: 'O', price_zec: '1', content_hash: h32('a'), merchant_vk: h32('b'), t_point: T, offer: '{"x":1}', size: 1 })).json.seller_token;
  for (const tok of [undefined, other, 'nope']) {
    for (const r of [(await call('GET', `/sessions/${sid}`, null, tok)).json.session, (await call('GET', `/listings/${lid}`, null, tok)).json.session]) {
      assert.equal(r.redacted, true);
      assert.deepEqual(r.stage, { partial: true, presig: true, signature: false });
      assert.equal(r.chain.settle_txid, h32('6'));
      for (const k of ['partial', 'presig', 'signature', 'merchant_pok', 'payer_vk', 'r_a', 'alpha', 'sighash']) assert.equal(r[k], undefined, k);
      assert.deepEqual(Object.keys(r.chain).sort(), ['settle_txid']);
    }
  }
  // buyer and seller read the full record
  for (const tok of [bt, st]) {
    const r = (await call('GET', `/sessions/${sid}`, null, tok)).json.session;
    assert.equal(r.redacted, undefined);
    assert.equal(r.partial, masked(T));
    assert.equal(r.chain.payer_address.slice(0, 6), 'utest1');
  }
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
