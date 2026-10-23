// On-chain settlement on Zcash testnet (NU7, Ironwood pool, v6), run from the
// browser. Same steps as `lintel-chain` / examples/testnet_sale.rs, split
// between the buyer's and the seller's browsers, which talk only through the
// relay's write-once public session fields.
//
// What stays on this device (localStorage, never sent): the wallet spending
// key, the transparent lock key, the payer/merchant signing shares and
// nonces, the adaptor secret t, the signed refund, plaintext.
// What the relay sees: vks, proofs of knowledge, contributions, addresses,
// agreed terms, unsigned PCZTs, nonce points, partial/pre-signatures,
// txids — the same public data the CLI flow exchanges. (Contributions + vks
// let the relay operator derive the escrow viewing key: it can SEE the escrow,
// never spend it. See docs/onchain.md.)
//
// Every step is idempotent and resumable: `advanceBuyer` / `advanceSeller`
// look at the relay session plus local state and do the next thing, so a
// reload continues where it stopped.
import { crypto, relay, store, randomHex, resolveOffer } from './api.js';

const C = (fn, ...args) => crypto('chain', { fn, args });
const enc = new TextEncoder();
export const LOCK_VALUE = 20_000; // chain::LOCK_UTXO_VALUE
export const SETTLE_FEE = 10_000; // zip317_fee(2, 0, 0)
export const FUND_FEE = 15_000; // zip317_fee(2, 0, 1): funding pays the lock UTXO
export const CLAIM_BLOCKS = 60; // settlement expiry E = tip + 60 (~75 min); refund locked until E
export const SAFETY_BLOCKS = 10; // seller refuses to build/broadcast the settlement within 10 blocks of E

export const b64 = (u8) => { let s = ''; for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode(...u8.subarray(i, i + 0x8000)); return btoa(s); };
export const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

/** "0.02" ZEC -> 2000000 zats, exactly (no floats). */
export function zats(zec) {
  const m = /^(\d{1,8})(?:\.(\d{1,8}))?$/.exec(String(zec).trim());
  if (!m) throw new Error(`bad amount ${zec}`);
  return Number(m[1]) * 1e8 + Number((m[2] || '').padEnd(8, '0'));
}
export const fmtZec = (z) => (z / 1e8).toFixed(8).replace(/0+$/, '').replace(/\.$/, '');
export const escrowFor = (priceZats) => priceZats + 2 * SETTLE_FEE; // settlement pays price + fee, rest back to payer

// ---------------------------------------------------------------- chain data (public, via relay proxy)
export const chainHeight = async () => (await relay('GET', '/chain/height')).height;
export async function chainTxMined(txid) {
  try { const r = await relay('GET', `/chain/tx/${txid}`); return r.mined ? r : null; } catch { return null; }
}
/** Broadcasts; if the node says no, still succeeds when it already knows `txid` (retry after a lost reply). */
export async function broadcast(rawHex, txid) {
  const r = await relay('POST', '/chain/broadcast', { tx: rawHex });
  if (r.accepted) return r;
  if (txid) { try { await relay('GET', `/chain/tx/${txid}`); return { ...r, accepted: true, already_known: true }; } catch {} }
  throw new Error(`node rejected the transaction: ${r.error_message || 'error ' + r.error_code}`);
}
/** Witness from public data, proof, full verification (all in this browser). */
async function finalize(pcztBytes, actionIndex, note) {
  if (!note.height) throw new Error('note is not mined yet');
  const h = note.height;
  const [prev, at, block] = await Promise.all([
    relay('GET', `/chain/tree/${h - 1}`), relay('GET', `/chain/tree/${h}`), relay('GET', `/chain/cmxs/${h}`),
  ]);
  return JSON.parse(await C('chainFinalize', pcztBytes, actionIndex, note.cmx, prev.ironwood_tree, JSON.stringify(block.cmxs), at.ironwood_tree));
}

