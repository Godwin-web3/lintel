// Lintel relay: stores and forwards PUBLIC protocol data only.
//
// What it holds: listing metadata, sealed offers (ciphertext + Halo 2 proof),
// verification keys, nonce points, partial signatures, pre-signatures and the
// final signature. What it never holds: signing shares, the adaptor secret t,
// plaintext, or anything that lets it decrypt or sign. For on-chain
// settlement it also proxies raw mined transactions from lightwalletd
// (GET /chain/tx/:txid) and stores public settlement fields. Every value it relays is
// re-verified in the browser, so a malicious relay can stall a sale but cannot
// forge one.
//
// Writes are write-once and gated by bearer tokens the relay hands out:
// seller_token (on listing creation) and buyer_token (on session creation).
//
// Session reads (GET /sessions/:id, and the session in GET /listings/:id)
// return the full record only with the session's buyer or seller token;
// anyone else gets a status view (stage flags and the public txids). This is
// defence in depth, not the privacy boundary: the settlement partial is
// stored with s_b masked to the buyer (partial wire v2), so even the full
// record plus the mined settlement does not give t. A plain (v1) partial is
// accepted only for the refund, whose adaptor point is the identity.
//
// Two listing kinds:
// * v1 (no `version`): one adaptor secret, one sale, interactive (seller online
//   for each step). Routes /listings/:id/sessions and /sessions/:id/*.
// * v2 (`version: 2`, presale): up to MAX_UNITS copies, each with its own
//   adaptor secret, key share and pre-committed nonce. A buyer orders a unit and
//   pre-signs in one request; the seller completes later in one request. The
//   relay never receives t, s_b in the clear, or anything else that yields t.
//   Routes /listings/:id/units*, /orders/:id*.
//
// Persistence is pluggable (see storage.js): RELAY_STORAGE=file|memory|upstash.

import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { createStorage } from './storage.js';
import { createBlobStore, BLOB_ID, sha256hex } from './blobs.js';
import * as lwd from './lwd.js';
export { decodeRawTransaction } from './lwd.js';

const PORT = Number(process.env.PORT || 8787);
const DATA = process.env.DATA_FILE || path.join(process.cwd(), 'data.json');
const ORIGINS = (process.env.ALLOWED_ORIGINS || '*').split(',').map((s) => s.trim());
const MAX_BODY = 64 * 1024;
const MAX_UNITS = Number(process.env.MAX_UNITS || 20);
const MAX_PAYLOAD_V2 = 7905; // lintel_wasm.maxPayloadV2(): 4 parts x 64 chunks x 31 bytes - 31
// Offer v3 (big payloads, lintel_wasm.maxPayloadBig()): up to 64 proven parts
// of 768 field elements each; ciphertext + proofs live in content-addressed
// blobs (PUT/GET /blobs/:sha256), the listing keeps only the manifest.
const MAX_PAYLOAD_BIG = 1523681; // (768 * 64 - 1) * 31
const BIG_N = 768, BIG_MAX_PARTS = 64;
const MAX_BLOB = Number(process.env.MAX_BLOB || 48 * 1024); // one part: 48 + 768*32 + ~4.5 KB proof
const MAX_LISTINGS = Number(process.env.MAX_LISTINGS || 5000);

export const storage = createStorage({ ...process.env, DATA_FILE: DATA });
export const blobs = createBlobStore({ ...process.env, DATA_FILE: DATA });
const db = await storage.load();
// save(): something changed; the backend persists only records whose JSON
// differs from what it last wrote. touch(): the exact records that changed.
function save() { storage.touchAll(); }
const touch = (...recs) => { for (const [c, id] of recs) storage.touch(c, id); };

const id = () => crypto.randomBytes(9).toString('base64url');
const token = () => crypto.randomBytes(24).toString('base64url');
const hashTok = (t) => crypto.createHash('sha256').update(String(t)).digest('hex');
const tokOk = (given, stored) => {
  if (!given || !stored) return false;
  const a = Buffer.from(hashTok(given)), b = Buffer.from(stored);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
};

// ---- validation ----
const HEX = /^[0-9a-f]+$/;
const isHex = (v, len) => typeof v === 'string' && HEX.test(v) && (len ? v.length === len : v.length > 0 && v.length % 2 === 0);
const str = (v, max) => typeof v === 'string' && v.length > 0 && v.length <= max;
const jsonStr = (v, max) => { if (typeof v !== 'string' || v.length > max) return false; try { JSON.parse(v); return true; } catch { return false; } };
class Bad extends Error { constructor(m, code = 400) { super(m); this.code = code; } }
const need = (cond, msg) => { if (!cond) throw new Bad(msg); };

