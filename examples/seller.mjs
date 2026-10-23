#!/usr/bin/env node
// Seller CLI: seal a file (or text), list it, and optionally finish the sale.
//
//   node seller.mjs --file report.md --title "Bug report: Acme vault" --price 0.02
//   node seller.mjs --text "the secret" --title T --price 0.01 --watch        # answer buyers until sold
//   node seller.mjs --listing <id> --watch                                     # resume a sale
//   node seller.mjs --listing <id> --handoff handoff.json --payout utest1...   # give it to lintel-agent
//
// --relay URL     relay (default: LINTEL_RELAY_URL or the hosted testnet relay)
// --state FILE    SECRET seller keys (default: ./seller-state.SECRET.json, mode 0600)
// --wallet-create create a testnet wallet in the state file to receive payouts
import { readFileSync, writeFileSync } from 'node:fs';
import { basename } from 'node:path';
import { createLintel, FileStore, fmtZec } from 'lintel-sdk';
import { parseArgs, log } from './args.mjs';

const a = parseArgs();
const lintel = await createLintel({ relayUrl: a.relay || process.env.LINTEL_RELAY_URL, store: new FileStore(a.state || 'seller-state.SECRET.json') });
log(`relay ${lintel.relay.url}`);

if (a['wallet-create'] && !(await lintel.wallet.address())) log('payout wallet', await lintel.wallet.create());

let id = a.listing;
if (!id) {
  if (!a.title || !a.price || !(a.file || a.text)) {
    console.error('usage: node seller.mjs (--file F | --text T) --title TITLE --price ZEC [--description D] [--watch]');
    process.exit(2);
  }
  const data = a.file ? readFileSync(a.file) : String(a.text);
  log(`sealing ${data.length} bytes (Halo 2 proof${data.length > (await lintel.engine.maxPayload()) ? 's per 23.8 KB part' : ''})…`);
  const r = await lintel.sell({
    title: a.title, price: String(a.price), description: a.description, filename: a.file ? basename(a.file) : undefined, data,
    onProgress: (p) => { if ('part' in p && p.part) log(`proved part ${p.part}/${p.parts} (${(p.ms / 1000).toFixed(0)} s)`); if ('uploaded' in p) log(`uploaded ${p.uploaded}/${p.blobs} parts`); },
  });
  id = r.listing.id;
  log(`listed ${id}: "${r.listing.title}" for ${r.listing.price_zec} TAZ (${r.kind} proof, sealed in ${(r.sealMs / 1000).toFixed(1)} s)`);
  log(`content hash ${r.listing.content_hash}`);
}

const sale = lintel.sale(id, { payoutAddress: a.payout });
if (a.handoff) {
  const h = await sale.handoff({ payoutAddress: a.payout });
  writeFileSync(a.handoff, JSON.stringify(h, null, 2), { mode: 0o600 });
  log(`handoff written to ${a.handoff} (SECRET). Next: lintel-agent import ${a.handoff} && lintel-agent run`);
} else if (a.watch) {
  log('answering buyers until sold (Ctrl-C to stop; rerun with --listing to resume)');
  let last = '';
  for await (const s of sale.watch({ intervalMs: Number(a.interval || 5000) })) {
    if (s.note !== last) { log(`[${s.phase}] ${s.note}`); last = s.note; }
    if (s.done) {
      if (s.txids.settlement) log(`settlement txid ${s.txids.settlement}`);
      const w = await lintel.wallet.info();
      if (w) log(`wallet balance ${fmtZec(w.balance)} TAZ`);
    }
  }
} else {
  log(`status: ${(await lintel.status(id)).label}. Run with --listing ${id} --watch to finish sales here, or --handoff to use lintel-agent.`);
}