// ---------------------------------------------------------------- device wallet (testnet)
// One Ironwood wallet per device: pays escrows (buyer) and receives payouts
// (seller). SECRET spending key, device-local only.
export const wallet = {
  get() { return store.get().wallet || null; },
  async create() {
    const w = JSON.parse(await C('chainNewSpendingKey'));
    store.put((s) => { s.wallet = { sk: w.sk, address: w.address, notes: [] }; });
    return wallet.get();
  },
  /** Imports `lintel-chain wallet` JSON ({"sk": ...}) or a bare hex key. */
  async import(text) {
    let sk = text.trim();
    try { sk = JSON.parse(sk).sk || sk; } catch {}
    if (!/^[0-9a-f]{64}$/.test(sk)) throw new Error('expected a 32-byte hex spending key or lintel-chain wallet JSON');
    const address = await C('chainAddress', sk);
    store.put((s) => { s.wallet = { sk, address, notes: [] }; });
    return wallet.get();
  },
  /** Adds this wallet's notes from a mined transaction (e.g. a faucet payment). */
  async scan(txid) {
    const w = wallet.get(); if (!w) throw new Error('no wallet');
    const tx = await chainTxMined(txid);
    if (!tx) throw new Error('transaction not found or not mined yet');
    const found = JSON.parse(await C('chainFindNotes', JSON.stringify({ kind: 'own', sk: w.sk }), tx.data, tx.height, txid));
    store.put((s) => { for (const n of found) if (!s.wallet.notes.some((x) => x.cmx === n.cmx)) s.wallet.notes.push({ ...n, spent: false }); });
    return found;
  },
  spendable() { return (wallet.get()?.notes || []).filter((n) => !n.spent && n.height > 0); },
  balance() { return wallet.spendable().reduce((a, n) => a + n.value, 0); },
  markSpent(cmx, by) { store.put((s) => { const n = s.wallet.notes.find((x) => x.cmx === cmx); if (n) { n.spent = true; n.spent_by = by; } }); },
};
const ownKey = () => JSON.stringify({ kind: 'own', sk: wallet.get().sk });

// ---------------------------------------------------------------- pay from another wallet
// The escrow cannot be paid by an external wallet directly: the refund is
// pre-signed over the exact escrow note, and the funding also creates the
// buyer's lock coin at vout 0. So each purchase gets its own pay-in wallet
// (Ironwood key + transparent key, SECRET, stored here BEFORE its address is
// shown). Any testnet wallet pays it a ZIP 321 request; NU6.3 wallets pay the
// Orchard-protocol receiver (an Ironwood note), others the P2PKH receiver.
// Once the payment is mined, the funding is built from it exactly as from the
// device wallet. Refund, settlement change and the returned lock coin come
// back to this pay-in wallet; "Withdraw" sweeps it to any address.
const payKey = (p) => JSON.stringify({ kind: 'own', sk: p.sk });
const putPayin = (lid, fn) => store.put((s) => { fn(s.payins[lid]); });
const SCAN_SPAN = 99; // blocks per /chain/compact call (relay max 100)

