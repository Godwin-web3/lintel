// Pure helpers: amounts, status, stores. No relay, no engine.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { zats, fmtZec, escrowFor, walletNeedFor, isPrice, listingStatus, txids, MemoryStore, FileStore, LOCK_VALUE, SETTLE_FEE, FUND_FEE } from '../dist/node.js';

test('zats / fmtZec are exact', () => {
  assert.equal(zats('0.02'), 2_000_000);
  assert.equal(zats('1'), 100_000_000);
  assert.equal(zats('0.00000001'), 1);
  assert.equal(zats('12345678.12345678'), 1234567812345678);
  assert.throws(() => zats('0.000000001'));
  assert.throws(() => zats('-1'));
  assert.equal(fmtZec(2_000_000), '0.02');
  assert.equal(fmtZec(100_000_000), '1');
  assert.equal(escrowFor(2_000_000), 2_000_000 + 2 * SETTLE_FEE);
  assert.equal(walletNeedFor(2_000_000), escrowFor(2_000_000) + LOCK_VALUE + FUND_FEE);
  assert.ok(isPrice('0.1') && !isPrice('0') && !isPrice('1e3') && !isPrice('0.123456789'));
});

test('listingStatus follows the on-chain session fields', () => {
  const listing = { id: 'a', status: 'pending', title: 't', price_zec: '0.02' };
  const s = (chain, extra = {}) => ({ id: 's', mode: 'chain', chain, presig: null, signature: null, ...extra });
  assert.equal(listingStatus({ ...listing, status: 'open' }, null).phase, 'open');
  assert.equal(listingStatus(listing, s({})).phase, 'joined');
  assert.equal(listingStatus(listing, s({ escrow_address: 'utest1x' })).phase, 'escrow_announced');
  assert.equal(listingStatus(listing, s({ escrow_address: 'u', refund_partial: '{}' })).phase, 'refund_cosigned');
  assert.equal(listingStatus(listing, s({ refund_partial: '{}', funding_txid: 'f'.repeat(64) })).phase, 'funding_broadcast');
  assert.equal(listingStatus(listing, s({ funding_txid: 'f'.repeat(64), settle_pczt: 'AA==' })).phase, 'settlement_built');
  assert.equal(listingStatus(listing, s({ settle_pczt: 'AA==' }, { presig: '{}' })).phase, 'presigned');
  const done = listingStatus({ ...listing, status: 'sold' }, s({ funding_txid: 'a'.repeat(64), settle_txid: 'b'.repeat(64) }));
  assert.equal(done.phase, 'settled');
  assert.deepEqual(done.txids, { funding: 'a'.repeat(64), settlement: 'b'.repeat(64) });
  assert.equal(listingStatus(listing, { id: 's', mode: 'relay', presig: '{}', signature: 'ab' }).phase, 'settled');
  assert.equal(listingStatus({ ...listing, version: 2 }, null).phase, 'presale');
  assert.deepEqual(txids(null), {});
});

test('FileStore writes 0600 atomically; MemoryStore round-trips', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lintel-sdk-'));
  const f = new FileStore(path.join(dir, 'sub', 'state.json'));
  assert.equal(await f.load(), null);
  await f.save({ selling: { x: { title: 't', state: 's', token: 'k' } }, buying: {} });
  assert.equal(fs.statSync(f.path).mode & 0o777, 0o600);
  assert.equal((await f.load()).selling.x.token, 'k');
  const m = new MemoryStore();
  m.save({ selling: {}, buying: { y: { session: 's', token: 't' } } });
  assert.equal(m.load().buying.y.session, 's');
});