// Offer v3 manifest: shape checks here, and every blob it names must already
// be uploaded. The proofs themselves are checked by the buyer's app.
// Returns the payload ceiling the offer allows.
async function checkOffer(offerStr) {
  let o; try { o = JSON.parse(offerStr); } catch { throw new Bad('offer must be JSON'); }
  if (!o || o.v !== 3) { // v1/v2 offers carry everything inline
    need(o?.predicates === undefined, 'claims (predicates) need an offer v3');
    return null;
  }
  checkPredicates(o.predicates);
  need(o.n === BIG_N, `offer v3 parts must hold ${BIG_N} elements`);
  need(isHex(o.t_point, 64) && isHex(o.content_hash, 64), 'offer v3 needs t_point and content_hash');
  need(Array.isArray(o.parts) && o.parts.length >= 1 && o.parts.length <= BIG_MAX_PARTS, `offer v3 has 1..${BIG_MAX_PARTS} parts`);
  for (const [j, p] of o.parts.entries()) {
    need(p && isHex(p.hash, 64) && BLOB_ID.test(p.blob) && p.offset === j * BIG_N / 2, `offer v3 part ${j} is malformed`);
    need(Number.isInteger(p.len) && p.len > 0 && p.len <= MAX_BLOB, `offer v3 part ${j} has a bad length`);
    need(p.data === undefined, 'upload blobs to /blobs; the offer carries only the manifest');
    need(await blobs.has(p.blob), `blob ${p.blob.slice(0, 12)}… is not uploaded`);
  }
  return MAX_PAYLOAD_BIG;
}

// Claims proven in part 0 of an offer v3 (engine `predicate::Claim`). Shape
// checks only; the buyer's app verifies the proof against them, and a claim
// changed here would make that proof fail.
const CLAIM_LEN_LIMIT = 2 ** 40;
function checkPredicates(ps) {
  if (ps === undefined) return;
  need(Array.isArray(ps) && ps.length >= 1 && ps.length <= 3, 'offer v3 predicates: 1..3 claims');
  let lengths = 0, bytes = 0;
  const uint = (v) => Number.isSafeInteger(v) && v >= 0;
  for (const c of ps) {
    need(c && typeof c === 'object' && !Array.isArray(c), 'claim must be an object');
    const keys = Object.keys(c).sort().join(',');
    if (c.id === 'length') {
      need(keys === 'id,max,min' && uint(c.min) && uint(c.max) && c.min <= c.max && c.max < CLAIM_LEN_LIMIT, 'length claim needs 0 <= min <= max < 2^40');
      lengths++;
    } else if (c.id === 'prefix' || c.id === 'bytes_at') {
      need(keys === (c.id === 'prefix' ? 'hex,id' : 'hex,id,offset'), `${c.id} claim has unexpected fields`);
      need(isHex(c.hex) && c.hex.length <= 64, `${c.id} claim needs 1..32 bytes of hex`);
      if (c.id === 'bytes_at') need(uint(c.offset), 'bytes_at claim needs an offset');
      bytes++;
    } else throw new Bad('unknown claim id');
  }
  need(lengths <= 1 && bytes <= 2, 'at most one length claim and two byte claims');
}