export const payin = {
  get(lid) { return store.get().payins?.[lid] || null; },
  all() { return store.get().payins || {}; },
  /** Opens (or returns) the pay-in wallet and payment request for a listing. */
  async open(listing) {
    const have = payin.get(listing.id);
    if (have) return have;
    const escrowValue = escrowFor(zats(listing.price_zec));
    const amount = await C('chainPayinAmount', escrowValue);
    const k = JSON.parse(await C('chainPayinNew'));
    const start = await chainHeight();
    const msg = `Lintel escrow ${listing.id}`;
    const entry = { ...k, listing: listing.id, title: listing.title, amount, escrowValue, start, scanned: start - 1,
      uri: await C('chainZip321', k.payment_ua, amount, msg), uri_t: await C('chainZip321', k.taddr, amount, msg),
      notes: [], utxos: [], created: Date.now() };
    // keys hit device storage before the address can be shown or paid
    store.put((s) => { s.payins ??= {}; s.payins[listing.id] = entry; });
    if (!payin.get(listing.id)?.sk) throw new Error('could not store the pay-in wallet on this device');
    return payin.get(listing.id);
  },
  /** Imports a pay-in backup file (keys + request). */
  importBackup(text) {
    const b = JSON.parse(text);
    if (b.kind !== 'lintel-payin-backup' || !/^[0-9a-f]{64}$/.test(b.sk) || !/^[0-9a-f]{64}$/.test(b.tsk) || !b.listing) throw new Error('not a Lintel pay-in backup');
    store.put((s) => { s.payins ??= {}; if (s.payins[b.listing]?.sk && s.payins[b.listing].sk !== b.sk) throw new Error('a different pay-in wallet exists for this listing'); s.payins[b.listing] = { ...b, kind: undefined, notes: [], utxos: [], scanned: b.start - 1 }; });
    return payin.get(b.listing);
  },
  backup(lid) {
    const p = payin.get(lid);
    const { notes, utxos, scanned, ...keep } = p;
    return JSON.stringify({ kind: 'lintel-payin-backup', ...keep }, null, 2);
  },
  /**
   * Re-reads the pay-in wallet from public chain data: mined coins of its
   * t-address (each checked against the raw transaction), and Ironwood notes
   * (compact blocks trial-decrypted here; hits read from the full tx). Notes
   * whose nullifier shows up later are marked spent. Never trusts the relay
   * for a value: it can only hide a payment, not invent one.
   */
  async scan(lid) {
    let p = payin.get(lid);
    const tip = await chainHeight();
    const { utxos: claimed } = await relay('GET', `/chain/utxos/${p.taddr}`);
    const utxos = [];
    for (const u of claimed) {
      const known = p.utxos.find((x) => x.txid === u.txid && x.vout === u.vout);
      if (known) { utxos.push(known); continue; }
      const tx = await chainTxMined(u.txid);
      if (!tx) continue;
      utxos.push(JSON.parse(await C('chainUtxoFromTx', tx.data, tx.height, u.txid, u.vout, p.taddr)));
    }
    putPayin(lid, (x) => { x.utxos = utxos; });
    for (let n = 0; p.scanned < tip && n < 20; n++) {
      const from = p.scanned + 1, to = Math.min(tip, from + SCAN_SPAN - 1);
      const { txs } = await relay('GET', `/chain/compact/${from}/${to}`);
      const nfs = new Set();
      for (const t of txs) {
        for (const a of t.actions) nfs.add(a.nf);
        const hits = JSON.parse(await C('chainScanCompact', p.sk, JSON.stringify(t.actions)));
        if (!hits.length) continue;
        const tx = await chainTxMined(t.txid);
        if (!tx) throw new Error(`could not fetch ${t.txid}`);
        const found = JSON.parse(await C('chainFindNotes', payKey(p), tx.data, tx.height, t.txid));
        for (const f of found) f.nf = await C('chainNoteNullifier', payKey(p), JSON.stringify(f));
        putPayin(lid, (x) => { for (const f of found) if (!x.notes.some((y) => y.cmx === f.cmx)) x.notes.push({ ...f, spent: false }); });
      }
      putPayin(lid, (x) => { for (const n2 of x.notes) if (nfs.has(n2.nf)) n2.spent = true; x.scanned = to; });
      p = payin.get(lid);
    }
    return payin.status(lid, tip);
  },
  spendable(lid) {
    const p = payin.get(lid);
    return { notes: p.notes.filter((n) => !n.spent && !n.spent_by), utxos: p.utxos.filter((u) => !u.spent_by) };
  },
  balance(lid) { const { notes, utxos } = payin.spendable(lid); return notes.reduce((a, n) => a + n.value, 0) + utxos.reduce((a, u) => a + u.value, 0); },
  /** Whether the pay-in wallet can fund the escrow now; `sel` is what the funding will spend. */
  async status(lid, tip) {
    const p = payin.get(lid);
    const { notes, utxos } = payin.spendable(lid);
    const outs = [{ to: p.orchard_ua, value: p.escrowValue }, { to: p.taddr, value: LOCK_VALUE }];
    const have = payin.balance(lid);
    try {
      const sel = JSON.parse(await C('chainPayinSelect', JSON.stringify(notes), JSON.stringify(utxos), JSON.stringify(outs)));
      return { paid: true, have, need: p.amount, sel, tip, scanned: p.scanned };
    } catch (e) {
      return { paid: false, have, need: p.amount, tip, scanned: p.scanned, note: e.message };
    }
  },
  /** Sends everything the pay-in wallet holds (one Ironwood note per transaction, plus all coins) to `dest` (utest1… or tm…). */
  async withdraw(lid, dest) {
    const p = payin.get(lid);
    dest = dest.trim();
    if (!/^(utest1[0-9a-z]+|tm[1-9A-HJ-NP-Za-km-z]{30,40})$/.test(dest)) throw new Error('enter a testnet unified address (utest1…) or t-address (tm…)');
    if (dest === p.taddr || dest === p.orchard_ua || dest === p.payment_ua) throw new Error('that is the pay-in wallet itself');
    const { notes, utxos } = payin.spendable(lid);
    const note = notes.sort((a, b) => b.value - a.value)[0] || null;
    if (!note && !utxos.length) throw new Error('nothing to withdraw (scan first)');
    const total = (note?.value || 0) + utxos.reduce((a, u) => a + u.value, 0);
    const fee = await C('chainPayinFee', note ? 1 : 0, utxos.length, dest.startsWith('tm') ? 0 : 1, dest.startsWith('tm') ? 1 : 0);
    if (total <= fee) throw new Error(`balance ${fmtZec(total)} TAZ does not cover the ${fmtZec(fee)} TAZ fee`);
    const tip = await chainHeight();
    const plan = { note, utxos, outputs: [{ to: dest, value: total - fee }], change_to: null, target_height: tip + 1, expiry_height: tip + 40 };
    const built = JSON.parse(await C('chainPayinBuild', p.sk, p.tsk, JSON.stringify(plan), JSON.stringify(await anchorFor(note, tip))));
    await broadcast(built.raw, built.txid);
    putPayin(lid, (x) => {
      if (note) x.notes.find((n) => n.cmx === note.cmx).spent_by = built.txid;
      for (const u of utxos) x.utxos.find((y) => y.txid === u.txid && y.vout === u.vout).spent_by = built.txid;
      (x.withdrawals ??= []).push({ txid: built.txid, to: dest, value: total - fee });
    });
    return { txid: built.txid, value: total - fee, fee, more: notes.length > 1 };
  },
};

