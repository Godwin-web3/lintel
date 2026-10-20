// End-to-end: a seller and a buyer trade through a live relay, using the same
// WASM calls and relay routes as the app. Run after `npm run wasm` in web/app:
//   node web/e2e.mjs
import fs from 'node:fs';
import { spawn } from 'node:child_process';
import init, * as L from './app/src/pkg/lintel_wasm.js';

const here = (p) => new URL(p, import.meta.url);
const port = 8900 + Math.floor(Math.random() * 90);
const relayProc = spawn(process.execPath, [here('./relay/server.js').pathname], {
  env: { ...process.env, PORT: String(port), DATA_FILE: `/tmp/lintel-e2e-${port}.json` }, stdio: 'inherit',
});
const base = `http://127.0.0.1:${port}`;
const call = async (method, path, body, tok) => {
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
  await new Promise((r) => setTimeout(r, 400)); // let the relay flush its file
  const dump2 = fs.readFileSync(`/tmp/lintel-e2e-${port}.json`, 'utf8');
  const leaked2 = Object.values(secrets).some((sj) => Object.values(JSON.parse(sj)).some((v) => dump2.includes(v)))
    || dump2.includes('Full write-up') || buyers.some((b) => dump2.includes(b.keep));
  const status2 = (await call('GET', `/listings/${lid2}`)).listing.status;
  const v2 = { v2_both_buyers_decrypted: outs.every(Boolean), v2_status: status2, v2_cross_unlock: cross, v2_relay_saw_secret: leaked2, v2_parts: JSON.parse(s1.unit.offer).parts.length, v2_seal_ms_single_thread_node: sealMs };
  console.log(JSON.stringify(v2));
  if (!v2.v2_both_buyers_decrypted || status2 !== 'sold' || cross || leaked2 || v2.v2_parts !== 2) process.exitCode = 1;
} finally {
  relayProc.kill();
}
