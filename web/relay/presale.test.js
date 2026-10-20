// v2 presale routes: many copies per listing, one-request orders, one-request
// completion, write-once, reject reopens, no unit reuse.
process.env.NODE_ENV = 'test';
process.env.RELAY_STORAGE = 'memory';
import { test } from 'node:test';
import assert from 'node:assert/strict';
const { server } = await import('./server.js');

await new Promise((r) => server.listen(0, r));
const base = `http://127.0.0.1:${server.address().port}`;
const call = async (method, path, body, tok) => {
  const r = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json', ...(tok ? { Authorization: `Bearer ${tok}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, json: await r.json(), headers: r.headers };
};
let n = 0;
const hx = () => (++n).toString(16).padStart(64, '0');
const unit = () => ({ t_point: hx(), merchant_vk: hx(), r_b: hx(), pok: '{"r":"1","s":"2"}', offer: '{"v":2}' });
const order = () => ({ payer_vk: hx(), r_a: hx(), dh_point: hx(), s_a: hx(), alpha: hx(), payer_pok: '{}', sighash: 'ab'.repeat(32) });

test('presale listing: two copies, two buyers, seller completes later', async () => {
  const c = await call('POST', '/listings', { version: 2, title: 'Report', price_zec: '0.5', content_hash: 'a'.repeat(64), size: 3000, unit: unit() });
  assert.equal(c.status, 200);
  const lid = c.json.listing.id, st = c.json.seller_token;
  assert.equal(c.json.listing.seller_token_hash, undefined);
  assert.equal(c.headers.get('cross-origin-resource-policy'), 'cross-origin');

  const u2 = unit();
  assert.equal((await call('POST', `/listings/${lid}/units`, { unit: u2 })).status, 401);
  assert.equal((await call('POST', `/listings/${lid}/units`, { unit: u2 }, st)).status, 200);
  assert.equal((await call('POST', `/listings/${lid}/units`, { unit: { ...unit(), r_b: u2.r_b } }, st)).status, 400, 'nonce reuse rejected');

  const list = (await call('GET', '/listings')).json.listings.find((l) => l.id === lid);
  assert.equal(list.units, undefined);
  assert.equal(list.units_open, 2);
  const one = (await call('GET', `/listings/${lid}`)).json.listing;
  assert.equal(one.units.length, 2);
  assert.equal(one.units[0].offer, undefined, 'detail view omits offers');
  assert.equal((await call('GET', `/listings/${lid}/units/1`)).json.unit.offer, '{"v":2}');
  assert.equal((await call('POST', `/listings/${lid}/sessions`, order())).status, 400, 'v1 route refuses v2');

  // Buyer A orders copy 0 while the seller is offline.
  const a = await call('POST', `/listings/${lid}/units/0/orders`, order());
  assert.equal(a.status, 200);
  assert.equal(a.json.order.buyer_token_hash, undefined);
  assert.equal((await call('POST', `/listings/${lid}/units/0/orders`, order())).status, 409);
  assert.equal((await call('POST', `/listings/${lid}/units/1/orders`, { ...order(), s_a: 'zz' })).status, 400);
  // Buyer B orders copy 1.
  const b = await call('POST', `/listings/${lid}/units/1/orders`, order());
  assert.equal((await call('GET', `/listings/${lid}`)).json.listing.status, 'pending');

  // Seller comes online: rejects B's order (say it failed verification), completes A's.
  assert.equal((await call('POST', `/orders/${b.json.order.id}/reject`, { reason: 'bad pre-signature' }, a.json.buyer_token)).status, 401);
  assert.equal((await call('POST', `/orders/${b.json.order.id}/reject`, { reason: 'bad pre-signature' }, st)).status, 200);
  assert.equal((await call('GET', `/listings/${lid}`)).json.listing.units[1].state, 'open');
  const sig = { signature: 'cd'.repeat(64), enc_sb: 'ef'.repeat(32) };
  assert.equal((await call('POST', `/orders/${a.json.order.id}/complete`, sig, a.json.buyer_token)).status, 401);
  assert.equal((await call('POST', `/orders/${a.json.order.id}/complete`, { ...sig, enc_sb: 'x' }, st)).status, 400);
  assert.equal((await call('POST', `/orders/${a.json.order.id}/complete`, sig, st)).status, 200);
  assert.equal((await call('POST', `/orders/${a.json.order.id}/complete`, sig, st)).status, 400, 'write-once');
  assert.equal((await call('POST', `/orders/${a.json.order.id}/reject`, {}, st)).status, 400, 'cannot reject a completed order');
  const done = (await call('GET', `/orders/${a.json.order.id}`)).json.order;
  assert.equal(done.status, 'complete');
  assert.equal(done.enc_sb, sig.enc_sb);

  const orders = (await call('GET', `/listings/${lid}/orders`)).json.orders;
  assert.equal(orders.length, 1);
  // Copy 1 re-sells, then everything is sold.
  const c2 = await call('POST', `/listings/${lid}/units/1/orders`, order());
  await call('POST', `/orders/${c2.json.order.id}/complete`, sig, st);
  const final = (await call('GET', `/listings/${lid}`)).json.listing;
  assert.deepEqual([final.status, final.units_sold, final.units_open], ['sold', 2, 0]);
});

test('presale validation', async () => {
  assert.equal((await call('POST', '/listings', { version: 2, title: 'x', price_zec: '1', content_hash: 'a'.repeat(64), size: 8000, unit: unit() })).status, 400);
  assert.equal((await call('POST', '/listings', { version: 2, title: 'x', price_zec: '1', content_hash: 'a'.repeat(64), size: 10 })).status, 400);
  assert.equal((await call('POST', '/listings', { version: 2, title: 'x', price_zec: '1', content_hash: 'a'.repeat(64), size: 10, unit: { ...unit(), offer: 'not json' } })).status, 400);
  assert.equal((await call('GET', '/listings/nope/units/0')).status, 404);
  server.close();
});
