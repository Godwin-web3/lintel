// Buying: verify the offer, then either
//   * mode 'chain' (default): fund a two-party escrow on Zcash testnet, keep a
//     co-signed time-locked refund, pre-sign the settlement locked to T, and
//     read t from the MINED settlement transaction; or
//   * mode 'relay': an off-chain rehearsal of the same adaptor-signature
//     exchange through the relay (no funds move; for tests and demos).
//
// Same steps as the app (web/app/src/onchain.js advanceBuyer). Every step is
// idempotent and resumable: step() reads the relay session plus local state
// and does the next thing, so a crashed process continues where it stopped.

import { CLAIM_BLOCKS, escrowFor, fmtZec, LOCK_VALUE, walletNeedFor, zats } from './amounts.js';
import { bytesToHex, hexToBytes, randomAlpha, randomHex, sessionBytes } from './engine.js';
import type { BuyingEntry } from './store.js';
import type { Listing, NoteRecord, Session } from './types.js';
import { PayIn, type Ctx, type PaymentRequest, Wallet } from './wallet.js';

export type BuyPhase =
  | 'awaiting_payment' // pay-in: waiting for the external wallet's payment to be mined
  | 'joined' // session open, key proof sent; waiting for the seller
  | 'refund' // funding built (not broadcast); refund being co-signed
  | 'funding' // funding broadcast, waiting to be mined
  | 'funded' // escrow mined; waiting for the seller's settlement
  | 'settle' // settlement checked; waiting for the seller's partial signature
  | 'presigned' // pre-signed locked to T; waiting for the seller to broadcast
  | 'broadcast' // settlement broadcast; waiting to be mined
  | 'done'; // t extracted, plaintext decrypted

export interface RefundStatus { lockHeight: number; tip: number; ready: boolean; txid: string; broadcast: string | null }

export interface BuyStep {
  phase: BuyPhase;
  note: string;
  done?: boolean;
  /** Decrypted content, once done. */
  plaintext?: Uint8Array;
  /** Pay-in request, while awaiting payment. */
  payment?: PaymentRequest;
  refund?: RefundStatus | null;
  txids: { funding?: string; settlement?: string; refund?: string };
}

export interface BuyOptions {
  /** 'chain' (Zcash testnet escrow, default) or 'relay' (off-chain rehearsal, no funds move). */
  mode?: 'chain' | 'relay';
  /** Chain mode: fund from the in-app 'wallet' (default) or a 'payin' wallet any testnet wallet pays (ZIP 321). */
  funding?: 'wallet' | 'payin';
  /**
   * Called before any funds are committed: once before the funding
   * transaction is built, and again right before it is broadcast. Throw to
   * stop the purchase (then cancel() it; nothing has moved). The seller's
   * payout address is known at both points, so this is where spending
   * policies (allowed sellers, caps) belong.
   */
  approve?: (info: ApproveInfo) => void | Promise<void>;
}

export interface ApproveInfo {
  stage: 'build' | 'broadcast';
  listingId: string;
  priceZats: number;
  /** What leaves the funding source at broadcast: escrow + lock coin + funding fee (zats). */
  outlayZats: number;
  /** Address the settlement must pay (announced by the seller; the buyer refuses any other). */
  sellerAddress: string;
  escrowAddress: string;
  funding: 'wallet' | 'payin';
}

const b64 = (u8: Uint8Array): string => { let s = ''; for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode(...u8.subarray(i, i + 0x8000)); return btoa(s); };
const unb64 = (s: string): Uint8Array => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
export { b64, unb64 };

/** Witness from public data, proof, full verification (all in this process). */
export async function finalizeSpend(ctx: Ctx, pczt: Uint8Array, actionIndex: number, note: NoteRecord): Promise<{ raw: string; txid: string }> {
  if (!note.height) throw new Error('note is not mined yet');
  const h = note.height;
  const [prev, at, block] = await Promise.all([ctx.relay.tree(h - 1), ctx.relay.tree(h), ctx.relay.cmxs(h)]);
  const C = await ctx.engine.chain();
  return JSON.parse(C.chainFinalize(pczt, actionIndex, note.cmx, prev.ironwood_tree, JSON.stringify(block.cmxs), at.ironwood_tree));
}

export class Purchase {
  readonly listingId: string;
  private readonly wallet: Wallet;
  private readonly payin: PayIn;

