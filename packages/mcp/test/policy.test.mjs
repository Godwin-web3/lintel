// Spending limits: the pure policy checks and the spend log's rolling total.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parsePolicy, loadPolicy, checkSpend } from '../dist/policy.js';
import { SpendLog } from '../dist/spendlog.js';

const SELLER = 'utest1' + 'a'.repeat(100);
const base = { maxPerPurchaseZec: '0.05', maxPerDayZec: '0.1', allowedSellers: 'any' };

test('parsePolicy validates amounts, lists, dates and unknown keys', () => {
  const p = parsePolicy({ ...base, expiresAt: '2030-01-01T00:00:00Z', allowSelling: true });
  assert.equal(p.maxPerPurchase, 5_000_000);
  assert.equal(p.maxPerDay, 10_000_000);
  assert.equal(p.allowedListings, 'any');
  assert.equal(p.allowSelling, true);
  assert.throws(() => parsePolicy({ ...base, maxPerPurchaseZec: 0.05 }), /decimal string/);
  assert.throws(() => parsePolicy({ ...base, maxPerPurchaseZec: '1' }), /cannot exceed/);
  assert.throws(() => parsePolicy({ ...base, allowedSellers: ['0xabc'] }), /utest1/);
  assert.throws(() => parsePolicy({ maxPerPurchaseZec: '0.01', maxPerDayZec: '0.1' }), /allowedSellers is required/);
  assert.throws(() => parsePolicy({ ...base, expiresAt: 'soon' }), /ISO 8601/);
  assert.throws(() => parsePolicy({ ...base, maxPerPurchaseZEC: '1' }), /unknown policy key/);
  assert.equal(parsePolicy(base).allowSelling, false, 'selling is opt-in');
});

test('a missing or broken policy disables spending (never fails open)', () => {
  assert.equal(loadPolicy(undefined, () => '').mode, 'disabled');
  assert.equal(loadPolicy('/nope.json', () => { throw new Error('ENOENT'); }).mode, 'disabled');
  const bad = loadPolicy('/p.json', () => '{"maxPerPurchaseZec":"x"}');
  assert.equal(bad.mode, 'disabled');
  assert.match(bad.reason, /invalid/);
  assert.equal(loadPolicy('/p.json', () => JSON.stringify(base)).mode, 'enforced');
});

test('checkSpend: per-purchase, per-day, expiry, listings, sellers', () => {
  const p = parsePolicy({ ...base, allowedSellers: [SELLER], allowedListings: ['L1', 'L2'], expiresAt: '2030-01-01T00:00:00Z' });
  const now = new Date('2029-06-01T00:00:00Z');
  const req = (o) => ({ listingId: 'L1', outlay: 2_055_000, price: 2_000_000, seller: null, ...o });
  assert.deepEqual(checkSpend(p, req({}), 0, now), { ok: true });
  assert.equal(checkSpend(p, req({ outlay: 5_000_001 }), 0, now).code, 'over_per_purchase');
  assert.equal(checkSpend(p, req({ outlay: 5_000_000 }), 0, now).ok, true, 'cap is inclusive');
  assert.equal(checkSpend(p, req({}), 8_000_000, now).code, 'over_per_day');
  assert.equal(checkSpend(p, req({}), 10_000_000 - 2_055_000, now).ok, true, 'daily cap is inclusive');
  assert.equal(checkSpend(p, req({ listingId: 'L3' }), 0, now).code, 'listing_not_allowed');
  assert.equal(checkSpend(p, req({ seller: SELLER }), 0, now).ok, true);
  assert.equal(checkSpend(p, req({ seller: 'utest1' + 'b'.repeat(100) }), 0, now).code, 'seller_not_allowed');
  assert.equal(checkSpend(p, req({}), 0, new Date('2030-01-01T00:00:00Z')).code, 'expired');
  assert.match(checkSpend(p, req({ outlay: 6_000_000 }), 0, now).reason, /exceeds the per-purchase cap of 0\.05 TAZ/);
});

test('spend log: rolling 24 h total counts reserved/funded/settled, not refused/released/refunded', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lintel-mcp-'));
  const log = new SpendLog(path.join(dir, 'log.jsonl'));
  const t = (h) => new Date(Date.UTC(2029, 0, 2, h)).toISOString();
  log.append({ at: t(0), id: 'a', listing: 'a', status: 'reserved', outlay_zats: 100 });
  log.append({ at: t(1), id: 'a', listing: 'a', status: 'funded', txid: 'x' });
  log.append({ at: t(2), id: 'a', listing: 'a', status: 'settled' });
  log.append({ at: t(3), id: 'b', listing: 'b', status: 'refused', outlay_zats: 999 });
  log.append({ at: t(4), id: 'c', listing: 'c', status: 'reserved', outlay_zats: 10 });
  log.append({ at: t(5), id: 'c', listing: 'c', status: 'released' });
  log.append({ at: t(6), id: 'd', listing: 'd', status: 'reserved', outlay_zats: 20 });
  log.append({ at: t(7), id: 'd', listing: 'd', status: 'refunded', txid: 'r' });
  log.append({ at: t(8), id: 'e', listing: 'e', status: 'reserved', outlay_zats: 7 });
  const now = new Date(Date.UTC(2029, 0, 2, 12));
  assert.equal(log.spentSince(now), 107);
  assert.equal(log.spentSince(now, 'e'), 100, 'excludes the purchase being checked');
  assert.equal(log.spentSince(new Date(Date.UTC(2029, 0, 3, 1))), 7, '24 h window from when each purchase started');
  assert.equal(log.status('a'), 'settled');
  assert.equal(fs.statSync(log.path).mode & 0o777, 0o600);
});
