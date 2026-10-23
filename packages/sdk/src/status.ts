// Pure helpers over PUBLIC relay data: where a listing's sale stands and
// which transactions it produced. No engine, no network.

import type { AnyListing, Session } from './types.js';

export type ListingPhase =
  | 'open' // no buyer
  | 'joined' // buyer joined, key exchange in progress
  | 'escrow_announced' // seller bound and announced the escrow address
  | 'refund_cosigned' // seller co-signed the time-locked refund; buyer may fund
  | 'funding_broadcast' // buyer broadcast the funding
  | 'settlement_built' // seller posted the settlement PCZT
  | 'presigned' // buyer pre-signed, locked to T
  | 'settled' // settlement txid posted (on chain) or signature published (rehearsal)
  | 'presale'; // multi-copy listing (see units_open / units_sold)

export interface ListingStatus {
  phase: ListingPhase;
  /** Relay status: open | pending | sold. */
  status: string;
  mode: 'chain' | 'relay' | null;
  txids: { funding?: string; settlement?: string };
  /** Human-readable one-liner. */
  label: string;
}

const LABEL: Record<ListingPhase, string> = {
  open: 'Open: no buyer yet',
  joined: 'Buyer joined; exchanging key proofs',
  escrow_announced: 'Escrow address announced; buyer building funding and refund',
  refund_cosigned: 'Refund co-signed; waiting for the buyer to fund',
  funding_broadcast: 'Escrow funding broadcast',
  settlement_built: 'Settlement built; signing in progress',
  presigned: 'Buyer pre-signed; waiting for the seller to broadcast',
  settled: 'Settled',
  presale: 'Presale listing',
};

/** Where a listing's sale stands, from the relay's public listing + session. */
export function listingStatus(listing: AnyListing, session: Session | null): ListingStatus {
  if ((listing as any).version === 2) return { phase: 'presale', status: listing.status, mode: null, txids: {}, label: LABEL.presale };
  const t = txids(session);
  const done = (phase: ListingPhase): ListingStatus => ({ phase, status: listing.status, mode: session?.mode ?? null, txids: t, label: LABEL[phase] });
  if (!session) return done('open');
  if (session.redacted) {
    // status view (no token): stage flags and public txids only
    const st = session.stage || { partial: false, presig: false, signature: false };
    if (session.chain?.settle_txid || st.signature) return done('settled');
    if (st.presig) return done('presigned');
    if (session.mode === 'chain' && st.partial) return done('settlement_built');
    if (session.chain?.funding_txid) return done('funding_broadcast');
    return done('joined');
  }
  if (session.mode === 'relay') {
    if (session.signature) return done('settled');
    if (session.presig) return done('presigned');
    return done('joined');
  }
  const ch = session.chain || {};
  if (ch.settle_txid) return done('settled');
  if (session.presig) return done('presigned');
  if (ch.settle_pczt) return done('settlement_built');
  if (ch.funding_txid) return done('funding_broadcast');
  if (ch.refund_partial) return done('refund_cosigned');
  if (ch.escrow_address) return done('escrow_announced');
  return done('joined');
}

/** Funding and settlement txids a session has published. */
export function txids(session: Session | null): { funding?: string; settlement?: string } {
  const ch = session?.chain || {};
  return { ...(ch.funding_txid ? { funding: ch.funding_txid } : {}), ...(ch.settle_txid ? { settlement: ch.settle_txid } : {}) };
}

/** Relay URL of a raw mined transaction (public; any lightwalletd gives the same bytes). */
export const txUrl = (relayUrl: string, txid: string) => `${relayUrl.replace(/\/$/, '')}/chain/tx/${txid}`;