function publicListing(l, { offers = false } = {}) {
  const { seller_token_hash, ...rest } = l;
  if (l.version === 2) {
    rest.units = l.units.map((u, index) => {
      const { offer, ...pub } = u;
      return offers ? { index, ...u } : { index, ...pub };
    });
    Object.assign(rest, unitCounts(l));
  }
  return rest;
}
const unitCounts = (l) => ({
  units_total: l.units.length,
  units_open: l.units.filter((u) => u.state === 'open').length,
  units_sold: l.units.filter((u) => u.state === 'sold').length,
});
function v2Status(l) {
  const c = unitCounts(l);
  return c.units_open > 0 ? 'open' : c.units_sold === c.units_total ? 'sold' : 'pending';
}
function publicOrder(o) {
  const { buyer_token_hash, ...rest } = o;
  return rest;
}
// A presale unit: everything public about one copy of a v2 listing.
function checkUnit(u) {
  need(u && typeof u === 'object' && !Array.isArray(u), 'unit required');
  need(isHex(u.t_point, 64), 'unit.t_point must be 32-byte hex');
  need(isHex(u.merchant_vk, 64), 'unit.merchant_vk must be 32-byte hex');
  need(isHex(u.r_b, 64), 'unit.r_b must be 32-byte hex');
  need(jsonStr(u.pok, 1024), 'unit.pok must be JSON');
  need(jsonStr(u.offer, 60 * 1024), 'unit.offer must be JSON (max 60 KB)');
  return { t_point: u.t_point, merchant_vk: u.merchant_vk, r_b: u.r_b, pok: u.pok, offer: u.offer, state: 'open', order_id: null };
}
// Single use is the seller app's job; this catches a buggy client re-sending
// a unit (same nonce or key) before it can ever be signed twice.
function assertFreshUnit(l, u) {
  for (const x of l.units) {
    need(x.r_b !== u.r_b && x.merchant_vk !== u.merchant_vk && x.t_point !== u.t_point, 'unit reuses a nonce, key or adaptor point');
  }
}
function publicSession(s) {
  const { buyer_token_hash, ...rest } = s;
  return rest;
}
// The session as `auth` may see it: full for its buyer and seller, otherwise
// a status view with no partial, pre-signature, signature, proofs, keys,
// addresses or PCZTs (the funding and settlement txids are public on chain).
function sessionFor(s, auth) {
  if (!s) return null;
  const l = db.listings[s.listing_id];
  if (tokOk(auth, s.buyer_token_hash) || (l && tokOk(auth, l.seller_token_hash))) return publicSession(s);
  const ch = s.chain || {};
  const chain = {};
  for (const k of ['funding_txid', 'settle_txid']) if (ch[k] !== undefined) chain[k] = ch[k];
  return {
    id: s.id, listing_id: s.listing_id, created_at: s.created_at, mode: s.mode, redacted: true,
    stage: { partial: !!s.partial, presig: !!s.presig, signature: !!s.signature },
    ...(s.mode === 'chain' ? { chain } : {}),
  };
}
// Partial wire format (engine protocol::PartialWire). The settlement partial
// must be v2: s_b masked to the buyer, never in the clear. A partial in the
// clear (v1) is allowed only where T is the identity (the refund).
const IDENTITY = '0'.repeat(64);
function checkPartial(str, { settle, t_point }) {
  let p; try { p = JSON.parse(str); } catch { throw new Bad('partial must be JSON'); }
  need(p && typeof p === 'object' && isHex(p.r_b, 64) && isHex(p.t_point, 64), 'partial needs r_b and t_point');
  if (settle) {
    need(p.v === 2 && p.s_b === undefined && isHex(p.enc_sb, 64) && isHex(p.vk_a, 64) && isHex(p.vk_b, 64),
      'settlement partial must be masked to the buyer (partial v2: enc_sb, no s_b); update the seller app or lintel-agent');
    need(!t_point || p.t_point === t_point, 'partial is locked to a different T than the listing');
  } else {
    need(p.v === undefined && isHex(p.s_b, 64) && p.t_point === IDENTITY, 'refund partial must be v1 with T = identity');
  }
}

// ---- on-chain settlement (public data only) ----
//
// Fields either party posts while settling on Zcash testnet with
// lintel-chain (see docs/onchain.md). All are public between the two
// parties: addresses, contributions, txids, the agreed terms, and PCZTs
// (which carry note values/addresses, never shares, t or plaintext).
// Write-once and role-gated like the rest of the session.
const UA = (v) => str(v, 400) && /^utest1[0-9a-z]+$/.test(v);
const B64 = (v) => typeof v === 'string' && v.length > 0 && v.length <= 48 * 1024 && /^[A-Za-z0-9+/=]+$/.test(v);
const CHAIN_FIELDS = {
  payer_contrib: ['buyer', (v) => isHex(v, 64)],
  payer_pok: ['buyer', (v) => jsonStr(v, 1024)],
  payer_address: ['buyer', UA],
  funding_txid: ['buyer', (v) => isHex(v, 64)],
  refund_terms: ['buyer', (v) => jsonStr(v, 2048)],
  refund_pczt: ['buyer', B64],
  refund_r_a: ['buyer', (v) => isHex(v, 64)],
  settle_r_a: ['buyer', (v) => isHex(v, 64)],
  merchant_contrib: ['seller', (v) => isHex(v, 64)],
  merchant_address: ['seller', UA],
  escrow_address: ['seller', UA],
  refund_partial: ['seller', (v) => {
    if (!jsonStr(v, 2048)) return false;
    const o = JSON.parse(v);
    if (!o || typeof o.partial !== 'string' || !jsonStr(o.pok, 1024)) return false;
    checkPartial(o.partial, { settle: false });
    return true;
  }],
  settle_terms: ['seller', (v) => jsonStr(v, 2048)],
  settle_pczt: ['seller', B64],
  settle_txid: ['seller', (v) => isHex(v, 64)],
};

