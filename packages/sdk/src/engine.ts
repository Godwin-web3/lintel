// The Lintel engine (Rust, compiled to WebAssembly) behind a typed facade.
//
// Two WASM modules ship with the SDK:
//   wasm/core   sealing, Halo 2 proof verification, adaptor signatures (1.8 MB)
//   wasm/chain  in-process Zcash testnet transactions: PCZT build/check/sign,
//               witness + proof, ZIP 321 pay-in wallets (loaded on first use)
// plus the pinned proving parameters (params/params.bin, params-big.bin). The
// parameter digests are pinned inside the WASM: a swapped file is rejected.
//
// Secrets (signing shares, t, nonces, spending keys, plaintext) stay in this
// process. Nothing in this file talks to the network.

import initCore, * as core from '../wasm/core/lintel_wasm.js';

type ChainModule = typeof import('../wasm/chain/lintel_chain.js');

/** How a platform entry (node / browser) supplies the WASM and parameter bytes. */
export interface Platform {
  /** Argument for the wasm-bindgen init of `kind`; undefined = the glue's default (fetch next to the .js). */
  wasm(kind: 'core' | 'chain'): Promise<unknown>;
  /** Bytes of params.bin ('v1') or params-big.bin ('big'). */
  params(kind: 'v1' | 'big'): Promise<Uint8Array>;
}

export interface SealResult {
  /** Public offer JSON (inline proof, or a v3 manifest whose parts are `blobs`). */
  offer: string;
  /** Content-addressed parts to upload before listing (big payloads only). */
  blobs: Array<{ id: string; bytes: Uint8Array }>;
  contentHash: string;
  tPoint: string;
  merchantVk: string;
  /** SECRET merchant state (signing share + adaptor secret). */
  state: string;
  /** 'single' = one proof (≤ maxPayload bytes), 'big' = proven 23.8 KB parts. */
  kind: 'single' | 'big';
}

export interface SealProgress { part: number; parts: number; ms: number }

