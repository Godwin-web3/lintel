// The on-chain engine (wasm/chain) in Node: constants agree with the engine,
// wallets derive testnet addresses, ZIP 321 requests. Network-free except the
// last test (LINTEL_TEST_NETWORK=1: pay-in request against a local relay
// proxying the public testnet lightwalletd).
import test from 'node:test';
import assert from 'node:assert/strict';
import { createLintel, MemoryStore, LOCK_VALUE, SETTLE_FEE, FUND_FEE, escrowFor, walletNeedFor } from '../dist/node.js';
import { startRelay } from './helpers.mjs';

test('fee and lock constants match the WASM engine', async () => {
  const l = await createLintel();
  const C = await l.engine.chain();
  assert.equal(C.chainLockUtxoValue(), LOCK_VALUE);
  assert.equal(C.chainFee(2, 0, 0), SETTLE_FEE);
  assert.equal(C.chainFee(2, 0, 1), FUND_FEE);
  assert.equal(C.chainRefundPayout(escrowFor(2_000_000)) <= escrowFor(2_000_000), true);
  // what an external wallet pays a pay-in request covers the same outputs
  assert.ok(C.chainPayinAmount(escrowFor(2_000_000)) >= escrowFor(2_000_000) + LOCK_VALUE);
  assert.ok(walletNeedFor(2_000_000) > escrowFor(2_000_000));
});

test('wallet: create and import derive testnet unified addresses; keys stay in the store', async () => {
  const store = new MemoryStore();
  const l = await createLintel({ store });
  const addr = await l.wallet.create();
  assert.match(addr, /^utest1[0-9a-z]+$/);
  await assert.rejects(l.wallet.create(), /already exists/);
  const sk = await l.wallet.exportKey();
  const l2 = await createLintel();
  assert.equal(await l2.wallet.import(JSON.stringify({ sk })), addr);
  assert.equal(await l2.wallet.balance(), 0);
  const info = await l.wallet.info();
  assert.equal(info.address, addr);
  assert.ok(!('sk' in info));
});

test('ZIP 321 request from the engine', async () => {
  const l = await createLintel();
  const C = await l.engine.chain();
  const k = JSON.parse(C.chainPayinNew());
  assert.match(k.payment_ua, /^utest1/);
  assert.match(k.taddr, /^tm/);
  const uri = C.chainZip321(k.taddr, 2_055_000, 'Lintel escrow x');
  assert.ok(uri.startsWith(`zcash:${k.taddr}?amount=0.02055`), uri);
});

test('pay-in request against the testnet (LINTEL_TEST_NETWORK=1)', { skip: !process.env.LINTEL_TEST_NETWORK }, async () => {
  const relay = await startRelay();
  try {
    const seller = await createLintel({ relayUrl: relay.url });
    const buyer = await createLintel({ relayUrl: relay.url, store: new MemoryStore() });
    const { listing } = await seller.sell({ title: 'pay-in request', price: '0.02', data: 'x' });
    const p = buyer.buy(listing.id, { funding: 'payin' });
    const s = await p.step();
    assert.equal(s.phase, 'awaiting_payment');
    assert.match(s.payment.uri, /^zcash:utest1/);
    assert.match(s.payment.uriTransparent, /^zcash:tm/);
    assert.equal(s.payment.amount, (await buyer.engine.chain()).chainPayinAmount(escrowFor(2_000_000)));
    assert.equal((await buyer.listing(listing.id)).session, null, 'no session before payment');
    const backup = JSON.parse(await buyer.payin.backup(listing.id));
    assert.equal(backup.kind, 'lintel-payin-backup');
  } finally { await relay.stop(); }
});
