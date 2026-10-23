// Testnet wallets, all keys device-local (in the StateStore, never sent).
//
// * Wallet: one Ironwood wallet per store. Pays escrows (buyer) and receives
//   payouts (seller). Notes are added by scanning mined transactions.
// * PayIn: "pay from another wallet". Each purchase gets its own pay-in
//   wallet (Ironwood key + transparent key). Any Zcash testnet wallet pays its
//   ZIP 321 request (shielded or transparent); once mined, the funding is
//   built from it. Refund, settlement change and the returned lock coin come
//   back to it; withdraw() sweeps it to any testnet address.

import { escrowFor, fmtZec, LOCK_VALUE, zats } from './amounts.js';
import type { Engine } from './engine.js';
import type { RelayClient } from './relay.js';
import type { PayinEntry, StateBox, WalletEntry } from './store.js';
import type { AnyListing, NoteRecord } from './types.js';

export interface Ctx { relay: RelayClient; engine: Engine; box: StateBox }

const SCAN_SPAN = 99; // blocks per /chain/compact call (relay max 100)
const ADDR = /^(utest1[0-9a-z]+|tm[1-9A-HJ-NP-Za-km-z]{30,40})$/;

/** Public view of the device wallet (no keys). */
export interface WalletInfo { address: string; balance: number; spendable: NoteRecord[] }

export class Wallet {
  constructor(private readonly ctx: Ctx) {}

  private async raw(): Promise<WalletEntry | null> { return (await this.ctx.box.get()).wallet || null; }
  /** Address and balance, or null when no wallet exists yet. */
  async info(): Promise<WalletInfo | null> {
    const w = await this.raw();
    if (!w) return null;
    const spendable = await this.spendable();
    return { address: w.address, balance: spendable.reduce((a, n) => a + n.value, 0), spendable };
  }
  async address(): Promise<string | null> { return (await this.raw())?.address ?? null; }
  /** Creates a new testnet wallet (replaces nothing: throws if one exists). */
  async create(): Promise<string> {
    if (await this.raw()) throw new Error('a wallet already exists in this store');
    const C = await this.ctx.engine.chain();
    const w = JSON.parse(C.chainNewSpendingKey());
    await this.ctx.box.put((s) => { s.wallet = { sk: w.sk, address: w.address, notes: [] }; });
    return w.address;
  }
  /** Imports `lintel-chain wallet` JSON ({"sk": ...}) or a bare 32-byte hex key. */
  async import(text: string): Promise<string> {
    let sk = text.trim();
    try { sk = JSON.parse(sk).sk || sk; } catch { /* bare hex */ }
    if (!/^[0-9a-f]{64}$/.test(sk)) throw new Error('expected a 32-byte hex spending key or lintel-chain wallet JSON');
    const C = await this.ctx.engine.chain();
    const address = C.chainAddress(sk);
    await this.ctx.box.put((s) => { s.wallet = { sk, address, notes: [] }; });
    return address;
  }
  /** Adds this wallet's notes from a mined transaction (e.g. a faucet payment). */
  async scan(txid: string): Promise<NoteRecord[]> {
    const w = await this.raw();
    if (!w) throw new Error('no wallet');
    const tx = await this.ctx.relay.minedTx(txid);
    if (!tx) throw new Error('transaction not found or not mined yet');
    const C = await this.ctx.engine.chain();
    const found: NoteRecord[] = JSON.parse(C.chainFindNotes(JSON.stringify({ kind: 'own', sk: w.sk }), tx.data, tx.height, txid));
    await this.addNotes(found);
    return found;
  }
  /**
   * Syncs the wallet from public chain data: trial-decrypts compact blocks
   * from `from` (default: where the last sync stopped) to the tip, adds the
   * notes paying this wallet (read from the full transactions), and marks
   * notes spent when their nullifiers appear. At most `maxBlocks` per call
   * (default 2,000). The relay can hide a payment, never invent one.
   */
  async sync(opts: { from?: number; maxBlocks?: number; onProgress?: (height: number, tip: number) => void } = {}): Promise<{ scanned: number; tip: number; found: number; balance: number }> {
    const w = await this.raw();
    if (!w) throw new Error('no wallet');
    const { relay } = this.ctx;
    const C = await this.ctx.engine.chain();
    const key = JSON.stringify({ kind: 'own', sk: w.sk });
    const tip = await relay.height();
    let at = (opts.from ?? ((w as any).synced ?? tip - 1) + 1);
    const stop = Math.min(tip, at + (opts.maxBlocks ?? 2000) - 1);
    let found = 0;
    // nullifiers of every note we hold (old ones included) so spends are seen
    const nfs = new Map<string, string>();
    for (const n of w.notes) { try { nfs.set((n as any).nf ?? C.chainNoteNullifier(key, JSON.stringify(n)), n.cmx); } catch { /* foreign record */ } }
    while (at <= stop) {
      const to = Math.min(stop, at + SCAN_SPAN - 1);
      const { txs } = await relay.compact(at, to);
      const spent: string[] = [];
      for (const t of txs) {
        for (const a of t.actions) { const cmx = nfs.get(a.nf); if (cmx) spent.push(cmx); }
        const hits = JSON.parse(C.chainScanCompact(w.sk, JSON.stringify(t.actions)));
        if (!hits.length) continue;
        const tx = await relay.minedTx(t.txid);
        if (!tx) throw new Error(`could not fetch ${t.txid}`);
        const mine: NoteRecord[] = JSON.parse(C.chainFindNotes(key, tx.data, tx.height, t.txid));
        for (const n of mine) { (n as any).nf = C.chainNoteNullifier(key, JSON.stringify(n)); nfs.set((n as any).nf, n.cmx); }
        found += mine.length;
        await this.addNotes(mine);
      }
      await this.ctx.box.put((s) => {
        for (const n of s.wallet!.notes) if (spent.includes(n.cmx)) n.spent = true;
        (s.wallet as any).synced = to;
      });
      opts.onProgress?.(to, tip);
      at = to + 1;
    }
    return { scanned: stop, tip, found, balance: await this.balance() };
  }

