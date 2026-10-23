// The Lintel client: one object for discovery, verification, selling and
// buying, over a relay URL, the WASM engine, and a device-local state store.

import { Purchase, type BuyOptions } from './buyer.js';
import { Engine, type Platform } from './engine.js';
import { HOSTED_RELAY, RelayClient, type FetchLike } from './relay.js';
import { Sale, sell, type SellInput, type SellResult } from './seller.js';
import { listingStatus, type ListingStatus } from './status.js';
import { MemoryStore, StateBox, type LintelState, type StateStore } from './store.js';
import type { AnyListing, Listing, ListingDetail } from './types.js';
import { PayIn, Wallet, type Ctx } from './wallet.js';

export interface LintelOptions {
  /** Relay base URL. Default: the hosted testnet relay. */
  relayUrl?: string;
  /** Device-local state (SECRET keys live here). Default: in-memory. */
  store?: StateStore;
  fetch?: FetchLike;
}

export interface VerifyResult {
  ok: true;
  listingId: string;
  /** Adaptor point T the proof is bound to (pinned for the purchase). */
  tPoint: string;
  contentHash: string;
  size: number;
  /** 'single' proof, 'big' (proven parts), or 'presale' (each copy checked). */
  kind: 'single' | 'big' | 'presale';
  /** Proven parts (big) or copies checked (presale); 1 for a single proof. */
  parts: number;
  ms: number;
}

export class Lintel {
  readonly relay: RelayClient;
  readonly engine: Engine;
  /** The device wallet (testnet): create/import, scan, balance. */
  readonly wallet: Wallet;
  /** Per-purchase pay-in wallets (ZIP 321 requests any testnet wallet can pay). */
  readonly payin: PayIn;
  private readonly box: StateBox;
  private readonly ctx: Ctx;

  constructor(platform: Platform, opts: LintelOptions = {}) {
    this.relay = new RelayClient(opts.relayUrl ?? HOSTED_RELAY, { fetch: opts.fetch });
    this.engine = new Engine(platform);
    this.box = new StateBox(opts.store ?? new MemoryStore());
    this.ctx = { relay: this.relay, engine: this.engine, box: this.box };
    this.wallet = new Wallet(this.ctx);
    this.payin = new PayIn(this.ctx);
  }

  /** Loads the core engine and parameters now (otherwise done on first use). */
  async ready(): Promise<this> { await this.engine.ready(); return this; }

  // ---------------------------------------------------------------- discovery
  /** All listings on the relay, newest first. */
  listings(): Promise<AnyListing[]> { return this.relay.listings(); }
  /** One listing (with its offer) and its current session. */
  listing(id: string): Promise<ListingDetail> { return this.relay.listing(id); }
  /** Where a listing's sale stands, plus its txids. */
  async status(id: string): Promise<ListingStatus> { const { listing, session } = await this.relay.listing(id); return listingStatus(listing, session); }

  /**
   * Fetches a listing's offer and verifies its Halo 2 proof(s) locally
   * against the listing's content hash. Throws if any proof fails.
   */
  async verify(idOrListing: string | AnyListing): Promise<VerifyResult> {
    const t0 = Date.now();
    const listing = typeof idOrListing === 'string' || !(idOrListing as Listing).offer && (idOrListing as any).version !== 2
      ? (await this.relay.listing(typeof idOrListing === 'string' ? idOrListing : idOrListing.id)).listing
      : idOrListing;
    if ((listing as any).version === 2) {
      const n = (listing as any).units_total ?? (listing as any).units?.length ?? 0;
      let tPoint = '';
      for (let i = 0; i < n; i++) {
        const { unit } = await this.relay.unit(listing.id, i);
        const resolved = { ...unit, offer: await this.relay.resolveOffer(unit.offer) };
        await this.engine.verifyUnit(JSON.stringify(resolved), listing.content_hash);
        tPoint ||= unit.t_point;
      }
      return { ok: true, listingId: listing.id, tPoint, contentHash: listing.content_hash, size: listing.size, kind: 'presale', parts: n, ms: Date.now() - t0 };
    }
    const l = listing as Listing;
    if (!l.offer) throw new Error('listing has no offer');
    const offer = await this.relay.resolveOffer(l.offer);
    const tPoint = await this.engine.verifyOffer(offer, l.content_hash);
    let parts = 1, kind: 'single' | 'big' = 'single';
    try { const o = JSON.parse(l.offer); if (o?.v === 3) { kind = 'big'; parts = o.parts.length; } } catch { /* inline */ }
    if (tPoint !== l.t_point) throw new Error('offer is bound to a different T than the listing advertises');
    return { ok: true, listingId: l.id, tPoint, contentHash: l.content_hash, size: l.size, kind, parts, ms: Date.now() - t0 };
  }

  // ---------------------------------------------------------------- selling
  /** Seals `data`, uploads proven parts if big, and lists it. Seller keys go to the store. */
  sell(input: SellInput): Promise<SellResult> { return sell(this.ctx, input); }
  /** The seller's side of a listing in this store: step()/watch() to answer buyers, handoff() for lintel-agent. */
  sale(listingId: string, opts: { payoutAddress?: string } = {}): Sale { return new Sale(this.ctx, listingId, opts); }
  /** Listing ids this store sells. */
  async selling(): Promise<string[]> { return Object.keys((await this.box.get()).selling); }

  // ---------------------------------------------------------------- buying
  /** A purchase of a single-copy listing. Nothing happens until step()/complete(). */
  buy(listingId: string, opts: BuyOptions = {}): Purchase { return new Purchase(this.ctx, listingId, opts); }
  /** Listing ids this store is buying or bought. */
  async buying(): Promise<string[]> { return Object.keys((await this.box.get()).buying); }

  /** SECRET: the whole device-local state document (app-compatible "lintel.v1" shape). */
  exportState(): Promise<LintelState> { return this.box.get(); }
}
