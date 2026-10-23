/**
 * lintel-mcp: Lintel for AI agents over the Model Context Protocol.
 *
 * An agent can browse listings, verify their Halo 2 proofs locally, buy
 * sealed data on Zcash testnet under the owner's spending limits, and sell
 * (seal + list, then finish the sale here or hand it to lintel-agent).
 *
 * Keys stay in this server: the wallet spending key, payer/seller signing
 * shares, adaptor secrets and signed refunds live in the state file
 * (LINTEL_MCP_STATE, mode 0600). No tool returns them. Decrypted purchases are
 * written to LINTEL_MCP_OUT; small text is also returned inline.
 */
import { mkdirSync, readFileSync, writeFileSync, realpathSync } from 'node:fs';
import { join, resolve, sep, basename } from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { fmtZec, listingStatus, walletNeedFor, zats, type Lintel, type BuyStep, type ApproveInfo, type Listing } from 'lintel-sdk';
import { checkSpend, describe, loadPolicy, type LoadedPolicy } from './policy.js';
import { SpendLog } from './spendlog.js';
import { VERSION } from './version.js';

export interface ServerConfig {
  lintel: Lintel;
  /** Policy file path (owner-written). Missing = spending disabled. */
  policyPath?: string;
  spendLogPath: string;
  /** Where decrypted purchases are saved. */
  outDir: string;
  /** Directory the agent may sell files from (lintel_sell path=). Unset = text only. */
  filesDir?: string;
  /** Where lintel_handoff_to_agent writes handoff files (SECRET, 0600). */
  handoffDir: string;
  /** 'chain' (Zcash testnet escrow) or 'relay' (off-chain rehearsal, no funds move). */
  mode: 'chain' | 'relay';
  now?: () => Date;
}

export const ENFORCED_BY = 'Enforced by this MCP server before anything is built, signed or broadcast (off-chain). The wallet key lives only in this server\'s state file and no tool returns it, so the limits bind the agent. Zcash testnet only.';

const text = (v: unknown) => ({ content: [{ type: 'text' as const, text: typeof v === 'string' ? v : JSON.stringify(v, null, 2) }] });
const fail = (msg: string) => ({ ...text({ error: msg }), isError: true });
const ID = z.string().min(1).max(64).regex(/^[\w-]+$/, 'listing id');
const PRICE = z.string().regex(/^\d{1,8}(\.\d{1,8})?$/, 'decimal TAZ, e.g. "0.02"');

class Refused extends Error { constructor(readonly code: string, msg: string) { super(msg); } }