  constructor(private readonly ctx: Ctx, listingId: string, private readonly opts: BuyOptions = {}) {
    this.listingId = listingId;
    this.wallet = new Wallet(ctx);
    this.payin = new PayIn(ctx);
  }

  private async entry(): Promise<BuyingEntry | undefined> { return (await this.ctx.box.get()).buying[this.listingId]; }
  private putBuy(fn: (c: Record<string, any>) => void) { return this.ctx.box.put((s) => { fn(s.buying[this.listingId].chain!); }); }
  private async savePayer(state: string) { await this.ctx.box.put((s) => { const e = s.buying[this.listingId]; (e.chain ?? e.relay!).payerState = state; }); }

  /** Session id once the purchase has joined the listing. */
  async sessionId(): Promise<string | null> { return (await this.entry())?.session ?? null; }
  /** Pay-in request (funding 'payin'), opening the pay-in wallet if needed. */
  async paymentRequest(): Promise<PaymentRequest> {
    const { listing } = await this.ctx.relay.listing(this.listingId);
    return this.payin.open(listing);
  }

  private async listing(): Promise<Listing> {
    const { listing } = await this.ctx.relay.listing(this.listingId);
    if ((listing as any).version === 2) throw new Error('presale listings are not supported by Purchase yet');
    return listing as Listing;
  }

  /** Verifies the listing's proof and pins T (done automatically by the first step()). */
  async verify(listing?: Listing): Promise<string> {
    const e = await this.entry();
    if (e?.verifiedT) return e.verifiedT;
    listing ??= await this.listing();
    const offer = await this.ctx.relay.resolveOffer(listing.offer!);
    return this.ctx.engine.verifyOffer(offer, listing.content_hash);
  }

  /** Advances the purchase by one or more steps. Call until `done`. */
  async step(): Promise<BuyStep> {
    const listing = await this.listing();
    let e = await this.entry();
    if (!e) {
      const verifiedT = await this.verify(listing);
      const mode = this.opts.mode ?? 'chain';
      if (mode === 'relay') return this.startRelay(listing, verifiedT);
      const started = await this.startChain(listing, verifiedT);
      if (started) return started;
      e = await this.entry();
    }
    if (e!.plaintextHex) return { phase: 'done', done: true, note: 'Already unlocked', plaintext: hexToBytes(e!.plaintextHex), txids: await this.txids() };
    return e!.mode === 'relay' ? this.advanceRelay(listing) : this.advanceChain(listing);
  }

  /**
   * Steps until done (or `signal` aborts), sleeping `intervalMs` between steps
   * that made no progress. Returns the plaintext.
   */
  async complete(opts: { intervalMs?: number; onStep?: (s: BuyStep) => void; signal?: AbortSignal; timeoutMs?: number } = {}): Promise<Uint8Array> {
    for await (const s of this.watch(opts)) if (s.done) return s.plaintext!;
    throw new Error('purchase stopped before completing');
  }

  /** Async iterator of steps until done. */
  async *watch(opts: { intervalMs?: number; onStep?: (s: BuyStep) => void; signal?: AbortSignal; timeoutMs?: number } = {}): AsyncGenerator<BuyStep> {
    const interval = opts.intervalMs ?? 5000;
    const deadline = opts.timeoutMs ? Date.now() + opts.timeoutMs : Infinity;
    let last = '';
    for (;;) {
      if (opts.signal?.aborted) return;
      if (Date.now() > deadline) throw new Error('timed out waiting for the purchase');
      const s = await this.step();
      opts.onStep?.(s);
      yield s;
      if (s.done) return;
      if (s.note === last) await sleep(interval, opts.signal);
      last = s.note;
    }
  }

  // ---------------------------------------------------------------- off-chain rehearsal
  private async startRelay(listing: Listing, verifiedT: string): Promise<BuyStep> {
    const { state, payerVk } = await this.ctx.engine.newPayer();
    const { result: rA, state: st } = await this.ctx.engine.withPayer(state, (p) => p.nonce());
    const sighash = randomHex(32), alpha = randomAlpha();
    const { session, buyer_token } = await this.ctx.relay.createSession(listing.id, { payer_vk: payerVk, r_a: rA, alpha, sighash });
    await this.ctx.box.put((s) => { s.buying[listing.id] = { session: session.id, token: buyer_token, mode: 'relay', verifiedT, relay: { payerState: st, sighash, alpha } }; });
    return { phase: 'joined', note: 'Joined the sale (off-chain rehearsal); waiting for the seller\'s partial signature', txids: {} };
  }

