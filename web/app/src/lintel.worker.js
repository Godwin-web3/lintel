// All cryptography runs here, off the main thread. Signing shares, the
// adaptor secret t, nonces and plaintext live only in this worker's memory
// (and, for a seller, in this device's localStorage via exportState).
//
// Engine selection: when the page is cross-origin isolated (COOP/COEP, so
// SharedArrayBuffer exists) and the threaded build is deployed at /pkg-mt/,
// proofs run on a rayon pool of Web Workers. Otherwise the bundled
// single-threaded build is used, exactly as before.
import { v2ops } from './ops.v2.js';

let L = null;
let ready = null;
let params = null;
let v1Ready = false;
let bigLoad = null;
const merchants = new Map(); // listingId -> Merchant
const payers = new Map(); // sessionKey -> Payer

// `threads`: undefined/-1 = auto, 0 = force single thread, n = pool size.
async function loadEngine(threads) {
  const want = threads === undefined || threads === null || threads === '' ? -1 : Number(threads);
  if (self.crossOriginIsolated && typeof SharedArrayBuffer === 'function' && want !== 0) {
    try {
      const mt = await import(/* @vite-ignore */ new URL('/pkg-mt/lintel_wasm.js', self.location.origin).href);
      await mt.default();
      if (typeof mt.initThreadPool === 'function') {
        const n = want > 0 ? want : Math.min(navigator.hardwareConcurrency || 2, 8);
        await mt.initThreadPool(n);
        return { lib: mt, threads: n };
      }
    } catch (e) {
      console.warn('threaded engine unavailable, using single thread:', e?.message || e);
    }
  }
  const st = await import('./pkg/lintel_wasm.js');
  await st.default();
  return { lib: st, threads: 1 };
}

async function boot({ threads } = {}) {
  const engine = await loadEngine(threads);
  L = engine.lib;
  const res = await fetch('/params.bin');
  if (!res.ok) throw new Error('could not load proving parameters');
  // The digest of this file is pinned inside the WASM; a swapped file is rejected.
  params = new Uint8Array(await res.arrayBuffer());
  L.warmUpV2WithParams(params);
  return {
    maxPayload: L.maxPayloadBytes(), maxPayloadV2: L.maxPayloadV2(),
    maxPayloadBig: L.maxPayloadBig ? L.maxPayloadBig() : 0, bigPartBytes: L.bigPartBytes ? L.bigPartBytes() : 0,
    threads: engine.threads,
  };
}

// Big-payload (offer v3) keys: params-big.bin (2 MB, k = 15, digest pinned in
// the WASM) is fetched and the keys built only when a big offer is first used.
function ensureBig() {
  bigLoad ??= (async () => {
    await ready;
    if (L.bigReady()) return;
    const res = await fetch('/params-big.bin');
    if (!res.ok) throw new Error('could not load big-payload proving parameters');
    L.warmUpBigWithParams(new Uint8Array(await res.arrayBuffer()));
  })();
  return bigLoad.catch((e) => { bigLoad = null; throw e; });
}
const NEEDS_KEYS = new Set(['verifyOffer', 'unlock', 'unlockFromTx', 'verifyUnit', 'buyerOrder', 'buyerUnlock']);
const isBig = (v) => typeof v === 'string' && v.includes('"v":3');

// Proves every part of a BigSealer, reporting progress; returns the blobs.
function proveAll(sealer, progress) {
  const parts = sealer.parts(), blobs = [], t0 = performance.now();
  for (let j = 0; j < parts; j++) {
    const bytes = sealer.provePart(j);
    blobs.push({ id: sealer.blobId(j), bytes });
    progress({ part: j + 1, parts, ms: Math.round(performance.now() - t0) });
  }
  return blobs;
}

// Single-copy (v1) keys are built on first use only.
function ensureV1() {
  if (!v1Ready) { L.warmUpWithParams(params); v1Ready = true; }
}

const enc = new TextEncoder();
const merchant = (key) => {
  const m = merchants.get(key);
  if (!m) throw new Error('seller keys for this listing are not on this device');
  return m;
};
const payer = (key) => {
  const p = payers.get(key);
  if (!p) throw new Error('purchase state lost (tab was reloaded); start the purchase again');
  return p;
};

