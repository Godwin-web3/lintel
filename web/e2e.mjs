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
} finally {
  relayProc.kill();
}
