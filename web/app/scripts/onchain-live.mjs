// LIVE Zcash testnet sale driven entirely through the browser UI (two
// headless Chromium contexts: seller and buyer), against a local relay that
// proxies the public testnet lightwalletd. Spends real TAZ from the buyer
// wallet you pass in. Writes a public evidence record (txids, heights; no keys).
//
//   npm run build   # with VITE_RELAY_URL unset (http://localhost:8787)
//   BUYER_WALLET=/path/payer-wallet.json BUYER_NOTE_TXIDS=<txid>[,<txid>] \
//   EVIDENCE=../../docs/testnet/evidence-browser-settle.json node scripts/onchain-live.mjs
import fs from 'node:fs';
import { harness } from './harness.mjs';

const t0 = Date.now();
const log = (...a) => console.log(`[${((Date.now() - t0) / 1000).toFixed(0)}s]`, ...a);
const walletJson = fs.readFileSync(process.env.BUYER_WALLET, 'utf8');
const noteTxids = (process.env.BUYER_NOTE_TXIDS || '').split(',').filter(Boolean);
const price = process.env.PRICE || '0.02';
const secret = `Lintel browser on-chain demo ${new Date().toISOString()}: sealed finding #${Math.random().toString(16).slice(2, 10)}`;

const { browser, app, relayUrl, close } = await harness({ appPort: 4183 });
let bp = null, sp = null;
// Device state (contains SECRET keys and the signed refund) is saved to a LOCAL
// file so a failed run can still be refunded later. Never commit it.
async function saveStates() {
  for (const [who, page, out] of [['buyer', bp, process.env.BUYER_STATE_OUT], ['seller', sp, process.env.SELLER_STATE_OUT]]) {
    if (!page || !out) continue;
    try { fs.writeFileSync(out, await page.evaluate(() => localStorage.getItem('lintel.v1')), { mode: 0o600 }); log(`${who} device state saved locally`); } catch (e) { log(`could not save ${who} state`, e.message); }
  }
}
const evidence = { network: 'testnet', driven_by: 'browser UI (headless Chromium, two contexts)', price_taz: price, started: new Date().toISOString() };
try {
  // ---- seller: wallet + on-chain listing, then My sales stays open
  const sctx = await browser.newContext();
  sp = await sctx.newPage();
  sp.on('pageerror', (e) => log('seller pageerror', e.message));
  sp.on('console', (m) => { if (m.type() === 'error') log('seller console', m.text()); });
  await sp.goto(`${app}/#/wallet`);
  await sp.waitForSelector('.engine.ready', { timeout: 300000 });
  await sp.click('text=Create wallet', { timeout: 120000 });
  await sp.waitForSelector('text=Spendable');
  evidence.seller_payout_address = (await sp.textContent('dl.facts dd.mono')).trim();
  log('seller wallet', evidence.seller_payout_address.slice(0, 24) + '…');
  await sp.goto('about:blank');
  await sp.goto(`${app}/#/sell`);
  await sp.waitForSelector('.engine.ready', { timeout: 300000 });
  await sp.fill('input[maxlength="120"]', 'Browser on-chain demo');
  await sp.fill('input[inputmode="decimal"]', price);
  await sp.check('label.check input[type="checkbox"]');
  await sp.fill('textarea.mono', secret);
  await sp.click('form button.btn');
  await sp.waitForURL(/#\/mine/, { timeout: 600000 });
  const { listings } = await (await fetch(relayUrl + '/listings')).json();
  const lid = listings.find((l) => l.title === 'Browser on-chain demo').id;
  evidence.listing_id = lid;
  log('listed', lid);

  // ---- buyer: import wallet, add notes, buy on-chain
  const bctx = await browser.newContext();
  bp = await bctx.newPage();
  bp.on('pageerror', (e) => log('buyer pageerror', e.message));
  bp.on('console', (m) => { if (m.type() === 'error') log('buyer console', m.text()); });
  await bp.goto(`${app}/#/wallet`);
  await bp.waitForSelector('.engine.ready', { timeout: 300000 });
  await bp.fill('textarea.mono', walletJson);
  await bp.click('button:has-text("Import")');
  await bp.waitForSelector('text=Spendable', { timeout: 120000 });
  for (const tx of noteTxids) {
    await bp.fill('input.mono', tx);
    await bp.click('button:has-text("Scan")');
    await bp.waitForFunction(() => /Found|No notes|not found|error/i.test(document.querySelector('section p.small:last-child')?.textContent || ''), null, { timeout: 120000 });
    log('scan', tx.slice(0, 12), await bp.textContent('section p.small:last-child'));
  }
  evidence.buyer_balance_before = await bp.textContent('dl.facts dd:nth-of-type(2)');
  await bp.goto(`${app}/#/listing/${lid}`);
  await bp.waitForSelector('text=Proof verified', { timeout: 300000 });
  await bp.click('button:has-text("Buy on-chain")', { timeout: 120000 });
  log('buy clicked');

  let lastB = '', lastS = '';
  let saved = false;
  const deadline = Date.now() + 90 * 60 * 1000;
  for (;;) {
    if (Date.now() > deadline) throw new Error('timed out waiting for the on-chain sale');
    const bl = await bp.$$eval('.onchain ol.log li', (xs) => xs.map((x) => x.textContent));
    const bLast = bl[bl.length - 1] || '';
    if (bLast !== lastB) { lastB = bLast; log('buyer:', bLast); }
    const sNote = await sp.$$eval('.card p.small.muted', (xs) => xs.map((x) => x.textContent).join(' | ')).catch(() => '');
    if (sNote !== lastS) { lastS = sNote; log('seller:', sNote); }
    const err = await bp.$('.onchain .error');
    if (err) throw new Error('buyer error: ' + (await err.textContent()));
    if (await bp.$('.unlocked')) break;
    if (/Funding broadcast/.test(bLast) && !saved) { await saveStates(); saved = true; }
    await new Promise((r) => setTimeout(r, 5000));
  }
  const unlocked = await bp.textContent('.unlocked pre');
  evidence.decrypted_matches = unlocked === secret;
  const { session } = await (await fetch(`${relayUrl}/listings/${lid}`)).json();
  const ch = session.chain;
  evidence.escrow_address = ch.escrow_address;
  const mined = async (txid) => (await (await fetch(`${relayUrl}/chain/tx/${txid}`)).json()).height;
  evidence.funding = { txid: ch.funding_txid, height: await mined(ch.funding_txid) };
  evidence.settlement = { txid: ch.settle_txid, height: await mined(ch.settle_txid), terms: JSON.parse(ch.settle_terms) };
  const rt = JSON.parse(ch.refund_terms);
  evidence.refund_presigned_before_funding = { lock_input: `${rt.terms.lock.txid}:${rt.terms.lock.vout}`, lock_address: rt.terms.lock.address, n_lock_time: rt.terms.lock.lock_height, settle_expiry: rt.settle_expiry, status: 'kept on the buyer device; conflicts with the mined settlement (same escrow nullifier)' };
  evidence.relay_saw = Object.keys(ch).sort();
  evidence.relay_saw_signature = session.signature !== null;
  evidence.t_source = 'mined settlement transaction via relay GET /chain/tx/:txid, signature verified in the buyer browser (unlockFromTx)';
  evidence.finished = new Date().toISOString();
  evidence.elapsed_s = Math.round((Date.now() - t0) / 1000);
  log('DONE', JSON.stringify(evidence));
  if (process.env.EVIDENCE) fs.writeFileSync(process.env.EVIDENCE, JSON.stringify(evidence, null, 2) + '\n');
} catch (e) {
  log('FAILED', e.message);
  evidence.error = e.message;
  if (process.env.EVIDENCE) fs.writeFileSync(process.env.EVIDENCE + '.failed.json', JSON.stringify(evidence, null, 2) + '\n');
  process.exitCode = 1;
} finally {
  await saveStates();
  await close();
}