export function createServer(cfg: ServerConfig): McpServer {
  const { lintel } = cfg;
  const log = new SpendLog(cfg.spendLogPath);
  const now = cfg.now ?? (() => new Date());
  const policy = (): LoadedPolicy => loadPolicy(cfg.policyPath, (p) => readFileSync(p, 'utf8'));
  const server = new McpServer({ name: 'lintel', version: VERSION });

  /** The approve hook every purchase runs with: policy re-read, seller checked, before build and before broadcast. */
  const approver = (title: string) => async (a: ApproveInfo) => {
    const p = policy();
    if (p.mode !== 'enforced') throw new Refused('disabled', p.reason);
    const d = checkSpend(p.policy, { listingId: a.listingId, outlay: a.outlayZats, price: a.priceZats, seller: a.sellerAddress }, log.spentSince(now(), a.listingId), now());
    if (!d.ok) throw new Refused(d.code, d.reason);
    if (a.stage === 'broadcast') log.append({ id: a.listingId, listing: a.listingId, title, status: 'reserved', seller: a.sellerAddress, outlay_zats: a.outlayZats, price_zats: a.priceZats, reason: 'seller approved; broadcasting funding' });
  };

  /** Steps a purchase, keeping the spend log in sync; on a policy refusal cancels it (nothing has moved). */
  async function advance(listingId: string, waitS: number) {
    const { listing } = await lintel.listing(listingId);
    const purchase = lintel.buy(listingId, { mode: cfg.mode, approve: approver(listing.title) });
    const deadline = Date.now() + Math.min(Math.max(waitS, 0), 300) * 1000;
    const steps: Array<Pick<BuyStep, 'phase' | 'note'>> = [];
    let s: BuyStep;
    for (;;) {
      try { s = await purchase.step(); }
      catch (e: any) {
        if (e instanceof Refused) {
          await purchase.cancel().catch(() => {});
          log.append({ id: listingId, listing: listingId, status: 'refused', reason: e.message });
          log.append({ id: listingId, listing: listingId, status: 'released', reason: `policy: ${e.code}` });
          return { refused: true, code: e.code, reason: e.message, note: 'Purchase cancelled before any funds moved.' };
        }
        throw e;
      }
      steps.push({ phase: s.phase, note: s.note });
      if (s.txids.funding && log.status(listingId) === 'reserved') log.append({ id: listingId, listing: listingId, status: 'funded', txid: s.txids.funding });
      if (s.done || Date.now() >= deadline) break;
      if (steps.length > 1 && steps[steps.length - 2].note === s.note) await new Promise((r) => setTimeout(r, 3000));
    }
    const out: Record<string, unknown> = { listing_id: listingId, phase: s.phase, note: s.note, steps, txids: s.txids };
    if (s.refund) out.refund = s.refund;
    if (s.done && s.plaintext) {
      if (log.status(listingId) !== 'settled') log.append({ id: listingId, listing: listingId, status: 'settled', txid: s.txids.settlement });
      mkdirSync(cfg.outDir, { recursive: true, mode: 0o700 });
      const name = safeName((listing as Listing).filename || `${listingId}.bin`);
      const file = join(cfg.outDir, `${listingId}-${name}`);
      writeFileSync(file, s.plaintext, { mode: 0o600 });
      out.saved_to = file;
      out.bytes = s.plaintext.length;
      const t = utf8(s.plaintext);
      if (t !== null && t.length <= 8000) out.content = t;
    }
    return out;
  }

  // ------------------------------------------------------------ browse & verify
  server.registerTool('lintel_list_listings', {
    title: 'List Lintel listings',
    description: 'Lists sealed-data listings on the relay (Zcash testnet). Each has a title, a price in TAZ, a size, and a status (open / pending / sold). Use lintel_verify_listing before buying.',
    inputSchema: { status: z.enum(['open', 'pending', 'sold', 'any']).optional().describe('Filter by status (default open)'), limit: z.number().int().min(1).max(200).optional() },
  }, async ({ status = 'open', limit = 50 }) => {
    const all = await lintel.listings();
    const rows = all.filter((l) => status === 'any' || l.status === status).slice(0, limit).map((l: any) => ({
      id: l.id, title: l.title, description: (l.description || '').slice(0, 300), price_taz: l.price_zec, size_bytes: l.size, status: l.status,
      kind: l.version === 2 ? `presale (${l.units_open}/${l.units_total} copies open)` : 'single copy', created_at: new Date(l.created_at).toISOString(),
    }));
    return text({ relay: lintel.relay.url, count: rows.length, listings: rows });
  });

  server.registerTool('lintel_get_listing', {
    title: 'Get a listing',
    description: 'One listing with where its sale stands (phase, funding and settlement txids).',
    inputSchema: { listingId: ID },
  }, async ({ listingId }) => {
    const { listing, session } = await lintel.listing(listingId);
    const { offer, ...pub } = listing as any;
    return text({ listing: { ...pub, offer_bytes: offer?.length ?? 0 }, status: listingStatus(listing, session) });
  });

  server.registerTool('lintel_verify_listing', {
    title: 'Verify a listing\'s proof',
    description: 'Fetches the sealed offer and verifies its Halo 2 proof(s) on this server against the listing\'s content hash: the ciphertext provably decrypts, under the secret the purchase will reveal, to content with that hash. Big files are checked part by part. Read-only, no spending.',
    inputSchema: { listingId: ID },
  }, async ({ listingId }) => {
    try { return text({ verified: true, ...(await lintel.verify(listingId)) }); }
    catch (e: any) { return text({ verified: false, listing_id: listingId, error: e.message }); }
  });

  // ------------------------------------------------------------ limits & ledger
  server.registerTool('lintel_get_limits', {
    title: 'Get spending limits',
    description: 'The owner-set limits this agent buys under, what has been spent in the last 24 hours, and what remains. The agent cannot change them.',
    inputSchema: {},
  }, async () => {
    const p = policy();
    if (p.mode !== 'enforced') return text({ spending: 'disabled', reason: p.reason });
    return text({ spending: 'enabled', source: p.source, ...describe(p.policy, log.spentSince(now())), enforced_by: ENFORCED_BY });
  });

  server.registerTool('lintel_spending_report', {
    title: 'Spending report',
    description: 'Every purchase attempt this server logged (refusals included), newest first.',
    inputSchema: { days: z.number().int().min(1).max(365).optional() },
  }, async ({ days = 7 }) => {
    const since = now().getTime() - days * 86400000;
    const entries = log.entries().filter((e) => Date.parse(e.at) >= since).reverse()
      .map((e) => ({ ...e, ...(e.outlay_zats !== undefined ? { outlay_taz: fmtZec(e.outlay_zats) } : {}), ...(e.price_zats !== undefined ? { price_taz: fmtZec(e.price_zats) } : {}) }));
    return text({ spent_last_24h_taz: fmtZec(log.spentSince(now())), entries });
  });

  // ------------------------------------------------------------ wallet
  server.registerTool('lintel_wallet', {
    title: 'Wallet',
    description: 'The server\'s testnet wallet: its receiving address and spendable balance. The key never leaves the server. The owner funds it (testnet faucet), then lintel_wallet_scan adds the payment.',
    inputSchema: {},
  }, async () => {
    const info = await lintel.wallet.info();
    if (!info) return text({ wallet: null, note: 'No wallet yet. The owner creates one with `lintel-mcp wallet create` (or LINTEL_MCP_CREATE_WALLET=1).' });
    return text({ address: info.address, balance_taz: fmtZec(info.balance), notes: info.spendable.map((n) => ({ value_taz: fmtZec(n.value), height: n.height })) });
  });

  server.registerTool('lintel_wallet_scan', {
    title: 'Scan a transaction into the wallet',
    description: 'Adds the wallet\'s notes from a mined testnet transaction (e.g. a faucet payment to the wallet address).',
    inputSchema: { txid: z.string().regex(/^[0-9a-f]{64}$/) },
  }, async ({ txid }) => {
    const found = await lintel.wallet.scan(txid);
    return text({ found: found.map((n) => ({ value_taz: fmtZec(n.value), height: n.height })), balance_taz: fmtZec(await lintel.wallet.balance()) });
  });

  // ------------------------------------------------------------ buy
  server.registerTool('lintel_buy', {
    title: 'Buy a listing',
    description: `Starts buying a single-copy listing ${cfg.mode === 'chain' ? 'on Zcash testnet: the proof is verified first, then a two-party escrow is funded from the server wallet with a co-signed time-locked refund kept as a fallback' : 'as an off-chain rehearsal (no funds move)'}. Checked against the owner's limits before anything is built and again before the funding is broadcast. Then call lintel_purchase_status until phase is "done"; the decrypted content is saved on the server and small text returned.`,
    inputSchema: { listingId: ID, maxPriceTaz: PRICE.optional().describe('Your own ceiling on the price; refused if the listing costs more'), waitSeconds: z.number().int().min(0).max(300).optional() },
  }, async ({ listingId, maxPriceTaz, waitSeconds = 20 }) => {
    const p = policy();
    if (p.mode !== 'enforced') return fail(p.reason);
    const { listing } = await lintel.listing(listingId);
    if ((listing as any).version === 2) return fail('presale (multi-copy) listings cannot be bought through lintel-mcp yet');
    const already = log.status(listingId);
    if (already && already !== 'released' && already !== 'refunded') return text({ note: `already ${already}; use lintel_purchase_status`, ...(await advance(listingId, 0)) });
    const price = zats(listing.price_zec);
    const outlay = walletNeedFor(price);
    if (maxPriceTaz && price > zats(maxPriceTaz)) {
      log.append({ id: listingId, listing: listingId, title: listing.title, status: 'refused', price_zats: price, outlay_zats: outlay, reason: `price ${listing.price_zec} over the agent's own maxPriceTaz ${maxPriceTaz}` });
      return fail(`price ${listing.price_zec} TAZ is over your maxPriceTaz ${maxPriceTaz}`);
    }
    const d = checkSpend(p.policy, { listingId, outlay, price, seller: null }, log.spentSince(now()), now());
    if (!d.ok) {
      log.append({ id: listingId, listing: listingId, title: listing.title, status: 'refused', price_zats: price, outlay_zats: outlay, reason: d.reason });
      return fail(`refused by the owner's limits (${d.code}): ${d.reason}`);
    }
    if (listing.status !== 'open') return fail(`listing is ${listing.status}`);
    log.append({ id: listingId, listing: listingId, title: listing.title, status: 'reserved', price_zats: price, outlay_zats: outlay, reason: 'within limits; seller check pending' });
    try { return text(await advance(listingId, waitSeconds)); }
    catch (e: any) {
      const sid = await lintel.buy(listingId).sessionId().catch(() => null);
      if (!sid) log.append({ id: listingId, listing: listingId, status: 'released', reason: `could not start: ${e.message}` });
      return fail(e.message);
    }
  });

  server.registerTool('lintel_purchase_status', {
    title: 'Advance / check a purchase',
    description: 'Advances a purchase as far as it can go (waiting up to waitSeconds) and reports its phase. On-chain purchases take several blocks (about 75 s each). When phase is "done" the content has been decrypted with the key read from the mined settlement.',
    inputSchema: { listingId: ID, waitSeconds: z.number().int().min(0).max(300).optional() },
  }, async ({ listingId, waitSeconds = 30 }) => {
    if (!(await lintel.buying()).includes(listingId)) return fail('no purchase of this listing on this server');
    try { return text(await advance(listingId, waitSeconds)); } catch (e: any) { return fail(e.message); }
  });

  server.registerTool('lintel_refund', {
    title: 'Refund a purchase',
    description: 'Broadcasts the co-signed refund of an on-chain purchase the seller never settled. Valid only after its lock height (the network enforces it).',
    inputSchema: { listingId: ID },
  }, async ({ listingId }) => {
    try {
      const txid = await lintel.buy(listingId).refund();
      log.append({ id: listingId, listing: listingId, status: 'refunded', txid });
      return text({ refund_txid: txid });
    } catch (e: any) { return fail(e.message); }
  });

  // ------------------------------------------------------------ sell
  server.registerTool('lintel_sell', {
    title: 'Seal and list data for sale',
    description: 'Seals content on this server (encrypts it and proves with Halo 2 that the ciphertext opens to content with the listed hash) and lists it on the relay. Give `text`, or `path` to a file inside the owner\'s allowed directory. Then lintel_sale_status finishes sales here, or lintel_handoff_to_agent hands the listing to lintel-agent.',
    inputSchema: {
      title: z.string().min(1).max(120), priceTaz: PRICE, description: z.string().max(2000).optional(),
      text: z.string().max(1_523_681).optional(), path: z.string().max(1024).optional(), filename: z.string().max(120).optional(),
    },
  }, async (a) => {
    const p = policy();
    if (p.mode !== 'enforced' || !p.policy.allowSelling) return fail('selling is not allowed by the owner\'s policy (allowSelling)');
    if ((a.text === undefined) === (a.path === undefined)) return fail('give exactly one of text or path');
    let data: Uint8Array | string, filename = a.filename;
    if (a.path !== undefined) {
      if (!cfg.filesDir) return fail('selling files is not enabled (LINTEL_MCP_FILES)');
      const full = insideDir(cfg.filesDir, a.path);
      if (!full) return fail('path is outside the allowed directory');
      data = readFileSync(full);
      filename ??= basename(full);
    } else data = a.text!;
    const r = await lintel.sell({ title: a.title, price: a.priceTaz, description: a.description, filename, data });
    return text({ listing_id: r.listing.id, title: r.listing.title, price_taz: r.listing.price_zec, size_bytes: r.listing.size, proof: r.kind, seal_ms: r.sealMs, next: 'lintel_sale_status (finish sales here) or lintel_handoff_to_agent' });
  });

  server.registerTool('lintel_sale_status', {
    title: 'Advance / check a sale',
    description: 'Answers the buyer of one of this server\'s listings as far as possible (waiting up to waitSeconds): checks their key proof, co-signs the time-locked refund, builds and broadcasts the settlement once the escrow is mined. Payment goes to the server wallet.',
    inputSchema: { listingId: ID, waitSeconds: z.number().int().min(0).max(300).optional() },
  }, async ({ listingId, waitSeconds = 30 }) => {
    if (!(await lintel.selling()).includes(listingId)) return fail('this server does not sell that listing');
    const sale = lintel.sale(listingId);
    const deadline = Date.now() + waitSeconds * 1000;
    const steps: unknown[] = [];
    try {
      for (;;) {
        const s = await sale.step();
        steps.push({ phase: s.phase, note: s.note });
        if (s.done || s.phase === 'delegated' || s.phase === 'listed' || Date.now() >= deadline) return text({ listing_id: listingId, ...s, steps });
        await new Promise((r) => setTimeout(r, 3000));
      }
    } catch (e: any) { return fail(e.message); }
  });

  server.registerTool('lintel_handoff_to_agent', {
    title: 'Hand a listing to lintel-agent',
    description: 'Writes a lintel-agent handoff file for one of this server\'s listings to the owner\'s handoff directory (the file holds the listing\'s secrets; it is never returned here) and stops this server from acting on that sale. The owner then runs `lintel-agent import <file>` and `lintel-agent run`.',
    inputSchema: { listingId: ID },
  }, async ({ listingId }) => {
    if (!(await lintel.selling()).includes(listingId)) return fail('this server does not sell that listing');
    try {
      const h = await lintel.sale(listingId).handoff();
      mkdirSync(cfg.handoffDir, { recursive: true, mode: 0o700 });
      const file = join(cfg.handoffDir, `lintel-handoff-${listingId}.json`);
      writeFileSync(file, JSON.stringify(h, null, 2), { mode: 0o600 });
      return text({ handoff_file: file, payout_address: h.payout_address, next: `lintel-agent import ${file} && lintel-agent run` });
    } catch (e: any) { return fail(e.message); }
  });

  return server;
}

function utf8(b: Uint8Array): string | null { try { return new TextDecoder('utf-8', { fatal: true }).decode(b); } catch { return null; } }
const safeName = (s: string) => s.replace(/[^\w.-]+/g, '_').slice(0, 100) || 'content.bin';
function insideDir(dir: string, p: string): string | null {
  try {
    const root = realpathSync(dir);
    const full = realpathSync(resolve(root, p));
    return full === root || !full.startsWith(root + sep) ? null : full;
  } catch { return null; }
}
