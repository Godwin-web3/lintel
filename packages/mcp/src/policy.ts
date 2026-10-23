/**
 * Owner-set spending limits for an AI agent: the pure half (no I/O).
 *
 * The owner who runs lintel-mcp writes a policy file. Every tool that can
 * move money checks it (freshly loaded on each call, so the owner can tighten
 * it without a restart) before anything is built, signed or broadcast:
 *
 *   per-purchase cap   the purchase's outlay must not exceed it
 *   per-day cap        outlays in the rolling 24 hours, this one included
 *   allowed sellers    the seller's payout address (the address the
 *                      settlement must pay) must be on the list
 *   allowed listings   optional allow-list of listing ids
 *   expiry             no spending after this instant
 *
 * Amounts are compared in zatoshis. The counted amount is the OUTLAY, what
 * leaves the server's wallet when the escrow is funded: escrow (price + 2 x
 * settlement fee) + lock coin + funding fee. Part of it (the lock coin and
 * the escrow's unused fee) comes back after settlement; counting the full
 * outlay keeps the cap conservative.
 *
 * Honest scope: the limits are enforced by this server, off-chain. They bind
 * the agent because the wallet key lives only in this server's state file,
 * which no tool returns. Anyone with that file is not bound by them.
 * Zcash TESTNET only.
 */
import { zats, fmtZec } from 'lintel-sdk';

export interface Policy {
  agent: string;
  maxPerPurchase: number; // zats
  maxPerDay: number; // zats
  allowedSellers: 'any' | string[];
  allowedListings: 'any' | string[];
  expiresAt: Date | null;
  allowSelling: boolean;
}

export type LoadedPolicy = { mode: 'enforced'; policy: Policy; source: string } | { mode: 'disabled'; reason: string; source: string };

export interface PolicyFile {
  agent?: string;
  maxPerPurchaseZec: string;
  maxPerDayZec: string;
  allowedSellers?: 'any' | string[];
  allowedListings?: 'any' | string[];
  expiresAt?: string | null;
  allowSelling?: boolean;
}

const UA = /^utest1[0-9a-z]+$/;

/** Parses and validates a policy file. Throws with a readable message. */
export function parsePolicy(json: unknown): Policy {
  if (!json || typeof json !== 'object' || Array.isArray(json)) throw new Error('policy must be a JSON object');
  const p = json as Record<string, unknown>;
  const known = new Set(['agent', 'maxPerPurchaseZec', 'maxPerDayZec', 'allowedSellers', 'allowedListings', 'expiresAt', 'allowSelling', '$comment']);
  for (const k of Object.keys(p)) if (!known.has(k)) throw new Error(`unknown policy key "${k}"`);
  const amt = (k: string) => {
    if (typeof p[k] !== 'string') throw new Error(`${k} must be a decimal string, e.g. "0.05"`);
    return zats(p[k] as string);
  };
  const maxPerPurchase = amt('maxPerPurchaseZec');
  const maxPerDay = amt('maxPerDayZec');
  if (maxPerPurchase > maxPerDay) throw new Error('maxPerPurchaseZec cannot exceed maxPerDayZec');
  const list = (k: string, re?: RegExp): 'any' | string[] => {
    const v = p[k];
    if (v === undefined) return k === 'allowedListings' ? 'any' : (() => { throw new Error(`${k} is required ("any" or a list)`); })();
    if (v === 'any') return 'any';
    if (!Array.isArray(v) || !v.every((x) => typeof x === 'string' && (!re || re.test(x)))) throw new Error(`${k} must be "any" or a list of ${re ? 'testnet unified addresses (utest1…)' : 'strings'}`);
    return v as string[];
  };
  let expiresAt: Date | null = null;
  if (p.expiresAt !== undefined && p.expiresAt !== null) {
    if (typeof p.expiresAt !== 'string' || Number.isNaN(Date.parse(p.expiresAt))) throw new Error('expiresAt must be an ISO 8601 date');
    expiresAt = new Date(p.expiresAt);
  }
  return {
    agent: typeof p.agent === 'string' && p.agent ? p.agent : 'agent',
    maxPerPurchase, maxPerDay,
    allowedSellers: list('allowedSellers', UA),
    allowedListings: list('allowedListings'),
    expiresAt,
    allowSelling: p.allowSelling === true,
  };
}

/** Loads the policy from text; a missing or invalid file disables spending (never fails open). */
export function loadPolicy(path: string | undefined, read: (p: string) => string): LoadedPolicy {
  if (!path) return { mode: 'disabled', reason: 'no policy file configured (LINTEL_MCP_POLICY): spending is disabled', source: '(none)' };
  let text: string;
  try { text = read(path); } catch { return { mode: 'disabled', reason: `policy file ${path} not found: spending is disabled`, source: path }; }
  try { return { mode: 'enforced', policy: parsePolicy(JSON.parse(text)), source: path }; }
  catch (e: any) { return { mode: 'disabled', reason: `policy file ${path} is invalid (${e.message}): spending is disabled`, source: path }; }
}

export interface SpendRequest {
  listingId: string;
  outlay: number; // zats
  price: number; // zats
  /** Seller payout address; null before the seller has announced it. */
  seller: string | null;
}

export type Decision = { ok: true } | { ok: false; code: string; reason: string };

/**
 * Checks one purchase against the policy. `spentToday` is the counted outlay
 * of other purchases in the last 24 hours (excluding this one).
 */
export function checkSpend(policy: Policy, req: SpendRequest, spentToday: number, now: Date = new Date()): Decision {
  if (policy.expiresAt && now >= policy.expiresAt) return no('expired', `spending expired at ${policy.expiresAt.toISOString()}`);
  if (policy.allowedListings !== 'any' && !policy.allowedListings.includes(req.listingId)) return no('listing_not_allowed', `listing ${req.listingId} is not on the allowed list`);
  if (req.outlay > policy.maxPerPurchase) return no('over_per_purchase', `outlay ${fmtZec(req.outlay)} TAZ (price ${fmtZec(req.price)} + escrow fees, lock coin, funding fee) exceeds the per-purchase cap of ${fmtZec(policy.maxPerPurchase)} TAZ`);
  if (spentToday + req.outlay > policy.maxPerDay) return no('over_per_day', `outlay ${fmtZec(req.outlay)} TAZ would bring the last 24 hours to ${fmtZec(spentToday + req.outlay)} TAZ, over the daily cap of ${fmtZec(policy.maxPerDay)} TAZ`);
  if (req.seller !== null && policy.allowedSellers !== 'any' && !policy.allowedSellers.includes(req.seller)) return no('seller_not_allowed', `seller payout address ${req.seller.slice(0, 20)}… is not on the allowed list`);
  return { ok: true };
}
const no = (code: string, reason: string): Decision => ({ ok: false, code, reason });

/** Plain-language summary for lintel_get_limits. */
export function describe(policy: Policy, spentToday: number) {
  return {
    agent: policy.agent,
    per_purchase_cap_taz: fmtZec(policy.maxPerPurchase),
    per_day_cap_taz: fmtZec(policy.maxPerDay),
    spent_last_24h_taz: fmtZec(spentToday),
    remaining_today_taz: fmtZec(Math.max(0, policy.maxPerDay - spentToday)),
    allowed_sellers: policy.allowedSellers,
    allowed_listings: policy.allowedListings,
    expires_at: policy.expiresAt?.toISOString() ?? null,
    selling_allowed: policy.allowSelling,
    counted_amount: 'outlay at funding: price + 2 x settlement fee (escrow) + lock coin + funding fee',
  };
}