  private async advanceRelay(listing: Listing): Promise<BuyStep> {
    const e = (await this.entry())!;
    const r = e.relay!;
    const s = await this.ctx.relay.session(e.session, e.token);
    if (!r.presig) {
      if (!s.partial) return { phase: 'joined', note: 'Waiting for the seller\'s partial signature', txids: {} };
      const { result: presig, state } = await this.ctx.engine.withPayer(r.payerState, (p) =>
        p.preSign(listing.merchant_vk, s.partial!, hexToBytes(r.sighash), sessionBytes(s.id), s.merchant_pok!, r.alpha, e.verifiedT!));
      await this.ctx.box.put((x) => { Object.assign(x.buying[listing.id].relay!, { presig, partial: s.partial, payerState: state }); });
      if (!s.presig) await this.ctx.relay.postPresig(s.id, presig, e.token);
      return { phase: 'presigned', note: 'Pre-signed, locked to T; waiting for the seller to complete', txids: {} };
    }
    if (!s.signature) return { phase: 'presigned', note: 'Waiting for the seller to complete the signature', txids: {} };
    const offer = await this.ctx.relay.resolveOffer(listing.offer!);
    const bytes = await this.ctx.engine.unlock(r.payerState, { signature: s.signature, presig: r.presig, partial: r.partial, offer });
    await this.ctx.box.put((x) => { x.buying[listing.id].plaintextHex = bytesToHex(bytes); });
    return { phase: 'done', done: true, plaintext: bytes, note: 't extracted from the completed signature and verified here; content decrypted', txids: {} };
  }

  // ---------------------------------------------------------------- on-chain (Zcash testnet)
  /** Joins the listing. Returns a step when it cannot start yet (pay-in not paid). */
  private async startChain(listing: Listing, verifiedT: string): Promise<BuyStep | null> {
    const C = await this.ctx.engine.chain();
    const price = zats(listing.price_zec);
    const fromPayin = this.opts.funding === 'payin';
    let src: NoteRecord | null = null, pay: { sel: any; payerAddress: string } | null = null;
    if (fromPayin) {
      const payment = await this.payin.open(listing);
      const st = await this.payin.scan(listing.id);
      if (!st.paid) return { phase: 'awaiting_payment', note: `Waiting for ${fmtZec(payment.amount)} TAZ to the pay-in address (have ${fmtZec(st.have)}; scanned to block ${st.scanned})`, payment, txids: {} };
      pay = { sel: st.sel, payerAddress: (await this.payin.get(listing.id))!.orchard_ua };
    } else {
      if (!(await this.wallet.address())) throw new Error('create or import a testnet wallet first (lintel.wallet), or buy with { funding: "payin" }');
      const need = walletNeedFor(price);
      src = (await this.wallet.spendable()).filter((n) => n.value >= need).sort((a, b) => a.value - b.value)[0] || null;
      if (!src) throw new Error(`no single wallet note covers ${fmtZec(need)} TAZ (escrow + lock coin + fee); wallet has ${fmtZec(await this.wallet.balance())} TAZ`);
    }
    const { state, payerVk } = await this.ctx.engine.newPayer();
    const { session, buyer_token } = await this.ctx.relay.createSession(listing.id, { payer_vk: payerVk, mode: 'chain' });
    const p = fromPayin ? await this.payin.get(listing.id) : null;
    const tkey = p ? { tsk: p.tsk, address: p.taddr } : JSON.parse(C.chainNewTransparentKey());
    await this.ctx.box.put((s) => {
      s.buying[listing.id] = { session: session.id, token: buyer_token, mode: 'chain', verifiedT,
        chain: { price, escrowValue: escrowFor(price), src, tkey, contrib: randomHex(32), payerVk, payerState: state,
          ...(p ? { source: 'payin', payinSel: pay!.sel, payerAddress: pay!.payerAddress } : {}) } };
      if (src) { const n = s.wallet!.notes.find((x) => x.cmx === src!.cmx); if (n) n.reserved = session.id; }
    });
    return null;
  }

