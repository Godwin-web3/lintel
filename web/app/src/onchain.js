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
import { crypto, relay, store, randomHex } from './api.js';

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

// ---------------------------------------------------------------- buyer
const putBuy = (lid, fn) => store.put((s) => { fn(s.buying[lid].chain); });
const savePayer = async (lid, sid) => { const st = await crypto('payerExport', { key: sid }); putBuy(lid, (c) => { c.payerState = st; }); };

/** Starts an on-chain purchase of a v1 listing. Needs a funded device wallet. */
export async function startBuyer(listing) {
  const w = wallet.get(); if (!w) throw new Error('create or import a testnet wallet first');
  const price = zats(listing.price_zec);
  const need = escrowFor(price) + LOCK_VALUE + FUND_FEE;
  const src = wallet.spendable().filter((n) => n.value >= need).sort((a, b) => a.value - b.value)[0];
  if (!src) throw new Error(`no single wallet note covers ${fmtZec(need)} TAZ (escrow + lock coin + fee); wallet has ${fmtZec(wallet.balance())} TAZ`);
  const tmp = 'p-' + randomHex(8);
  const { payerVk } = await crypto('startPurchase', { key: tmp });
  const { session, buyer_token } = await relay('POST', `/listings/${listing.id}/sessions`, { payer_vk: payerVk, mode: 'chain' });
  await crypto('rebindPayer', { from: tmp, to: session.id });
  const tkey = JSON.parse(await C('chainNewTransparentKey')); // fresh t-address per sale (the lock coin is linkable)
  store.put((s) => {
    s.buying[listing.id] = { session: session.id, token: buyer_token, mode: 'chain',
      chain: { price, escrowValue: escrowFor(price), src, tkey, contrib: randomHex(32), payerVk } };
    const n = s.wallet.notes.find((x) => x.cmx === src.cmx); if (n) n.reserved = session.id;
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
  let { session: s } = await relay('GET', `/sessions/${sid}`);
  const ch = s.chain || {};
  const post = (field, value) => relay('POST', `/sessions/${sid}/chain/${field}`, { value }, tok).then((r) => { s = r.session; });

  // B1: bind to the escrow key, prove knowledge of our share (rogue-key check), publish contribution
  if (!ch.payer_pok) {
    const j = await crypto('payerBindJoint', { key: sid, merchantVk: listing.merchant_vk });
    await savePayer(lid, sid);
    putBuy(lid, (x) => { x.ak = j.ak; });
    const pok = await crypto('payerProveKnowledge', { key: sid, merchantVk: listing.merchant_vk, sessionId: sid });
    if (!ch.payer_contrib) await post('payer_contrib', c.contrib);
    if (!ch.payer_address) await post('payer_address', wallet.get().address);
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
    const fundTerms = { kind: 'fund', pay_to: ch.escrow_address, amount: c.escrowValue, change_to: wallet.get().address,
      target_height: tip + 1, expiry_height: tip + 40, t_out: { address: c.tkey.address, value: LOCK_VALUE } };
    const srcJson = JSON.stringify(c.src);
    let p = await C('chainBuildSpend', ownKey(), srcJson, JSON.stringify(fundTerms));
    const idx = await C('chainSpendIndex', p, ownKey(), srcJson);
    p = await C('chainSignOwn', p, wallet.get().sk);
    const fund = await finalize(p, idx, c.src);
    const escrow = JSON.parse(await C('chainFindNotes', joint, fund.raw, tip + 1, fund.txid))[0];
    if (!escrow || escrow.value !== c.escrowValue) throw new Error('funding transaction does not create the escrow note');
    escrow.height = 0;
    const refundTerms = { kind: 'refund', pay_to: wallet.get().address, amount: await C('chainRefundPayout', c.escrowValue), change_to: null,
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
    wallet.markSpent(c.src.cmx, c.fund.txid);
    await post('funding_txid', c.fund.txid);
    return { phase: 'funding', note: `Funding broadcast: ${c.fund.txid}` };
  }
  // B5: funding mined -> escrow height; pick up our change
  if (!c.escrow.height) {
    const tx = await chainTxMined(c.fund.txid);
    if (!tx) return { phase: 'funding', note: 'Waiting for the funding transaction to be mined' };
    putBuy(lid, (x) => { x.escrow.height = tx.height; x.fundHeight = tx.height; });
    const mine = JSON.parse(await C('chainFindNotes', ownKey(), tx.data, tx.height, c.fund.txid));
    store.put((st) => { for (const n of mine) if (!st.wallet.notes.some((y) => y.cmx === n.cmx)) st.wallet.notes.push({ ...n, spent: false }); });
    return { phase: 'funded', note: `Escrow funded at block ${tx.height}` };
  }
  const refund = await refundStatus(lid);
  // B6: check the seller's settlement PCZT against OUR terms; send a fresh nonce
  if (!c.settleInfo) {
    if (!ch.settle_pczt || !ch.settle_terms) return { phase: 'funded', note: 'Waiting for the seller to build the settlement', refund };
    const t = JSON.parse(ch.settle_terms);
    const want = { kind: 'settle', pay_to: ch.merchant_address, amount: c.price, change_to: wallet.get().address, expiry_height: c.E };
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
  const bytes = await crypto('unlockFromTx', { key: sid, rawTx: tx.data, presig: c.presig, partial: c.partial, offer: listing.offer });
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