  async addNotes(found: NoteRecord[]) {
    await this.ctx.box.put((s) => { for (const n of found) if (!s.wallet!.notes.some((x) => x.cmx === n.cmx)) s.wallet!.notes.push({ ...n, spent: false }); });
  }
  async spendable(): Promise<NoteRecord[]> { return ((await this.raw())?.notes || []).filter((n) => !n.spent && !n.reserved && n.height > 0); }
  async balance(): Promise<number> { return (await this.spendable()).reduce((a, n) => a + n.value, 0); }
  async markSpent(cmx: string, by: string) {
    await this.ctx.box.put((s) => { const n = s.wallet?.notes.find((x) => x.cmx === cmx); if (n) { n.spent = true; n.spent_by = by; delete n.reserved; } });
  }
  /** SECRET: the spending key, for callers that run their own key storage. */
  async exportKey(): Promise<string | null> { return (await this.raw())?.sk ?? null; }
}

/** Public view of a pay-in request: what to show the paying wallet. */
export interface PaymentRequest {
  listingId: string;
  /** Exact amount to pay, zats (escrow + lock coin + funding fee). */
  amount: number;
  /** ZIP 321 URI for the unified address (shielded wallets pay the Orchard receiver). */
  uri: string;
  /** ZIP 321 URI for the transparent address (for transparent-only wallets). */
  uriTransparent: string;
  address: string;
  transparentAddress: string;
}

export interface PayinStatus { paid: boolean; have: number; need: number; tip: number; scanned: number; note?: string; sel?: any }

export class PayIn {
  constructor(private readonly ctx: Ctx) {}

  async get(lid: string): Promise<PayinEntry | null> { return (await this.ctx.box.get()).payins?.[lid] || null; }
  private put(lid: string, fn: (p: PayinEntry) => void) { return this.ctx.box.put((s) => { fn(s.payins![lid]); }); }

  static request(p: PayinEntry): PaymentRequest {
    return { listingId: p.listing, amount: p.amount, uri: p.uri, uriTransparent: p.uri_t, address: p.payment_ua, transparentAddress: p.taddr };
  }

