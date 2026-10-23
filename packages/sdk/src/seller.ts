// Selling: seal a file under a fresh adaptor secret, publish the offer and
// proof, then answer the buyer:
//   * on-chain sessions: bind the escrow key (after checking the buyer's key
//     proof), co-sign the time-locked refund, build the settlement once the
//     escrow is mined, and broadcast it with the completed adaptor signature
//     (which is what reveals t to the buyer and pays the seller);
//   * off-chain rehearsal sessions: partial signature, then completion.
//
// Same steps as the app (web/app/src/onchain.js advanceSeller) and
// lintel-agent, which can take over a sale via handoff().

import { fmtZec, isPrice, SAFETY_BLOCKS, SETTLE_FEE, zats } from './amounts.js';
import { finalizeSpend, sleep, unb64, b64 } from './buyer.js';
import { randomHex, sessionBytes, type SealProgress } from './engine.js';
import type { SellingEntry } from './store.js';
import type { Listing, Session } from './types.js';
import { Wallet, type Ctx } from './wallet.js';

export interface SellInput {
  title: string;
  /** Decimal ZEC (testnet TAZ), up to 8 decimals, e.g. "0.02". */
  price: string;
  /** The content to seal. Strings are UTF-8 encoded. */
  data: Uint8Array | string;
  description?: string;
  filename?: string;
  /** Mark the listing for on-chain settlement in local state (informational; the buyer picks the mode). Default true. */
  onchain?: boolean;
  onProgress?: (p: SealProgress | { uploaded: number; blobs: number }) => void;
}

export interface SellResult {
  listing: Listing;
  /** Relay seller token (also kept in the store). */
  sellerToken: string;
  kind: 'single' | 'big';
  sealMs: number;
}

export type SalePhase =
  | 'listed' // no buyer yet
  | 'joined' // buyer joined; waiting for their key proof
  | 'escrow' // escrow key bound and announced
  | 'refund_cosigned' // refund co-signed; waiting for funding
  | 'funding' // funding broadcast, not mined
  | 'settlement_built'
  | 'partial_sent'
  | 'broadcast' // settlement broadcast (t is public)
  | 'sold'
  | 'delegated'; // handed to lintel-agent

export interface SaleStep { phase: SalePhase; note: string; done?: boolean; txids: { funding?: string; settlement?: string } }

/** File the app's "Hand off to agent" produces; lintel-agent imports it. SECRET. */
export interface AgentHandoff {
  kind: 'lintel-agent-handoff'; v: 1; relay: string; listing_id: string; title: string; token: string;
  state: string; payout_address: string; chain: Record<string, any> | null;
}

export async function sell(ctx: Ctx, input: SellInput): Promise<SellResult> {
  const title = input.title.trim();
  if (!title || title.length > 120) throw new Error('title required (max 120 chars)');
  if (!isPrice(input.price.trim())) throw new Error('price must be a positive decimal with up to 8 decimals');
  if (input.description && input.description.length > 2000) throw new Error('description too long (max 2000 chars)');
  const payload = typeof input.data === 'string' ? new TextEncoder().encode(input.data) : input.data;
  const t0 = Date.now();
  const r = await ctx.engine.seal(payload, input.onProgress);
  const sealMs = Date.now() - t0;
  if (r.blobs.length) await ctx.relay.putBlobs(r.blobs, (done, total) => input.onProgress?.({ uploaded: done, blobs: total }));
  const { listing, seller_token } = await ctx.relay.createListing({
    title, description: input.description?.trim() || undefined, price_zec: input.price.trim(), filename: input.filename,
    content_hash: r.contentHash, merchant_vk: r.merchantVk, t_point: r.tPoint, offer: r.offer, size: payload.length,
  });
  await ctx.box.put((s) => { s.selling[listing.id] = { title: listing.title, state: r.state, token: seller_token, onchain: input.onchain ?? true }; });
  return { listing, sellerToken: seller_token, kind: r.kind, sealMs };
}

export class Sale {
  private readonly wallet: Wallet;
  constructor(private readonly ctx: Ctx, readonly listingId: string, private readonly opts: { payoutAddress?: string } = {}) {
    this.wallet = new Wallet(ctx);
  }

