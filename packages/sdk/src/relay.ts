// Typed client for the Lintel relay's HTTP API (web/relay/server.js).
//
// The relay stores and forwards PUBLIC data only. Writes are write-once and
// gated by bearer tokens the relay hands out (seller_token on listing
// creation, buyer_token on session creation). Every value read from it is
// re-verified by the engine, so a lying relay can stall a sale, never forge one.

import type { AnyListing, BroadcastResult, ChainField, ChainTx, Hex, Listing, ListingDetail, Session } from './types.js';

/** Error from the relay, with the HTTP status. */
export class RelayError extends Error {
  readonly status: number;
  readonly path: string;
  constructor(message: string, status: number, path: string) {
    super(message);
    this.name = 'RelayError';
    this.status = status;
    this.path = path;
  }
}

export type FetchLike = (input: string, init?: { method?: string; headers?: Record<string, string>; body?: string | Uint8Array }) => Promise<{ ok: boolean; status: number; json(): Promise<any>; arrayBuffer(): Promise<ArrayBuffer> }>;

export interface NewListing {
  title: string;
  description?: string;
  price_zec: string;
  content_hash: Hex;
  merchant_vk: Hex;
  t_point: Hex;
  offer: string;
  filename?: string;
  size: number;
}

const hex = (u8: Uint8Array) => Array.from(u8, (b) => b.toString(16).padStart(2, '0')).join('');
export const sha256hex = async (bytes: Uint8Array): Promise<string> =>
  hex(new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', bytes as unknown as ArrayBuffer)));

/** One timers phase + one I/O poll phase, so stale sockets are noticed before reuse. */
const tick = async () => {
  await new Promise((r) => setTimeout(r, 1));
  await new Promise((r) => ((globalThis as any).setImmediate ?? setTimeout)(r));
};

/** Hosted testnet relay used by the public app. */
export const HOSTED_RELAY = 'https://lintel-relay.onrender.com';

export class RelayClient {
  readonly url: string;
  private readonly fetch: FetchLike;
  private readonly blobCache = new Map<string, Uint8Array>();

  constructor(url: string = HOSTED_RELAY, opts: { fetch?: FetchLike } = {}) {
    this.url = url.replace(/\/$/, '');
    // call through globalThis: a bare reference to window.fetch throws "Illegal invocation" in browsers
    this.fetch = opts.fetch ?? (((input, init) => (globalThis.fetch as any)(input, init)) as FetchLike);
    if (!opts.fetch && typeof globalThis.fetch !== 'function') throw new Error('no fetch available; pass opts.fetch');
  }

  /**
   * fetch with one retry for idempotent requests (GET/PUT) on a network
   * error, e.g. a keep-alive socket the server closed while this process was
   * busy proving. POSTs are never retried (relay writes are not idempotent).
   */
  private async send(url: string, init: Parameters<FetchLike>[1] & { method: string }) {
    try { return await this.fetch(url, init); }
    catch (e) {
      if (init.method === 'POST' || !(e instanceof TypeError)) throw e;
      await new Promise((r) => setTimeout(r, 100));
      return this.fetch(url, init);
    }
  }

  /** Low-level JSON call. */
  async call<T = any>(method: string, path: string, body?: unknown, token?: string): Promise<T> {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (token) headers.Authorization = `Bearer ${token}`;
    // let pending socket events (e.g. a server-closed keep-alive socket) run
    // before reusing a connection after long synchronous proving
    await tick();
    const res = await this.send(this.url + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw new RelayError(json?.error || `relay error ${res.status}`, res.status, path);
    return json as T;
  }

  health(): Promise<{ ok: boolean }> { return this.call('GET', '/health'); }

  // ---- listings ----
  /** All listings, newest first (list view: offers omitted). */
  async listings(): Promise<AnyListing[]> { return (await this.call<{ listings: AnyListing[] }>('GET', '/listings')).listings; }
  /** One listing with its offer and current session (if any). */
  listing(id: string): Promise<ListingDetail> { return this.call('GET', `/listings/${encodeURIComponent(id)}`); }
  createListing(l: NewListing): Promise<{ listing: Listing; seller_token: string }> { return this.call('POST', '/listings', l); }
  /** One presale unit with its offer. */
  unit(id: string, index: number): Promise<{ unit: any }> { return this.call('GET', `/listings/${encodeURIComponent(id)}/units/${index}`); }

  // ---- sessions (single-copy listings) ----
  createSession(listingId: string, body: { payer_vk: Hex; mode?: 'chain'; r_a?: Hex; alpha?: Hex; sighash?: Hex }): Promise<{ session: Session; buyer_token: string }> {
    return this.call('POST', `/listings/${encodeURIComponent(listingId)}/sessions`, body);
  }
  async session(id: string): Promise<Session> { return (await this.call<{ session: Session }>('GET', `/sessions/${encodeURIComponent(id)}`)).session; }
  async postPartial(sid: string, partial: string, merchantPok: string, sellerToken: string): Promise<Session> {
    return (await this.call<{ session: Session }>('POST', `/sessions/${sid}/partial`, { partial, merchant_pok: merchantPok }, sellerToken)).session;
  }
  async postPresig(sid: string, presig: string, buyerToken: string): Promise<Session> {
    return (await this.call<{ session: Session }>('POST', `/sessions/${sid}/presig`, { presig }, buyerToken)).session;
  }
  /** Off-chain ('relay' mode) sessions only: the seller's completed signature. */
  async postSignature(sid: string, signature: Hex, sellerToken: string): Promise<Session> {
    return (await this.call<{ session: Session }>('POST', `/sessions/${sid}/signature`, { signature }, sellerToken)).session;
  }
  async postChain(sid: string, field: ChainField, value: string, token: string): Promise<Session> {
    return (await this.call<{ session: Session }>('POST', `/sessions/${sid}/chain/${field}`, { value }, token)).session;
  }

  // ---- content-addressed blobs (offer v3 parts) ----
  async putBlob(id: string, bytes: Uint8Array): Promise<{ blob: string; created: boolean; size: number }> {
    if ((await sha256hex(bytes)) !== id) throw new Error('blob does not match its id');
    const res = await this.send(`${this.url}/blobs/${id}`, { method: 'PUT', headers: { 'Content-Type': 'application/octet-stream' }, body: bytes });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw new RelayError(json?.error || `blob upload failed (${res.status})`, res.status, `/blobs/${id}`);
    return json;
  }
  /** Uploads blobs a few at a time. */
  async putBlobs(blobs: Array<{ id: string; bytes: Uint8Array }>, onStep: (done: number, total: number) => void = () => {}): Promise<void> {
    let done = 0, next = 0;
    const run = async () => { while (next < blobs.length) { const b = blobs[next++]; await this.putBlob(b.id, b.bytes); onStep(++done, blobs.length); } };
    await Promise.all(Array.from({ length: Math.min(4, blobs.length) }, run));
  }
  /** Fetches a blob and re-hashes it against its name. */
  async getBlob(id: string): Promise<Uint8Array> {
    const hit = this.blobCache.get(id);
    if (hit) return hit;
    const res = await this.send(`${this.url}/blobs/${id}`, { method: 'GET' });
    if (!res.ok) throw new RelayError(`could not fetch offer part ${id.slice(0, 12)}… (${res.status})`, res.status, `/blobs/${id}`);
    const bytes = new Uint8Array(await res.arrayBuffer());
    if ((await sha256hex(bytes)) !== id) throw new Error('an offer part does not match its content address; refusing it');
    if (this.blobCache.size > 128) this.blobCache.clear();
    this.blobCache.set(id, bytes);
    return bytes;
  }
  /** Offer JSON ready for the engine: v1/v2 unchanged, v3 with every part's bytes attached. */
  async resolveOffer(offer: string): Promise<string> {
    let o: any;
    try { o = JSON.parse(offer); } catch { return offer; }
    if (!o || o.v !== 3) return offer;
    const datas = await Promise.all(o.parts.map((p: any) => this.getBlob(p.blob)));
    return JSON.stringify({ ...o, parts: o.parts.map((p: any, i: number) => ({ ...p, data: hex(datas[i]) })) });
  }

  // ---- public chain data (lightwalletd proxy, Zcash testnet) ----
  async height(): Promise<number> { return (await this.call<{ height: number }>('GET', '/chain/height')).height; }
  tx(txid: Hex): Promise<ChainTx> { return this.call('GET', `/chain/tx/${txid}`); }
  /** The mined transaction, or null when unknown or not mined yet. */
  async minedTx(txid: Hex): Promise<ChainTx | null> {
    try { const r = await this.tx(txid); return r.mined ? r : null; } catch { return null; }
  }
  tree(height: number): Promise<{ height: number; ironwood_tree: string }> { return this.call('GET', `/chain/tree/${height}`); }
  cmxs(height: number): Promise<{ height: number; cmxs: string[] }> { return this.call('GET', `/chain/cmxs/${height}`); }
  utxos(taddr: string): Promise<{ address: string; utxos: Array<{ txid: Hex; vout: number; value: number; height: number }> }> { return this.call('GET', `/chain/utxos/${taddr}`); }
  compact(from: number, to: number): Promise<{ from: number; to: number; txs: Array<{ txid: Hex; actions: Array<{ nf: Hex; cmx: Hex; epk: Hex; ct: Hex }> }> }> {
    return this.call('GET', `/chain/compact/${from}/${to}`);
  }
  /** Broadcasts; still succeeds when the node already knows `txid` (retry after a lost reply). */
  async broadcast(rawHex: string, txid?: Hex): Promise<BroadcastResult> {
    const r = await this.call<BroadcastResult>('POST', '/chain/broadcast', { tx: rawHex });
    if (r.accepted) return r;
    if (txid) { try { await this.tx(txid); return { ...r, accepted: true, already_known: true }; } catch { /* not known */ } }
    throw new Error(`node rejected the transaction: ${r.error_message || 'error ' + r.error_code}`);
  }
}
