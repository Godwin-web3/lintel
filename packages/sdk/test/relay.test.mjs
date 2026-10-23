// The SDK against a local relay: seal, list, verify, and a complete
// off-chain rehearsal purchase (no funds move) between two separate stores.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createLintel, MemoryStore, RelayError, listingStatus } from '../dist/node.js';
import { startRelay } from './helpers.mjs';

let relay, seller, buyer;
before(async () => {
  relay = await startRelay();
  seller = await (await createLintel({ relayUrl: relay.url, store: new MemoryStore() })).ready();
  buyer = await createLintel({ relayUrl: relay.url, store: new MemoryStore() });
});
after(async () => { await relay?.stop(); });

test('relay client: health, empty listings, validation errors are typed', async () => {
  assert.deepEqual(await seller.relay.health(), { ok: true });
  const err = await seller.relay.createListing({ title: '' }).catch((e) => e);
  assert.ok(err instanceof RelayError);
  assert.equal(err.status, 400);
  assert.match(err.message, /title required/);
  await assert.rejects(seller.listing('nope'), (e) => e instanceof RelayError && e.status === 404);
});

test('engine limits come from the WASM', async () => {
  assert.equal(await seller.engine.maxPayload(), 1953);
  assert.equal(await seller.engine.maxPayloadBig(), 1523681);
  assert.equal(await seller.engine.partsFor(1954), 1);
});

let listingId;
const secret = `SDK test finding ${Date.now()}: reentrancy in withdraw()`;

test('sell: seal + list a small file; listing is public and keys stay local', async () => {
  const r = await seller.sell({ title: 'SDK test listing', price: '0.02', data: secret, description: 'test', filename: 'finding.txt' });
  listingId = r.listing.id;
  assert.equal(r.kind, 'single');
  assert.equal(r.listing.status, 'open');
  assert.equal(r.listing.size, new TextEncoder().encode(secret).length);
  const state = await seller.exportState();
  assert.ok(state.selling[listingId].state.includes('sk_b'), 'merchant state kept locally');
  const { listing } = await buyer.listing(listingId);
  assert.ok(!JSON.stringify(listing).includes('sk_b'), 'relay never sees the signing share');
  assert.ok(!('seller_token_hash' in listing));
  const all = await buyer.listings();
  assert.ok(all.some((l) => l.id === listingId && l.offer === undefined), 'list view omits offers');
});

test('verify: proof checks against the listing, and fails against a different hash', async () => {
  const v = await buyer.verify(listingId);
  assert.equal(v.ok, true);
  assert.equal(v.kind, 'single');
  assert.equal(v.parts, 1);
  const { listing } = await buyer.listing(listingId);
  assert.equal(v.tPoint, listing.t_point);
  const wrong = await buyer.engine.contentHash(new TextEncoder().encode('something else'));
  await assert.rejects(buyer.engine.verifyOffer(listing.offer, wrong), /does not verify/);
});

test('buy (off-chain rehearsal): seller and buyer step in turn; buyer decrypts', async () => {
  const purchase = buyer.buy(listingId, { mode: 'relay' });
  const sale = seller.sale(listingId);
  assert.equal((await sale.step()).phase, 'listed');
  const phases = [];
  let s1 = await purchase.step(); phases.push(s1.phase);          // joined
  assert.equal((await seller.status(listingId)).phase, 'joined');
  const a = await sale.step(); assert.equal(a.phase, 'partial_sent');
  s1 = await purchase.step(); phases.push(s1.phase);              // presigned
  assert.equal((await seller.status(listingId)).phase, 'presigned');
  const b = await sale.step(); assert.equal(b.phase, 'sold'); assert.ok(b.done);
  s1 = await purchase.step(); phases.push(s1.phase);              // done
  assert.deepEqual(phases, ['joined', 'presigned', 'done']);
  assert.equal(new TextDecoder().decode(s1.plaintext), secret);
  const st = await buyer.status(listingId);
  assert.equal(st.phase, 'settled');
  assert.equal(st.status, 'sold');
  // idempotent after completion
  assert.equal(new TextDecoder().decode((await purchase.step()).plaintext), secret);
});

test('a sold listing refuses a second buyer', async () => {
  const other = await createLintel({ relayUrl: relay.url });
  await assert.rejects(other.buy(listingId, { mode: 'relay' }).step(), (e) => e.status === 409);
});

test('complete() and watch() drive a purchase while the seller runs concurrently', async () => {
  const text = 'concurrent sale ' + Math.random();
  const { listing } = await seller.sell({ title: 'SDK concurrent', price: '0.5', data: text });
  const ac = new AbortController();
  const sellerLoop = (async () => { for await (const s of seller.sale(listing.id).watch({ intervalMs: 100, signal: ac.signal })) if (s.done) break; })();
  const seen = [];
  const bytes = await buyer.buy(listing.id, { mode: 'relay' }).complete({ intervalMs: 100, timeoutMs: 120000, onStep: (s) => seen.push(s.phase) });
  ac.abort(); await sellerLoop;
  assert.equal(new TextDecoder().decode(bytes), text);
  assert.equal(seen.at(-1), 'done');
});

test('chain-mode purchase needs a funded wallet (clear error, nothing posted)', async () => {
  const { listing } = await seller.sell({ title: 'SDK chain needs wallet', price: '0.02', data: 'x' });
  await assert.rejects(buyer.buy(listing.id).step(), /create or import a testnet wallet/);
  await buyer.wallet.create();
  await assert.rejects(buyer.buy(listing.id).step(), /no single wallet note covers 0\.02055 TAZ/);
  assert.equal(listingStatus((await buyer.listing(listing.id)).listing, null).phase, 'open');
  assert.equal((await buyer.listing(listing.id)).session, null, 'no session was opened');
});

test('handoff: lintel-agent file carries the seller entry and marks it delegated', async () => {
  const { listing } = await seller.sell({ title: 'SDK handoff', price: '0.02', data: 'agent sale' });
  const sale = seller.sale(listing.id);
  await assert.rejects(sale.handoff(), /payout address/);
  const payout = await buyer.wallet.address();
  const h = await sale.handoff({ payoutAddress: payout });
  assert.equal(h.kind, 'lintel-agent-handoff');
  assert.equal(h.v, 1);
  assert.equal(h.relay, relay.url);
  assert.equal(h.listing_id, listing.id);
  assert.match(h.payout_address, /^utest1/);
  assert.ok(JSON.parse(h.state).sk_b);
  assert.equal((await sale.step()).phase, 'delegated');
  await sale.takeBack();
  assert.equal((await sale.step()).phase, 'listed');
});
