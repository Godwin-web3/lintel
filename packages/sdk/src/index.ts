// lintel-sdk: platform-neutral API. Import from 'lintel-sdk' (Node and
// browser builds resolve automatically) and call createLintel().

export { Lintel, type LintelOptions, type VerifyResult } from './lintel.js';
export { RelayClient, RelayError, HOSTED_RELAY, sha256hex, type FetchLike, type NewListing } from './relay.js';
export { Engine, bytesToHex, hexToBytes, type Platform, type SealResult, type SealProgress } from './engine.js';
export { Purchase, type BuyOptions, type ApproveInfo, type BuyPhase, type BuyStep, type RefundStatus } from './buyer.js';
export { Sale, type SellInput, type SellResult, type SalePhase, type SaleStep, type AgentHandoff } from './seller.js';
export { Wallet, PayIn, type WalletInfo, type PaymentRequest, type PayinStatus } from './wallet.js';
export { listingStatus, txids, txUrl, type ListingPhase, type ListingStatus } from './status.js';
export { MemoryStore, LocalStorageStore, emptyState, type StateStore, type LintelState, type SellingEntry, type BuyingEntry } from './store.js';
export { zats, fmtZec, escrowFor, walletNeedFor, isPrice, LOCK_VALUE, SETTLE_FEE, FUND_FEE, CLAIM_BLOCKS, SAFETY_BLOCKS } from './amounts.js';
export type * from './types.js';

import type { Lintel, LintelOptions } from './lintel.js';
/** Creates a client. Provided by the platform entry (node.js / browser.js). */
export declare function createLintel(opts?: LintelOptions): Promise<Lintel>;