  private async entry(): Promise<SellingEntry> {
    const e = (await this.ctx.box.get()).selling[this.listingId];
    if (!e) throw new Error('seller keys for this listing are not in this store');
    return e;
  }
  private putSell(fn: (c: Record<string, any>) => void) {
    return this.ctx.box.put((s) => { const e = s.selling[this.listingId]; e.chain ??= {}; fn(e.chain); });
  }
  private async payout(): Promise<string | null> { return this.opts.payoutAddress || (await this.wallet.address()); }

  /** Advances the seller's side by one step. */
  async step(): Promise<SaleStep> {
    const e = await this.entry();
    // seller token: the relay serves the full session only to its buyer and seller
    const { listing, session } = await this.ctx.relay.listing(this.listingId, e.token);
    const txids = { funding: session?.chain?.funding_txid, settlement: session?.chain?.settle_txid };
    if (e.delegated) return { phase: 'delegated', note: 'Handed off to lintel-agent; this store no longer acts on it', txids };
    if (!session) return { phase: 'listed', note: 'Listed; waiting for a buyer', txids };
    if (session.mode === 'relay') return this.stepRelay(e, session);
    return this.stepChain(e, listing as Listing, session);
  }

  /** Steps until sold (or aborted). */
  async *watch(opts: { intervalMs?: number; signal?: AbortSignal; timeoutMs?: number; onStep?: (s: SaleStep) => void } = {}): AsyncGenerator<SaleStep> {
    const interval = opts.intervalMs ?? 5000;
    const deadline = opts.timeoutMs ? Date.now() + opts.timeoutMs : Infinity;
    let last = '';
    for (;;) {
      if (opts.signal?.aborted) return;
      if (Date.now() > deadline) throw new Error('timed out waiting for the sale');
      const s = await this.step();
      opts.onStep?.(s);
      yield s;
      if (s.done || s.phase === 'delegated') return;
      if (s.note === last) await sleep(interval, opts.signal);
      last = s.note;
    }
  }

  private async stepRelay(e: SellingEntry, s: Session): Promise<SaleStep> {
    const { engine, relay } = this.ctx;
    if (!s.partial) {
      const r = await engine.respond(e.state, { payerVk: s.payer_vk, rA: s.r_a!, alpha: s.alpha!, sighash: s.sighash!, sessionId: s.id });
      await relay.postPartial(s.id, r.partial, r.pok, e.token);
      return { phase: 'partial_sent', note: 'Partial signature sent (off-chain rehearsal)', txids: {} };
    }
    if (!s.presig) return { phase: 'partial_sent', note: 'Waiting for the buyer\'s pre-signature', txids: {} };
    if (!s.signature) {
      const sig = await engine.complete(e.state, { presig: s.presig, rA: s.r_a!, partial: s.partial, payerVk: s.payer_vk, alpha: s.alpha! });
      await relay.postSignature(s.id, sig, e.token);
      return { phase: 'sold', note: 'Signature completed and published (off-chain rehearsal; no funds moved)', done: true, txids: {} };
    }
    return { phase: 'sold', note: 'Sold (off-chain rehearsal)', done: true, txids: {} };
  }

