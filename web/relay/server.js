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
// Tokens only stop third parties from overwriting fields; they protect no secret.
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
import http2 from 'node:http2';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { createStorage } from './storage.js';

const PORT = Number(process.env.PORT || 8787);
const DATA = process.env.DATA_FILE || path.join(process.cwd(), 'data.json');
const ORIGINS = (process.env.ALLOWED_ORIGINS || '*').split(',').map((s) => s.trim());
const MAX_BODY = 64 * 1024;
const MAX_UNITS = Number(process.env.MAX_UNITS || 20);
const MAX_PAYLOAD_V2 = 7905; // lintel_wasm.maxPayloadV2(): 4 parts x 64 chunks x 31 bytes - 31
const MAX_LISTINGS = Number(process.env.MAX_LISTINGS || 5000);

export const storage = createStorage({ ...process.env, DATA_FILE: DATA });
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
  merchant_contrib: ['seller', (v) => isHex(v, 64)],
  merchant_address: ['seller', UA],
  escrow_address: ['seller', UA],
  refund_partial: ['seller', (v) => jsonStr(v, 1024)],
  settle_terms: ['seller', (v) => jsonStr(v, 2048)],
  settle_pczt: ['seller', B64],
  settle_txid: ['seller', (v) => isHex(v, 64)],
};

// Raw transactions from lightwalletd, so a browser can extract t from the
// MINED settlement without trusting the relay: the payer verifies the
// signature against the rk and sighash it signed itself.
const LWD = process.env.LINTEL_LWD || 'https://testnet.zec.rocks:443';
const txCache = new Map();
function varint(n) { const out = []; while (n > 127) { out.push((n & 127) | 128); n = Math.floor(n / 128); } out.push(n); return Buffer.from(out); }
function readVarint(b, i) { let n = 0, mul = 1, x; do { x = b[i++]; n += (x & 127) * mul; mul *= 128; } while (x & 128); return [n, i]; }
export function decodeRawTransaction(buf) {
  let i = 0, data = null, height = 0;
  while (i < buf.length) {
    const [key, j] = readVarint(buf, i); i = j;
    const field = Math.floor(key / 8), wire = key & 7;
    if (wire === 2) { const [len, k] = readVarint(buf, i); i = k; if (field === 1) data = buf.subarray(i, i + len); i += len; }
    else if (wire === 0) { const [v, k] = readVarint(buf, i); i = k; if (field === 2) height = v; }
    else throw new Error('unexpected protobuf wire type');
  }
  return { data, height };
}
export function fetchRawTx(txidHex, lwd = LWD) {
  const hash = Buffer.from(txidHex, 'hex').reverse(); // display -> protocol byte order
  const msg = Buffer.concat([Buffer.from([0x1a]), varint(hash.length), hash]); // TxFilter.hash = field 3
  const frame = Buffer.concat([Buffer.from([0, 0, 0, 0, 0]), msg]);
  frame.writeUInt32BE(msg.length, 1);
  return new Promise((resolve, reject) => {
    const c = http2.connect(lwd);
    const done = (e, v) => { c.close(); e ? reject(e) : resolve(v); };
    c.on('error', (e) => done(e));
    const req = c.request({ ':method': 'POST', ':path': '/cash.z.wallet.sdk.rpc.CompactTxStreamer/GetTransaction', 'content-type': 'application/grpc', te: 'trailers' });
    const chunks = []; let status = null, message = '';
    req.setTimeout(15000, () => { req.close(); done(new Error('lightwalletd timeout')); });
    req.on('response', (h) => { if (h['grpc-status'] !== undefined) { status = h['grpc-status']; message = h['grpc-message'] || ''; } });
    req.on('trailers', (t) => { status = t['grpc-status']; message = t['grpc-message'] || ''; });
    req.on('data', (d) => chunks.push(d));
    req.on('end', () => {
      if (status !== null && status !== undefined && String(status) !== '0') return done(new Bad(`lightwalletd: ${decodeURIComponent(message) || 'error ' + status}`, 404));
      const b = Buffer.concat(chunks);
      if (b.length < 5) return done(new Bad('transaction not found', 404));
      const { data, height } = decodeRawTransaction(b.subarray(5, 5 + b.readUInt32BE(1)));
      if (!data) return done(new Bad('transaction not found', 404));
      done(null, { txid: txidHex, height, mined: height > 0 && height < 0xffffffff, data: data.toString('hex') });
    });
    req.end(frame);
  });
}