const enc = new TextEncoder();
export const hexToBytes = (h: string): Uint8Array => {
  if (h.length % 2 || /[^0-9a-f]/i.test(h)) throw new Error('invalid hex');
  const out = new Uint8Array(h.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(h.substr(i * 2, 2), 16);
  return out;
};
export const bytesToHex = (u8: Uint8Array): string => Array.from(u8, (b) => b.toString(16).padStart(2, '0')).join('');
export const randomHex = (n: number): string => bytesToHex(globalThis.crypto.getRandomValues(new Uint8Array(n)));
/** Uniform scalar below 2^250 (always canonical in the Pallas scalar field). Off-chain rehearsal only. */
export const randomAlpha = (): string => { const b = globalThis.crypto.getRandomValues(new Uint8Array(32)); b[31] &= 0x03; return bytesToHex(b); };
const isBig = (offer: string) => typeof offer === 'string' && offer.includes('"v":3');
const now = () => (globalThis.performance?.now ? globalThis.performance.now() : Date.now());

function using<T extends { free(): void }, R>(obj: T, fn: (o: T) => R): R {
  try { return fn(obj); } finally { obj.free(); }
}

export class Engine {
  private coreLoad: Promise<void> | null = null;
  private chainLoad: Promise<ChainModule> | null = null;
  private bigLoad: Promise<void> | null = null;
  private params: Uint8Array | null = null;
  private v1 = false;
  private v2 = false;

  constructor(private readonly platform: Platform) {}

  /** Loads the core module and the v1 parameters. Safe to call repeatedly. */
  ready(): Promise<void> {
    this.coreLoad ??= (async () => {
      const src = await this.platform.wasm('core');
      await (src === undefined ? initCore() : initCore({ module_or_path: src as any }));
      this.params = await this.platform.params('v1');
    })();
    return this.coreLoad.catch((e) => { this.coreLoad = null; throw e; });
  }
  private async ensureV1() { await this.ready(); if (!this.v1) { core.warmUpWithParams(this.params!); this.v1 = true; } }
  private async ensureV2() { await this.ready(); if (!this.v2) { core.warmUpV2WithParams(this.params!); this.v2 = true; } }
  /** Big-payload keys (params-big.bin, 2 MB), built on first use. */
  private ensureBig(): Promise<void> {
    this.bigLoad ??= (async () => {
      await this.ready();
      if (core.bigReady()) return;
      core.warmUpBigWithParams(await this.platform.params('big'));
    })();
    return this.bigLoad.catch((e) => { this.bigLoad = null; throw e; });
  }
  /** The on-chain module (5 MB), loaded on first use. */
  chain(): Promise<ChainModule> {
    this.chainLoad ??= (async () => {
      const C = await import('../wasm/chain/lintel_chain.js');
      const src = await this.platform.wasm('chain');
      await (src === undefined ? C.default() : C.default({ module_or_path: src as any }));
      if (typeof C.chainJoint !== 'function') throw new Error('this build has no on-chain engine');
      return C;
    })();
    return this.chainLoad.catch((e) => { this.chainLoad = null; throw e; });
  }

  // ---------------------------------------------------------------- limits
  /** Largest payload sealed with a single proof (bytes). */
  async maxPayload(): Promise<number> { await this.ready(); return core.maxPayloadBytes(); }
  /** Largest payload a listing can hold (bytes), proven in parts. */
  async maxPayloadBig(): Promise<number> { await this.ready(); return core.maxPayloadBig(); }
  /** Bytes per proven part of a big payload. */
  async bigPartBytes(): Promise<number> { await this.ready(); return core.bigPartBytes(); }
  /** How many proven parts a payload of `len` bytes needs (0 if too large). */
  async partsFor(len: number): Promise<number> { await this.ready(); return core.bigPartsFor(len); }

  // ---------------------------------------------------------------- seller
  /** Seals a payload for a single-copy listing under a fresh adaptor secret. */
  async seal(payload: Uint8Array, onProgress?: (p: SealProgress) => void): Promise<SealResult> {
    await this.ready();
    if (payload.length <= core.maxPayloadBytes()) {
      await this.ensureV1();
      return using(new core.Merchant(), (m) => ({
        offer: m.seal(payload), blobs: [], contentHash: core.contentHash(payload),
        tPoint: m.tPoint(), merchantVk: m.verificationKey(), state: m.exportState(), kind: 'single' as const,
      }));
    }
    if (payload.length > core.maxPayloadBig()) throw new Error(`payload is ${payload.length} bytes; a listing holds up to ${core.maxPayloadBig()}`);
    await this.ensureBig();
    return using(new core.Merchant(), (m) => using(m.bigSealer(payload), (sealer) => {
      const parts = sealer.parts(), blobs: Array<{ id: string; bytes: Uint8Array }> = [], t0 = now();
      onProgress?.({ part: 0, parts, ms: 0 });
      for (let j = 0; j < parts; j++) {
        const bytes = sealer.provePart(j);
        blobs.push({ id: sealer.blobId(j), bytes });
        onProgress?.({ part: j + 1, parts, ms: Math.round(now() - t0) });
      }
      return { offer: sealer.manifest(), blobs, contentHash: core.contentHashBig(payload), tPoint: m.tPoint(), merchantVk: m.verificationKey(), state: m.exportState(), kind: 'big' as const };
    }));
  }

  /** Content hash a buyer should expect for `payload` (single or big encoding, by size). */
  async contentHash(payload: Uint8Array): Promise<string> {
    await this.ready();
    return payload.length <= core.maxPayloadBytes() ? core.contentHash(payload) : core.contentHashBig(payload);
  }

  /** Runs `fn` with the merchant restored from `state`; returns the result and the (possibly changed) state. */
  async withMerchant<R>(state: string, fn: (m: core.Merchant) => R): Promise<{ result: R; state: string }> {
    await this.ready();
    return using(core.Merchant.fromState(state), (m) => { const result = fn(m); return { result, state: m.exportState() }; });
  }

  /** Seller's reply to a buyer nonce: partial signature + proof of knowledge bound to the session. */
  async respond(state: string, a: { payerVk: string; rA: string; alpha: string; sighash: string; sessionId: string }) {
    return (await this.withMerchant(state, (m) => ({
      partial: m.partial(a.rA, a.payerVk, a.alpha, hexToBytes(a.sighash)),
      pok: m.proveKnowledge(a.payerVk, enc.encode(a.sessionId)),
    }))).result;
  }
  /** Checks the buyer's pre-signature and completes it (64-byte hex). Publishing it reveals t. */
  async complete(state: string, a: { presig: string; rA: string; partial: string; payerVk: string; alpha: string }): Promise<string> {
    return (await this.withMerchant(state, (m) => {
      if (!m.verifyPresig(a.presig, a.rA, a.partial, a.payerVk, a.alpha)) throw new Error('buyer pre-signature is invalid');
      return m.complete(a.presig, a.partial);
    })).result;
  }

  // ---------------------------------------------------------------- buyer
  /**
   * Verifies a sealed offer (resolved: v3 parts attached) against the
   * expected content hash. Returns T on success; throws if the proof fails.
   */
  async verifyOffer(offer: string, contentHash: string): Promise<string> {
    await this.ensureV1();
    if (isBig(offer)) await this.ensureBig();
    return using(new core.Payer(), (p) => p.verifyOffer(offer, contentHash));
  }
  /** Verifies one presale unit (resolved) against the listing's content hash. */
  async verifyUnit(unitJson: string, contentHash: string): Promise<void> {
    await this.ensureV2();
    if (isBig(unitJson)) await this.ensureBig();
    core.verifyUnit(unitJson, contentHash);
  }
  /** A fresh payer: returns its SECRET state and public key. */
  async newPayer(): Promise<{ state: string; payerVk: string }> {
    await this.ready();
    return using(new core.Payer(), (p) => ({ state: p.exportState(), payerVk: p.verificationKey() }));
  }
  /** Runs `fn` with the payer restored from `state`; returns the result and the new state (save it: nonces are single-use). */
  async withPayer<R>(state: string, fn: (p: core.Payer) => R): Promise<{ result: R; state: string }> {
    await this.ready();
    return using(core.Payer.fromState(state), (p) => { const result = fn(p); return { result, state: p.exportState() }; });
  }
  async unlock(state: string, a: { signature: string; presig: string; partial: string; offer: string }): Promise<Uint8Array> {
    await this.ensureV1();
    if (isBig(a.offer)) await this.ensureBig();
    return (await this.withPayer(state, (p) => p.unlock(a.signature, a.presig, a.partial, a.offer))).result;
  }
  async unlockFromTx(state: string, a: { rawTx: string; presig: string; partial: string; offer: string }): Promise<Uint8Array> {
    await this.ensureV1();
    if (isBig(a.offer)) await this.ensureBig();
    return (await this.withPayer(state, (p) => p.unlockFromTx(hexToBytes(a.rawTx), a.presig, a.partial, a.offer))).result;
  }
}

export { core };
export const sessionBytes = (sid: string) => enc.encode(sid);