  private async stepChain(e: SellingEntry, listing: Listing, session: Session): Promise<SaleStep> {
    const { engine, relay } = this.ctx;
    const C = await engine.chain();
    const sid = session.id, tok = e.token;
    const ch = session.chain || {};
    const c = e.chain || {};
    const txids = { funding: ch.funding_txid, settlement: ch.settle_txid };
    const step = (phase: SalePhase, note: string, done = false): SaleStep => ({ phase, note, txids, ...(done ? { done } : {}) });
    const post = (field: any, value: string) => relay.postChain(sid, field, value, tok);
    const payout = await this.payout();
    if (!payout) return step('joined', 'Set a payout address or create a wallet (lintel.wallet) to receive on-chain payments');

    // S1: rogue-key check BEFORE anything else, then bind and announce the escrow
    if (!ch.merchant_contrib) {
      if (!ch.payer_pok || !ch.payer_contrib || !ch.payer_address) return step('joined', 'Buyer joined; waiting for their key proof');
      const { result, state } = await engine.withMerchant(e.state, (m) => {
        const j = JSON.parse(m.bindJoint(session.payer_vk));
        const ok = m.verifyPayerKnowledge(session.payer_vk, ch.payer_pok!, sessionBytes(sid));
        return { j, ok };
      });
      if (!result.ok) throw new Error('buyer key proof is invalid (possible rogue key): not proceeding');
      await this.ctx.box.put((s) => { s.selling[this.listingId].state = state; });
      const contrib = c.contrib || randomHex(32);
      const joint = C.chainJoint(result.j.ak, sessionBytes(sid), ch.payer_contrib, contrib);
      await this.putSell((x) => Object.assign(x, { sid, contrib, joint, ak: result.j.ak, payout }));
      await post('merchant_contrib', contrib);
      await post('merchant_address', payout);
      await post('escrow_address', JSON.parse(joint).escrow_address);
      return step('escrow', 'Escrow key bound (buyer proof checked); escrow address announced');
    }
    const joint = c.joint;
    if (!joint) throw new Error('escrow key state for this sale is missing from this store');
    // S2: co-sign the time-locked refund, before the buyer funds (lock height ≥ E)
    if (!ch.refund_partial) {
      if (!ch.refund_terms || !ch.refund_pczt || !ch.refund_r_a) return step('escrow', 'Waiting for the buyer to build the funding and refund');
      const { terms, settle_expiry: E, escrow_note: note } = JSON.parse(ch.refund_terms);
      const price = zats(listing.price_zec);
      const tip = await relay.height();
      const J = JSON.parse(joint);
      if (note.recipient !== J.escrow_raw) throw new Error('escrow note is not paid to the joint escrow address');
      if (note.value < price + SETTLE_FEE) throw new Error('escrow note is smaller than price + fee');
      if (E < tip + 2 * SAFETY_BLOCKS) throw new Error(`claim window too short (expires at ${E}, tip ${tip})`);
      if (terms.pay_to !== ch.payer_address) throw new Error('refund must go to the buyer\'s announced address');
      C.chainCheckRefundWindow(JSON.stringify(terms), E);
      const info = JSON.parse(C.chainCheckSpend(unb64(ch.refund_pczt), joint, JSON.stringify(note), JSON.stringify(terms)));
      const { result: r } = await engine.withMerchant(e.state, (m) => ({
        partial: m.refundPartial(ch.refund_r_a!, session.payer_vk, info.alpha, hexBytes(info.sighash)),
        pok: m.proveKnowledge(session.payer_vk, sessionBytes(sid)),
      }));
      await this.putSell((x) => Object.assign(x, { E, escrow: note, refundTxid: info.txid }));
      await post('refund_partial', JSON.stringify(r));
      return step('refund_cosigned', `Refund co-signed (valid only after block ${E}); waiting for the buyer to fund`);
    }
    // S3: funding mined -> build the settlement (not within SAFETY_BLOCKS of E)
    if (!ch.settle_pczt) {
      if (!ch.funding_txid) return step('refund_cosigned', 'Waiting for the buyer to broadcast the funding');
      const tx = await relay.minedTx(ch.funding_txid);
      if (!tx) return step('funding', `Funding ${ch.funding_txid.slice(0, 12)}… seen; waiting for it to be mined`);
      const found = JSON.parse(C.chainFindNotes(joint, tx.data, tx.height, ch.funding_txid));
      const escrow = found.find((n: any) => n.cmx === c.escrow.cmx);
      if (!escrow) throw new Error('mined funding does not contain the agreed escrow note');
      const tip = await relay.height();
      if (tip + SAFETY_BLOCKS >= c.E) throw new Error(`too close to the end of the claim window (tip ${tip}, expiry ${c.E}): not settling; the buyer can refund after ${c.E}`);
      const terms = { kind: 'settle', pay_to: c.payout, amount: zats(listing.price_zec), change_to: ch.payer_address, target_height: tip + 1, expiry_height: c.E };
      const p = C.chainBuildSpend(joint, JSON.stringify(escrow), JSON.stringify(terms));
      const info = JSON.parse(C.chainCheckSpend(p, joint, JSON.stringify(escrow), JSON.stringify(terms)));
      await this.putSell((x) => Object.assign(x, { escrow, settleTerms: terms, settlePczt: b64(p), settleInfo: info }));
      await post('settle_terms', JSON.stringify(terms));
      await post('settle_pczt', b64(p));
      return step('settlement_built', `Settlement built (pays ${fmtZec(terms.amount)} TAZ to ${c.payout.slice(0, 16)}…, expires at block ${c.E})`);
    }
    // S4: partial signature over OUR OWN check's sighash/alpha
    const info = c.settleInfo;
    if (!session.partial) {
      if (!ch.settle_r_a) return step('settlement_built', 'Waiting for the buyer to check the settlement');
      const r = await engine.respond(e.state, { payerVk: session.payer_vk, rA: ch.settle_r_a, alpha: info.alpha, sighash: info.sighash, sessionId: sid });
      await relay.postPartial(sid, r.partial, r.pok, tok);
      return step('partial_sent', 'Partial signature sent; waiting for the buyer\'s pre-signature');
    }
    // S5: complete, prove, broadcast. Broadcasting reveals t (that is the sale).
    if (!ch.settle_txid) {
      if (!session.presig) return step('partial_sent', 'Waiting for the buyer\'s pre-signature');
      const tip = await relay.height();
      if (tip + 1 > c.E) throw new Error('claim window closed: the settlement can no longer be mined');
      const sig = await engine.complete(e.state, { presig: session.presig, rA: ch.settle_r_a!, partial: session.partial, payerVk: session.payer_vk, alpha: info.alpha });
      const p = C.chainApplySignature(unb64(c.settlePczt), info.action_index, sig);
      const r = await finalizeSpend(this.ctx, p, info.action_index, c.escrow);
      if (r.txid !== info.txid) throw new Error('settlement txid changed');
      await relay.broadcast(r.raw, r.txid);
      await this.putSell((x) => { x.settleTxid = r.txid; });
      await post('settle_txid', r.txid);
      return { phase: 'broadcast', note: `Settlement broadcast: ${r.txid}`, txids: { ...txids, settlement: r.txid } };
    }
    const tx = await relay.minedTx(ch.settle_txid);
    if (!tx) return step('broadcast', `Settlement ${ch.settle_txid.slice(0, 12)}… broadcast; waiting for it to be mined`);
    if (!c.paidNote && (await this.wallet.address()) === c.payout) {
      const sk = await this.wallet.exportKey();
      const mine = JSON.parse(C.chainFindNotes(JSON.stringify({ kind: 'own', sk }), tx.data, tx.height, ch.settle_txid));
      await this.wallet.addNotes(mine);
      await this.putSell((x) => { x.paidNote = mine.reduce((a: number, n: any) => a + n.value, 0); x.soldHeight = tx.height; });
    }
    return step('sold', `Sold on chain at block ${tx.height}`, true);
  }