// ---- routes ----
const routes = [
  ['GET', /^\/health$/, () => ({ ok: true })],

  ['GET', /^\/listings$/, () => ({
    listings: Object.values(db.listings)
      .sort((a, b) => b.created_at - a.created_at)
      .map(({ offer, units, ...l }) => {
        if (l.version !== 2) return publicListing(l); // list view omits the bulky offer
        const { seller_token_hash, ...rest } = l;
        return { ...rest, ...unitCounts({ units }) };
      }),
  })],

  ['POST', /^\/listings$/, (_, body) => {
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
    need(Number.isInteger(body.size) && body.size >= 0 && body.size <= 4096, 'size invalid');
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

  ['GET', /^\/listings\/([\w-]+)$/, ([lid]) => {
    const l = db.listings[lid]; if (!l) throw new Bad('not found', 404);
    if (l.version === 2) return { listing: publicListing(l), session: null };
    return { listing: publicListing(l), session: l.session_id ? publicSession(db.sessions[l.session_id]) : null };
  }],

  // A listing sells once: its adaptor secret is public after the first
  // completed signature, so a second sale would hand the goods out for free.
  ['POST', /^\/listings\/([\w-]+)\/sessions$/, ([lid], body) => {
    const l = db.listings[lid]; if (!l) throw new Bad('not found', 404);
    need(l.version !== 2, 'presale listings use /units/:i/orders');
    if (l.session_id) {
      const s = db.sessions[l.session_id];
      const stale = !s.presig && Date.now() - s.created_at > 15 * 60 * 1000;
      if (!stale) throw new Bad('listing already has a buyer', 409);
      delete db.sessions[l.session_id];
    }
    need(isHex(body.payer_vk, 64), 'payer_vk must be 32-byte hex');
    need(isHex(body.r_a, 64), 'r_a must be 32-byte hex');
    need(isHex(body.alpha, 64), 'alpha must be 32-byte hex');
    need(isHex(body.sighash) && body.sighash.length <= 128, 'sighash must be hex (max 64 bytes)');
    const tok = token();
    const s = {
      id: id(), listing_id: lid, created_at: Date.now(),
      payer_vk: body.payer_vk, r_a: body.r_a, alpha: body.alpha, sighash: body.sighash,
      partial: null, merchant_pok: null, presig: null, signature: null,
      buyer_token_hash: hashTok(tok),
    };
    db.sessions[s.id] = s; l.session_id = s.id; l.status = 'pending'; save();
    return { session: publicSession(s), buyer_token: tok };
  }],

  ['GET', /^\/sessions\/([\w-]+)$/, ([sid]) => {
    const s = db.sessions[sid]; if (!s) throw new Bad('not found', 404);
    return { session: publicSession(s) };
  }],

  ['POST', /^\/sessions\/([\w-]+)\/partial$/, ([sid], body, auth) => {
    const s = db.sessions[sid]; if (!s) throw new Bad('not found', 404);
    if (!tokOk(auth, db.listings[s.listing_id].seller_token_hash)) throw new Bad('seller token required', 401);
    need(!s.partial, 'partial already set');
    need(jsonStr(body.partial, 1024) && jsonStr(body.merchant_pok, 1024), 'partial and merchant_pok must be JSON');
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
    const r = await fetchRawTx(txid);
    if (r.mined) { if (txCache.size > 500) txCache.clear(); txCache.set(txid, r); }
    return r;
  }],

  ['POST', /^\/sessions\/([\w-]+)\/signature$/, ([sid], body, auth) => {
    const s = db.sessions[sid]; if (!s) throw new Bad('not found', 404);
    const l = db.listings[s.listing_id];
    if (!tokOk(auth, l.seller_token_hash)) throw new Bad('seller token required', 401);
    need(s.presig && !s.signature, 'not expecting a signature');
    need(isHex(body.signature, 128), 'signature must be 64-byte hex');
    s.signature = body.signature; l.status = 'sold'; save();
    return { session: publicSession(s) };
  }],

  // ---------- v2: presale listings ----------

  // Seller adds another pre-sealed copy (its own t, key share, nonce, proof).
  ['POST', /^\/listings\/([\w-]+)\/units$/, ([lid], body, auth) => {
    const l = v2(lid);
    if (!tokOk(auth, l.seller_token_hash)) throw new Bad('seller token required', 401);
    need(l.units.length < MAX_UNITS, `at most ${MAX_UNITS} copies per listing`);
    const u = checkUnit(body.unit); assertFreshUnit(l, u);
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
function createV2(body) {
  need(str(body.title, 120), 'title required (max 120 chars)');
  need(body.description === undefined || (typeof body.description === 'string' && body.description.length <= 2000), 'description too long');
  need(typeof body.price_zec === 'string' && /^\d{1,8}(\.\d{1,8})?$/.test(body.price_zec) && Number(body.price_zec) > 0, 'price_zec must be a positive decimal');
  need(isHex(body.content_hash, 64), 'content_hash must be 32-byte hex');
  need(body.filename === undefined || str(body.filename, 120), 'filename too long');
  need(Number.isInteger(body.size) && body.size >= 0 && body.size <= MAX_PAYLOAD_V2, 'size invalid');
  const unit = checkUnit(body.unit);
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

function cors(req, res) {
  const origin = req.headers.origin;
  const allow = ORIGINS.includes('*') ? '*' : (ORIGINS.includes(origin) ? origin : ORIGINS[0]);
  res.setHeader('Access-Control-Allow-Origin', allow);
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
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
  let size = 0; const chunks = [];
  req.on('data', (c) => { size += c.length; if (size > MAX_BODY) { send(res, 413, { error: 'body too large' }); req.destroy(); } else chunks.push(c); });
  req.on('end', () => {
    if (res.writableEnded) return;
    try {
      let body = {};
      if (req.method === 'POST') {
        try { body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); } catch { throw new Bad('invalid JSON'); }
        if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Bad('body must be an object');
      }
      Promise.resolve(route[2](params, body, auth)).then((out) => send(res, 200, out)).catch((e) => fail(res, e));
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
