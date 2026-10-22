// End-to-end: a seller and a buyer trade through a live relay, using the same
// WASM calls and relay routes as the app. Run after `npm run wasm` in web/app:
//   node web/e2e.mjs
import fs from 'node:fs';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import init, * as L from './app/src/pkg/lintel_wasm.js';

const here = (p) => new URL(p, import.meta.url);
const port = 8900 + Math.floor(Math.random() * 90);
const relayProc = spawn(process.execPath, [here('./relay/server.js').pathname], {
  env: { ...process.env, PORT: String(port), DATA_FILE: `/tmp/lintel-e2e-${port}.json` }, stdio: 'inherit',
});
const base = `http://127.0.0.1:${port}`;
// Proving is synchronous WASM and blocks the event loop for tens of seconds,
// during which the relay closes the idle keep-alive socket. Yield first so
// fetch sees that close instead of writing to a dead socket ("other side closed").
const call = async (method, path, body, tok) => {
  await new Promise((r) => setTimeout(r, 20));
  const r = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json', ...(tok ? { Authorization: `Bearer ${tok}` } : {}) }, body: body && JSON.stringify(body) });
  const j = await r.json(); if (!r.ok) throw new Error(`${path}: ${j.error}`); return j;
};
const hex = (u8) => Buffer.from(u8).toString('hex');
const rnd = (n) => hex(globalThis.crypto.getRandomValues(new Uint8Array(n)));
const enc = new TextEncoder();