/** Anchor data for a pay-in build: the spent note's block (witness), else the tip. */
async function anchorFor(note, tip) {
  if (note) {
    const h = note.height;
    const [prev, at, block] = await Promise.all([relay('GET', `/chain/tree/${h - 1}`), relay('GET', `/chain/tree/${h}`), relay('GET', `/chain/cmxs/${h}`)]);
    return { prev_tree: prev.ironwood_tree, block_cmxs: block.cmxs, at_tree: at.ironwood_tree };
  }
  return { at_tree: (await relay('GET', `/chain/tree/${tip}`)).ironwood_tree };
}
/** The buyer's own receiving address for this purchase (change and refund). */
const payerAddr = (c) => c.payerAddress || wallet.get().address;

// ---------------------------------------------------------------- buyer
const putBuy = (lid, fn) => store.put((s) => { fn(s.buying[lid].chain); });
const savePayer = async (lid, sid) => { const st = await crypto('payerExport', { key: sid }); putBuy(lid, (c) => { c.payerState = st; }); };

/** Starts an on-chain purchase of a v1 listing. Needs a funded device wallet. */
export async function startBuyer(listing, { fromPayin = false } = {}) {
  const price = zats(listing.price_zec);
  const need = escrowFor(price) + LOCK_VALUE + FUND_FEE;
  let src = null, pay = null;
  if (fromPayin) {
    const st = await payin.scan(listing.id);
    if (!st.paid) throw new Error(`payment not complete: ${st.note}`);
    pay = { sel: st.sel, payerAddress: payin.get(listing.id).orchard_ua };
  } else {
    if (!wallet.get()) throw new Error('create or import a testnet wallet first');
    src = wallet.spendable().filter((n) => n.value >= need).sort((a, b) => a.value - b.value)[0];
    if (!src) throw new Error(`no single wallet note covers ${fmtZec(need)} TAZ (escrow + lock coin + fee); wallet has ${fmtZec(wallet.balance())} TAZ`);
  }
  const tmp = 'p-' + randomHex(8);
  const { payerVk } = await crypto('startPurchase', { key: tmp });
  const { session, buyer_token } = await relay('POST', `/listings/${listing.id}/sessions`, { payer_vk: payerVk, mode: 'chain' });
  await crypto('rebindPayer', { from: tmp, to: session.id });
  // fresh t-address per sale (the lock coin is linkable); the pay-in wallet's own t-key when paying from another wallet
  const p = fromPayin && payin.get(listing.id);
  const tkey = p ? { tsk: p.tsk, address: p.taddr } : JSON.parse(await C('chainNewTransparentKey'));
  store.put((s) => {
    s.buying[listing.id] = { session: session.id, token: buyer_token, mode: 'chain',
      chain: { price, escrowValue: escrowFor(price), src, tkey, contrib: randomHex(32), payerVk,
        ...(p ? { source: 'payin', payinSel: pay.sel, payerAddress: pay.payerAddress } : {}) } };
    if (src) { const n = s.wallet.notes.find((x) => x.cmx === src.cmx); if (n) n.reserved = session.id; }
  });
  await savePayer(listing.id, session.id);
  return session.id;
}

/**
 * Advances the buyer one or more steps. Returns { phase, note, done?, plaintext? }.
 * `verifiedT` is the T returned by verifyOffer for this listing.
 */