  /** Opens (or returns) the pay-in wallet and payment request for a listing. Keys are stored before the address is returned. */
  async open(listing: AnyListing): Promise<PaymentRequest> {
    const have = await this.get(listing.id);
    if (have) return PayIn.request(have);
    const C = await this.ctx.engine.chain();
    const escrowValue = escrowFor(zats(listing.price_zec));
    const amount = C.chainPayinAmount(escrowValue);
    const k = JSON.parse(C.chainPayinNew());
    const start = await this.ctx.relay.height();
    const msg = `Lintel escrow ${listing.id}`;
    const entry: PayinEntry = { ...k, listing: listing.id, title: listing.title, amount, escrowValue, start, scanned: start - 1,
      uri: C.chainZip321(k.payment_ua, amount, msg), uri_t: C.chainZip321(k.taddr, amount, msg), notes: [], utxos: [], created: Date.now() };
    await this.ctx.box.put((s) => { s.payins![listing.id] = entry; });
    const saved = await this.get(listing.id);
    if (!saved?.sk) throw new Error('could not store the pay-in wallet');
    return PayIn.request(saved);
  }

  /** SECRET backup of a pay-in wallet (keys + request), same format as the app's. */
  async backup(lid: string): Promise<string> {
    const p = await this.get(lid);
    if (!p) throw new Error('no pay-in wallet for this listing');
    const { notes, utxos, scanned, ...keep } = p;
    return JSON.stringify({ kind: 'lintel-payin-backup', ...keep }, null, 2);
  }

  /**
   * Re-reads the pay-in wallet from public chain data: transparent coins
   * (each checked against the raw tx) and Ironwood notes (compact blocks
   * trial-decrypted here). The relay can hide a payment, never invent one.
   * Scans at most 20 x 99 blocks per call.
   */
  async scan(lid: string): Promise<PayinStatus> {
    const { relay } = this.ctx;
    const C = await this.ctx.engine.chain();
    let p = (await this.get(lid))!;
    if (!p) throw new Error('no pay-in wallet for this listing');
    const payKey = JSON.stringify({ kind: 'own', sk: p.sk });
    const tip = await relay.height();
    const { utxos: claimed } = await relay.utxos(p.taddr);
    const utxos: any[] = [];
    for (const u of claimed) {
      const known = p.utxos.find((x) => x.txid === u.txid && x.vout === u.vout);
      if (known) { utxos.push(known); continue; }
      const tx = await relay.minedTx(u.txid);
      if (!tx) continue;
      utxos.push(JSON.parse(C.chainUtxoFromTx(tx.data, tx.height, u.txid, u.vout, p.taddr)));
    }
    await this.put(lid, (x) => { x.utxos = utxos; });
    for (let n = 0; p.scanned < tip && n < 20; n++) {
      const from = p.scanned + 1, to = Math.min(tip, from + SCAN_SPAN - 1);
      const { txs } = await relay.compact(from, to);
      const nfs = new Set<string>();
      for (const t of txs) {
        for (const a of t.actions) nfs.add(a.nf);
        const hits = JSON.parse(C.chainScanCompact(p.sk, JSON.stringify(t.actions)));
        if (!hits.length) continue;
        const tx = await relay.minedTx(t.txid);
        if (!tx) throw new Error(`could not fetch ${t.txid}`);
        const found = JSON.parse(C.chainFindNotes(payKey, tx.data, tx.height, t.txid));
        for (const f of found) f.nf = C.chainNoteNullifier(payKey, JSON.stringify(f));
        await this.put(lid, (x) => { for (const f of found) if (!x.notes.some((y) => y.cmx === f.cmx)) x.notes.push({ ...f, spent: false }); });
      }
      await this.put(lid, (x) => { for (const n2 of x.notes) if (n2.nf && nfs.has(n2.nf)) n2.spent = true; x.scanned = to; });
      p = (await this.get(lid))!;
    }
    return this.status(lid, tip);
  }

