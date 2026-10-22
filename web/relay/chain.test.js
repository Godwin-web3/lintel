// Chain proxy routes and on-chain ("chain" mode) sessions, against a fake
// lightwalletd (gRPC over cleartext HTTP/2) so no network is needed.
import http2 from 'node:http2';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const enc = (field, buf) => Buffer.concat([vi(field * 8 + 2), vi(buf.length), buf]);
const encV = (field, n) => Buffer.concat([vi(field * 8), vi(n)]);
function vi(n) { const o = []; while (n > 127) { o.push((n % 128) | 128); n = Math.floor(n / 128); } o.push(n); return Buffer.from(o); }
const frame = (m) => { const f = Buffer.concat([Buffer.alloc(5), m]); f.writeUInt32BE(m.length, 1); return f; };

const cmx = (c) => Buffer.alloc(32, c);
// first length-delimited field of a request (the address of GetAddressUtxosArg)
const decodeFirst = (b) => { let i = 1, n = 0, m = 1, x; do { x = b[i++]; n += (x & 127) * m; m *= 128; } while (x & 128); return b.subarray(i, i + n).toString(); };
const sent = [];
const fake = http2.createServer();
fake.on('stream', (stream, headers) => {
  const method = headers[':path'].split('/').pop();
  const chunks = [];
  stream.on('data', (d) => chunks.push(d));
  stream.on('end', () => {
    const req = Buffer.concat(chunks).subarray(5);
    let out = [];
    if (method === 'GetLatestBlock') out = [encV(1, 5000)];
    if (method === 'GetTreeState') out = [Buffer.concat([enc(1, Buffer.from('test')), encV(2, 4000), enc(7, Buffer.from('01ab'))])];
    if (method === 'GetBlockRange') {
      // two txs out of order; actions must come back sorted by tx index
      // real lightwalletd compact actions carry nullifier, cmx, ephemeral key, 52-byte ciphertext
      const act = (c) => enc(9, Buffer.concat([enc(1, Buffer.alloc(32)), enc(2, cmx(c)), enc(3, Buffer.alloc(32, 0xe0 + c)), enc(4, Buffer.alloc(52, c))]));
      const tx1 = enc(7, Buffer.concat([encV(1, 1), enc(2, Buffer.alloc(32, 0x11)), act(3)]));
      const tx0 = enc(7, Buffer.concat([encV(1, 0), enc(2, Buffer.alloc(32, 0x10)), act(1), act(2)]));
      const txT = enc(7, Buffer.concat([encV(1, 2), enc(2, Buffer.alloc(32, 0x12))])); // transparent-only tx: no actions
      out = [Buffer.concat([encV(2, 4001), tx1, tx0, txT])];
    }
    if (method === 'GetAddressUtxos') {
      const addr = decodeFirst(req);
      const txid = Buffer.alloc(32); txid[0] = 0xab; // protocol order: displayed reversed
      const u = (vout, value) => enc(1, Buffer.concat([enc(1, txid), ...(vout ? [encV(2, vout)] : []), enc(3, Buffer.from('76a914' + '00'.repeat(20) + '88ac', 'hex')), encV(4, value), encV(5, 4000), enc(6, Buffer.from(addr))]));
      out = [Buffer.concat([u(0, 2055000), u(3, 20000)])];
    }
    if (method === 'SendTransaction') {
      sent.push(req);
      const bad = req.includes(Buffer.from([0xba, 0xd0]));
      out = [bad ? Buffer.concat([encV(1, 0), enc(2, Buffer.from('transaction is locked until after block height 4522354'))])
        : Buffer.concat([enc(2, Buffer.from(req.includes(Buffer.from([0x51])) ? '"' + 'bb'.repeat(32) + '"' : 'aa'.repeat(32)))])];
    }
    stream.respond({ ':status': 200, 'content-type': 'application/grpc' }, { waitForTrailers: true });
    stream.on('wantTrailers', () => stream.sendTrailers({ 'grpc-status': '0' }));
    stream.end(Buffer.concat(out.map(frame)));
  });
});
await new Promise((r) => fake.listen(0, r));
process.env.LINTEL_LWD = `http://127.0.0.1:${fake.address().port}`;
process.env.NODE_ENV = 'test';
process.env.DATA_FILE = '/tmp/lintel-relay-chain-test.json';
try { fs.unlinkSync(process.env.DATA_FILE); } catch {}
const { server } = await import('./server.js');
await new Promise((r) => server.listen(0, r));
const base = `http://127.0.0.1:${server.address().port}`;
const call = async (method, path, body, tok) => {
  const r = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json', ...(tok ? { Authorization: `Bearer ${tok}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, json: await r.json() };
};
const h32 = (c) => c.repeat(64);