export async function advanceBuyer(listing, verifiedT) {
  const lid = listing.id;
  const entry = store.get().buying[lid];
  const c = entry.chain, sid = entry.session, tok = entry.token;
  await crypto('payerImport', { key: sid, state: c.payerState });
  let { session: s } = await relay('GET', `/sessions/${sid}`, undefined, tok);
  const ch = s.chain || {};
  const post = (field, value) => relay('POST', `/sessions/${sid}/chain/${field}`, { value }, tok).then((r) => { s = r.session; });

  // B1: bind to the escrow key, prove knowledge of our share (rogue-key check), publish contribution
  if (!ch.payer_pok) {
    const j = await crypto('payerBindJoint', { key: sid, merchantVk: listing.merchant_vk });
    await savePayer(lid, sid);
    putBuy(lid, (x) => { x.ak = j.ak; });
    const pok = await crypto('payerProveKnowledge', { key: sid, merchantVk: listing.merchant_vk, sessionId: sid });
    if (!ch.payer_contrib) await post('payer_contrib', c.contrib);
    if (!ch.payer_address) await post('payer_address', payerAddr(c));
    await post('payer_pok', pok);
    return { phase: 'joined', note: 'Sent key proof and contribution; waiting for the seller to bind the escrow key' };
  }
  // B2: escrow key from public data; both sides must get the same address
  if (!ch.escrow_address || !ch.merchant_contrib || !ch.merchant_address) return { phase: 'joined', note: 'Waiting for the seller (their app must be open)' };
  let joint = c.joint;
  if (!joint) {
    joint = await C('chainJoint', c.ak, enc.encode(sid), c.contrib, ch.merchant_contrib);
    if (JSON.parse(joint).escrow_address !== ch.escrow_address) throw new Error('seller announced a different escrow address: refusing');
    putBuy(lid, (x) => { x.joint = joint; });
  }
  // B3: build + prove funding (not broadcast), build the time-locked refund, ask the seller to co-sign it
  if (!ch.refund_pczt) {
    const tip = await chainHeight();
    const E = tip + CLAIM_BLOCKS;
    const fundTerms = { kind: 'fund', pay_to: ch.escrow_address, amount: c.escrowValue, change_to: payerAddr(c),
      target_height: tip + 1, expiry_height: tip + 40, t_out: { address: c.tkey.address, value: LOCK_VALUE } };
    let fund;
    if (c.source === 'payin') {
      // straight from what the external wallet paid: escrow note + lock coin at vout 0 (no separate sweep tx)
      const pw = payin.get(lid);
      const plan = { note: c.payinSel.note, utxos: c.payinSel.utxos, change_to: payerAddr(c), target_height: tip + 1, expiry_height: tip + 40,
        outputs: [{ to: ch.escrow_address, value: c.escrowValue }, { to: c.tkey.address, value: LOCK_VALUE }] };
      const built = JSON.parse(await C('chainPayinBuild', pw.sk, pw.tsk, JSON.stringify(plan), JSON.stringify(await anchorFor(plan.note, tip))));
      fund = { raw: built.raw, txid: built.txid };
    } else {
      const srcJson = JSON.stringify(c.src);
      let p = await C('chainBuildSpend', ownKey(), srcJson, JSON.stringify(fundTerms));
      const idx = await C('chainSpendIndex', p, ownKey(), srcJson);
      p = await C('chainSignOwn', p, wallet.get().sk);
      fund = await finalize(p, idx, c.src);
    }
    const escrow = JSON.parse(await C('chainFindNotes', joint, fund.raw, tip + 1, fund.txid))[0];
    if (!escrow || escrow.value !== c.escrowValue) throw new Error('funding transaction does not create the escrow note');
    escrow.height = 0;
    const refundTerms = { kind: 'refund', pay_to: payerAddr(c), amount: await C('chainRefundPayout', c.escrowValue), change_to: null,
      target_height: tip + 1, expiry_height: 0, lock: { txid: fund.txid, vout: 0, value: LOCK_VALUE, address: c.tkey.address, lock_height: E } };
    const rp = await C('chainBuildSpend', joint, JSON.stringify(escrow), JSON.stringify(refundTerms));
    const info = JSON.parse(await C('chainCheckSpend', rp, joint, JSON.stringify(escrow), JSON.stringify(refundTerms)));
    const rA = await crypto('payerNonce', { key: sid });
    await savePayer(lid, sid);
    putBuy(lid, (x) => Object.assign(x, { fund, fundTerms, escrow, refundTerms, refundInfo: info, refundPczt: b64(rp), E, refundRA: rA }));
    await post('refund_terms', JSON.stringify({ terms: refundTerms, settle_expiry: E, escrow_note: escrow }));
    await post('refund_pczt', b64(rp));
    await post('refund_r_a', rA);
    return { phase: 'refund', note: `Funding built and proven on this device (not broadcast). Asked the seller to co-sign the refund (locked until block ${E})` };
  }
  // B4: complete the refund alone, keep it on device, THEN broadcast funding
  if (!c.refundSigned) {
    if (!ch.refund_partial) return { phase: 'refund', note: 'Waiting for the seller to co-sign the refund' };
    const { partial, pok } = JSON.parse(ch.refund_partial);
    const i = c.refundInfo;
    const sig = await crypto('refundSign', { key: sid, merchantVk: listing.merchant_vk, partial, sighash: i.sighash, sessionId: sid, pok, alpha: i.alpha });
    await savePayer(lid, sid);
    let rp = await C('chainApplySignature', unb64(c.refundPczt), i.action_index, sig);
    rp = await C('chainSignLockInput', rp, c.tkey.tsk);
    putBuy(lid, (x) => { x.refundSigned = b64(rp); });
    return { phase: 'refund', note: 'Refund signed and stored on this device' };
  }
  if (!ch.funding_txid) {
    await broadcast(c.fund.raw, c.fund.txid);
    if (c.source === 'payin') {
      putPayin(lid, (x) => {
        const sel = c.payinSel;
        if (sel.note) { const n = x.notes.find((y) => y.cmx === sel.note.cmx); if (n) n.spent_by = c.fund.txid; }
        for (const u of sel.utxos) { const y = x.utxos.find((z) => z.txid === u.txid && z.vout === u.vout); if (y) y.spent_by = c.fund.txid; }
      });
    } else wallet.markSpent(c.src.cmx, c.fund.txid);
    await post('funding_txid', c.fund.txid);
    return { phase: 'funding', note: `Funding broadcast: ${c.fund.txid}` };
  }
  // B5: funding mined -> escrow height; pick up our change
  if (!c.escrow.height) {
    const tx = await chainTxMined(c.fund.txid);
    if (!tx) return { phase: 'funding', note: 'Waiting for the funding transaction to be mined' };
    putBuy(lid, (x) => { x.escrow.height = tx.height; x.fundHeight = tx.height; });
    if (c.source !== 'payin') { // the pay-in wallet picks up its own change when it is scanned
      const mine = JSON.parse(await C('chainFindNotes', ownKey(), tx.data, tx.height, c.fund.txid));
      store.put((st) => { for (const n of mine) if (!st.wallet.notes.some((y) => y.cmx === n.cmx)) st.wallet.notes.push({ ...n, spent: false }); });
    }
    return { phase: 'funded', note: `Escrow funded at block ${tx.height}` };
  }
  const refund = await refundStatus(lid);
  // B6: check the seller's settlement PCZT against OUR terms; send a fresh nonce
  if (!c.settleInfo) {
    if (!ch.settle_pczt || !ch.settle_terms) return { phase: 'funded', note: 'Waiting for the seller to build the settlement', refund };
    const t = JSON.parse(ch.settle_terms);
    const want = { kind: 'settle', pay_to: ch.merchant_address, amount: c.price, change_to: payerAddr(c), expiry_height: c.E };
    for (const [k, v] of Object.entries(want)) if (t[k] !== v) throw new Error(`settlement terms: ${k} is ${t[k]}, agreed ${v}: refusing to sign`);
    const info = JSON.parse(await C('chainCheckSpend', unb64(ch.settle_pczt), joint, JSON.stringify(c.escrow), ch.settle_terms));
    const rA = await crypto('payerNonce', { key: sid });
    await savePayer(lid, sid);
    putBuy(lid, (x) => { x.settleInfo = info; x.settleRA = rA; });
    await post('settle_r_a', rA);
    return { phase: 'settle', note: `Settlement checked on this device (sighash ${info.sighash.slice(0, 12)}…, txid ${info.txid.slice(0, 12)}…)`, refund };
  }
  // B7: pre-sign the real sighash/alpha, locked to T
  if (!c.presig) {
    if (!s.partial) return { phase: 'settle', note: 'Waiting for the seller\'s partial signature', refund };
    const i = c.settleInfo;
    const presig = await crypto('preSign', { key: sid, merchantVk: listing.merchant_vk, partial: s.partial, sighash: i.sighash, sessionId: sid, pok: s.merchant_pok, alpha: i.alpha, verifiedT });
    await savePayer(lid, sid);
    if (JSON.parse(presig).vk_hex !== i.rk) throw new Error('joint key does not match the escrow spend rk');
    putBuy(lid, (x) => { x.presig = presig; x.partial = s.partial; });
    if (!s.presig) await relay('POST', `/sessions/${sid}/presig`, { presig }, tok);
    return { phase: 'presigned', note: 'Pre-signed; the seller can now complete and broadcast the settlement', refund };
  }
  // B8: t comes from the MINED settlement, verified here
  if (!ch.settle_txid) return { phase: 'presigned', note: 'Waiting for the seller to broadcast the settlement', refund };
  if (ch.settle_txid !== c.settleInfo.txid) throw new Error('seller posted a different settlement txid than the one we signed');
  const tx = await chainTxMined(ch.settle_txid);
  if (!tx) return { phase: 'broadcast', note: `Settlement ${ch.settle_txid.slice(0, 12)}… broadcast; waiting for it to be mined`, refund };
  const bytes = await crypto('unlockFromTx', { key: sid, rawTx: tx.data, presig: c.presig, partial: c.partial, offer: await resolveOffer(listing.offer) });
  putBuy(lid, (x) => { x.settledHeight = tx.height; });
  return { phase: 'done', done: true, plaintext: bytes, note: `Settled at block ${tx.height}; t extracted from the mined transaction and verified on this device` };
}

