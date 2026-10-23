#!/usr/bin/env node
// Seller and buyer in one process, off-chain rehearsal (no funds move):
// seal + list, verify, adaptor-signature exchange through the relay, decrypt.
// The quickest end-to-end check of a relay and the SDK.
//
//   node rehearsal.mjs --relay http://localhost:8787
import { createLintel, MemoryStore } from 'lintel-sdk';
import { parseArgs, log } from './args.mjs';

const a = parseArgs();
const relayUrl = a.relay || process.env.LINTEL_RELAY_URL || 'http://localhost:8787';
const seller = await createLintel({ relayUrl, store: new MemoryStore() });
const buyer = await createLintel({ relayUrl, store: new MemoryStore() });
const secret = a.text || `rehearsal ${new Date().toISOString()}: the vault's withdraw() is reentrant`;

const t0 = Date.now();
const { listing, kind } = await seller.sell({ title: 'Rehearsal listing', price: '0.01', data: secret });
log(`listed ${listing.id} (${kind} proof) in ${Date.now() - t0} ms`);
const v = await buyer.verify(listing.id);
log(`buyer verified the proof in ${v.ms} ms`);
const sale = seller.sale(listing.id), purchase = buyer.buy(listing.id, { mode: 'relay' });
for (;;) {
  const b = await purchase.step(); log(`buyer  [${b.phase}] ${b.note}`);
  if (b.done) { log(`decrypted: ${new TextDecoder().decode(b.plaintext)}`); log(`match: ${new TextDecoder().decode(b.plaintext) === secret}`); break; }
  const s = await sale.step(); log(`seller [${s.phase}] ${s.note}`);
}
log(`status: ${(await buyer.status(listing.id)).label}`);
