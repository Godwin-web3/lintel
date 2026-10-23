// Wire types of the Lintel relay (web/relay/server.js). Everything here is
// PUBLIC protocol data: the relay never holds keys, the adaptor secret t, or
// plaintext.

/** Hex string (lowercase, even length). */
export type Hex = string;

/** Listing status as the relay reports it. */
export type ListingStatusValue = 'open' | 'pending' | 'sold';

/** A single-copy listing (no `version`), the kind that settles on chain. */
export interface Listing {
  id: string;
  created_at: number;
  status: ListingStatusValue;
  title: string;
  description: string;
  /** Decimal ZEC string, up to 8 decimals (e.g. "0.02"). Testnet TAZ. */
  price_zec: string;
  /** Hash of the plaintext the proof commits to (field element, hex). */
  content_hash: Hex;
  /** Seller's verification key share for this listing (32-byte hex). */
  merchant_vk: Hex;
  /** Adaptor point T (32-byte hex). The secret t behind it decrypts the offer. */
  t_point: Hex;
  /** Sealed offer JSON (ciphertext + Halo 2 proof, or a v3 manifest). Absent in list views. */
  offer?: string;
  filename: string | null;
  size: number;
  session_id: string | null;
  version?: undefined;
}

/** A presale (v2) listing: several copies, each with its own secret. */
export interface PresaleListing {
  id: string;
  version: 2;
  created_at: number;
  status: ListingStatusValue;
  title: string;
  description: string;
  price_zec: string;
  content_hash: Hex;
  filename: string | null;
  size: number;
  units?: Array<{ index: number; t_point: Hex; merchant_vk: Hex; r_b: Hex; pok: string; state: 'open' | 'ordered' | 'sold'; order_id: string | null; offer?: string }>;
  units_total: number;
  units_open: number;
  units_sold: number;
}

export type AnyListing = Listing | PresaleListing;

/** Public on-chain settlement fields, write-once, posted by each side. */
export interface ChainFields {
  payer_contrib?: Hex;
  payer_pok?: string;
  payer_address?: string;
  funding_txid?: Hex;
  refund_terms?: string;
  refund_pczt?: string;
  refund_r_a?: Hex;
  settle_r_a?: Hex;
  merchant_contrib?: Hex;
  merchant_address?: string;
  escrow_address?: string;
  refund_partial?: string;
  settle_terms?: string;
  settle_pczt?: string;
  settle_txid?: Hex;
}

export type ChainField = keyof ChainFields;

/** A purchase session on a single-copy listing. */
export interface Session {
  id: string;
  listing_id: string;
  created_at: number;
  /** 'chain': settles on Zcash testnet. 'relay': off-chain rehearsal, no funds move. */
  mode: 'chain' | 'relay';
  payer_vk: Hex;
  r_a: Hex | null;
  alpha: Hex | null;
  sighash: Hex | null;
  partial: string | null;
  merchant_pok: string | null;
  presig: string | null;
  signature: Hex | null;
  chain?: ChainFields;
  /**
   * Set when the relay served the status view (no buyer or seller token):
   * only id, listing_id, created_at, mode, `stage` and the public funding /
   * settlement txids are present.
   */
  redacted?: true;
  /** Status view only: which signing steps have happened. */
  stage?: { partial: boolean; presig: boolean; signature: boolean };
}

export interface ListingDetail {
  listing: AnyListing;
  session: Session | null;
}

/** Raw mined transaction from the relay's lightwalletd proxy. */
export interface ChainTx {
  /** Hex bytes of the transaction. */
  data: string;
  height: number;
  mined: boolean;
}

export interface BroadcastResult {
  accepted: boolean;
  error_code: number;
  error_message: string;
  already_known?: boolean;
}

/** An Ironwood note the engine found for a key (public fields + position data). */
export interface NoteRecord {
  cmx: Hex;
  value: number;
  height: number;
  txid?: Hex;
  recipient?: string;
  [k: string]: unknown;
}

/** A transparent coin of a pay-in wallet. */
export interface Utxo {
  txid: Hex;
  vout: number;
  value: number;
  height: number;
  spent_by?: string;
  [k: string]: unknown;
}

/** Data the engine returns after checking a PCZT against agreed terms. */
export interface SigningInfo {
  sighash: Hex;
  alpha: Hex;
  rk: Hex;
  txid: Hex;
  action_index: number;
  [k: string]: unknown;
}

export interface SpendTerms {
  kind: 'fund' | 'refund' | 'settle';
  pay_to: string;
  amount: number;
  change_to: string | null;
  target_height?: number;
  expiry_height: number;
  t_out?: { address: string; value: number };
  lock?: { txid: Hex; vout: number; value: number; address: string; lock_height: number };
}