  private async advanceChain(listing: Listing): Promise<BuyStep> {
    const { relay, engine } = this.ctx;
    const C = await engine.chain();
    const lid = listing.id;
    const entry = (await this.entry())!;
    const c = entry.chain!, sid = entry.session, tok = entry.token;
    let s: Session = await relay.session(sid, tok);
    const ch = s.chain || {};
    const post = async (field: any, value: string) => { s = await relay.postChain(sid, field, value, tok); };
    const ownKey = async () => JSON.stringify({ kind: 'own', sk: await this.wallet.exportKey() });
    const payerAddr = async () => c.payerAddress || (await this.wallet.address());
    const txids = () => ({ funding: ch.funding_txid || c.fund?.txid, settlement: ch.settle_txid, refund: c.refundInfo?.txid });
    const step = (phase: BuyPhase, note: string, extra: Partial<BuyStep> = {}): BuyStep => ({ phase, note, txids: txids(), ...extra });

    // B1: bind to the escrow key, prove knowledge of our share (rogue-key check), publish contribution
    if (!ch.payer_pok) {
      const { result: j, state } = await engine.withPayer(c.payerState, (p) => JSON.parse(p.bindJoint(listing.merchant_vk)));
      await this.savePayer(state);
      await this.putBuy((x) => { x.ak = j.ak; });
      const { result: pok, state: st2 } = await engine.withPayer(state, (p) => p.proveKnowledge(listing.merchant_vk, sessionBytes(sid)));
      await this.savePayer(st2);
      if (!ch.payer_contrib) await post('payer_contrib', c.contrib);
      if (!ch.payer_address) await post('payer_address', await payerAddr());
      await post('payer_pok', pok);
      return step('joined', 'Sent key proof and contribution; waiting for the seller to bind the escrow key');
    }
    // B2: escrow key from public data; both sides must derive the same address
    if (!ch.escrow_address || !ch.merchant_contrib || !ch.merchant_address) return step('joined', 'Waiting for the seller (their app, SDK or lintel-agent must be running)');
    let joint = c.joint;
    if (!joint) {
      joint = C.chainJoint(c.ak, sessionBytes(sid), c.contrib, ch.merchant_contrib);
      if (JSON.parse(joint).escrow_address !== ch.escrow_address) throw new Error('seller announced a different escrow address: refusing');
      await this.putBuy((x) => { x.joint = joint; });
    }
    const approve = (stage: 'build' | 'broadcast') => this.opts.approve?.({ stage, listingId: lid, priceZats: c.price,
      outlayZats: walletNeedFor(c.price),
      sellerAddress: ch.merchant_address!, escrowAddress: ch.escrow_address!, funding: c.source === 'payin' ? 'payin' : 'wallet' });
    // B3: build + prove funding (not broadcast), build the time-locked refund, ask the seller to co-sign it
    if (!ch.refund_pczt) {
      await approve('build');
      const tip = await relay.height();
      const E = tip + CLAIM_BLOCKS;
      const addr = await payerAddr();
      const fundTerms = { kind: 'fund', pay_to: ch.escrow_address, amount: c.escrowValue, change_to: addr,
        target_height: tip + 1, expiry_height: tip + 40, t_out: { address: c.tkey.address, value: LOCK_VALUE } };
      let fund: { raw: string; txid: string };
      if (c.source === 'payin') {
        const pw = (await this.payin.get(lid))!;
        const plan = { note: c.payinSel.note, utxos: c.payinSel.utxos, change_to: addr, target_height: tip + 1, expiry_height: tip + 40,
          outputs: [{ to: ch.escrow_address, value: c.escrowValue }, { to: c.tkey.address, value: LOCK_VALUE }] };
        const built = JSON.parse(C.chainPayinBuild(pw.sk, pw.tsk, JSON.stringify(plan), JSON.stringify(await this.payin.anchorFor(plan.note, tip))));
        fund = { raw: built.raw, txid: built.txid };
      } else {
        const srcJson = JSON.stringify(c.src);
        const key = await ownKey();
        let p = C.chainBuildSpend(key, srcJson, JSON.stringify(fundTerms));
        const idx = C.chainSpendIndex(p, key, srcJson);
        p = C.chainSignOwn(p, (await this.wallet.exportKey())!);
        fund = await finalizeSpend(this.ctx, p, idx, c.src);
      }
      const escrow = JSON.parse(C.chainFindNotes(joint, fund.raw, tip + 1, fund.txid))[0];
      if (!escrow || escrow.value !== c.escrowValue) throw new Error('funding transaction does not create the escrow note');
      escrow.height = 0;
      const refundTerms = { kind: 'refund', pay_to: addr, amount: C.chainRefundPayout(c.escrowValue), change_to: null,
        target_height: tip + 1, expiry_height: 0, lock: { txid: fund.txid, vout: 0, value: LOCK_VALUE, address: c.tkey.address, lock_height: E } };
      const rp = C.chainBuildSpend(joint, JSON.stringify(escrow), JSON.stringify(refundTerms));
      const info = JSON.parse(C.chainCheckSpend(rp, joint, JSON.stringify(escrow), JSON.stringify(refundTerms)));
      const { result: rA, state } = await engine.withPayer(c.payerState, (p) => p.nonce());
      await this.savePayer(state);
      await this.putBuy((x) => Object.assign(x, { fund, fundTerms, escrow, refundTerms, refundInfo: info, refundPczt: b64(rp), E, refundRA: rA }));
      await post('refund_terms', JSON.stringify({ terms: refundTerms, settle_expiry: E, escrow_note: escrow }));
      await post('refund_pczt', b64(rp));
      await post('refund_r_a', rA);
      return step('refund', `Funding built and proven here (not broadcast). Asked the seller to co-sign the refund (locked until block ${E})`);
    }
    // B4: complete the refund alone, keep it locally, THEN broadcast funding
    if (!c.refundSigned) {
      if (!ch.refund_partial) return step('refund', 'Waiting for the seller to co-sign the refund');
      const { partial, pok } = JSON.parse(ch.refund_partial);
      const i = c.refundInfo;
      const fresh = (await this.entry())!.chain!;
      const { result: sig, state } = await engine.withPayer(fresh.payerState, (p) => p.refundSign(listing.merchant_vk, partial, hexToBytes(i.sighash), sessionBytes(sid), pok, i.alpha));
      await this.savePayer(state);
      let rp = C.chainApplySignature(unb64(c.refundPczt), i.action_index, sig);
      rp = C.chainSignLockInput(rp, c.tkey.tsk);
      await this.putBuy((x) => { x.refundSigned = b64(rp); });
      return step('refund', 'Refund signed and stored locally');
    }
    if (!ch.funding_txid) {
      await approve('broadcast');
      await relay.broadcast(c.fund.raw, c.fund.txid);
      if (c.source === 'payin') {
        await this.ctx.box.put((st) => {
          const x = st.payins![lid], sel = c.payinSel;
          if (sel.note) { const n = x.notes.find((y) => y.cmx === sel.note.cmx); if (n) n.spent_by = c.fund.txid; }
          for (const u of sel.utxos) { const y = x.utxos.find((z) => z.txid === u.txid && z.vout === u.vout); if (y) y.spent_by = c.fund.txid; }
        });
      } else await this.wallet.markSpent(c.src.cmx, c.fund.txid);
      await post('funding_txid', c.fund.txid);
      return step('funding', `Funding broadcast: ${c.fund.txid}`);
    }
    // B5: funding mined -> escrow height; pick up our change
    if (!c.escrow.height) {
      const tx = await relay.minedTx(c.fund.txid);
      if (!tx) return step('funding', 'Waiting for the funding transaction to be mined');
      await this.putBuy((x) => { x.escrow.height = tx.height; x.fundHeight = tx.height; });
      if (c.source !== 'payin') await this.wallet.addNotes(JSON.parse(C.chainFindNotes(await ownKey(), tx.data, tx.height, c.fund.txid)));
      return step('funded', `Escrow funded at block ${tx.height}`);
    }
    const refund = await this.refundStatus();
    // B6: check the seller's settlement PCZT against OUR terms; send a fresh nonce
    if (!c.settleInfo) {
      if (!ch.settle_pczt || !ch.settle_terms) return step('funded', 'Waiting for the seller to build the settlement', { refund });
      const t = JSON.parse(ch.settle_terms);
      const want: Record<string, unknown> = { kind: 'settle', pay_to: ch.merchant_address, amount: c.price, change_to: await payerAddr(), expiry_height: c.E };
      for (const [k, v] of Object.entries(want)) if (t[k] !== v) throw new Error(`settlement terms: ${k} is ${t[k]}, agreed ${v}: refusing to sign`);
      const info = JSON.parse(C.chainCheckSpend(unb64(ch.settle_pczt), joint, JSON.stringify(c.escrow), ch.settle_terms));
      const { result: rA, state } = await engine.withPayer(c.payerState, (p) => p.nonce());
      await this.savePayer(state);
      await this.putBuy((x) => { x.settleInfo = info; x.settleRA = rA; });
      await post('settle_r_a', rA);
      return step('settle', `Settlement checked here (txid ${info.txid.slice(0, 12)}…)`, { refund });
    }
    // B7: pre-sign the real sighash/alpha, locked to T
    if (!c.presig) {
      if (!s.partial) return step('settle', 'Waiting for the seller\'s partial signature', { refund });
      const i = c.settleInfo;
      const { result: presig, state } = await engine.withPayer(c.payerState, (p) => p.preSign(listing.merchant_vk, s.partial!, hexToBytes(i.sighash), sessionBytes(sid), s.merchant_pok!, i.alpha, entry.verifiedT!));
      await this.savePayer(state);
      if (JSON.parse(presig).vk_hex !== i.rk) throw new Error('joint key does not match the escrow spend rk');
      await this.putBuy((x) => { x.presig = presig; x.partial = s.partial; });
      if (!s.presig) await relay.postPresig(sid, presig, tok);
      return step('presigned', 'Pre-signed; the seller can now complete and broadcast the settlement', { refund });
    }
    // B8: t comes from the MINED settlement, verified here
    if (!ch.settle_txid) return step('presigned', 'Waiting for the seller to broadcast the settlement', { refund });
    if (ch.settle_txid !== c.settleInfo.txid) throw new Error('seller posted a different settlement txid than the one we signed');
    const tx = await relay.minedTx(ch.settle_txid);
    if (!tx) return step('broadcast', `Settlement ${ch.settle_txid.slice(0, 12)}… broadcast; waiting for it to be mined`, { refund });
    const offer = await relay.resolveOffer(listing.offer!);
    const bytes = await engine.unlockFromTx(c.payerState, { rawTx: tx.data, presig: c.presig, partial: c.partial, offer });
    await this.ctx.box.put((x) => { const b = x.buying[lid]; b.plaintextHex = bytesToHex(bytes); b.chain!.settledHeight = tx.height; });
    return step('done', `Settled at block ${tx.height}; t extracted from the mined transaction and verified here`, { done: true, plaintext: bytes });
  }