// Raw transactions from lightwalletd, so a browser can extract t from the
// MINED settlement without trusting the relay: the payer verifies the
// signature against the rk and sighash it signed itself.
const txCache = new Map();
const chainCache = new Map(); // `${kind}:${height}` -> value, for heights well below the tip
const cached = async (key, fn) => {
  if (chainCache.has(key)) return chainCache.get(key);
  const v = await fn();
  if (chainCache.size > 2000) chainCache.clear();
  chainCache.set(key, v);
  return v;
};
let tipCache = { at: 0, height: 0 };
async function tip() {
  if (Date.now() - tipCache.at < 15000) return tipCache.height;
  tipCache = { at: Date.now(), height: await lwd.latestHeight() };
  return tipCache.height;
}
const fetchRawTx = (txid) => lwd.rawTx(txid);
const lwdErr = (e) => { if (e instanceof lwd.LwdError) throw new Bad(e.message, e.code); throw e; };
const HEIGHT = (h) => { const n = Number(h); need(Number.isInteger(n) && n > 0 && n < 2 ** 31, 'bad height'); return n; };

// ---- routes ----
const routes = [
  ['GET', /^\/health$/, () => ({ ok: true, storage: storage.kind })],

  // Content-addressed blobs (offer v3 parts). The name must be the SHA-256 of
  // the bytes; anything else is refused. Public data, write-once, immutable.
  ['PUT', /^\/blobs\/([0-9a-f]{64})$/, async ([bid], body) => {
    need(Buffer.isBuffer(body) && body.length > 0, 'blob body required');
    if (sha256hex(body) !== bid) throw new Bad('blob does not match its SHA-256 name', 422);
    try { return { blob: bid, created: await blobs.put(bid, body), size: body.length }; }
    catch (e) { if (e.code === 507) throw new Bad(e.message, 507); throw e; }
  }],
  ['GET', /^\/blobs\/([0-9a-f]{64})$/, async ([bid]) => {
    const b = await blobs.get(bid);
    if (!b) throw new Bad('not found', 404);
    return { [RAW]: b };
  }],

  ['GET', /^\/listings$/, () => ({
    listings: Object.values(db.listings)
      .sort((a, b) => b.created_at - a.created_at)
      .map(({ offer, units, ...l }) => {
        if (l.version !== 2) return publicListing(l); // list view omits the bulky offer
        const { seller_token_hash, ...rest } = l;
        return { ...rest, ...unitCounts({ units }) };
      }),
  })],

  ['POST', /^\/listings$/, async (_, body) => {
    need(Object.keys(db.listings).length < MAX_LISTINGS, 'relay is full');
    if (body.version === 2) return createV2(body);
    need(str(body.title, 120), 'title required (max 120 chars)');
    need(body.description === undefined || (typeof body.description === 'string' && body.description.length <= 2000), 'description too long');
    need(typeof body.price_zec === 'string' && /^\d{1,8}(\.\d{1,8})?$/.test(body.price_zec) && Number(body.price_zec) > 0, 'price_zec must be a positive decimal');
    need(isHex(body.content_hash, 64), 'content_hash must be 32-byte hex');
    need(isHex(body.merchant_vk, 64), 'merchant_vk must be 32-byte hex');
    need(isHex(body.t_point, 64), 't_point must be 32-byte hex');
    need(jsonStr(body.offer, 48 * 1024), 'offer must be JSON (max 48 KB)');
    need(body.filename === undefined || str(body.filename, 120), 'filename too long');
    const cap = (await checkOffer(body.offer)) ?? 4096;
    need(Number.isInteger(body.size) && body.size >= 0 && body.size <= cap, 'size invalid');
    const tok = token();
    const l = {
      id: id(), created_at: Date.now(), status: 'open',
      title: body.title, description: body.description || '', price_zec: body.price_zec,
      content_hash: body.content_hash, merchant_vk: body.merchant_vk, t_point: body.t_point,
      offer: body.offer, filename: body.filename || null, size: body.size,
      session_id: null, seller_token_hash: hashTok(tok),
    };
    db.listings[l.id] = l; save();
    return { listing: publicListing(l), seller_token: tok };
  }],

  ['GET', /^\/listings\/([\w-]+)$/, ([lid], _, auth) => {
    const l = db.listings[lid]; if (!l) throw new Bad('not found', 404);
    if (l.version === 2) return { listing: publicListing(l), session: null };
    return { listing: publicListing(l), session: l.session_id ? sessionFor(db.sessions[l.session_id], auth) : null };
  }],

  // A listing sells once: its adaptor secret is public after the first
  // completed signature, so a second sale would hand the goods out for free.
  ['POST', /^\/listings\/([\w-]+)\/sessions$/, ([lid], body) => {
    const l = db.listings[lid]; if (!l) throw new Bad('not found', 404);
    need(l.version !== 2, 'presale listings use /units/:i/orders');
    if (l.session_id) {
      const s = db.sessions[l.session_id];
      // an on-chain sale whose escrow was funded is never stale (the buyer's money is in it)
      const stale = !s.presig && !s.chain?.funding_txid && Date.now() - s.created_at > 15 * 60 * 1000;
      if (!stale) throw new Bad('listing already has a buyer', 409);
      delete db.sessions[l.session_id];
    }
    need(isHex(body.payer_vk, 64), 'payer_vk must be 32-byte hex');
    // mode 'chain': settlement on Zcash testnet. The signing nonce, alpha and
    // sighash are not known yet (they come from the agreed PCZTs later), so
    // they are absent here and exchanged through /chain/:field.
    const chainMode = body.mode === 'chain';
    if (!chainMode) {
      need(isHex(body.r_a, 64), 'r_a must be 32-byte hex');
      need(isHex(body.alpha, 64), 'alpha must be 32-byte hex');
      need(isHex(body.sighash) && body.sighash.length <= 128, 'sighash must be hex (max 64 bytes)');
    }
    const tok = token();
    const s = {
      id: id(), listing_id: lid, created_at: Date.now(), mode: chainMode ? 'chain' : 'relay',
      payer_vk: body.payer_vk, r_a: chainMode ? null : body.r_a, alpha: chainMode ? null : body.alpha, sighash: chainMode ? null : body.sighash,
      partial: null, merchant_pok: null, presig: null, signature: null,
      buyer_token_hash: hashTok(tok),
    };
    db.sessions[s.id] = s; l.session_id = s.id; l.status = 'pending'; save();
    return { session: publicSession(s), buyer_token: tok };
  }],

  ['GET', /^\/sessions\/([\w-]+)$/, ([sid], _, auth) => {
    const s = db.sessions[sid]; if (!s) throw new Bad('not found', 404);
    return { session: sessionFor(s, auth) };
  }],

  ['POST', /^\/sessions\/([\w-]+)\/partial$/, ([sid], body, auth) => {
    const s = db.sessions[sid]; if (!s) throw new Bad('not found', 404);
    if (!tokOk(auth, db.listings[s.listing_id].seller_token_hash)) throw new Bad('seller token required', 401);
    need(!s.partial, 'partial already set');
    if (s.mode === 'chain') need(s.chain?.settle_r_a && s.chain?.settle_pczt, 'on-chain session: settlement PCZT and nonce first');
    need(jsonStr(body.partial, 1024) && jsonStr(body.merchant_pok, 1024), 'partial and merchant_pok must be JSON');
    checkPartial(body.partial, { settle: true, t_point: db.listings[s.listing_id].t_point });
    s.partial = body.partial; s.merchant_pok = body.merchant_pok; save();
    return { session: publicSession(s) };
  }],

  ['POST', /^\/sessions\/([\w-]+)\/presig$/, ([sid], body, auth) => {
    const s = db.sessions[sid]; if (!s) throw new Bad('not found', 404);
    if (!tokOk(auth, s.buyer_token_hash)) throw new Bad('buyer token required', 401);
    need(s.partial && !s.presig, 'not expecting a pre-signature');
    need(jsonStr(body.presig, 2048), 'presig must be JSON');
    s.presig = body.presig; save();
    return { session: publicSession(s) };
  }],

  ['POST', /^\/sessions\/([\w-]+)\/chain\/(\w+)$/, ([sid, field], body, auth) => {
    const s = db.sessions[sid]; if (!s) throw new Bad('not found', 404);
    const spec = CHAIN_FIELDS[field]; if (!spec) throw new Bad('unknown field', 404);
    const [role, valid] = spec;
    const hash = role === 'seller' ? db.listings[s.listing_id].seller_token_hash : s.buyer_token_hash;
    if (!tokOk(auth, hash)) throw new Bad(`${role} token required`, 401);
    s.chain ??= {};
    need(s.chain[field] === undefined, `${field} already set`);
    need(valid(body.value), `invalid ${field}`);
    s.chain[field] = body.value;
    if (field === 'settle_txid') db.listings[s.listing_id].status = 'sold';
    save();
    return { session: publicSession(s) };
  }],

  ['GET', /^\/chain\/tx\/([0-9a-f]{64})$/, async ([txid]) => {
    const hit = txCache.get(txid);
    if (hit) return hit;
    const r = await fetchRawTx(txid).catch(lwdErr);
    if (r.mined) { if (txCache.size > 500) txCache.clear(); txCache.set(txid, r); }
    return r;
  }],

  // Public chain data for in-browser settlement (all of it is on chain anyway;
  // a lying relay can only make a proof or broadcast fail, never move funds:
  // the browser cross-checks the witness root against GetTreeState(h)).
  ['GET', /^\/chain\/height$/, async () => ({ height: await tip().catch(lwdErr) })],
  ['GET', /^\/chain\/tree\/(\d+)$/, async ([h]) => {
    const n = HEIGHT(h);
    const t = n + 10 < await tip().catch(lwdErr) ? await cached(`tree:${n}`, () => lwd.treeState(n)).catch(lwdErr) : await lwd.treeState(n).catch(lwdErr);
    return { height: t.height, ironwood_tree: t.ironwood_tree };
  }],
  ['GET', /^\/chain\/cmxs\/(\d+)$/, async ([h]) => {
    const n = HEIGHT(h);
    return n + 10 < await tip().catch(lwdErr) ? cached(`cmxs:${n}`, () => lwd.blockCmxs(n)).catch(lwdErr) : lwd.blockCmxs(n).catch(lwdErr);
  }],
  // "Pay from another wallet": how the buyer's app sees a payment to its
  // per-purchase pay-in wallet. Mined coins of a testnet P2PKH address, and
  // Ironwood compact actions (trial-decrypted in the browser; a hit is then
  // fetched in full via /chain/tx). The browser re-checks every coin against
  // the raw transaction, so a lying relay can hide a payment, never fake one.
  ['GET', /^\/chain\/utxos\/(tm[1-9A-HJ-NP-Za-km-z]{30,40})$/, async ([addr]) => lwd.addressUtxos(addr).catch(lwdErr)],
  ['GET', /^\/chain\/compact\/(\d+)\/(\d+)$/, async ([a, b]) => {
    const from = HEIGHT(a), to = HEIGHT(b);
    need(to >= from && to - from < 100, 'range must be 1..100 blocks');
    return to + 10 < await tip().catch(lwdErr) ? cached(`compact:${from}:${to}`, () => lwd.compactRange(from, to)).catch(lwdErr) : lwd.compactRange(from, to).catch(lwdErr);
  }],
  // Broadcasts a fully signed and proven transaction (public bytes). The
  // node, not the relay, decides validity (proofs, signatures, lock time).
  ['POST', /^\/chain\/broadcast$/, async (_, body) => {
    need(isHex(body.tx) && body.tx.length <= 60000, 'tx must be hex (max 30,000 bytes)');
    const r = await lwd.sendTx(body.tx).catch(lwdErr);
    // lightwalletd: error_code 0 and the txid (or nothing) as message on
    // success; the testnet server returns the txid JSON-quoted ("…").
    const msg = r.error_message.trim().replace(/^"|"$/g, '');
    const accepted = r.error_code === 0 && (msg === '' || /^[0-9a-f]{64}$/.test(msg));
    return { accepted, error_code: r.error_code, error_message: r.error_message };
  }],

  ['POST', /^\/sessions\/([\w-]+)\/signature$/, ([sid], body, auth) => {
    const s = db.sessions[sid]; if (!s) throw new Bad('not found', 404);
    const l = db.listings[s.listing_id];
    if (!tokOk(auth, l.seller_token_hash)) throw new Bad('seller token required', 401);
    need(s.presig && !s.signature, 'not expecting a signature');
    need(s.mode !== 'chain', 'on-chain session: broadcast the settlement and post settle_txid instead');
    need(isHex(body.signature, 128), 'signature must be 64-byte hex');
    s.signature = body.signature; l.status = 'sold'; save();
    return { session: publicSession(s) };
  }],

  // ---------- v2: presale listings ----------

  // Seller adds another pre-sealed copy (its own t, key share, nonce, proof).
  ['POST', /^\/listings\/([\w-]+)\/units$/, async ([lid], body, auth) => {
    const l = v2(lid);
    if (!tokOk(auth, l.seller_token_hash)) throw new Bad('seller token required', 401);
    need(l.units.length < MAX_UNITS, `at most ${MAX_UNITS} copies per listing`);
    const u = checkUnit(body.unit); assertFreshUnit(l, u);
    const cap = (await checkOffer(u.offer)) ?? MAX_PAYLOAD_V2;
    need(l.size <= cap, 'this copy cannot hold the listing size');
    l.units.push(u); l.status = v2Status(l); touch(['listings', lid]);
    return { listing: publicListing(l) };
  }],

  ['GET', /^\/listings\/([\w-]+)\/units\/(\d+)$/, ([lid, i]) => {
    const l = v2(lid); const u = l.units[Number(i)]; if (!u) throw new Bad('not found', 404);
    return { unit: { index: Number(i), ...u } };
  }],

  ['GET', /^\/listings\/([\w-]+)\/orders$/, ([lid]) => {
    const l = v2(lid);
    return { orders: l.units.filter((u) => u.order_id && db.orders[u.order_id]).map((u) => publicOrder(db.orders[u.order_id])) };
  }],

  // Buyer orders one open copy and pre-signs in the same request.
  ['POST', /^\/listings\/([\w-]+)\/units\/(\d+)\/orders$/, ([lid, i], body) => {
    const l = v2(lid); const idx = Number(i); const u = l.units[idx]; if (!u) throw new Bad('not found', 404);
    if (u.state !== 'open') throw new Bad('this copy is taken; pick another', 409);
    for (const k of ['payer_vk', 'r_a', 'dh_point', 's_a', 'alpha']) need(isHex(body[k], 64), `${k} must be 32-byte hex`);
    need(isHex(body.sighash) && body.sighash.length <= 128, 'sighash must be hex (max 64 bytes)');
    need(jsonStr(body.payer_pok, 1024), 'payer_pok must be JSON');
    const tok = token();
    const o = {
      id: id(), listing_id: lid, unit: idx, created_at: Date.now(), status: 'awaiting_seller',
      payer_vk: body.payer_vk, r_a: body.r_a, dh_point: body.dh_point, s_a: body.s_a, payer_pok: body.payer_pok,
      alpha: body.alpha, sighash: body.sighash, signature: null, enc_sb: null, reason: null,
      buyer_token_hash: hashTok(tok),
    };
    db.orders[o.id] = o; u.state = 'ordered'; u.order_id = o.id; l.status = v2Status(l);
    touch(['orders', o.id], ['listings', lid]);
    return { order: publicOrder(o), buyer_token: tok };
  }],

  ['GET', /^\/orders\/([\w-]+)$/, ([oid]) => {
    const o = db.orders[oid]; if (!o) throw new Bad('not found', 404);
    return { order: publicOrder(o) };
  }],

  // Seller's single step: the full signature plus s_b masked to the buyer.
  ['POST', /^\/orders\/([\w-]+)\/complete$/, ([oid], body, auth) => {
    const [o, l, u] = orderCtx(oid, auth);
    need(o.status === 'awaiting_seller', 'order is not awaiting the seller');
    need(isHex(body.signature, 128), 'signature must be 64-byte hex');
    need(isHex(body.enc_sb, 64), 'enc_sb must be 32-byte hex');
    o.signature = body.signature; o.enc_sb = body.enc_sb; o.status = 'complete'; o.completed_at = Date.now();
    u.state = 'sold'; l.status = v2Status(l);
    touch(['orders', oid], ['listings', l.id]);
    return { order: publicOrder(o) };
  }],

  // Seller refuses an invalid order before signing anything; the copy reopens.
  ['POST', /^\/orders\/([\w-]+)\/reject$/, ([oid], body, auth) => {
    const [o, l, u] = orderCtx(oid, auth);
    need(o.status === 'awaiting_seller', 'order is not awaiting the seller');
    need(body.reason === undefined || (typeof body.reason === 'string' && body.reason.length <= 200), 'reason too long');
    o.status = 'rejected'; o.reason = body.reason || 'rejected by seller';
    u.state = 'open'; u.order_id = null; l.status = v2Status(l);
    touch(['orders', oid], ['listings', l.id]);
    return { order: publicOrder(o) };
  }],
];

