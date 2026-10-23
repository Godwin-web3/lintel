#!/usr/bin/env node
// Buyer: verify a listing's proof locally, then buy it.
//
//   node buyer.mjs --listing <id>                         # verify only
//   node buyer.mjs --listing <id> --buy --funding payin   # pay a ZIP 321 request from any testnet wallet
//   node buyer.mjs --listing <id> --buy --wallet-import wallet.json --scan <faucet txid>
//   node buyer.mjs --listing <id> --buy --mode relay      # off-chain rehearsal (no funds move)
//   node buyer.mjs --listing <id> --refund                # after the lock height, if the seller never settled
//
// --relay URL   relay (default: LINTEL_RELAY_URL or the hosted testnet relay)
// --state FILE  SECRET buyer keys and the co-signed refund (default ./buyer-state.SECRET.json)
// --out FILE    where to write the decrypted content (default ./<listing>.bin)
import { readFileSync, writeFileSync } from 'node:fs';
import { createLintel, FileStore, fmtZec, walletNeedFor, zats } from 'lintel-sdk';
import { parseArgs, log } from './args.mjs';

const a = parseArgs();
if (!a.listing) { console.error('usage: node buyer.mjs --listing ID [--buy] [--mode chain|relay] [--funding wallet|payin]'); process.exit(2); }
const lintel = await createLintel({ relayUrl: a.relay || process.env.LINTEL_RELAY_URL, store: new FileStore(a.state || 'buyer-state.SECRET.json') });
log(`relay ${lintel.relay.url}`);

if (a['wallet-import']) log('wallet', await lintel.wallet.import(readFileSync(a['wallet-import'], 'utf8')));
for (const tx of String(a.scan || '').split(',').filter(Boolean)) log(`scanned ${tx.slice(0, 12)}…: ${(await lintel.wallet.scan(tx)).length} note(s)`);

const purchase = lintel.buy(a.listing, { mode: a.mode || 'chain', funding: a.funding || 'wallet' });
if (a.refund) { log('refund broadcast', await purchase.refund()); process.exit(0); }

const { listing } = await lintel.listing(a.listing);
log(`"${listing.title}": ${listing.price_zec} TAZ, ${listing.size} bytes, status ${listing.status}`);
const v = await lintel.verify(listing);
log(`proof verified locally in ${(v.ms / 1000).toFixed(1)} s (${v.kind}, ${v.parts} part${v.parts > 1 ? 's' : ''}); T = ${v.tPoint.slice(0, 16)}…`);
if (!a.buy) process.exit(0);

if ((a.mode || 'chain') === 'chain' && (a.funding || 'wallet') === 'wallet') {
  const w = await lintel.wallet.info();
  log(`wallet ${w ? `${fmtZec(w.balance)} TAZ` : 'missing'}; this purchase needs one note of ${fmtZec(walletNeedFor(zats(listing.price_zec)))} TAZ`);
}
let last = '', shown = false;
for await (const s of purchase.watch({ intervalMs: Number(a.interval || 8000) })) {
  if (s.payment && !shown) { shown = true; log(`pay exactly ${fmtZec(s.payment.amount)} TAZ:\n  ${s.payment.uri}\n  (transparent-only wallets: ${s.payment.uriTransparent})`); }
  if (s.note !== last) { log(`[${s.phase}] ${s.note}`); last = s.note; }
  if (s.done) {
    const out = a.out || `${a.listing}.bin`;
    writeFileSync(out, s.plaintext);
    log(`decrypted ${s.plaintext.length} bytes -> ${out}`);
    if (s.txids.funding) log(`funding txid ${s.txids.funding}`);
    if (s.txids.settlement) log(`settlement txid ${s.txids.settlement}`);
  }
}