  /** Funding / settlement / refund txids known so far. */
  async txids(): Promise<{ funding?: string; settlement?: string; refund?: string }> {
    const e = await this.entry();
    if (!e || e.mode !== 'chain') return {};
    const s = await this.ctx.relay.session(e.session, e.token).catch(() => null);
    return { funding: s?.chain?.funding_txid || e.chain?.fund?.txid, settlement: s?.chain?.settle_txid, refund: e.chain?.refundInfo?.txid };
  }

  /** When the refund may be broadcast (tip ≥ lock height E), and whether it was. */
  async refundStatus(): Promise<RefundStatus | null> {
    const c = (await this.entry())?.chain;
    if (!c?.refundSigned || !c.E) return null;
    const tip = await this.ctx.relay.height().catch(() => 0);
    return { lockHeight: c.E, tip, ready: tip >= c.E, txid: c.refundInfo.txid, broadcast: c.refundBroadcast || null };
  }

  /**
   * Broadcasts the co-signed refund. Valid only after the lock height (the
   * node enforces nLockTime) and only if the seller never settled (the
   * settlement and refund spend the same escrow note).
   */
  async refund(): Promise<string> {
    const c = (await this.entry())?.chain;
    if (!c?.refundSigned) throw new Error('no signed refund for this purchase');
    if (!c.escrow?.height) throw new Error('escrow not mined; nothing to refund (the funding was never confirmed)');
    const st = await this.refundStatus();
    if (st && !st.ready) throw new Error(`refund is time-locked until block ${st.lockHeight} (tip ${st.tip})`);
    const r = await finalizeSpend(this.ctx, unb64(c.refundSigned), c.refundInfo.action_index, c.escrow);
    await this.ctx.relay.broadcast(r.raw, r.txid);
    await this.putBuy((x) => { x.refundBroadcast = r.txid; });
    return r.txid;
  }

  /** Abandons a purchase that has not broadcast its funding (releases the reserved wallet note). */
  async cancel(): Promise<void> {
    const e = await this.entry();
    if (!e) return;
    const s = await this.ctx.relay.session(e.session, e.token).catch(() => null);
    if (s?.chain?.funding_txid) throw new Error('funding was broadcast: wait for the settlement or use refund()');
    await this.ctx.box.put((x) => {
      for (const n of x.wallet?.notes || []) if (n.reserved === e.session) delete n.reserved;
      delete x.buying[this.listingId];
    });
  }
}

export const sleep = (ms: number, signal?: AbortSignal) => new Promise<void>((r) => {
  const t = setTimeout(r, ms);
  signal?.addEventListener('abort', () => { clearTimeout(t); r(); }, { once: true });
});