const ops = {
  boot: (args) => (ready ??= boot(args)),

  // ---- seller ----
  // Single-copy listing (on-chain flow) above maxPayloadBytes(): offer v3.
  // Returns the manifest as `offer` plus the blobs the app must upload first.
  async sealBig({ payload }, progress) {
    await ensureBig();
    const m = new L.Merchant();
    const sealer = m.bigSealer(payload);
    progress({ part: 0, parts: sealer.parts(), ms: 0 });
    const blobs = proveAll(sealer, progress);
    const out = { offer: sealer.manifest(), blobs, contentHash: L.contentHashBig(payload), tPoint: m.tPoint(), merchantVk: m.verificationKey(), state: m.exportState() };
    sealer.free(); m.free();
    return out;
  },
  async seal({ payload }) {
    await ready;
    ensureV1();
    const m = new L.Merchant();
    const offer = m.seal(payload);
    const out = {
      offer,
      contentHash: L.contentHash(payload),
      tPoint: m.tPoint(),
      merchantVk: m.verificationKey(),
      state: m.exportState(),
    };
    m.free();
    return out;
  },
  loadMerchant({ key, state }) {
    if (!merchants.has(key)) merchants.set(key, L.Merchant.fromState(state));
    return true;
  },
  respond({ key, payerVk, rA, alpha, sighash, sessionId }) {
    const m = merchant(key);
    return {
      partial: m.partial(rA, payerVk, alpha, hex2u8(sighash)),
      pok: m.proveKnowledge(payerVk, enc.encode(sessionId)),
    };
  },
  complete({ key, presig, rA, partial, payerVk, alpha }) {
    const m = merchant(key);
    if (!m.verifyPresig(presig, rA, partial, payerVk, alpha)) throw new Error('buyer pre-signature is invalid');
    return m.complete(presig, partial);
  },

  // ---- buyer ----
  async verifyOffer({ offer, contentHash }) {
    await ready;
    ensureV1();
    const p = new L.Payer();
    const t = p.verifyOffer(offer, contentHash);
    p.free();
    return t;
  },
  startPurchase({ key }) {
    const p = new L.Payer();
    payers.set(key, p);
    return { payerVk: p.verificationKey(), rA: p.nonce() };
  },
  preSign({ key, merchantVk, partial, sighash, sessionId, pok, alpha, verifiedT }) {
    return payer(key).preSign(merchantVk, partial, hex2u8(sighash), enc.encode(sessionId), pok, alpha, verifiedT);
  },
  unlock({ key, signature, presig, partial, offer }) {
    const bytes = payer(key).unlock(signature, presig, partial, offer);
    return bytes;
  },
  // ---- on-chain settlement (testnet; chain steps via lintel-chain, docs/onchain.md) ----
  // Both sides bind to the escrow key ak = vk_payer + vk_merchant and check
  // each other's proof of knowledge BEFORE the escrow is funded. sighash and
  // alpha then come from each side's own `lintel-chain check` of the agreed
  // PCZT, never from the counterparty.
  merchantBindJoint({ key, payerVk }) { return JSON.parse(merchant(key).bindJoint(payerVk)); },
  payerBindJoint({ key, merchantVk }) { return JSON.parse(payer(key).bindJoint(merchantVk)); },
  verifyPayerKnowledge({ key, payerVk, pok, sessionId }) { return merchant(key).verifyPayerKnowledge(payerVk, pok, enc.encode(sessionId)); },
  payerProveKnowledge({ key, merchantVk, sessionId }) { return payer(key).proveKnowledge(merchantVk, enc.encode(sessionId)); },
  payerNonce({ key }) { return payer(key).nonce(); },
  refundPartial({ key, payerVk, rA, alpha, sighash, sessionId }) {
    const m = merchant(key);
    return { partial: m.refundPartial(rA, payerVk, alpha, hex2u8(sighash)), pok: m.proveKnowledge(payerVk, enc.encode(sessionId)) };
  },
  refundSign({ key, merchantVk, partial, sighash, sessionId, pok, alpha }) {
    return payer(key).refundSign(merchantVk, partial, hex2u8(sighash), enc.encode(sessionId), pok, alpha);
  },
  // rawTx: hex of the MINED settlement transaction (relay GET /chain/tx/:txid
  // or any other source); the signature inside is verified against this
  // payer's own rk and sighash.
  unlockFromTx({ key, rawTx, presig, partial, offer }) {
    return payer(key).unlockFromTx(hex2u8(rawTx), presig, partial, offer);
  },
  // ---- in-browser on-chain settlement (pkg-chain, loaded on first use) ----
  // Pure functions over public data plus this device's own wallet keys; see
  // wasm/src/chain.rs. `fn` must be one of the chain* exports.
  async chain({ fn, args }) {
    const C = await chainEngine();
    if (!/^chain[A-Z]\w*$/.test(fn) || typeof C[fn] !== 'function') throw new Error(`unknown chain function ${fn}`);
    return C[fn](...(args || []));
  },
  async chainAvailable() { try { await chainEngine(); return true; } catch (e) { return String(e?.message || e); } },
  // Payer state must survive reloads during an on-chain sale (several blocks).
  // SECRET: returned only to this device's own storage.
  payerExport({ key }) { return payer(key).exportState(); },
  payerImport({ key, state }) { if (!payers.has(key)) payers.set(key, L.Payer.fromState(state)); return payer(key).verificationKey(); },
  payerFresh({ key, avoidYOdd, peerVk }) {
    // Presale on-chain: the unit's key share is fixed, so the buyer redraws
    // its own share until vk_a + vk_i has y~ = 0 (no negation needed later).
    for (let i = 0; i < 64; i++) {
      const p = new L.Payer();
      if (!avoidYOdd) { payers.set(key, p); return p.verificationKey(); }
      const j = JSON.parse(p.bindJoint(peerVk));
      if (!j.negated) { payers.set(key, p); return p.verificationKey(); }
      p.free();
    }
    throw new Error('could not find a share with an even joint key');
  },
  merchantExport({ key }) { return merchant(key).exportState(); },
  rebindPayer({ from, to }) {
    payers.set(to, payer(from));
    payers.delete(from);
    return true;
  },
};

Object.assign(ops, v2ops(() => L, () => ready, { ensureBig, proveAll }));

let chainLoad = null;
function chainEngine() {
  chainLoad ??= (async () => {
    const C = await import('./pkg-chain/lintel_chain.js');
    await C.default();
    if (typeof C.chainJoint !== 'function') throw new Error('this build has no on-chain engine');
    return C;
  })();
  return chainLoad.catch((e) => { chainLoad = null; throw e; });
}

function hex2u8(h) {
  const out = new Uint8Array(h.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(h.substr(i * 2, 2), 16);
  return out;
}

self.onmessage = async ({ data: { id, op, args } }) => {
  try {
    // Verifying or opening a v3 offer (inline or inside a unit) needs the big keys first.
    if (NEEDS_KEYS.has(op) && args && (isBig(args.offer) || isBig(args.unit))) await ensureBig();
    const result = await ops[op](args || {}, (progress) => self.postMessage({ id, progress }));
    self.postMessage({ id, ok: true, result });
  } catch (e) {
    self.postMessage({ id, ok: false, error: String(e?.message || e) });
  }
};
