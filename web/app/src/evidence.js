// Testnet evidence shown on / and /evidence. Every txid and height comes from
// the public records in docs/testnet/*.json, imported at build time, so the
// pages can't drift from the records. docs/testnet-evidence.md has the prose.
import browserSettle from '../../../docs/testnet/evidence-browser-settle.json';
import browserRefund from '../../../docs/testnet/evidence-browser-refund.json';
import agentSale from '../../../docs/testnet/evidence-agent-sale.json';
import privacySale from '../../../docs/testnet/evidence-session-privacy-sale.json';
import payinT from '../../../docs/testnet/evidence-payin-transparent-sale.json';
import payinZ from '../../../docs/testnet/evidence-payin-shielded-sale.json';
import v2Settle from '../../../docs/testnet/evidence-v2-settle.json';
import v2Refund from '../../../docs/testnet/evidence-v2-refund.json';
import cliSettle from '../../../docs/testnet/evidence-settle.json';
import cliRefund from '../../../docs/testnet/evidence-refund.json';

export const n = (x) => Number(x).toLocaleString('en-US');
export { browserSettle };

const payin = (r) => [
  { step: 'Payment from the other wallet', txid: r.funding_source.payment.txid, h: r.funding_source.payment.height },
  { step: 'Escrow funded from that payment', txid: r.funding.txid, h: r.funding.height },
  { step: 'Settlement by the seller agent', txid: r.settlement.txid, h: r.settlement.height },
  { step: 'Leftovers withdrawn', txid: r.payin_withdraw.txid, h: r.payin_withdraw.height },
];

/** Newest first. `what` is the run, `why` one line on what it shows. */
export const RUNS = [
  {
    id: 'session-privacy', date: '23 Oct', what: 'Single-copy sale, key kept to the buyer',
    why: `After the session-privacy change: lintel-agent sent the settlement partial with the seller’s share masked to the buyer, and only the buyer, reading with its token, could open it and recover t from the mined settlement. A read of the same session with no token returned only the stage and the public txids. Refund lock ${n(privacySale.refund_presigned_before_funding.n_lock_time)}.`,
    rows: [
      { step: 'Escrow funded', txid: privacySale.funding.txid, h: privacySale.funding.height },
      { step: 'Settlement by the agent', txid: privacySale.settlement.txid, h: privacySale.settlement.height },
    ],
  },
  {
    id: 'pay-in-transparent', date: '22 Oct', what: 'Paid from another wallet, transparent receiver',
    why: 'The buyer had no device wallet: a separate wallet paid the app’s ZIP 321 request to a t-address, and the escrow was funded straight from that coin. The seller side was the agent alone.',
    rows: payin(payinT),
  },
  {
    id: 'pay-in-shielded', date: '22 Oct', what: 'Paid from another wallet, Orchard receiver',
    why: 'Same flow, paid as a shielded Ironwood note to the request’s unified address.',
    rows: payin(payinZ),
  },
  {
    id: 'seller-agent', date: '22 Oct', what: 'Seller agent, seller’s browser closed',
    why: `lintel-agent co-signed the time-locked refund (lock ${n(agentSale.refund_presigned_before_funding.n_lock_time)}) before funding, then built, proved and broadcast the settlement. The buyer recovered t from the mined transaction and the content matched its hash.`,
    rows: [
      { step: 'Escrow funded', txid: agentSale.funding.txid, h: agentSale.funding.height },
      { step: 'Settlement by the agent', txid: agentSale.settlement.txid, h: agentSale.settlement.height },
    ],
  },
  {
    id: 'browser-sale', date: '20 Oct', what: 'Browser sale, both sides in the web app',
    why: `Buyer’s device wallet funded the escrow; the seller’s browser broadcast the adaptor-signed settlement; the buyer’s browser read t from it and decrypted. ${Math.floor(browserSettle.elapsed_s / 60)} min ${browserSettle.elapsed_s % 60} s end to end.`,
    rows: [
      { step: 'Escrow funded', txid: browserSettle.funding.txid, h: browserSettle.funding.height },
      { step: 'Settlement', txid: browserSettle.settlement.txid, h: browserSettle.settlement.height },
    ],
  },
  {
    id: 'browser-refund', date: '20 Oct', what: 'Browser refund after the lock',
    why: `An escrow funded from the app and never settled, returned with its pre-signed refund once the chain passed block ${n(browserRefund.n_lock_time)}.`,
    rows: [
      { step: 'Escrow funded', txid: browserRefund.funding_txid, h: browserRefund.funding_height },
      { step: 'Refund', txid: browserRefund.refund_txid, h: browserRefund.refund_height },
    ],
  },
  {
    id: 'time-lock', date: '20 Oct', what: 'Time lock enforced by consensus (CLI, v2)',
    why: `The refund bytes were rejected before block ${n(v2Refund.claim_window.refund_first_valid_height)} (“transaction is locked until after block height”) and mined after it.`,
    rows: [
      { step: 'Settle run: funding', txid: v2Settle.funding.txid, h: v2Settle.funding.height },
      { step: 'Settle run: settlement', txid: v2Settle.settlement.txid, h: v2Settle.settlement.height },
      { step: 'Refund run: funding', txid: v2Refund.funding.txid, h: v2Refund.funding.height },
      { step: 'Refund run: refund', txid: v2Refund.refund.txid, h: v2Refund.refund.height },
    ],
  },
  {
    id: 'first-escrow', date: '20 Oct', what: 'First two-party escrow (CLI, v1)',
    why: 'Escrow note owned by the joint key, so neither side could spend it alone; t recovered from the mined settlement. v1 refunds were not time-locked, which v2 fixed.',
    rows: [
      { step: 'Settle run: funding', txid: cliSettle.funding.txid, h: cliSettle.funding.height },
      { step: 'Settle run: settlement', txid: cliSettle.settlement.txid, h: cliSettle.settlement.height },
      { step: 'Refund run: funding', txid: cliRefund.funding.txid, h: cliRefund.funding.height },
      { step: 'Refund run: refund', txid: cliRefund.refund.txid, h: cliRefund.refund.height },
    ],
  },
];
