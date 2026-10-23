// Big payload (offer v3): proven parts uploaded as content-addressed blobs.
// Slow (one Halo 2 part proof, minutes single-threaded): LINTEL_TEST_BIG=1.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createLintel, MemoryStore } from '../dist/node.js';
import { startRelay } from './helpers.mjs';

test('big payload: seal in parts, verify every part, rehearse the sale', { skip: !process.env.LINTEL_TEST_BIG, timeout: 30 * 60 * 1000 }, async () => {
  const relay = await startRelay();
  try {
    const seller = await createLintel({ relayUrl: relay.url, store: new MemoryStore() });
    const buyer = await createLintel({ relayUrl: relay.url, store: new MemoryStore() });
    const data = new Uint8Array(4000).map((_, i) => (i * 7) & 255);
    const progress = [];
    const r = await seller.sell({ title: 'big', price: '0.01', data, onProgress: (p) => progress.push(p) });
    assert.equal(r.kind, 'big');
    console.log(`# sealed ${data.length} bytes in ${r.sealMs} ms`);
    const v = await buyer.verify(r.listing.id);
    assert.equal(v.kind, 'big');
    assert.equal(v.parts, 1);
    console.log(`# verified ${v.parts} part(s) in ${v.ms} ms`);
    const sale = seller.sale(r.listing.id);
    const p = buyer.buy(r.listing.id, { mode: 'relay' });
    await p.step(); await sale.step(); await p.step(); await sale.step();
    const done = await p.step();
    assert.deepEqual(done.plaintext, data);
  } finally { await relay.stop(); }
});
