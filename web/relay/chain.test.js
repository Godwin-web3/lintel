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
      const act = (c) => enc(9, Buffer.concat([enc(1, Buffer.alloc(32)), enc(2, cmx(c))]));
      const tx1 = enc(7, Buffer.concat([encV(1, 1), act(3)]));
      const tx0 = enc(7, Buffer.concat([encV(1, 0), act(1), act(2)]));
      out = [Buffer.concat([encV(2, 4001), tx1, tx0])];
    }
    if (method === 'SendTransaction') {
      sent.push(req);
      const bad = req.includes(Buffer.from([0xba, 0xd0]));
      out = [bad ? Buffer.concat([encV(1, 0), enc(2, Buffer.from('transaction is locked until after block height 4522354'))])
        : Buffer.concat([enc(2, Buffer.from('aa'.repeat(32)))])];
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
  const no = (await call('POST', '/chain/broadcast', { tx: '06bad0' })).json;
  assert.equal(no.accepted, false, 'a node error message means rejected even with error_code 0');
  assert.match(no.error_message, /locked until/);
  assert.equal(sent.length, 2);
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