/** When the refund may be broadcast (height > E), and whether it was. */
export async function refundStatus(lid) {
  const c = store.get().buying[lid]?.chain;
  if (!c?.refundSigned || !c.E) return null;
  const tip = await chainHeight().catch(() => 0);
  return { lockHeight: c.E, tip, ready: tip >= c.E, txid: c.refundInfo.txid, broadcast: c.refundBroadcast || null };
}
export async function broadcastRefund(lid) {
  const c = store.get().buying[lid].chain;
  if (!c.escrow.height) throw new Error('escrow not mined; nothing to refund (the funding was never confirmed)');
  const r = await finalize(unb64(c.refundSigned), c.refundInfo.action_index, c.escrow);
  await broadcast(r.raw, r.txid);
  putBuy(lid, (x) => { x.refundBroadcast = r.txid; });
  return r.txid;
}

// ---------------------------------------------------------------- seller
const putSell = (lid, fn) => store.put((s) => { s.selling[lid].chain ??= {}; fn(s.selling[lid].chain); });
const saveMerchant = async (lid) => { const st = await crypto('merchantExport', { key: lid }); store.put((s) => { s.selling[lid].state = st; }); };

/** Advances the seller's side of an on-chain session. Returns a status note. */
export async function advanceSeller(lid, entry, listing, session) {
  const sid = session.id, tok = entry.token;
  const ch = session.chain || {};
  const c = entry.chain || {};
  const post = (field, value) => relay('POST', `/sessions/${sid}/chain/${field}`, { value }, tok);
  const w = wallet.get();
  if (!w) return 'Create a testnet wallet (Wallet panel) to receive on-chain payments';

  // S1: rogue-key check BEFORE anything else, then bind and announce the escrow
  if (!ch.merchant_contrib) {
    if (!ch.payer_pok || !ch.payer_contrib || !ch.payer_address) return 'Buyer joined; waiting for their key proof';
    const j = await crypto('merchantBindJoint', { key: lid, payerVk: session.payer_vk });
    await saveMerchant(lid);
    const ok = await crypto('verifyPayerKnowledge', { key: lid, payerVk: session.payer_vk, pok: ch.payer_pok, sessionId: sid });
    if (!ok) throw new Error('buyer key proof is invalid (possible rogue key): not proceeding');
    const contrib = c.contrib || randomHex(32);
    const joint = await C('chainJoint', j.ak, enc.encode(sid), ch.payer_contrib, contrib);
    putSell(lid, (x) => Object.assign(x, { sid, contrib, joint, ak: j.ak, payout: w.address }));
    await post('merchant_contrib', contrib);
    await post('merchant_address', w.address);
    await post('escrow_address', JSON.parse(joint).escrow_address);
    return 'Escrow key bound (buyer proof checked); escrow address announced';
  }
  const joint = c.joint;
  // S2: co-sign the time-locked refund, before the buyer funds (H_lock >= E)
  if (!ch.refund_partial) {
    if (!ch.refund_terms || !ch.refund_pczt || !ch.refund_r_a) return 'Waiting for the buyer to build the funding and refund';
    const { terms, settle_expiry: E, escrow_note: note } = JSON.parse(ch.refund_terms);
    const price = zats(listing.price_zec);
    const tip = await chainHeight();
    const J = JSON.parse(joint);
    if (note.recipient !== J.escrow_raw) throw new Error('escrow note is not paid to the joint escrow address');
    if (note.value < price + SETTLE_FEE) throw new Error('escrow note is smaller than price + fee');
    if (E < tip + 2 * SAFETY_BLOCKS) throw new Error(`claim window too short (expires at ${E}, tip ${tip})`);
    if (terms.pay_to !== ch.payer_address) throw new Error('refund must go to the buyer\'s announced address');
    await C('chainCheckRefundWindow', JSON.stringify(terms), E);
    const info = JSON.parse(await C('chainCheckSpend', unb64(ch.refund_pczt), joint, JSON.stringify(note), JSON.stringify(terms)));
    const r = await crypto('refundPartial', { key: lid, payerVk: session.payer_vk, rA: ch.refund_r_a, alpha: info.alpha, sighash: info.sighash, sessionId: sid });
    putSell(lid, (x) => Object.assign(x, { E, escrow: note, refundTxid: info.txid }));
    await post('refund_partial', JSON.stringify(r));
    return `Refund co-signed (valid only after block ${E}); waiting for the buyer to fund`;
  }
  // S3: funding mined -> build the settlement (not within SAFETY_BLOCKS of E)
  if (!ch.settle_pczt) {
    if (!ch.funding_txid) return 'Waiting for the buyer to broadcast the funding';
    const tx = await chainTxMined(ch.funding_txid);
    if (!tx) return `Funding ${ch.funding_txid.slice(0, 12)}… seen; waiting for it to be mined`;
    const found = JSON.parse(await C('chainFindNotes', joint, tx.data, tx.height, ch.funding_txid));
    const escrow = found.find((n) => n.cmx === c.escrow.cmx);
    if (!escrow) throw new Error('mined funding does not contain the agreed escrow note');
    const tip = await chainHeight();
    if (tip + SAFETY_BLOCKS >= c.E) throw new Error(`too close to the end of the claim window (tip ${tip}, expiry ${c.E}): not settling; the buyer can refund after ${c.E}`);
    const terms = { kind: 'settle', pay_to: c.payout, amount: zats(listing.price_zec), change_to: ch.payer_address,
      target_height: tip + 1, expiry_height: c.E };
    const p = await C('chainBuildSpend', joint, JSON.stringify(escrow), JSON.stringify(terms));
    const info = JSON.parse(await C('chainCheckSpend', p, joint, JSON.stringify(escrow), JSON.stringify(terms)));
    putSell(lid, (x) => Object.assign(x, { escrow, settleTerms: terms, settlePczt: b64(p), settleInfo: info }));
    await post('settle_terms', JSON.stringify(terms));
    await post('settle_pczt', b64(p));
    return `Settlement built (pays ${fmtZec(terms.amount)} TAZ to this device's wallet, expires at ${c.E})`;
  }
  // S4: partial signature over OUR OWN check's sighash/alpha
  const info = c.settleInfo;
  if (!session.partial) {
    if (!ch.settle_r_a) return 'Waiting for the buyer to check the settlement';
    const r = await crypto('respond', { key: lid, payerVk: session.payer_vk, rA: ch.settle_r_a, alpha: info.alpha, sighash: info.sighash, sessionId: sid });
    await relay('POST', `/sessions/${sid}/partial`, { partial: r.partial, merchant_pok: r.pok }, tok);
    return 'Partial signature sent; waiting for the buyer\'s pre-signature';
  }
  // S5: complete, prove, broadcast. Broadcasting reveals t (that is the sale).
  if (!ch.settle_txid) {
    if (!session.presig) return 'Waiting for the buyer\'s pre-signature';
    const tip = await chainHeight();
    if (tip + 1 > c.E) throw new Error('claim window closed: the settlement can no longer be mined');
    const sig = await crypto('complete', { key: lid, presig: session.presig, rA: ch.settle_r_a, partial: session.partial, payerVk: session.payer_vk, alpha: info.alpha });
    const p = await C('chainApplySignature', unb64(c.settlePczt), info.action_index, sig);
    const r = await finalize(p, info.action_index, c.escrow);
    if (r.txid !== info.txid) throw new Error('settlement txid changed');
    await broadcast(r.raw, r.txid);
    putSell(lid, (x) => { x.settleTxid = r.txid; });
    await post('settle_txid', r.txid);
    return `Settlement broadcast: ${r.txid}`;
  }
  const tx = await chainTxMined(ch.settle_txid);
  if (!tx) return `Settlement ${ch.settle_txid.slice(0, 12)}… broadcast; waiting for it to be mined`;
  if (!c.paidNote) {
    const mine = JSON.parse(await C('chainFindNotes', ownKey(), tx.data, tx.height, ch.settle_txid));
    store.put((st) => { for (const n of mine) if (!st.wallet.notes.some((y) => y.cmx === n.cmx)) st.wallet.notes.push({ ...n, spent: false }); });
    putSell(lid, (x) => { x.paidNote = mine.reduce((a, n) => a + n.value, 0); });
  }
  return `Sold on chain at block ${tx.height}`;
}
