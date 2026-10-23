// Amounts and on-chain constants. All values are in zatoshis (1 ZEC = 10^8),
// Zcash TESTNET (TAZ). Constants mirror the app (web/app/src/onchain.js) and
// the engine (lintel::chain); the SDK's tests check them against the WASM
// engine's own chainLockUtxoValue() / chainFee().

/** Value of the buyer's transparent lock coin created by the funding tx (chain::LOCK_UTXO_VALUE). */
export const LOCK_VALUE = 20_000;
/** ZIP 317 fee of the settlement / refund (zip317_fee(2, 0, 0)). */
export const SETTLE_FEE = 10_000;
/** ZIP 317 fee of the funding transaction from the in-app wallet (zip317_fee(2, 0, 1)). */
export const FUND_FEE = 15_000;
/** Settlement expiry E = tip + CLAIM_BLOCKS; the refund is time-locked until E. */
export const CLAIM_BLOCKS = 60;
/** The seller refuses to build or broadcast the settlement within this many blocks of E. */
export const SAFETY_BLOCKS = 10;

/** "0.02" ZEC -> 2000000 zats, exactly (no floats). */
export function zats(zec: string | number): number {
  const m = /^(\d{1,8})(?:\.(\d{1,8}))?$/.exec(String(zec).trim());
  if (!m) throw new Error(`bad amount ${zec}`);
  return Number(m[1]) * 1e8 + Number((m[2] || '').padEnd(8, '0'));
}
/** 2000000 -> "0.02". */
export const fmtZec = (z: number): string => (z / 1e8).toFixed(8).replace(/0+$/, '').replace(/\.$/, '');
/** Escrow note value for a price: the settlement pays price + fee, the rest returns to the buyer. */
export const escrowFor = (priceZats: number): number => priceZats + 2 * SETTLE_FEE;
/** What a purchase from the in-app wallet needs in ONE note: escrow + lock coin + funding fee. */
export const walletNeedFor = (priceZats: number): number => escrowFor(priceZats) + LOCK_VALUE + FUND_FEE;
/** True for a valid relay price string (positive decimal, up to 8 decimals). */
export const isPrice = (s: string): boolean => /^\d{1,8}(\.\d{1,8})?$/.test(s) && Number(s) > 0;