  async spendable(lid: string) {
    const p = (await this.get(lid))!;
    return { notes: p.notes.filter((n) => !n.spent && !n.spent_by), utxos: p.utxos.filter((u) => !u.spent_by) };
  }
  async balance(lid: string): Promise<number> {
    const { notes, utxos } = await this.spendable(lid);
    return notes.reduce((a, n) => a + n.value, 0) + utxos.reduce((a, u) => a + u.value, 0);
  }
  /** Whether the pay-in wallet can fund the escrow now (`sel` is what the funding will spend). */
  async status(lid: string, tip?: number): Promise<PayinStatus> {
    const C = await this.ctx.engine.chain();
    const p = (await this.get(lid))!;
    const { notes, utxos } = await this.spendable(lid);
    const outs = [{ to: p.orchard_ua, value: p.escrowValue }, { to: p.taddr, value: LOCK_VALUE }];
    const have = await this.balance(lid);
    tip ??= await this.ctx.relay.height();
    try {
      const sel = JSON.parse(C.chainPayinSelect(JSON.stringify(notes), JSON.stringify(utxos), JSON.stringify(outs)));
      return { paid: true, have, need: p.amount, sel, tip, scanned: p.scanned };
    } catch (e: any) {
      return { paid: false, have, need: p.amount, tip, scanned: p.scanned, note: e?.message || String(e) };
    }
  }

  /** Anchor data for a pay-in build: the spent note's block (witness), else the tip. */
  async anchorFor(note: NoteRecord | null, tip: number) {
    const { relay } = this.ctx;
    if (note) {
      const h = note.height;
      const [prev, at, block] = await Promise.all([relay.tree(h - 1), relay.tree(h), relay.cmxs(h)]);
      return { prev_tree: prev.ironwood_tree, block_cmxs: block.cmxs, at_tree: at.ironwood_tree };
    }
    return { at_tree: (await relay.tree(tip)).ironwood_tree };
  }

  /** Sends everything the pay-in wallet holds (one Ironwood note per tx, plus all coins) to `dest` (utest1… or tm…). */
  async withdraw(lid: string, dest: string): Promise<{ txid: string; value: number; fee: number; more: boolean }> {
    const C = await this.ctx.engine.chain();
    const p = (await this.get(lid))!;
    dest = dest.trim();
    if (!ADDR.test(dest)) throw new Error('enter a testnet unified address (utest1…) or t-address (tm…)');
    if (dest === p.taddr || dest === p.orchard_ua || dest === p.payment_ua) throw new Error('that is the pay-in wallet itself');
    const { notes, utxos } = await this.spendable(lid);
    const note = [...notes].sort((a, b) => b.value - a.value)[0] || null;
    if (!note && !utxos.length) throw new Error('nothing to withdraw (scan first)');
    const total = (note?.value || 0) + utxos.reduce((a, u) => a + u.value, 0);
    const toT = dest.startsWith('tm');
    const fee = C.chainPayinFee(note ? 1 : 0, utxos.length, toT ? 0 : 1, toT ? 1 : 0);
    if (total <= fee) throw new Error(`balance ${fmtZec(total)} TAZ does not cover the ${fmtZec(fee)} TAZ fee`);
    const tip = await this.ctx.relay.height();
    const plan = { note, utxos, outputs: [{ to: dest, value: total - fee }], change_to: null, target_height: tip + 1, expiry_height: tip + 40 };
    const built = JSON.parse(C.chainPayinBuild(p.sk, p.tsk, JSON.stringify(plan), JSON.stringify(await this.anchorFor(note, tip))));
    await this.ctx.relay.broadcast(built.raw, built.txid);
    await this.put(lid, (x) => {
      if (note) x.notes.find((n) => n.cmx === note.cmx)!.spent_by = built.txid;
      for (const u of utxos) x.utxos.find((y) => y.txid === u.txid && y.vout === u.vout)!.spent_by = built.txid;
      (x.withdrawals ??= []).push({ txid: built.txid, to: dest, value: total - fee });
    });
    return { txid: built.txid, value: total - fee, fee, more: notes.length > 1 };
  }
}