function v2(lid) {
  const l = db.listings[lid]; if (!l) throw new Bad('not found', 404);
  need(l.version === 2, 'not a presale listing');
  return l;
}
function orderCtx(oid, auth) {
  const o = db.orders[oid]; if (!o) throw new Bad('not found', 404);
  const l = db.listings[o.listing_id];
  if (!l || !tokOk(auth, l.seller_token_hash)) throw new Bad('seller token required', 401);
  return [o, l, l.units[o.unit]];
}
async function createV2(body) {
  need(str(body.title, 120), 'title required (max 120 chars)');
  need(body.description === undefined || (typeof body.description === 'string' && body.description.length <= 2000), 'description too long');
  need(typeof body.price_zec === 'string' && /^\d{1,8}(\.\d{1,8})?$/.test(body.price_zec) && Number(body.price_zec) > 0, 'price_zec must be a positive decimal');
  need(isHex(body.content_hash, 64), 'content_hash must be 32-byte hex');
  need(body.filename === undefined || str(body.filename, 120), 'filename too long');
  const unit = checkUnit(body.unit);
  const cap = (await checkOffer(unit.offer)) ?? MAX_PAYLOAD_V2;
  need(Number.isInteger(body.size) && body.size >= 0 && body.size <= cap, 'size invalid');
  const tok = token();
  const l = {
    id: id(), version: 2, created_at: Date.now(), status: 'open',
    title: body.title, description: body.description || '', price_zec: body.price_zec,
    content_hash: body.content_hash, filename: body.filename || null, size: body.size,
    units: [unit], seller_token_hash: hashTok(tok),
  };
  db.listings[l.id] = l; touch(['listings', l.id]);
  return { listing: publicListing(l), seller_token: tok };
}

