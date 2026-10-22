// Worker-side operations for presale (v2) listings. Runs inside
// lintel.worker.js; secrets returned here go only to device-local storage.
export function v2ops(lib, ready, { ensureBig, proveAll } = {}) {
  const L = () => lib();
  return {
    // Copy above maxPayloadV2(): offer v3 (blobs uploaded by the app, manifest in the unit).
    async sealUnitBig({ payload }, progress) {
      await ensureBig();
      const { unit, secret } = JSON.parse(L().presaleNewUnit());
      const sealer = new (L().BigSealer)(JSON.parse(secret).s, payload);
      progress({ part: 0, parts: sealer.parts(), ms: 0 });
      const blobs = proveAll(sealer, progress);
      unit.offer = sealer.manifest();
      sealer.free();
      return { unit, secret, blobs, contentHash: L().contentHashBig(payload) };
    },
    async contentHashBig({ payload }) { await ready(); return L().contentHashBig(payload); },
    async sealUnit({ payload }) {
      await ready();
      const { unit, secret } = JSON.parse(L().sealUnit(payload));
      return { unit, secret, contentHash: L().contentHashV2(payload) };
    },
    async contentHashV2({ payload }) { await ready(); return L().contentHashV2(payload); },
    async verifyUnit({ unit, contentHash }) { await ready(); L().verifyUnit(unit, contentHash); return true; },
    async checkOrder({ unit, order }) { await ready(); return L().checkOrder(unit, order); },
    async sellerComplete({ secret, order }) { await ready(); return JSON.parse(L().sellerComplete(secret, order)); },
    async buyerOrder({ unit, contentHash, alpha, sighash }) {
      await ready();
      return JSON.parse(L().buyerOrder(unit, contentHash, alpha, hex2u8(sighash)));
    },
    async buyerUnlock({ keep, unit, order, completion }) { await ready(); return L().buyerUnlock(keep, unit, order, completion); },
  };
}

function hex2u8(h) {
  const out = new Uint8Array(h.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(h.substr(i * 2, 2), 16);
  return out;
}