try {
  await init({ module_or_path: fs.readFileSync(here('./app/src/pkg/lintel_wasm_bg.wasm')) });
  L.warmUpWithParams(fs.readFileSync(here('./app/public/params.bin')));
  for (let i = 0; i < 30; i++) { try { await call('GET', '/health'); break; } catch { await new Promise((r) => setTimeout(r, 100)); } }

  // seller: seal + publish, then simulate a reload by restoring from saved state
  const payload = enc.encode('PoC: reentrancy in withdraw() drains the vault. Fix: CEI ordering.');
  const m0 = new L.Merchant();
  const offer = m0.seal(payload);
  const { listing, seller_token } = await call('POST', '/listings', {
    title: 'Vault bug', price_zec: '1.25', content_hash: L.contentHash(payload),
    merchant_vk: m0.verificationKey(), t_point: m0.tPoint(), offer, size: payload.length,
  });
  const seller = L.Merchant.fromState(m0.exportState());

  // buyer: fetch, verify proof, join
  const { listing: pub } = await call('GET', `/listings/${listing.id}`);
  const payer = new L.Payer();
  const T = payer.verifyOffer(pub.offer, pub.content_hash);
  if (T !== pub.t_point) throw new Error('T mismatch');
  const sighash = rnd(32); const alphaB = globalThis.crypto.getRandomValues(new Uint8Array(32)); alphaB[31] &= 3; const alpha = hex(alphaB);
  const { session, buyer_token } = await call('POST', `/listings/${listing.id}/sessions`, { payer_vk: payer.verificationKey(), r_a: payer.nonce(), alpha, sighash });

  // seller responds
  let s = (await call('GET', `/listings/${listing.id}`)).session;
  await call('POST', `/sessions/${s.id}/partial`, {
    partial: seller.partial(s.r_a, s.payer_vk, s.alpha, Buffer.from(s.sighash, 'hex')),
    merchant_pok: seller.proveKnowledge(s.payer_vk, enc.encode(s.id)),
  }, seller_token);

  // buyer pre-signs
  s = (await call('GET', `/sessions/${session.id}`)).session;
  const presig = payer.preSign(pub.merchant_vk, s.partial, Buffer.from(sighash, 'hex'), enc.encode(session.id), s.merchant_pok, alpha, T);
  await call('POST', `/sessions/${session.id}/presig`, { presig }, buyer_token);

  // seller completes
  s = (await call('GET', `/sessions/${session.id}`)).session;
  if (!seller.verifyPresig(s.presig, s.r_a, s.partial, s.payer_vk, s.alpha)) throw new Error('presig invalid');
  await call('POST', `/sessions/${session.id}/signature`, { signature: seller.complete(s.presig, s.partial) }, seller_token);

  // buyer unlocks
  s = (await call('GET', `/sessions/${session.id}`)).session;
  const out = payer.unlock(s.signature, presig, s.partial, pub.offer);
  const ok = Buffer.from(out).equals(Buffer.from(payload));
  const sold = (await call('GET', `/listings/${listing.id}`)).listing.status;
  const relayDump = fs.readFileSync(`/tmp/lintel-e2e-${port}.json`, 'utf8');
  const leaked = relayDump.includes(Buffer.from(payload).toString('hex')) || relayDump.includes('reentrancy') || relayDump.includes(JSON.parse(m0.exportState()).secret);
  console.log(JSON.stringify({ decrypted_ok: ok, status: sold, relay_saw_plaintext_or_secret: leaked }));
  if (!ok || sold !== 'sold' || leaked) process.exitCode = 1;

  // ---------- v2 presale: 2 copies, seller offline while both buyers order ----------
  L.warmUpV2WithParams(fs.readFileSync(here('./app/public/params.bin')));
  const big = enc.encode('Full write-up: '.padEnd(3000, 'x') + ' END'); // > 1,953 bytes: 2 proof parts
  const h2 = L.contentHashV2(big);
  const secrets = {};
  const t0 = Date.now();
  const s1 = JSON.parse(L.sealUnit(big)); secrets[s1.unit.r_b] = s1.secret;
  const sealMs = Date.now() - t0;
  const c2 = await call('POST', '/listings', { version: 2, title: 'Big report', price_zec: '2', content_hash: h2, size: big.length, unit: s1.unit });
  const s2 = JSON.parse(L.sealUnit(big)); secrets[s2.unit.r_b] = s2.secret;
  await call('POST', `/listings/${c2.listing.id}/units`, { unit: s2.unit }, c2.seller_token);
  const lid2 = c2.listing.id; const st2 = c2.seller_token;
  // (seller goes offline here)

  const buyers = [];
  for (const idx of [0, 1]) {
    const { unit } = await call('GET', `/listings/${lid2}/units/${idx}`);
    const unitJson = JSON.stringify(unit);
    let refused = false;
    try { L.buyerOrder(unitJson, '00'.repeat(32), alpha, Buffer.from(sighash, 'hex')); } catch { refused = true; }
    if (!refused) throw new Error('buyer pre-signed against a wrong content hash');
    const { order, keep } = JSON.parse(L.buyerOrder(unitJson, h2, alpha, Buffer.from(rnd(32), 'hex')));
    const r = await call('POST', `/listings/${lid2}/units/${idx}/orders`, order);
    buyers.push({ idx, unitJson, order, keep, id: r.order.id });
  }

  // Seller comes back once and completes both orders in one pass.
  const { listing: l2 } = await call('GET', `/listings/${lid2}`);
  const { orders } = await call('GET', `/listings/${lid2}/orders`);
  for (const o of orders) {
    const unitJson = JSON.stringify(l2.units[o.unit]);
    const ow = { payer_vk: o.payer_vk, r_a: o.r_a, dh_point: o.dh_point, s_a: o.s_a, payer_pok: o.payer_pok, alpha: o.alpha, sighash: o.sighash };
    if (!L.checkOrder(unitJson, JSON.stringify(ow))) throw new Error('order invalid');
    const done = JSON.parse(L.sellerComplete(secrets[l2.units[o.unit].r_b], JSON.stringify(ow)));
    await call('POST', `/orders/${o.id}/complete`, done, st2);
  }

  // Each buyer unlocks its own copy.
  const outs = [];
  for (const b of buyers) {
    const { order } = await call('GET', `/orders/${b.id}`);
    outs.push(Buffer.from(L.buyerUnlock(b.keep, b.unitJson, JSON.stringify(b.order), JSON.stringify({ signature: order.signature, enc_sb: order.enc_sb }))).equals(Buffer.from(big)));
  }
  // A buyer cannot unlock the other buyer's copy with its own key.
  let cross = false;
  try {
    const { order } = await call('GET', `/orders/${buyers[1].id}`);
    L.buyerUnlock(buyers[0].keep, buyers[1].unitJson, JSON.stringify(buyers[1].order), JSON.stringify({ signature: order.signature, enc_sb: order.enc_sb }));
    cross = true;
  } catch {}
  // A relay that re-serves the copy with another offer (same keys) cannot redirect the unlock.
  let swapped = false;
  try {
    const { order } = await call('GET', `/orders/${buyers[0].id}`);
    const u = JSON.parse(buyers[0].unitJson); u.offer = JSON.parse(buyers[1].unitJson).offer;
    L.buyerUnlock(buyers[0].keep, JSON.stringify(u), JSON.stringify(buyers[0].order), JSON.stringify({ signature: order.signature, enc_sb: order.enc_sb }));
    swapped = true;
  } catch {}
  // The buyer's own DH secret with the other buyer's (honest) copy does not unmask its share.
  let crossKey = false;
  try {
    const { order } = await call('GET', `/orders/${buyers[1].id}`);
    const k = JSON.parse(buyers[1].keep); k.e = JSON.parse(buyers[0].keep).e;
    L.buyerUnlock(JSON.stringify(k), buyers[1].unitJson, JSON.stringify(buyers[1].order), JSON.stringify({ signature: order.signature, enc_sb: order.enc_sb }));
    crossKey = true;
  } catch {}
  await new Promise((r) => setTimeout(r, 400)); // let the relay flush its file
  const dump2 = fs.readFileSync(`/tmp/lintel-e2e-${port}.json`, 'utf8');
  const leaked2 = Object.values(secrets).some((sj) => Object.values(JSON.parse(sj)).some((v) => dump2.includes(v)))
    || dump2.includes('Full write-up') || buyers.some((b) => dump2.includes(JSON.parse(b.keep).e));
  const status2 = (await call('GET', `/listings/${lid2}`)).listing.status;
  const v2 = { v2_both_buyers_decrypted: outs.every(Boolean), v2_status: status2, v2_cross_unlock: cross || crossKey, v2_swapped_offer_unlocked: swapped, v2_relay_saw_secret: leaked2, v2_parts: JSON.parse(s1.unit.offer).parts.length, v2_seal_ms_single_thread_node: sealMs };
  console.log(JSON.stringify(v2));
  if (!v2.v2_both_buyers_decrypted || status2 !== 'sold' || cross || crossKey || swapped || leaked2 || v2.v2_parts !== 2) process.exitCode = 1;

  // ---------- v3: big payload, blobs on the relay, manifest in the listing ----------
  // Skip with LINTEL_E2E_BIG=0 (proving 3 parts single-threaded takes minutes).
  if (process.env.LINTEL_E2E_BIG !== '0') {
    const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
    L.warmUpBigWithParams(fs.readFileSync(here('./app/public/params-big.bin')));
    const big = new Uint8Array(60000);
    for (let i = 0; i < big.length; i++) big[i] = (i * 131 + 17) & 255;
    const m3 = new L.Merchant();
    const sealer = m3.bigSealer(big);
    const t3 = Date.now();
    const blobs = [];
    for (let j = 0; j < sealer.parts(); j++) blobs.push({ id: null, bytes: sealer.provePart(j) });
    blobs.forEach((b, j) => { b.id = sealer.blobId(j); });
    const sealMs3 = Date.now() - t3;
    const put = async (id, bytes) => { await new Promise((r) => setTimeout(r, 20)); return (await fetch(`${base}/blobs/${id}`, { method: 'PUT', body: bytes })).status; };
    // A tampered blob under its honest name is refused by the relay.
    const tampered = Buffer.from(blobs[0].bytes); tampered[tampered.length - 1] ^= 1;
    const tamperedPut = await put(blobs[0].id, tampered);
    for (const b of blobs) if ((await put(b.id, b.bytes)) !== 200) throw new Error('blob upload failed');
    const manifest = sealer.manifest();
    const { listing: l3, seller_token: tok3 } = await call('POST', '/listings', {
      title: 'Big dataset', price_zec: '0.5', content_hash: L.contentHashBig(big),
      merchant_vk: m3.verificationKey(), t_point: m3.tPoint(), offer: manifest, size: big.length,
    });
    // buyer: manifest from the listing, blobs by content address, re-hashed
    const { listing: pub3 } = await call('GET', `/listings/${l3.id}`);
    const man = JSON.parse(pub3.offer);
    const datas = [];
    for (const p of man.parts) {
      const b = Buffer.from(await (await fetch(`${base}/blobs/${p.blob}`)).arrayBuffer());
      if (sha(b) !== p.blob) throw new Error('blob does not match its address');
      datas.push(b.toString('hex'));
    }
    const offer3 = JSON.stringify({ ...man, parts: man.parts.map((p, i) => ({ ...p, data: datas[i] })) });
    const p3 = new L.Payer();
    const tv = Date.now();
    const T3 = p3.verifyOffer(offer3, pub3.content_hash);
    const verifyMs3 = Date.now() - tv;
    // A swapped blob (another part's bytes) is refused before any proof runs.
    let swappedBlob;
    try { const w = JSON.parse(offer3); [w.parts[0].data, w.parts[1].data] = [w.parts[1].data, w.parts[0].data]; p3.verifyOffer(JSON.stringify(w), pub3.content_hash); swappedBlob = 'accepted'; } catch { swappedBlob = 'rejected'; }
    const sh3 = rnd(32); const a3 = globalThis.crypto.getRandomValues(new Uint8Array(32)); a3[31] &= 3; const alpha3 = hex(a3);
    const { session: ss3, buyer_token: bt3 } = await call('POST', `/listings/${l3.id}/sessions`, { payer_vk: p3.verificationKey(), r_a: p3.nonce(), alpha: alpha3, sighash: sh3 });
    let s3 = (await call('GET', `/listings/${l3.id}`)).session;
    await call('POST', `/sessions/${s3.id}/partial`, { partial: m3.partial(s3.r_a, s3.payer_vk, s3.alpha, Buffer.from(s3.sighash, 'hex')), merchant_pok: m3.proveKnowledge(s3.payer_vk, enc.encode(s3.id)) }, tok3);
    s3 = (await call('GET', `/sessions/${ss3.id}`)).session;
    const pre3 = p3.preSign(pub3.merchant_vk, s3.partial, Buffer.from(sh3, 'hex'), enc.encode(ss3.id), s3.merchant_pok, alpha3, T3);
    await call('POST', `/sessions/${ss3.id}/presig`, { presig: pre3 }, bt3);
    s3 = (await call('GET', `/sessions/${ss3.id}`)).session;
    await call('POST', `/sessions/${ss3.id}/signature`, { signature: m3.complete(s3.presig, s3.partial) }, tok3);
    s3 = (await call('GET', `/sessions/${ss3.id}`)).session;
    const out3 = p3.unlock(s3.signature, pre3, s3.partial, offer3);
    const v3 = {
      v3_decrypted_ok: Buffer.from(out3).equals(Buffer.from(big)), v3_bytes: big.length, v3_parts: man.parts.length,
      v3_manifest_bytes: pub3.offer.length, v3_tampered_blob_upload_status: tamperedPut, v3_swapped_blob: swappedBlob,
      v3_seal_ms_single_thread_node: sealMs3, v3_verify_ms: verifyMs3,
    };
    console.log(JSON.stringify(v3));
    if (!v3.v3_decrypted_ok || v3.v3_parts !== 3 || tamperedPut !== 422 || swappedBlob !== 'rejected' || T3 !== m3.tPoint()) process.exitCode = 1;
  }
} finally {
  relayProc.kill();
}