test('chain proxy: height, tree, ordered block commitments, broadcast', async () => {
  assert.deepEqual((await call('GET', '/chain/height')).json, { height: 5000 });
  assert.deepEqual((await call('GET', '/chain/tree/4000')).json, { height: 4000, ironwood_tree: '01ab' });
  const c = (await call('GET', '/chain/cmxs/4001')).json;
  assert.deepEqual(c.cmxs, [cmx(1), cmx(2), cmx(3)].map((b) => b.toString('hex')));
  assert.equal((await call('GET', '/chain/tree/0')).status, 400);
  assert.equal((await call('POST', '/chain/broadcast', { tx: 'zz' })).status, 400);
  assert.equal((await call('POST', '/chain/broadcast', { tx: 'ab'.repeat(30001) })).status, 400);
  const ok = (await call('POST', '/chain/broadcast', { tx: '0600008001' })).json;
  assert.equal(ok.accepted, true);
  const quoted = (await call('POST', '/chain/broadcast', { tx: '065151' })).json;
  assert.equal(quoted.accepted, true, 'testnet lightwalletd returns the txid JSON-quoted on success');
  const no = (await call('POST', '/chain/broadcast', { tx: '06bad0' })).json;
  assert.equal(no.accepted, false, 'a node error message means rejected even with error_code 0');
  assert.match(no.error_message, /locked until/);
  assert.equal(sent.length, 3);
});

test('pay-in detection: transparent coins and Ironwood compact actions', async () => {
  const taddr = 'tmXi4socqXL9bvpsGpVUVUEGngUSAey2yCE';
  const u = (await call('GET', `/chain/utxos/${taddr}`)).json;
  assert.equal(u.address, taddr);
  assert.deepEqual(u.utxos, [
    { txid: '00'.repeat(31) + 'ab', vout: 0, value: 2055000, height: 4000 },
    { txid: '00'.repeat(31) + 'ab', vout: 3, value: 20000, height: 4000 },
  ]);
  assert.equal((await call('GET', '/chain/utxos/utest1abc')).status, 404, 'only testnet P2PKH addresses');
  const c = (await call('GET', '/chain/compact/4001/4001')).json;
  assert.equal(c.txs.length, 2, 'transactions without Ironwood actions are skipped');
  assert.deepEqual(c.txs.map((t) => t.txid), ['10'.repeat(32), '11'.repeat(32)], 'block order, display txids');
  assert.deepEqual(c.txs[0].actions[1], { nf: '00'.repeat(32), cmx: cmx(2).toString('hex'), epk: 'e2'.repeat(32), ct: '02'.repeat(52) });
  assert.equal((await call('GET', '/chain/compact/4001/4200')).status, 400, 'at most 100 blocks per call');
  assert.equal((await call('GET', '/chain/compact/4002/4001')).status, 400);
});

test('chain-mode session: no nonce up front, settlement round gated, no relay signature', async () => {
  const c = await call('POST', '/listings', { title: 'Onchain', price_zec: '0.02', content_hash: h32('a'), merchant_vk: h32('b'), t_point: h32('c'), offer: '{"x":1}', size: 10 });
  const st = c.json.seller_token, lid = c.json.listing.id;
  assert.equal((await call('POST', `/listings/${lid}/sessions`, { payer_vk: h32('d') })).status, 400, 'relay mode still needs r_a/alpha/sighash');
  const s = await call('POST', `/listings/${lid}/sessions`, { payer_vk: h32('d'), mode: 'chain' });
  assert.equal(s.status, 200);
  assert.equal(s.json.session.mode, 'chain');
  assert.equal(s.json.session.r_a, null);
  const sid = s.json.session.id, bt = s.json.buyer_token;
  // settlement partial only after the buyer's settlement nonce and the seller's PCZT
  assert.equal((await call('POST', `/sessions/${sid}/partial`, { partial: '{}', merchant_pok: '{}' }, st)).status, 400);
  assert.equal((await call('POST', `/sessions/${sid}/chain/settle_pczt`, { value: 'AAAA' }, st)).status, 200);
  assert.equal((await call('POST', `/sessions/${sid}/chain/settle_r_a`, { value: h32('e') }, st)).status, 401);
  assert.equal((await call('POST', `/sessions/${sid}/chain/settle_r_a`, { value: h32('e') }, bt)).status, 200);
  assert.equal((await call('POST', `/sessions/${sid}/partial`, { partial: '{}', merchant_pok: '{}' }, st)).status, 200);
  assert.equal((await call('POST', `/sessions/${sid}/presig`, { presig: '{}' }, bt)).status, 200);
  assert.equal((await call('POST', `/sessions/${sid}/signature`, { signature: h32('9').repeat(2) }, st)).status, 400, 'on-chain: t must come from the chain');
  assert.equal((await call('POST', `/sessions/${sid}/chain/settle_txid`, { value: h32('6') }, st)).status, 200);
  assert.equal((await call('GET', `/listings/${lid}`)).json.listing.status, 'sold');
});

test.after(() => { server.close(); fake.close(); });
