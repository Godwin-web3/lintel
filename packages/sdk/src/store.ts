// Device-local state. SECRET: seller entries hold the listing's signing share
// and adaptor secret; buyer entries hold the payer's signing share and the
// signed refund; the wallet and pay-in entries hold spending keys. Nothing in
// here is ever sent to the relay.
//
// The shape matches the Lintel app's localStorage document ("lintel.v1"), so
// state can move between the app and the SDK (and a seller entry can become
// a lintel-agent handoff file).

import type { NoteRecord, Utxo } from './types.js';

export interface SellingEntry {
  title: string;
  /** Merchant state (exportState JSON). SECRET. */
  state: string;
  /** Relay seller token. */
  token: string;
  onchain?: boolean;
  /** Set once the sale was handed to lintel-agent: this device stops acting on it. */
  delegated?: boolean;
  /** On-chain seller progress (field names match lintel-agent's SellerChain). */
  chain?: Record<string, any>;
}

export interface BuyingEntry {
  session: string;
  token: string;
  mode?: 'chain' | 'relay';
  /** T returned by verifyOffer, pinned for this purchase. */
  verifiedT?: string;
  chain?: Record<string, any>;
  /** Off-chain rehearsal state. */
  relay?: Record<string, any>;
  /** Plaintext, hex, once unlocked (kept so a finished purchase can be re-read). */
  plaintextHex?: string;
}

export interface WalletEntry { sk: string; address: string; notes: Array<NoteRecord & { spent?: boolean; spent_by?: string; reserved?: string }> }

export interface PayinEntry {
  sk: string; tsk: string; payment_ua: string; orchard_ua: string; taddr: string;
  listing: string; title: string; amount: number; escrowValue: number; start: number; scanned: number;
  uri: string; uri_t: string; notes: Array<NoteRecord & { spent?: boolean; spent_by?: string; nf?: string }>; utxos: Utxo[];
  created: number; withdrawals?: Array<{ txid: string; to: string; value: number }>;
}

export interface LintelState {
  selling: Record<string, SellingEntry>;
  buying: Record<string, BuyingEntry>;
  wallet?: WalletEntry | null;
  payins?: Record<string, PayinEntry>;
}

/** Where the SDK keeps device-local state. Implement this to use your own storage. */
export interface StateStore {
  load(): Promise<LintelState | null> | LintelState | null;
  save(state: LintelState): Promise<void> | void;
}

export const emptyState = (): LintelState => ({ selling: {}, buying: {}, payins: {} });

/** In-memory store (lost when the process exits). */
export class MemoryStore implements StateStore {
  private doc: string | null = null;
  constructor(initial?: LintelState) { if (initial) this.doc = JSON.stringify(initial); }
  load() { return this.doc ? JSON.parse(this.doc) : null; }
  save(s: LintelState) { this.doc = JSON.stringify(s); }
}

/** Browser localStorage. Key defaults to the app's own ("lintel.v1"). */
export class LocalStorageStore implements StateStore {
  constructor(private readonly key = 'lintel.v1') {}
  load() { try { return JSON.parse(globalThis.localStorage.getItem(this.key) || 'null'); } catch { return null; } }
  save(s: LintelState) { globalThis.localStorage.setItem(this.key, JSON.stringify(s)); }
}

/**
 * Serialises read-modify-write on a StateStore so concurrent SDK calls in one
 * process never lose an update.
 */
export class StateBox {
  private chain: Promise<unknown> = Promise.resolve();
  constructor(private readonly store: StateStore) {}
  async get(): Promise<LintelState> {
    await this.chain.catch(() => {});
    const s = (await this.store.load()) || emptyState();
    s.selling ??= {}; s.buying ??= {}; s.payins ??= {};
    return s;
  }
  /** Applies `fn` and persists. Returns the new state. */
  put(fn: (s: LintelState) => void): Promise<LintelState> {
    const run = this.chain.catch(() => {}).then(async () => {
      const s = (await this.store.load()) || emptyState();
      s.selling ??= {}; s.buying ??= {}; s.payins ??= {};
      fn(s);
      await this.store.save(s);
      return s;
    });
    this.chain = run;
    return run;
  }
}