const RAW = Symbol('raw');

function cors(req, res) {
  const origin = req.headers.origin;
  const allow = ORIGINS.includes('*') ? '*' : (ORIGINS.includes(origin) ? origin : ORIGINS[0]);
  res.setHeader('Access-Control-Allow-Origin', allow);
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization');
  // The app is cross-origin isolated (COOP/COEP) for threaded proving; CORS
  // already makes these responses loadable, CORP states it explicitly.
  res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
}

function send(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  res.end(JSON.stringify(obj));
}

function fail(res, e) {
  send(res, e.code || 500, { error: e instanceof Bad ? e.message : 'internal error' });
  if (!(e instanceof Bad)) console.error(e);
}

export const server = http.createServer((req, res) => {
  cors(req, res);
  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }
  const url = new URL(req.url, 'http://x');
  const route = routes.find(([m, re]) => m === req.method && re.test(url.pathname));
  if (!route) return send(res, 404, { error: 'not found' });
  const params = url.pathname.match(route[1]).slice(1);
  const auth = (req.headers.authorization || '').replace(/^Bearer\s+/i, '') || null;
  const limit = req.method === 'PUT' ? MAX_BLOB : MAX_BODY;
  let size = 0; const chunks = [];
  req.on('data', (c) => { size += c.length; if (size > limit) { if (!res.writableEnded) send(res, 413, { error: 'body too large' }); req.destroy(); } else chunks.push(c); });
  req.on('end', () => {
    if (res.writableEnded) return;
    try {
      let body = {};
      if (req.method === 'PUT') body = Buffer.concat(chunks);
      if (req.method === 'POST') {
        try { body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); } catch { throw new Bad('invalid JSON'); }
        if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Bad('body must be an object');
      }
      Promise.resolve().then(() => route[2](params, body, auth)).then((out) => {
        if (out && out[RAW]) {
          res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': out[RAW].length, 'Cache-Control': 'public, max-age=31536000, immutable', 'X-Content-Type-Options': 'nosniff' });
          return res.end(out[RAW]);
        }
        send(res, 200, out);
      }).catch((e) => fail(res, e));
    } catch (e) {
      fail(res, e);
    }
  });
});

if (process.env.NODE_ENV !== 'test') {
  server.listen(PORT, () => console.log(`lintel relay on :${PORT} (storage: ${storage.kind})`));
  const stop = async () => {
    try { await storage.flush(); } catch (e) { console.error(`relay storage flush failed: ${e.message}`); }
    process.exit(0);
  };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
}
