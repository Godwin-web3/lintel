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
  return { maxPayload: L.maxPayloadBytes(), maxPayloadV2: L.maxPayloadV2(), threads: engine.threads };
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
  rebindPayer({ from, to }) {
    payers.set(to, payer(from));
    payers.delete(from);
    return true;
  },
};

Object.assign(ops, v2ops(() => L, () => ready));

function hex2u8(h) {
  const out = new Uint8Array(h.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(h.substr(i * 2, 2), 16);
  return out;
}

self.onmessage = async ({ data: { id, op, args } }) => {
  try {
    const result = await ops[op](args || {});
    self.postMessage({ id, ok: true, result });
  } catch (e) {
    self.postMessage({ id, ok: false, error: String(e?.message || e) });
  }
};