  /**
   * Builds the lintel-agent handoff file for this listing and marks it
   * delegated here, so this store and the agent never race on the relay's
   * write-once fields. SECRET: the file holds the listing's signing share and
   * adaptor secret. Import it with `lintel-agent import <file>`.
   */
  async handoff(opts: { payoutAddress?: string } = {}): Promise<AgentHandoff> {
    const payout = opts.payoutAddress || (await this.payout());
    if (!payout) throw new Error('a payout address (or a wallet) is required: the agent pays the price to it');
    const s = await this.ctx.box.put((x) => { x.selling[this.listingId].delegated = true; });
    const e = s.selling[this.listingId];
    return { kind: 'lintel-agent-handoff', v: 1, relay: this.ctx.relay.url, listing_id: this.listingId, title: e.title, token: e.token, state: e.state, payout_address: payout, chain: e.chain || null };
  }
  /** Takes a delegated sale back (stop the agent for it first: `lintel-agent remove <id>`). */
  async takeBack(): Promise<void> { await this.ctx.box.put((x) => { delete x.selling[this.listingId].delegated; }); }
}

const hexBytes = (h: string) => { const o = new Uint8Array(h.length / 2); for (let i = 0; i < o.length; i++) o[i] = parseInt(h.substr(i * 2, 2), 16); return o; };
