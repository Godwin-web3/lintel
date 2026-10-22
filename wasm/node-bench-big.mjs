// Benchmarks offer v3 (big payloads) on the single-threaded WASM engine in
// Node: the same build the browser bundles (wasm-pack --target web).
//
//   cd web/app && npm run wasm        # builds src/pkg and public/params-big.bin
//   node wasm/node-bench-big.mjs 100000 [parts-to-prove]
//
// Seals a payload of the given size part by part (as the app's worker does),
// verifies every part, and prints timings and WASM memory. With
// [parts-to-prove] smaller than the part count, only that many parts are
// proven and the total is extrapolated (marked "estimated").
import fs from 'fs';
const pkg = new URL('../web/app/src/pkg/', import.meta.url);
const { default: init, ...L } = await import(new URL('lintel_wasm.js', pkg));
const wasm = await init({ module_or_path: fs.readFileSync(new URL('lintel_wasm_bg.wasm', pkg)) });

const size = Number(process.argv[2] || 100000);
const payload = new Uint8Array(size);
for (let i = 0; i < size; i++) payload[i] = (i * 31 + 7) & 255;

let t = Date.now();
L.warmUpBigWithParams(fs.readFileSync(new URL('../web/app/public/params-big.bin', import.meta.url)));
const keygen_ms = Date.now() - t;

const m = new L.Merchant(), p = new L.Payer();
const sealer = m.bigSealer(payload);
const parts = sealer.parts();
const limit = Math.min(parts, Number(process.argv[3] || parts));
const blobs = [], per = [];
for (let j = 0; j < limit; j++) {
  t = Date.now();
  blobs.push(sealer.provePart(j));
  per.push(Date.now() - t);
}
const prove_ms = per.reduce((a, b) => a + b, 0);
const out = {
  engine: 'wasm32 single-thread (node ' + process.version + ')', payload_bytes: size, parts, keygen_ms,
  prove_ms_per_part: Math.round(prove_ms / limit),
  prove_ms_total: limit === parts ? prove_ms : `${Math.round((prove_ms / limit) * parts)} (estimated from ${limit} parts)`,
};
if (limit === parts) {
  const man = JSON.parse(sealer.manifest());
  const offer = JSON.stringify({ ...man, parts: man.parts.map((x, i) => ({ ...x, data: Buffer.from(blobs[i]).toString('hex') })) });
  t = Date.now();
  const T = p.verifyOffer(offer, L.contentHashBig(payload));
  out.verify_ms = Date.now() - t;
  out.locked_to_merchant_T = T === m.tPoint();
  out.manifest_bytes = JSON.stringify(man).length;
  out.blob_bytes = blobs.reduce((a, b) => a + b.length, 0);
  // Tampered blob: rejected before any proof is checked.
  const bad = JSON.parse(offer);
  bad.parts[0].data = bad.parts[0].data.slice(0, -2) + (bad.parts[0].data.endsWith('00') ? '01' : '00');
  try { p.verifyOffer(JSON.stringify(bad), L.contentHashBig(payload)); out.tampered_blob = 'ACCEPTED (bug)'; } catch (e) { out.tampered_blob = 'rejected: ' + e.message; }
}
out.wasm_memory_mb = Math.round(wasm.memory.buffer.byteLength / 1048576);
out.rss_mb = Math.round(process.memoryUsage().rss / 1048576);
console.log(JSON.stringify(out));
